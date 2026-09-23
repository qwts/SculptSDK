import type {
  ActionOptions,
  ActionPreconditions,
  ActionResult,
  BrowserCapabilities,
  CheckResult,
  FormMaterialSnapshot,
  InputMode,
  PostconditionExpectation,
  RecoveryStep,
  StabilityOptions,
  StableStateReport,
  TargetSummary,
  VisibilityState
} from "../types/index.js";
import { matchText, serializeMatcher } from "../types/matchers.js";
import { serializeQuery } from "../types/queries.js";
import type { FoundationLayer, KernelTarget, Resolution } from "../foundation/index.js";
import type { KernelClient } from "../foundation/kernel-client.js";
import { SculptError, toSculptError } from "../errors.js";
import type { SemanticRuntime } from "../semantic/runtime.js";
import { resolveRiskPredicates, DP7_POINT } from "../semantic/points/dp7-risk.js";
import { checkRiskFloor, confirmationRequiredError, requiredRiskCheckUnavailableError, type RiskFloorSignals } from "./risk-floor.js";
import {
  computeFormValuesDigest,
  confirmationGrantInvalidError,
  CLICK_MATERIAL_DIGEST,
  ConsumedGrantRegistry,
  verifyConfirmationGrant
} from "./confirmation-grant.js";

/**
 * Interaction contract engine (§18): every action runs preconditions,
 * executes through the input engine, optionally waits for SPA stability,
 * verifies postconditions, and records every recovery step it took.
 */

export interface OrchestrationDefaults {
  preferSemanticActions: boolean;
  validatePostconditions: boolean;
  recoverFromRerenders: boolean;
  /** Wait for stable state after mutating actions unless overridden per call. */
  autoStabilize: boolean;
  defaultStability: StabilityOptions;
}

export const DEFAULT_ORCHESTRATION: OrchestrationDefaults = {
  preferSemanticActions: true,
  validatePostconditions: true,
  recoverFromRerenders: true,
  autoStabilize: true,
  defaultStability: { mutationQuietMs: 150, networkQuietMs: 250, timeoutMs: 4000 }
};

export interface ActionEnv {
  kernel: KernelClient;
  foundation: FoundationLayer;
  capabilities: BrowserCapabilities;
  orchestration: OrchestrationDefaults;
  /** @experimental Semantic Resolution Layer (m0 foundations). No production
   * policy reaches through this in m0 — see #4/#14. */
  semantic: SemanticRuntime;
  /** #27: single-use confirmation grants consumed while clearing a #26 risk
   * floor hit — scoped to this attachment, cleared on `dispose()`. */
  consumedGrants: ConsumedGrantRegistry;
}

export interface ActionSpec {
  action: string;
  target: KernelTarget;
  options: ActionOptions;
  execute: (target: KernelTarget) => Promise<{ mode?: InputMode; value?: unknown }>;
  /** Skip visibility preconditions (e.g. closing a dialog that may be mid-transition). */
  defaultPreconditions?: ActionPreconditions;
  /** Form scope for expectNoValidationErrors. */
  validationScope?: KernelTarget;
  onResolved?: (resolution: Resolution) => void;
}

/**
 * #26's deterministic risk floor, callable outside the `runAction` retry
 * loop. `UIForm.fill(values, { submit: true })` needs this: `formFill`
 * writes values and dispatches `input`/`change` events *before* `submit()`
 * ever runs, and a page's own handlers for those events could alter the
 * form's action/text/name in response — checking only post-fill (inside
 * `submit()`) risks seeing a state a page has already laundered from risky
 * to benign. Callers that go through `runAction` still get their own
 * post-resolution check too; this one covers the state before any mutation
 * this call is about to make.
 */
export async function checkRiskFloorForTarget(
  env: ActionEnv,
  target: KernelTarget,
  summary: TargetSummary | undefined
): Promise<void> {
  if (!env.semantic.enabled) return;
  const signals = await env.kernel.call<RiskFloorSignals>("riskSignals", { target });
  const matched = checkRiskFloor(signals);
  if (matched) throw confirmationRequiredError(matched, summary);
}

let actionCounter = 0;

