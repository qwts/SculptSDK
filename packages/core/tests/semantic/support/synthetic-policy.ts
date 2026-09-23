/**
 * Test-only synthetic policy (#17). Not exported as a feature — this is not
 * production DP code, it exists only to exercise every m0 runtime contract
 * end to end in one pipeline, the way a real decision-point policy (DP-1
 * through DP-7, none of which exists yet) eventually will:
 *
 *   1. Build deterministically admitted candidates from a live page.
 *   2. Compile a choice question through the #16 DTOs (redacted, allowlisted).
 *   3. Call the runtime under an operation budget.
 *   4. Validate the answer and map it to a typed outcome (inside `evaluate`).
 *   5. Apply the declared fallback on any degradation.
 *   6. Emit a decision record.
 */
import {
  buildCandidateSummaryDTO,
  type CandidateSummaryDTO,
  type DecisionOutcomeStatus,
  type DecisionPoint,
  type FreshnessEvidence,
  type OperationBudget,
  type QuestionOutcome,
  type SemanticDecisionRecord,
  type SemanticPointResult,
  type SemanticRuntime
} from "@sculptsdk/core";
import type { Sculpt, UIElement } from "@sculptsdk/core";

/** Maps a runtime result to the decision record's overall status. There is
 * no 1:1 mapping — the record's vocabulary is narrower (it predates the
 * richer, free-form `OutcomeReason.code` set), so this is the single place
 * that reconciles them. */
function mapToRecordStatus(result: SemanticPointResult<unknown, unknown>): DecisionOutcomeStatus {
  if (result.kind === "accepted") return "accepted";
  if (result.kind === "disabled") return "unavailable";
  switch (result.reason.code) {
    case "stale":
      return "stale";
    case "abstained":
      return "abstained";
    case "invalid_answer":
      return "invalid";
    default:
      // cancelled, budget_exhausted, origin_not_allowed, timeout,
      // no_calibration, recording_missing, null_provider, etc.
      return "unavailable";
  }
}

export const SYNTHETIC_POINT: DecisionPoint = "synthetic-consumer";
export const SYNTHETIC_MODEL = "synthetic-model";
export const SYNTHETIC_QUESTION_VERSION = "v1";
export const SYNTHETIC_POLICY_VERSION = "v1";

export interface SyntheticCandidate {
  targetId: string;
  kind?: string;
  role?: string;
  name?: string;
}

export interface SyntheticPolicyOutcome<TDegradation extends "recovery_or_advisory" | "required"> {
  result: SemanticPointResult<null, string>;
  record: SemanticDecisionRecord;
  admittedCandidateIds: string[];
  degradation: TDegradation;
}

/**
 * Step 1: the deterministically admitted candidate set — exactly what the
 * kernel's own query ranking returns, unmodified by anything semantic.
 */
type QueryWithEvidence = Sculpt["foundation"]["dom"]["queryWithEvidence"];
type KernelEvidence = Awaited<ReturnType<QueryWithEvidence>>["evidence"];

export async function gatherAdmittedCandidates(
  sculpt: Sculpt,
  query: Parameters<QueryWithEvidence>[0]
): Promise<{ candidates: SyntheticCandidate[]; evidence: KernelEvidence }> {
  const { candidates, evidence } = await sculpt.foundation.dom.queryWithEvidence(query);
  return {
    candidates: candidates.map((c) => ({
      targetId: c.summary.targetId,
      kind: c.summary.kind,
      role: c.summary.role,
      name: c.summary.name
    })),
    evidence
  };
}

/**
 * Runs the full synthetic pipeline once: builds the request from the
 * admitted candidates (step 2), calls `runtime.evaluate` under a budget
 * (step 3; validation and typed-outcome mapping happen inside it — step 4),
 * and returns a decision record built from what actually happened (step 6).
 * The declared fallback (step 5) is `null` — "no candidate selected", i.e.
 * today's behavior when nothing new is admitted.
 */
