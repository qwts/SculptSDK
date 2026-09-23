/**
 * @experimental Runtime validation of provider answers (ADR-0001, I4).
 * TypeScript types are not enough at a process boundary: every answer is
 * checked here before it can become a domain decision. Nothing here ever
 * silently repairs a malformed response (e.g. renormalizing a distribution) —
 * it is rejected instead, with a machine-readable reason.
 */
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  CoupledGroup,
  DecisionRequest,
  ProbabilityAnswer,
  ProbabilityQuestion,
  QuestionId,
  RawDecisionResponse,
  ScoreAnswer,
  ScoreQuestion,
  SemanticAnswer
} from "./provider.js";

/** Absolute tolerance for a choice distribution's sum against 1.0. Documented,
 * not silently widened: a distribution outside this band is rejected, never
 * renormalized. */
export const DISTRIBUTION_SUM_TOLERANCE = 1e-3;

/**
 * `validateDecisionResponse` only ever produces "accepted" | "abstained" |
 * "invalid" for a question outcome. "unavailable" (transport failure/timeout)
 * and "stale" (freshness check, #15) are applied by the caller wrapping this
 * validator — they describe failures that happen before or after validation,
 * not a validation verdict itself. The type is shared so every layer uses the
 * same closed vocabulary.
 */
export type DecisionOutcomeStatus = "accepted" | "abstained" | "unavailable" | "invalid" | "stale";

export interface OutcomeReason {
  code: string;
  detail?: string;
}

export interface AcceptedAnswer {
  answer: SemanticAnswer;
  /** Raw provider statistic (choice/score only) — not calibrated (ADR-0005). */
  providerConfidence?: number;
  /** Probability mass on the selected option (choice only), read off the distribution. */
  selectedOptionProbability?: number;
  /** Empirically calibrated probability of correctness. Absent until a
   * calibration artifact exists for this model/policy/question version. */
  calibratedEstimate?: number;
}

export interface QuestionOutcome {
  questionId: QuestionId;
  status: DecisionOutcomeStatus;
  reason: OutcomeReason;
  /** Present only when status === "accepted". */
  accepted?: AcceptedAnswer;
}

