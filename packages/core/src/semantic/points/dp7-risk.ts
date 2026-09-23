/**
 * @experimental DP-7 semantic risk predicates (#28). Separate binary
 * (probability) questions — never one summed marginal — escalate-only:
 * `resolveRiskPredicates` is only ever consulted when the #26 deterministic
 * floor already missed, so semantic evidence can add friction to an action
 * but can never remove it (I3/I5 as rewritten in the technical review).
 */
import { createHash } from "node:crypto";
import type { OperationBudget } from "../budget.js";
import type { KernelEvidence } from "../../types/evidence.js";
import type { FreshnessEvidence } from "../freshness.js";
import { buildRiskSignalsDTO, type RiskSignalsDTO } from "../redaction.js";
import { checkModelSupport, type DecisionPoint, type DecisionRequest, type ProbabilityQuestion } from "../provider.js";
import type { SemanticDecisionRecord } from "../records.js";
import type { SemanticRuntime } from "../runtime.js";
import type { QuestionOutcome } from "../validate.js";

export const DP7_POINT: DecisionPoint = "dp7-risk";
/** No live provider is bound in m1 (#19 ships it; enforcement depends on
 * #21's calibration artifacts). */
export const DP7_MODEL = "unset";
export const DP7_QUESTION_VERSION = "v1";
export const DP7_POLICY_VERSION = "v1";
/** The calibration mode key DP-7 predicates share — there is one shared
 * risk bar, not one per predicate, since they're combined with OR rather
 * than summed. */
export const DP7_CALIBRATION_MODE = "risk";

/** #2's starting categories, plus the direct question the review asked
 * for. Not final — see #26's own keyword-list note; tuning this list is
 * explicitly out of scope for this story. */
export const DP7_PREDICATE_IDS = [
  "destructive",
  "financial",
  "external-communication",
  "account-security",
  "requires-confirmation"
] as const;
export type Dp7PredicateId = (typeof DP7_PREDICATE_IDS)[number];

/** SHA-256, not a fast non-cryptographic hash: `candidateSetDigest` gates
 * the #15 freshness comparison (`isFresh`) this module recomputes fresh
 * signals against (review finding) — a collision there would let a
 * genuinely changed target still compare as "fresh". */
function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface Dp7RiskSignals {
  accessibleName?: string;
  text?: string;
  formAction?: string;
}

export interface Dp7RiskOptions {
  runtime: SemanticRuntime;
  origin: string;
  actionType: "click" | "submit";
  signals: Dp7RiskSignals;
  /** One intent sentence describing the action, plus the route path — same
   * free-text shape DP-1 sends, redacted the same way. */
  intent: string;
  routePath: string;
  documentEvidence: KernelEvidence;
  /** Re-reads the target's *current* risk signals, not just document
   * evidence — a freshness check that only compared document/navigation
   * identity could never notice the target's own text/name/action changing
   * under it without a full navigation (review finding). */
  checkFreshness?: () => Promise<{ evidence: KernelEvidence; signals: Dp7RiskSignals }>;
  operationId?: string;
  budget?: OperationBudget;
}

export interface Dp7RiskResult {
  /** Whether semantic evidence alone would escalate. Always `false` in
   * shadow mode (no calibration artifact) and whenever the check degrades
   * under `"recovery_or_advisory"` — advisory means the deterministic
   * floor decides alone, which here already missed. */
  escalate: boolean;
  /** True when `runtime.dp7RiskDegradation === "required"` and the check
   * could not produce a usable answer (provider unavailable, timeout,
   * invalid response). The caller must stop the action outright — this is
   * never something a confirmation grant clears, because there is no
   * approved risk decision for a grant to be bound to. */
  requiredButUnavailable: boolean;
  record: SemanticDecisionRecord;
}

/**
 * Runs DP-7's semantic risk predicates once. Never throws. The caller
 * (`runAction`) is responsible for only calling this when the deterministic
 * floor missed (I9: never spend a call whose answer can't change the
 * outcome) — when the floor already matched, the action escalates
 * regardless of anything this would say.
 */
