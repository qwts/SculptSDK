/**
 * @experimental Semantic Resolution Layer (m0 foundations). Not wired into
 * `Sculpt.attach` yet — see #14. This is the vendor-neutral `DecisionProvider`
 * port (ADR-0001): the runtime owns every identifier that admits a decision,
 * and every answer is validated (see `./validate.js`) before it can affect
 * control flow.
 */

/** A decision point identifier, e.g. "DP-1" for a production policy, or a
 * story-specific id for a non-production consumer (the #17 synthetic
 * policy consumer). Left open on purpose: m0 defines no production policy. */
export type DecisionPoint = string;

export type QuestionId = string;

/** Choice over named options. Every choice question includes "none" among
 * its options so abstention is always representable (§2's architecture doc). */
export interface ChoiceQuestion {
  kind: "choice";
  id: QuestionId;
  /** Candidate option IDs, always including "none". */
  options: readonly string[];
}

/** Ordinal score in [min, max]. */
export interface ScoreQuestion {
  kind: "score";
  id: QuestionId;
  min: number;
  max: number;
}

/** Binary probability (TypeSafe's "Noul" primitive has no confidence field). */
export interface ProbabilityQuestion {
  kind: "probability";
  id: QuestionId;
}

export type SemanticQuestion = ChoiceQuestion | ScoreQuestion | ProbabilityQuestion;

export interface ChoiceAnswer {
  kind: "choice";
  questionId: QuestionId;
  /** Must be one of the question's declared options. */
  selected: string;
  /** Full probability distribution over the question's options, if the
   * provider returns one. Every key must belong to the question's options. */
  distribution?: Readonly<Record<string, number>>;
  /** Raw provider-reported statistic — NOT a calibrated probability of
   * correctness (ADR-0005). Undefined when the provider doesn't report one. */
  providerConfidence?: number;
}

export interface ScoreAnswer {
  kind: "score";
  questionId: QuestionId;
  value: number;
  providerConfidence?: number;
}

/** Binary (Noul) answer: the value *is* the probability; no separate
 * confidence field exists for this primitive per TypeSafe's docs. */
export interface ProbabilityAnswer {
  kind: "probability";
  questionId: QuestionId;
  value: number;
}

export type SemanticAnswer = ChoiceAnswer | ScoreAnswer | ProbabilityAnswer;

/**
 * Evidence envelope the runtime alone populates (ADR-0001, ADR-0008). A
 * provider never invents or overrides any of these fields; where a provider
 * response carries its own identifiers, they are ignored or cause rejection
 * (see validate.ts), never trusted as evidence.
 */
export interface DecisionEvidence {
  requestId: string;
  operationId: string;
  point: DecisionPoint;
  model: string;
  /** Version of the question/schema shape sent. */
  questionVersion: string;
  /** Version of the policy (and, once one exists, calibration) that built this request. */
  policyVersion: string;
  origin: string;
  frameId: string;
  navigationEpoch: number;
  /** Revision of the specific target this decision concerns, where relevant (e.g. DP-1/DP-6). */
  targetRevision?: string;
  /** Digest of the candidate set the questions were built from. */
  candidateSetDigest: string;
  /** Digest of the redacted state sent alongside the questions. */
  redactedStateDigest: string;
  /** Absolute deadline (epoch ms) for the whole request. */
  deadline: number;
  signal: AbortSignal;
}

/** A group of question IDs whose answers must all be valid together (ADR-0001):
 * if any member is invalid or missing, every member in the group abstains. */
export type CoupledGroup = readonly QuestionId[];

export interface DecisionRequest {
  evidence: DecisionEvidence;
  questions: readonly SemanticQuestion[];
  coupledGroups?: readonly CoupledGroup[];
}

/** What a provider actually returns, before validation. Untrusted input. */
export interface RawDecisionResponse {
  answers: readonly SemanticAnswer[];
  /** Provider-reported request identifier, if any. Never used as evidence — see validate.ts. */
  providerRequestId?: string;
}

/** Vendor-neutral decision provider port (ADR-0001). */
export interface DecisionProvider {
  readonly id: string;
  /** Must be checked, and must return false for any (model, calibrationVersion)
   * the provider cannot serve, before `decide` is ever called for it. */
  supports(model: string, calibrationVersion: string): boolean;
  decide(request: DecisionRequest): Promise<RawDecisionResponse>;
}

/**
 * How a provider (or the runtime wrapping one) reports that no answer is
 * coming: a transport error, an already-aborted signal, a deadline already
 * passed, or — for `NullProvider`/`RecordedProvider` — simply that this
 * provider never answers that request. Always carries a machine-readable
 * `reasonCode`; a provider must never throw an untyped error instead.
 */
export class ProviderUnavailableError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message?: string) {
    super(message ?? reasonCode);
    this.name = "ProviderUnavailableError";
    this.reasonCode = reasonCode;
  }
}

export interface ModelSupportCheck {
  supported: boolean;
  reason?: { code: "unsupported_model_or_calibration"; detail: string };
}

/** Reject an unsupported model/calibration combination before any provider call. */
export function checkModelSupport(
  provider: DecisionProvider,
  model: string,
  calibrationVersion: string
): ModelSupportCheck {
  if (provider.supports(model, calibrationVersion)) return { supported: true };
  return {
    supported: false,
    reason: {
      code: "unsupported_model_or_calibration",
      detail: `provider "${provider.id}" does not support model "${model}" at calibration version "${calibrationVersion}"`
    }
  };
}