export interface DecisionValidationResult {
  /** One outcome per requested question, in request order. */
  outcomes: QuestionOutcome[];
  /** Answers the provider sent for a question ID that was not part of the
   * request. Never used for control flow — kept only for audit and tests. */
  unrecognizedAnswers: readonly { questionId: string }[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalid(questionId: QuestionId, code: string, detail?: string): QuestionOutcome {
  return { questionId, status: "invalid", reason: detail ? { code, detail } : { code } };
}

function validateProviderConfidence(questionId: QuestionId, value: number | undefined): QuestionOutcome | null {
  if (value === undefined) return null;
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    return invalid(questionId, "value_out_of_range", `providerConfidence = ${value}`);
  }
  return null;
}

function validateChoice(question: ChoiceQuestion, answer: ChoiceAnswer | undefined): QuestionOutcome {
  if (!answer) return invalid(question.id, "missing_required_answer");
  if (answer.kind !== "choice") {
    return invalid(question.id, "answer_kind_mismatch", `expected "choice", got "${answer.kind}"`);
  }

  const optionSet = new Set(question.options);
  if (!optionSet.has(answer.selected)) {
    return invalid(question.id, "foreign_candidate", `"${answer.selected}" is not among the question's options`);
  }

  if (answer.distribution) {
    for (const [option, value] of Object.entries(answer.distribution)) {
      if (!optionSet.has(option)) {
        return invalid(question.id, "unexpected_option", `distribution key "${option}" is not among the question's options`);
      }
      if (!isFiniteNumber(value) || value < 0) {
        return invalid(question.id, "value_out_of_range", `distribution["${option}"] = ${value}`);
      }
    }
    const sum = Object.values(answer.distribution).reduce((total, v) => total + v, 0);
    if (Math.abs(sum - 1) > DISTRIBUTION_SUM_TOLERANCE) {
      return invalid(
        question.id,
        "distribution_not_normalized",
        `distribution sums to ${sum}, expected 1 ± ${DISTRIBUTION_SUM_TOLERANCE}`
      );
    }
  }

  const confidenceError = validateProviderConfidence(question.id, answer.providerConfidence);
  if (confidenceError) return confidenceError;

  if (answer.selected === "none") {
    return { questionId: question.id, status: "abstained", reason: { code: "provider_abstained" } };
  }

  return {
    questionId: question.id,
    status: "accepted",
    reason: { code: "ok" },
    accepted: {
      answer,
      providerConfidence: answer.providerConfidence,
      selectedOptionProbability: answer.distribution?.[answer.selected]
    }
  };
}

function validateScore(question: ScoreQuestion, answer: ScoreAnswer | undefined): QuestionOutcome {
  if (!answer) return invalid(question.id, "missing_required_answer");
  if (answer.kind !== "score") {
    return invalid(question.id, "answer_kind_mismatch", `expected "score", got "${answer.kind}"`);
  }
  if (!isFiniteNumber(answer.value) || answer.value < question.min || answer.value > question.max) {
    return invalid(question.id, "value_out_of_range", `value ${answer.value} outside [${question.min}, ${question.max}]`);
  }
  const confidenceError = validateProviderConfidence(question.id, answer.providerConfidence);
  if (confidenceError) return confidenceError;

  return {
    questionId: question.id,
    status: "accepted",
    reason: { code: "ok" },
    accepted: { answer, providerConfidence: answer.providerConfidence }
  };
}

function validateProbability(question: ProbabilityQuestion, answer: ProbabilityAnswer | undefined): QuestionOutcome {
  if (!answer) return invalid(question.id, "missing_required_answer");
  if (answer.kind !== "probability") {
    return invalid(question.id, "answer_kind_mismatch", `expected "probability", got "${answer.kind}"`);
  }
  if (!isFiniteNumber(answer.value) || answer.value < 0 || answer.value > 1) {
    return invalid(question.id, "value_out_of_range", `value ${answer.value} outside [0, 1]`);
  }
  return { questionId: question.id, status: "accepted", reason: { code: "ok" }, accepted: { answer } };
}

/** Downgrades an otherwise-valid member of an incomplete coupled group to
 * "abstained" together, per ADR-0001. A member that was already "invalid"
 * keeps its specific rejection reason. */
function applyCoupledGroups(outcomes: QuestionOutcome[], groups: readonly CoupledGroup[]): void {
  const byId = new Map(outcomes.map((outcome) => [outcome.questionId, outcome] as const));
  for (const group of groups) {
    const members = group.map((id) => byId.get(id)).filter((o): o is QuestionOutcome => o !== undefined);
    const complete = members.length === group.length && members.every((o) => o.status !== "invalid");
    if (complete) continue;
    for (const member of members) {
      if (member.status === "invalid") continue;
      member.status = "abstained";
      member.reason = {
        code: "coupled_group_incomplete",
        detail: `question "${member.questionId}" is part of a coupled group that did not fully validate`
      };
      member.accepted = undefined;
    }
  }
}

/**
 * Validates a raw provider response against the request that produced it.
 * Never throws: every rejection is reported as a per-question outcome.
 */
export function validateDecisionResponse(
  request: DecisionRequest,
  raw: RawDecisionResponse
): DecisionValidationResult {
  const byQuestion = new Map<QuestionId, SemanticAnswer[]>();
  for (const answer of raw.answers) {
    const existing = byQuestion.get(answer.questionId);
    if (existing) existing.push(answer);
    else byQuestion.set(answer.questionId, [answer]);
  }

  const requestedIds = new Set(request.questions.map((q) => q.id));
  const unrecognizedAnswers = [...byQuestion.keys()]
    .filter((id) => !requestedIds.has(id))
    .map((questionId) => ({ questionId }));

  const outcomes: QuestionOutcome[] = request.questions.map((question): QuestionOutcome => {
    const answers = byQuestion.get(question.id);
    if (answers && answers.length > 1) {
      return invalid(question.id, "duplicate_question_id", `${answers.length} answers for question "${question.id}"`);
    }
    const answer = answers?.[0];
    switch (question.kind) {
      case "choice":
        return validateChoice(question, answer as ChoiceAnswer | undefined);
      case "score":
        return validateScore(question, answer as ScoreAnswer | undefined);
      case "probability":
        return validateProbability(question, answer as ProbabilityAnswer | undefined);
    }
  });

  applyCoupledGroups(outcomes, request.coupledGroups ?? []);

  return { outcomes, unrecognizedAnswers };
}
