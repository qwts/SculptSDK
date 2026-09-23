/**
 * @experimental DP-7 semantic risk predicates (#28). Separate binary
 * (probability) questions — never one summed marginal — escalate-only:
 * `resolveRiskPredicates` is only ever consulted when the #26 deterministic
 * floor already missed, so semantic evidence can add friction to an action
 * but can never remove it (I3/I5 as rewritten in the technical review).
 */
import type { OperationBudget } from "../budget.js";
import type { KernelEvidence } from "../../types/evidence.js";
import type { FreshnessEvidence } from "../freshness.js";
import { buildRiskSignalsDTO } from "../redaction.js";
import { checkModelSupport, type DecisionPoint, type DecisionRequest, type ProbabilityQuestion } from "../provider.js";
import type { SemanticDecisionRecord } from "../records.js";
import type { DegradationClass, SemanticRuntime } from "../runtime.js";
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

function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
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
  checkFreshness?: () => Promise<KernelEvidence>;
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

  const redactedSignals = buildRiskSignalsDTO(options.signals, runtime.redactor);
  const intent = runtime.redactor.text(options.intent) ?? options.intent;
  const routePath = runtime.redactor.text(options.routePath) ?? options.routePath;
  const candidateSetDigest = djb2(`${options.actionType}:${redactedSignals.accessibleName ?? ""}`);
  const redactedStateDigest = djb2(JSON.stringify({ signals: redactedSignals, intent, route: routePath }));

  const threshold = runtime.calibration.lookup({
    point: DP7_POINT,
    model: DP7_MODEL,
    policyVersion: DP7_POLICY_VERSION,
    questionVersion: DP7_QUESTION_VERSION,
    mode: DP7_CALIBRATION_MODE
  });

  const questions: ProbabilityQuestion[] = DP7_PREDICATE_IDS.map((id) => ({ kind: "probability", id }));
  let capturedOutcomes: QuestionOutcome[] = [];

  const capturedEvidence: FreshnessEvidence = {
    documentId: options.documentEvidence.documentId,
    navigationEpoch: options.documentEvidence.navigationEpoch,
    frameId: options.documentEvidence.frameId,
    candidateSetDigest
  };

  const result = await runtime.evaluate(
    {
      point: DP7_POINT,
      origin: options.origin,
      degradation: runtime.dp7RiskDegradation,
      fallback: () => false,
      buildRequest: (): DecisionRequest => ({
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
      }),
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
      checkFreshness: options.checkFreshness
        ? async () => {
            const current = await options.checkFreshness!();
            return { documentId: current.documentId, navigationEpoch: current.navigationEpoch, frameId: current.frameId, candidateSetDigest };
          }
        : undefined
    },
    { budget: options.budget }
  );

  const escalate = result.kind === "accepted" ? result.value : false;
  const requiredButUnavailable = result.kind === "unsatisfied";

  const record: SemanticDecisionRecord = {
    point: DP7_POINT,
    provider: runtime.provider.id,
    model: DP7_MODEL,
    questionVersion: DP7_QUESTION_VERSION,
    policyVersion: DP7_POLICY_VERSION,
    candidateSetDigest,
    redactedStateDigest,
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