export async function resolveRiskPredicates(options: Dp7RiskOptions): Promise<Dp7RiskResult> {
  const { runtime } = options;
  const startedAt = Date.now();

  const support = checkModelSupport(runtime.provider, DP7_MODEL, DP7_POLICY_VERSION);
  if (!support.supported) {
    const record: SemanticDecisionRecord = {
      point: DP7_POINT,
      provider: runtime.provider.id,
      model: DP7_MODEL,
      questionVersion: DP7_QUESTION_VERSION,
      policyVersion: DP7_POLICY_VERSION,
      candidateSetDigest: "n/a",
      redactedStateDigest: "n/a",
      outcomes: [],
      status: "unavailable",
      latencyMs: Date.now() - startedAt,
      error: support.reason ? { code: support.reason.code, message: support.reason.detail } : undefined
    };
    return { escalate: false, requiredButUnavailable: runtime.dp7RiskDegradation === "required", record };
  }

  function candidateSetDigestOf(redactedSignals: RiskSignalsDTO): string {
    return digest(`${options.actionType}:${redactedSignals.accessibleName ?? ""}`);
  }

  const threshold = runtime.calibration.lookup({
    point: DP7_POINT,
    model: DP7_MODEL,
    policyVersion: DP7_POLICY_VERSION,
    questionVersion: DP7_QUESTION_VERSION,
    mode: DP7_CALIBRATION_MODE
  });

  const questions: ProbabilityQuestion[] = DP7_PREDICATE_IDS.map((id) => ({ kind: "probability", id }));
  let capturedOutcomes: QuestionOutcome[] = [];

  // Filled in by `buildRequest()` below — `evaluate()` only calls it after
  // origin admission passes, so nothing page-derived is redacted (or even
  // read) for a denied origin (review finding). `capturedEvidence` is a
  // plain object `evaluate()` reads later (well after `buildRequest()` has
  // already run), so mutating it in place here is enough to thread the
  // digest through without exposing redaction to the pre-admission path.
  const capturedEvidence: FreshnessEvidence = {
    documentId: options.documentEvidence.documentId,
    navigationEpoch: options.documentEvidence.navigationEpoch,
    frameId: options.documentEvidence.frameId,
    candidateSetDigest: undefined
  };
  let candidateSetDigestForRecord = "n/a";
  let redactedStateDigestForRecord = "n/a";

  const result = await runtime.evaluate(
    {
      point: DP7_POINT,
      origin: options.origin,
      degradation: runtime.dp7RiskDegradation,
      fallback: () => false,
      buildRequest: (): DecisionRequest => {
        const redactedSignals = buildRiskSignalsDTO(options.signals, runtime.redactor);
        const intent = runtime.redactor.text(options.intent) ?? options.intent;
        const routePath = runtime.redactor.text(options.routePath) ?? options.routePath;
        const candidateSetDigest = candidateSetDigestOf(redactedSignals);
        const redactedStateDigest = digest(JSON.stringify({ signals: redactedSignals, intent, route: routePath }));
        capturedEvidence.candidateSetDigest = candidateSetDigest;
        candidateSetDigestForRecord = candidateSetDigest;
        redactedStateDigestForRecord = redactedStateDigest;
        return {
          evidence: {
            requestId: `dp7-${Date.now()}`,
            operationId: options.operationId ?? `dp7-op-${Date.now()}`,
            point: DP7_POINT,
            model: DP7_MODEL,
            questionVersion: DP7_QUESTION_VERSION,
            policyVersion: DP7_POLICY_VERSION,
            origin: options.origin,
            frameId: "main",
            navigationEpoch: options.documentEvidence.navigationEpoch,
            candidateSetDigest,
            redactedStateDigest,
            deadline: Date.now() + 800,
            signal: new AbortController().signal
          },
          questions,
          redactedState: { signals: redactedSignals, intent, route: routePath, actionType: options.actionType }
        };
      },
      // §21 (not built in m1): without a matching calibration artifact,
      // DP-7 runs in shadow mode — record what the provider said, escalate
      // nothing. Combined with OR, never summed: any single accepted
      // probability at or above the threshold escalates the whole request.
      select: (outcomes) => {
        capturedOutcomes = outcomes;
        if (!threshold) return undefined;
        return outcomes.some(
          (o) => o.status === "accepted" && o.accepted?.answer.kind === "probability" && o.accepted.answer.value >= threshold.minConfidence
        );
      },
      capturedEvidence,
      // Re-reads the target's own risk signals and recomputes the digest
      // from them — reusing the digest captured at request-build time here
      // would make this check blind to any content change that isn't also
      // a navigation (review finding).
      checkFreshness: options.checkFreshness
        ? async () => {
            const current = await options.checkFreshness!();
            const currentRedactedSignals = buildRiskSignalsDTO(current.signals, runtime.redactor);
            return {
              documentId: current.evidence.documentId,
              navigationEpoch: current.evidence.navigationEpoch,
              frameId: current.evidence.frameId,
              candidateSetDigest: candidateSetDigestOf(currentRedactedSignals)
            };
          }
        : undefined
    },
    { budget: options.budget }
  );

  const escalate = result.kind === "accepted" ? result.value : false;
  // "required" is documented to hard-stop on a provider outage, timeout, or
  // invalid answer — never on shadow mode simply choosing not to score
  // anything (no calibration artifact). Without this, setting
  // dp7RiskDegradation: "required" with no #21 artifact yet would hard-stop
  // every floor-missing click/submit, which shadow mode is specifically
  // supposed to never do (review finding).
  const requiredButUnavailable = result.kind === "unsatisfied" && !(result.reason.code === "abstained" && !threshold);

  const record: SemanticDecisionRecord = {
    point: DP7_POINT,
    provider: runtime.provider.id,
    model: DP7_MODEL,
    questionVersion: DP7_QUESTION_VERSION,
    policyVersion: DP7_POLICY_VERSION,
    candidateSetDigest: candidateSetDigestForRecord,
    redactedStateDigest: redactedStateDigestForRecord,
    outcomes: capturedOutcomes,
    status:
      result.kind === "accepted"
        ? "accepted"
        : result.kind === "disabled"
          ? "unavailable"
          : result.reason.code === "stale"
            ? "stale"
            : result.reason.code === "abstained"
              ? "abstained"
              : result.reason.code === "invalid_answer"
                ? "invalid"
                : "unavailable",
    threshold: threshold?.minConfidence,
    latencyMs: Date.now() - startedAt,
    error:
      result.kind !== "accepted" && result.kind !== "disabled"
        ? { code: result.reason.code, message: result.reason.detail ?? "" }
        : undefined
  };

  return { escalate, requiredButUnavailable, record };
}