function nextActionId(): string {
  return `act_${Date.now().toString(36)}_${(++actionCounter).toString(36)}`;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

const PRECONDITION_DEFAULTS: Required<ActionPreconditions> = {
  mustExist: true,
  mustBeVisible: true,
  mustBeEnabled: true,
  mustNotBeOccluded: true
};

function evaluatePreconditions(
  required: Required<ActionPreconditions>,
  visibility: VisibilityState,
  summary: TargetSummary
): CheckResult[] {
  const checks: CheckResult[] = [];
  if (required.mustExist) {
    checks.push({
      name: "exists",
      ok: visibility.exists && visibility.attached,
      detail: visibility.attached ? undefined : "element is not attached to the document"
    });
  }
  if (required.mustBeVisible) {
    const ok = visibility.displayed && visibility.inViewport;
    checks.push({
      name: "visible",
      ok,
      detail: ok ? undefined : visibility.reasons.join("; ") || "element is not visible"
    });
  }
  if (required.mustBeEnabled) {
    checks.push({
      name: "enabled",
      ok: summary.enabled !== false,
      detail: summary.enabled === false ? "element is disabled" : undefined
    });
  }
  if (required.mustNotBeOccluded) {
    checks.push({
      name: "not-occluded",
      ok: !visibility.occluded,
      detail: visibility.occluded ? "element is covered by another element" : undefined
    });
  }
  return checks;
}

function preconditionError(failed: CheckResult, summary: TargetSummary): SculptError {
  const code =
    failed.name === "visible"
      ? "TARGET_NOT_VISIBLE"
      : failed.name === "enabled"
        ? "TARGET_DISABLED"
        : failed.name === "not-occluded"
          ? "TARGET_OCCLUDED"
          : "TARGET_STALE";
  return new SculptError(code, `precondition "${failed.name}" failed: ${failed.detail ?? "check failed"}`, {
    layer: "uikit",
    target: summary
  });
}

async function evaluateExpectation(
  env: ActionEnv,
  expectation: PostconditionExpectation,
  actionStartedAt: number
): Promise<CheckResult> {
  if (expectation.routeIncludes !== undefined) {
    const route = await env.foundation.observers.routeState();
    const matcher = serializeMatcher(expectation.routeIncludes);
    const ok = matchText(route.url, matcher) !== null || matchText(route.path + route.hash, matcher) !== null;
    return { name: "route-includes", ok, detail: ok ? route.url : `current route: ${route.url}` };
  }
  if (expectation.toastAppeared !== undefined) {
    const candidates = await env.foundation.dom.query(
      { kind: "toast", text: expectation.toastAppeared, visible: true },
      3
    );
    return {
      name: "toast-appeared",
      ok: candidates.length > 0,
      detail: candidates.length > 0 ? candidates[0]?.summary.name : "no matching toast/status message visible"
    };
  }
  if (expectation.networkCompleted !== undefined) {
    const log = await env.foundation.observers.networkLog();
    if (!log.observed) {
      return { name: "network-completed", ok: false, detail: "network observation is disabled" };
    }
    const matcher = serializeMatcher(expectation.networkCompleted);
    const hit = log.completed.find((r) => r.endedAt >= actionStartedAt && matchText(r.url, matcher) !== null);
    return { name: "network-completed", ok: hit !== undefined, detail: hit?.url };
  }
  if (expectation.elementVisible !== undefined) {
    const candidates = await env.foundation.dom.query({ ...expectation.elementVisible, visible: true }, 1);
    return { name: "element-visible", ok: candidates.length > 0, detail: candidates[0]?.summary.name };
  }
  return { name: "expectation", ok: false, detail: "empty expectation" };
}

export async function runAction(env: ActionEnv, spec: ActionSpec): Promise<ActionResult> {
  const startedAt = Date.now();
  const actionId = nextActionId();
  const options = spec.options;
  const preconditions: CheckResult[] = [];
  const postconditions: CheckResult[] = [];
  const recoverySteps: RecoveryStep[] = [];

  const recovery = {
    rebindOnStale: env.orchestration.recoverFromRerenders,
    scrollIntoView: true,
    retryLimit: 2,
    ...options.recovery
  };
  const required: Required<ActionPreconditions> = {
    ...PRECONDITION_DEFAULTS,
    ...spec.defaultPreconditions,
    ...options.preconditions
  };

  let target = spec.target;
  let summary: TargetSummary | undefined;
  let error: SculptError | undefined;
  let mode: InputMode | undefined;
  let value: unknown;
  let executed = false;
  // A grant is verified and consumed at most once per `runAction` call, not
  // once per attempt: a retryable precondition failure (e.g. the target
  // isn't visible yet) re-enters this loop with the *same* grant, which
  // `env.consumedGrants` would otherwise already show as consumed —
  // reporting a spurious "reused" on a grant that's still doing its job for
  // this very call. Once cleared, later attempts skip the gate entirely and
  // reuse the guard/material check it already established.
  let riskGateCleared = false;
  let pendingSubmitRevalidation: { grantId: string; materialDigest: string } | undefined;

  for (let attempt = 0; attempt <= recovery.retryLimit; attempt++) {
    if (attempt > 0) recoverySteps.push({ step: "retry", ok: true, detail: `attempt ${attempt + 1}` });
    try {
      const resolution = await env.foundation.identity.resolve(target);
      if (resolution.rebound) {
        recoverySteps.push({
          step: "rebind",
          ok: true,
          detail: `rebound via ${resolution.rebound.strategy} (confidence ${resolution.rebound.confidence})`
        });
      }
      // Preserve the #22 guard across the retry loop — it must keep
      // re-validating on every subsequent kernel call for this attempt,
      // not just the initial resolve().
      target = { targetId: resolution.summary.targetId, identity: resolution.identity, guard: target.guard };
      summary = resolution.summary;
      spec.onResolved?.(resolution);

      // #26/#28: the risk gate — click/submit only. The deterministic floor
      // runs first, no provider, nothing a later answer can clear. Only
      // when it misses does DP-7's semantic risk check (#28) get a say, and
      // only escalate-only: it can add a hit the floor didn't find, never
      // remove one the floor did. Either kind of hit throws
      // CONFIRMATION_REQUIRED unless options.confirmation carries a grant
      // that verifies clean for this exact action/target/document/material
      // state (#27) — the thrown error is always non-retryable (see
      // CODE_TRAITS), so the loop below breaks immediately rather than
      // retrying past it. Verified and consumed at most once per call
      // (`riskGateCleared`, #27) — a retryable precondition failure on a
      // later attempt must not re-check an already-consumed grant.
      if (!riskGateCleared && env.semantic.enabled && (spec.action === "click" || spec.action === "submit")) {
        const actionType = spec.action as "click" | "submit";
        const signals = await env.kernel.call<RiskFloorSignals>("riskSignals", { target });
        let matched = checkRiskFloor(signals);

        if (!matched && env.semantic.isPointEnabled(DP7_POINT)) {
          const route = await env.foundation.observers.routeState();
          const dp7 = await resolveRiskPredicates({
            runtime: env.semantic,
            origin: safeOrigin(route.url),
            actionType,
            signals,
            intent: `${actionType} on ${summary.role ?? summary.kind ?? "element"} "${summary.name ?? ""}"`,
            routePath: route.path,
            documentEvidence: await env.foundation.observers.evidence(),
            checkFreshness: () => env.foundation.observers.evidence()
          });
          // A required check that couldn't run is a hard stop: never
          // routed through grant verification below — there is no
          // approved risk decision for a grant to be bound to.
          if (dp7.requiredButUnavailable) throw requiredRiskCheckUnavailableError(summary);
          if (dp7.escalate) matched = "semantic-risk";
        }

        if (matched) {
          const grant = options.confirmation;
          if (!grant) throw confirmationRequiredError(matched, summary);

          const evidence = await env.foundation.observers.evidence();
          const route = await env.foundation.observers.routeState();
          const materialDigest =
            actionType === "submit"
              ? computeFormValuesDigest(await env.kernel.call<FormMaterialSnapshot>("formMaterialSnapshot", { target }))
              : CLICK_MATERIAL_DIGEST;

          const verification = verifyConfirmationGrant(
            grant,
            {
              actionType,
              targetDigest: resolution.identity.id,
              rebound: resolution.rebound !== null,
              documentId: evidence.documentId,
              navigationEpoch: evidence.navigationEpoch,
              origin: safeOrigin(route.url),
              materialDigest,
              riskDecision: matched,
              now: Date.now()
            },
            env.consumedGrants.has(grant.grantId)
          );
          if (!verification.ok) throw verification.error;
          // Consumed the instant it clears the floor — regardless of
          // whether the action goes on to succeed for an unrelated reason.
          env.consumedGrants.consume(grant.grantId, grant.expiresAt);

          // A verified grant is bound to one exact element and one exact
          // material state — reviewed once, at this instant. Without a
          // guard, nothing stops the rest of this attempt (visibility wait,
          // scroll, dispatch) from silently rebinding to a replacement
          // element that happens to look "similar enough" (the default
          // unguarded path's whole purpose). Attaching #22's guard here
          // makes every subsequent kernel call for this attempt fail closed
          // instead, reusing the exact identity the grant was verified
          // against.
          target = {
            ...target,
            guard: { documentId: evidence.documentId, navigationEpoch: evidence.navigationEpoch, targetDigest: resolution.identity.id, rebind: "forbid" }
          };

          // The guard above binds the *target*, not the *material*: a form's
          // values can still change in the gap between this digest and the
          // actual dispatch below. Re-checked immediately before dispatch so
          // that gap is as small as this loop can make it, on top of (not
          // instead of) the snapshot already verified against the grant.
          if (actionType === "submit") {
            pendingSubmitRevalidation = { grantId: grant.grantId, materialDigest };
          }
          riskGateCleared = true;
        }
      }

      let visibility = await env.foundation.layout.visible(target);
      if (
        required.mustBeVisible &&
        visibility.displayed &&
        !visibility.inViewport &&
        recovery.scrollIntoView
      ) {
        await env.foundation.layout.scrollIntoView(target);
        recoverySteps.push({ step: "scroll-into-view", ok: true });
        visibility = await env.foundation.layout.visible(target);
      }

      preconditions.length = 0;
      preconditions.push(...evaluatePreconditions(required, visibility, summary));
      const failedCheck = preconditions.find((check) => !check.ok);
      if (failedCheck) {
        error = preconditionError(failedCheck, summary);
        if (error.retryable && attempt < recovery.retryLimit) {
          await env.foundation.observers.waitForStableState({ mutationQuietMs: 100, timeoutMs: 500 });
          continue;
        }
        break;
      }

      if (pendingSubmitRevalidation) {
        const freshSnapshot = await env.kernel.call<FormMaterialSnapshot>("formMaterialSnapshot", { target });
        if (computeFormValuesDigest(freshSnapshot) !== pendingSubmitRevalidation.materialDigest) {
          throw confirmationGrantInvalidError("material-mismatch", pendingSubmitRevalidation.grantId);
        }
      }

      const outcome = await spec.execute(target);
      mode = outcome.mode;
      value = outcome.value;
      executed = true;
      error = undefined;
      break;
    } catch (caught) {
      error = toSculptError(caught, "uikit");
      if (error.code === "TARGET_STALE" && recovery.rebindOnStale && attempt < recovery.retryLimit) {
        recoverySteps.push({ step: "rebind", ok: false, detail: "handle went stale mid-action; retrying" });
        continue;
      }
      if (error.retryable && attempt < recovery.retryLimit) continue;
      break;
    }
  }

  if (executed) {
    const waitSpec =
      options.after?.waitFor ?? (env.orchestration.autoStabilize ? ("stable-spa-state" as const) : undefined);
    if (waitSpec) {
      const stabilityOptions = waitSpec === "stable-spa-state" ? env.orchestration.defaultStability : waitSpec;
      const report = await env.kernel.call<StableStateReport>("waitForStable", { options: stabilityOptions });
      recoverySteps.push({
        step: "wait-for-stable",
        ok: report.stable,
        detail: report.stable ? `stable after ${report.elapsedMs}ms` : report.reasons.join("; ")
      });
    }

    if (options.postconditions && env.orchestration.validatePostconditions) {
      const expectations = options.postconditions.expectOneOf ?? [];
      for (const expectation of expectations) {
        postconditions.push(await evaluateExpectation(env, expectation, startedAt));
      }
      const oneOfSatisfied = expectations.length === 0 || postconditions.some((check) => check.ok);

      let validationOk = true;
      if (options.postconditions.expectNoValidationErrors) {
        const scope = spec.validationScope ?? target;
        const { errors } = await env.kernel.call<{ errors: { message: string }[] }>("formValidationErrors", {
          target: scope
        });
        validationOk = errors.length === 0;
        postconditions.push({
          name: "no-validation-errors",
          ok: validationOk,
          detail: validationOk ? undefined : errors.map((e) => e.message).join("; ")
        });
      }

      if (!oneOfSatisfied || !validationOk) {
        error = new SculptError("POSTCONDITION_FAILED", "action executed but postconditions were not satisfied", {
          layer: "uikit",
          target: summary,
          details: { failed: postconditions.filter((check) => !check.ok).map((check) => check.name) }
        });
      }
    }
  }

  const endedAt = Date.now();
  return {
    ok: executed && error === undefined,
    actionId,
    action: spec.action,
    target: summary,
    inputMode: mode,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    preconditions,
    postconditions,
    recoverySteps,
    capabilitySnapshot: env.capabilities,
    value,
    error: error?.toShape()
  };
}

/** Builds an ActionResult for operations that never touched a target. */
export function syntheticResult(
  env: ActionEnv,
  action: string,
  outcome: { ok: boolean; value?: unknown; error?: SculptError; startedAt?: number }
): ActionResult {
  const startedAt = outcome.startedAt ?? Date.now();
  const endedAt = Date.now();
  return {
    ok: outcome.ok,
    actionId: nextActionId(),
    action,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    preconditions: [],
    postconditions: [],
    recoverySteps: [],
    capabilitySnapshot: env.capabilities,
    value: outcome.value,
    error: outcome.error?.toShape()
  };
}

export { serializeQuery };
