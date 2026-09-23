/**
 * @experimental DP-1 target resolution — disambiguation (#23). The first
 * production decision point: `tryFind` calls this only on a genuine tie
 * (every option already passed every mandatory matcher deterministically);
 * DP-1 never widens the candidate set, it only helps pick among candidates
 * the kernel already admitted. Recall (opt-in, on a miss) is #24.
 */
import type { OperationBudget } from "../budget.js";
import type { QueryCandidate } from "../../types/queries.js";
import { buildCandidateSummaryDTO, type CandidateSummaryDTO } from "../redaction.js";
import { checkModelSupport, type ChoiceQuestion, type DecisionPoint, type DecisionRequest } from "../provider.js";
import type { SemanticDecisionRecord } from "../records.js";
import type { SemanticRuntime } from "../runtime.js";
import type { QuestionOutcome } from "../validate.js";

export const DP1_POINT: DecisionPoint = "dp1-target";
/** No live provider is bound in m1 (#19 ships it) — this pins the identity
 * calibration (#21) will eventually be keyed against, once it exists. */
export const DP1_MODEL = "unset";
export const DP1_QUESTION_VERSION = "v1";
export const DP1_POLICY_VERSION = "v1";

export type Dp1Mode = "tie" | "miss";

/** No non-text predicate here failed to verify (§23: a `region` skipped for
 * lack of layout is exactly the case this rejects). */
function everyMandatoryPredicateVerified(candidates: readonly QueryCandidate[]): boolean {
  return candidates.every((c) => c.unverifiedMandatoryPredicates.length === 0);
}

export interface Dp1DisambiguationOptions {
  runtime: SemanticRuntime;
  origin: string;
  /** The tied candidates only — already passed every mandatory matcher and
   * are within the query's ambiguity margin of each other. Never a broader
   * "everything that sort of matched" set (I3/§23). */
  tied: readonly QueryCandidate[];
  /** One intent sentence describing the query, plus the route path (§2's
   * DP-1 state shape). Both are free text — learned by the runtime's
   * redactor before being sent, same as any other outbound string. */
  intent: string;
  routePath: string;
  documentEvidence: { documentId: string; navigationEpoch: number };
  operationId?: string;
  budget?: OperationBudget;
}

export interface Dp1DisambiguationResult {
  /** The accepted candidate's `targetId`, or `undefined` if DP-1 abstained,
   * degraded, or never had anything to accept. */
  acceptedTargetId?: string;
  record: SemanticDecisionRecord;
}

function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/**
 * Runs DP-1 disambiguation once. Never throws — every failure mode (no
 * verified mandatory predicates, unsupported model, timeout, invalid answer,
 * no calibration, low confidence) comes back as `acceptedTargetId: undefined`
 * with a record explaining why, and the caller (`UIRoot.tryFind`) falls
 * through to today's `TARGET_AMBIGUOUS` unchanged.
 */
