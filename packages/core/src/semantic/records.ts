/**
 * @experimental Decision records (ADR-0001). Every provider call produces one
 * of these for audit: which point, which provider/model/versions, what was
 * asked and answered, and which single named metric a threshold gated (I7 —
 * never an ambiguous "confidence").
 */
import type { DecisionPoint } from "./provider.js";
import type { DecisionOutcomeStatus, QuestionOutcome } from "./validate.js";

/** The one metric a threshold names when it gates a decision (ADR-0005). A
 * record never exposes a single ambiguous "confidence" for provider values —
 * whichever of these actually gated the outcome is named explicitly. */
export type GatedMetric =
  | "heuristicConfidence"
  | "providerConfidence"
  | "selectedOptionProbability"
  | "calibratedEstimate";

export interface SanitizedError {
  code: string;
  /** Must never contain raw page content, form values, or other redacted
   * state — see #16's redaction checks, which test records as a sink. */
  message: string;
}

export interface SemanticDecisionRecord {
  point: DecisionPoint;
  provider: string;
  model: string;
  questionVersion: string;
  policyVersion: string;
  candidateSetDigest: string;
  redactedStateDigest: string;
  /** Per-question outcomes for the request this record covers. */
  outcomes: readonly QuestionOutcome[];
  /** Overall status for the request (distinct from each question's own outcome:
   * e.g. the whole call can be "unavailable" on a transport failure even
   * though no per-question outcome was ever computed). */
  status: DecisionOutcomeStatus;
  /** The metric a threshold gated to reach `status`, when one applied. */
  gatedMetric?: GatedMetric;
  threshold?: number;
  latencyMs: number;
  error?: SanitizedError;
}
