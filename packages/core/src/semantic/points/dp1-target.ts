/**
 * @experimental DP-1 target resolution (#23 disambiguation, #24 recall).
 * The first production decision point: `resolveDisambiguation` is called
 * either on a genuine tie (`mode: "tie"`, every option already passed
 * every mandatory matcher deterministically) or, opt-in only, on a miss
 * with text matchers dropped (`mode: "miss"`, #24) — DP-1 never widens the
 * candidate set beyond what the kernel already admitted for that mode.
 */
import type { OperationBudget } from "../budget.js";
import type { CachedDecision, DecisionCacheKey } from "../cache.js";
import type { KernelEvidence } from "../../types/evidence.js";
import type { QueryCandidate } from "../../types/queries.js";
import { isFresh, type FreshnessEvidence } from "../freshness.js";
import { buildCandidateSummaryDTO, REDACTION_VERSION, type CandidateSummaryDTO } from "../redaction.js";
import { checkModelSupport, type ChoiceQuestion, type DecisionPoint, type DecisionRequest } from "../provider.js";
import type { GatedMetric, SemanticDecisionRecord } from "../records.js";
import type { SemanticRuntime } from "../runtime.js";
import type { QuestionOutcome } from "../validate.js";

export const DP1_POINT: DecisionPoint = "dp1-target";
/** No live provider is bound in m1 (#19 ships it) — this pins the identity
 * calibration (#21) will eventually be keyed against, once it exists. */
export const DP1_MODEL = "unset";
export const DP1_QUESTION_VERSION = "v1";
export const DP1_POLICY_VERSION = "v1";
/** Deterministic retrieval cap for recall's shortlist (#24). The 32 figure
 * from #2 is a hypothesis for #20/#21 to set empirically. */
export const DP1_RECALL_CAP = 32;

export type Dp1Mode = "tie" | "miss";

/** No non-text predicate here failed to verify (§23: a `region` skipped for
 * lack of layout is exactly the case this rejects). */
function everyMandatoryPredicateVerified(candidates: readonly QueryCandidate[]): boolean {
  return candidates.every((c) => c.unverifiedMandatoryPredicates.length === 0);
}

export interface Dp1DisambiguationOptions {
  runtime: SemanticRuntime;
  origin: string;
  /** `"tie"`: the tied candidates only, within the query's ambiguity margin
   * of each other. `"miss"` (#24, recall): the capped structural-only
   * shortlist, text matchers dropped. Either way, never a broader
   * "everything that sort of matched" set than what the kernel actually
   * admitted for that mode (I3). */
  tied: readonly QueryCandidate[];
  mode: Dp1Mode;
  /** One intent sentence describing the query, plus the route path (§2's
   * DP-1 state shape). Both are free text — learned by the runtime's
   * redactor before being sent, same as any other outbound string. */
  intent: string;
  routePath: string;
  documentEvidence: KernelEvidence;
  /** Re-fetches current kernel evidence for the freshness comparison against
   * `documentEvidence` (ADR-0008), called only once an answer would
   * otherwise be accepted. Omitted disables the freshness check for this
   * call, e.g. in tests that don't model navigation. */
  checkFreshness?: () => Promise<KernelEvidence>;
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
  const intent = runtime.redactor.text(options.intent) ?? options.intent;
  const routePath = runtime.redactor.text(options.routePath) ?? options.routePath;
  // §16: the digest must cover exactly the payload sent (`redactedState`
  // below), not just the candidate array — otherwise two requests that
  // differ only in intent/route can collide on the same digest.
  const redactedStateDigest = djb2(JSON.stringify({ candidates: redactedState, intent, route: routePath }));

  // §21 (not built in m1): the threshold actually in effect for this exact
  // (model, policy/question version, mode) — computed once, both for the
  // cache key (there's no separate "calibration version" anywhere in the
  // codebase; a different threshold is a different decision, #25) and for
  // gating acceptance below.
  const calibrationThreshold = runtime.calibration.lookup({
    point: DP1_POINT,
    model: DP1_MODEL,
    policyVersion: DP1_POLICY_VERSION,
    questionVersion: DP1_QUESTION_VERSION,
    mode: options.mode
  });

  const capturedEvidence: FreshnessEvidence = {
    documentId: options.documentEvidence.documentId,
    navigationEpoch: options.documentEvidence.navigationEpoch,
    frameId: options.documentEvidence.frameId,
    candidateSetDigest
  };