export async function resolveDisambiguation(options: Dp1DisambiguationOptions): Promise<Dp1DisambiguationResult> {
  const { runtime, tied } = options;
  const startedAt = Date.now();
  const optionIds = [...tied.map((c) => c.summary.targetId), "none"];
  const candidateSetDigest = optionIds.slice(0, -1).sort().join(",") || "empty";

  // §23: a mandatory predicate the kernel could not conclusively verify
  // (e.g. `region` with no layout data) means this tied set cannot be
  // treated as "everything mandatory verifiably passed" — never even ask.
  if (!everyMandatoryPredicateVerified(tied)) {
    const record: SemanticDecisionRecord = {
      point: DP1_POINT,
      provider: runtime.provider.id,
      model: DP1_MODEL,
      questionVersion: DP1_QUESTION_VERSION,
      policyVersion: DP1_POLICY_VERSION,
      candidateSetDigest,
      redactedStateDigest: candidateSetDigest,
      outcomes: [],
      status: "invalid",
      threshold: undefined,
      latencyMs: Date.now() - startedAt,
      error: { code: "unverified_mandatory_predicate", message: "a tied candidate had an unverifiable mandatory predicate" }
    };
    return { record };
  }

  const support = checkModelSupport(runtime.provider, DP1_MODEL, DP1_POLICY_VERSION);
  if (!support.supported) {
    const record: SemanticDecisionRecord = {
      point: DP1_POINT,
      provider: runtime.provider.id,
      model: DP1_MODEL,
      questionVersion: DP1_QUESTION_VERSION,
      policyVersion: DP1_POLICY_VERSION,
      candidateSetDigest,
      redactedStateDigest: candidateSetDigest,
      outcomes: [],
      status: "unavailable",
      threshold: undefined,
      latencyMs: Date.now() - startedAt,
      error: support.reason ? { code: support.reason.code, message: support.reason.detail } : undefined
    };
    return { record };
  }

  const redactedState: CandidateSummaryDTO[] = tied.map((c) =>
    buildCandidateSummaryDTO(
      { targetId: c.summary.targetId, kind: c.summary.kind, role: c.summary.role, accessibleName: c.summary.name },
      runtime.redactor
    )
  );
  const redactedStateDigest = djb2(JSON.stringify(redactedState));
  const intent = runtime.redactor.text(options.intent) ?? options.intent;
  const routePath = runtime.redactor.text(options.routePath) ?? options.routePath;

  const question: ChoiceQuestion = { kind: "choice", id: "target", options: optionIds };
  let capturedOutcomes: QuestionOutcome[] = [];
  let acceptedTargetId: string | undefined;

  const result = await runtime.evaluate(
    {
      point: DP1_POINT,
      origin: options.origin,
      degradation: "recovery_or_advisory",
      fallback: () => undefined,
      buildRequest: (): DecisionRequest => ({
        evidence: {
          requestId: `dp1-${Date.now()}`,
          operationId: options.operationId ?? `dp1-op-${Date.now()}`,
          point: DP1_POINT,
          model: DP1_MODEL,
          questionVersion: DP1_QUESTION_VERSION,
          policyVersion: DP1_POLICY_VERSION,
          origin: options.origin,
          frameId: "main",
          navigationEpoch: options.documentEvidence.navigationEpoch,
          candidateSetDigest,
          redactedStateDigest,
          deadline: Date.now() + 800, // §2's DP-1 timeout budget
          signal: new AbortController().signal
        },
        questions: [question],
        redactedState: { candidates: redactedState, intent, route: routePath }
      }),
      select: (outcomes) => {
        capturedOutcomes = outcomes;
        const accepted = outcomes.find((o) => o.status === "accepted");
        if (accepted?.accepted?.answer.kind !== "choice") return undefined;
        const selected = accepted.accepted.answer.selected;
        if (selected === "none" || !optionIds.includes(selected)) return undefined;

        // §21 (not built in m1): without a matching calibration artifact,
        // DP-1 runs in shadow mode — record what the provider said, accept
        // nothing. This is the only gate deciding acceptance; nothing above
        // this line ever treats a confidence number as a threshold.
        const mode: Dp1Mode = "tie";
        const threshold = runtime.calibration.lookup({
          point: DP1_POINT,
          model: DP1_MODEL,
          policyVersion: DP1_POLICY_VERSION,
          questionVersion: DP1_QUESTION_VERSION,
          mode
        });
        if (!threshold) return undefined;
        const confidence = accepted.accepted.selectedOptionProbability ?? accepted.accepted.providerConfidence ?? 0;
        if (confidence < threshold.minConfidence) return undefined;
        return selected;
      }
    },
    { budget: options.budget }
  );

  if (result.kind === "accepted") acceptedTargetId = result.value;

  const record: SemanticDecisionRecord = {
    point: DP1_POINT,
    provider: runtime.provider.id,
    model: DP1_MODEL,
    questionVersion: DP1_QUESTION_VERSION,
    policyVersion: DP1_POLICY_VERSION,
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
    threshold: undefined,
    latencyMs: Date.now() - startedAt,
    error: result.kind !== "accepted" && result.kind !== "disabled" ? { code: result.reason.code, message: result.reason.detail ?? "" } : undefined
  };

  return { acceptedTargetId, record };
}