export async function runSyntheticPolicy<TDegradation extends "recovery_or_advisory" | "required">(options: {
  runtime: SemanticRuntime;
  admittedCandidates: SyntheticCandidate[];
  origin: string;
  degradation: TDegradation;
  /** Override to feed a specific evidence shape (e.g. for freshness tests). */
  navigationEpoch?: number;
  operationId?: string;
  /** Share one budget across calls (I5: budget-exhausted class). */
  budget?: OperationBudget;
  /** Freshness binding (I5: stale class). */
  capturedEvidence?: FreshnessEvidence;
  checkFreshness?: () => Promise<FreshnessEvidence>;
}): Promise<SyntheticPolicyOutcome<TDegradation>> {
  const { runtime, admittedCandidates, degradation } = options;
  let capturedOutcomes: QuestionOutcome[] = [];
  const startedAt = Date.now();

  const optionIds = [...admittedCandidates.map((c) => c.targetId), "none"];
  const candidateSetDigest = optionIds.slice(0, -1).sort().join(",") || "empty";

  // Step 2: compiled through the #16 DTO framework — allowlisted, redacted,
  // truncated. Never a raw value. `SyntheticCandidate.name` is the kernel's
  // accessible name; buildCandidateSummaryDTO's input field is named
  // accessibleName, so it's mapped explicitly here rather than relying on an
  // unrelated property name lining up by accident.
  const redactedState = buildRedactedState(admittedCandidates, runtime.redactor);
  // Digested from the *actual* DTO payload (not just the candidate-set
  // digest) — two candidate sets with the same targetIds but different
  // names/roles must not collide, since RecordedProvider matches on this
  // digest and a collision would replay a recording for different state.
  const redactedStateDigest = computeRedactedStateDigest(redactedState);

  const result = await runtime.evaluate({
    point: SYNTHETIC_POINT,
    origin: options.origin,
    degradation,
    fallback: () => null,
    buildRequest: () => ({
      evidence: {
        requestId: `synthetic-${Date.now()}`,
        operationId: options.operationId ?? "synthetic-op",
        point: SYNTHETIC_POINT,
        model: SYNTHETIC_MODEL,
        questionVersion: SYNTHETIC_QUESTION_VERSION,
        policyVersion: SYNTHETIC_POLICY_VERSION,
        origin: options.origin,
        frameId: "main",
        navigationEpoch: options.navigationEpoch ?? 0,
        candidateSetDigest,
        redactedStateDigest,
        deadline: Date.now() + 5000,
        signal: new AbortController().signal
      },
      questions: [{ kind: "choice", id: "target", options: optionIds }],
      redactedState
    }),
    select: (outcomes) => {
      capturedOutcomes = outcomes;
      const accepted = outcomes.find((o) => o.status === "accepted");
      if (accepted?.accepted?.answer.kind !== "choice") return undefined;
      return accepted.accepted.answer.selected;
    },
    capturedEvidence: options.capturedEvidence,
    checkFreshness: options.checkFreshness
  }, { budget: options.budget });

  const latencyMs = Date.now() - startedAt;
  const admittedIds = admittedCandidates.map((c) => c.targetId);

  const record: SemanticDecisionRecord = {
    point: SYNTHETIC_POINT,
    provider: runtime.provider.id,
    model: SYNTHETIC_MODEL,
    questionVersion: SYNTHETIC_QUESTION_VERSION,
    policyVersion: SYNTHETIC_POLICY_VERSION,
    candidateSetDigest,
    redactedStateDigest,
    outcomes: capturedOutcomes,
    status: mapToRecordStatus(result),
    threshold: undefined,
    latencyMs,
    error: result.kind !== "accepted" && result.kind !== "disabled" ? { code: result.reason.code, message: result.reason.detail ?? "" } : undefined
  };

  return { result, record, admittedCandidateIds: admittedIds, degradation };
}

/** Builds the same allowlisted, redacted candidate DTOs `runSyntheticPolicy`
 * sends outbound — exported so a test seeding a `RecordedProvider` recording
 * can build its `redactedStateDigest` from the exact same payload. */
export function buildRedactedState(candidates: SyntheticCandidate[], redactor: SemanticRuntime["redactor"]): CandidateSummaryDTO[] {
  return candidates.map((c) => buildCandidateSummaryDTO({ targetId: c.targetId, kind: c.kind, role: c.role, accessibleName: c.name }, redactor));
}

/** Digests the actual redacted DTO payload (not just candidate ids) —
 * exported for the same reason as `buildRedactedState`. */
export function computeRedactedStateDigest(redactedState: CandidateSummaryDTO[]): string {
  return djb2(JSON.stringify(redactedState));
}

/** Same non-cryptographic stable hash the kernel/digest module uses (djb2) —
 * good enough for "does the exact DTO payload match" test-support matching. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** Finds the interactive element a candidate id points to, for assertions
 * that want to inspect it further (kept out of the hot path above). */
export async function elementFor(sculpt: Sculpt, targetId: string): Promise<UIElement> {
  return sculpt.ui.fromRef({ targetId });
}