  const cacheKey: DecisionCacheKey = {
    point: DP1_POINT,
    model: DP1_MODEL,
    questionVersion: DP1_QUESTION_VERSION,
    policyVersion: DP1_POLICY_VERSION,
    mode: options.mode,
    candidateGenerationVersion: options.documentEvidence.kernelVersion ?? "unknown",
    redactionVersion: REDACTION_VERSION,
    calibrationMinConfidence: calibrationThreshold?.minConfidence ?? "none",
    origin: options.origin,
    frameId: options.documentEvidence.frameId,
    documentId: options.documentEvidence.documentId,
    navigationEpoch: options.documentEvidence.navigationEpoch,
    candidateSetDigest,
    redactedStateDigest
  };

  // §25: a hit still gets the same freshness revalidation a live decision
  // would — the key alone already covers "nothing versioned changed", but
  // not the narrower race of the page moving on between the cache write and
  // this read. Without a `checkFreshness` hook (e.g. a test that doesn't
  // model navigation), a hit is returned as-is, matching how the live path
  // below also skips that gate when no hook is supplied.
  const cached = runtime.decisionCache.get(cacheKey);
  if (cached) {
    if (!options.checkFreshness) return cached;
    const current = await options.checkFreshness();
    if (isFresh(capturedEvidence, { documentId: current.documentId, navigationEpoch: current.navigationEpoch, frameId: current.frameId, candidateSetDigest })) {
      return cached;
    }
    // Stale: fall through to a live decision rather than serving or
    // rewriting this entry — the fresh call below will key differently once
    // it captures current evidence, so this entry simply ages out.
  }

  const question: ChoiceQuestion = { kind: "choice", id: "target", options: optionIds };
  let capturedOutcomes: QuestionOutcome[] = [];
  let acceptedTargetId: string | undefined;
  let gatedThreshold: number | undefined;
  let gatedMetric: GatedMetric | undefined;

  // §2's DP-1 timeout budget: only spend it when the caller didn't already
  // share a budget with us — a nested call inherits the operation's own
  // deadline instead of shortening it to 800ms.
  const budget = options.budget ?? runtime.createOperationBudget({ maxOperationMs: 800 });

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
          deadline: Date.now() + 800, // overwritten by the runtime with `budget.deadline`
          signal: new AbortController().signal
        },
        questions: [question],
        redactedState: { candidates: redactedState, intent, route: routePath }
      }),
      select: (outcomes) => {
        capturedOutcomes = outcomes;
        const accepted = outcomes.find((o) => o.status === "accepted");
        if (accepted?.accepted?.answer.kind !== "choice") return undefined;
        const answer = accepted.accepted.answer;
        const selected = answer.selected;
        if (selected === "none" || !optionIds.includes(selected)) return undefined;

        // §21 (not built in m1): without a matching calibration artifact,
        // DP-1 runs in shadow mode — record what the provider said, accept
        // nothing. This is the only gate deciding acceptance; nothing above
        // this line ever treats a confidence number as a threshold.
        if (!calibrationThreshold) return undefined;
        // A distribution, when present, is the metric of record (I7): a
        // selected option missing from it means zero mass on that option,
        // never a silent fallback to the answer's overall confidence.
        const metric: GatedMetric = answer.distribution !== undefined ? "selectedOptionProbability" : "providerConfidence";
        const confidence = metric === "selectedOptionProbability" ? (accepted.accepted.selectedOptionProbability ?? 0) : (accepted.accepted.providerConfidence ?? 0);
        gatedThreshold = calibrationThreshold.minConfidence;
        gatedMetric = metric;
        if (confidence < calibrationThreshold.minConfidence) return undefined;
        return selected;
      },
      capturedEvidence,
      checkFreshness: options.checkFreshness
        ? async () => {
            const current = await options.checkFreshness!();
            return { documentId: current.documentId, navigationEpoch: current.navigationEpoch, frameId: current.frameId, candidateSetDigest };
          }
        : undefined
    },
    { budget }
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
    threshold: gatedThreshold,
    gatedMetric,
    latencyMs: Date.now() - startedAt,
    error: result.kind !== "accepted" && result.kind !== "disabled" ? { code: result.reason.code, message: result.reason.detail ?? "" } : undefined
  };

  // §25: only ever cache an actual accept. `evaluate()` never resolves
  // "accepted" for a request that was aborted or superseded (late results
  // fall through to "cancelled" instead, per `runtime.ts`), so this can't
  // write a late result — and there's nothing evidence-only to cache for an
  // abstain/degrade anyway.
  if (result.kind === "accepted") {
    const entry: CachedDecision = { acceptedTargetId, record };
    runtime.decisionCache.set(cacheKey, entry);
  }

  return { acceptedTargetId, record };
}
