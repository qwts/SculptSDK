import type {
  ActionOptions,
  ActionPreconditions,
  ActionResult,
  BrowserCapabilities,
  CheckResult,
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

let actionCounter = 0;

function nextActionId(): string {
  return `act_${Date.now().toString(36)}_${(++actionCounter).toString(36)}`;
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
      target = { targetId: resolution.summary.targetId, identity: resolution.identity };
      summary = resolution.summary;
      spec.onResolved?.(resolution);

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
