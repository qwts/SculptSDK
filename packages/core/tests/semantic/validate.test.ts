import { describe, expect, it } from "vitest";
import {
  checkModelSupport,
  DISTRIBUTION_SUM_TOLERANCE,
  validateDecisionResponse,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type DecisionEvidence,
  type DecisionProvider,
  type DecisionRequest,
  type ProbabilityAnswer,
  type ProbabilityQuestion,
  type RawDecisionResponse,
  type ScoreAnswer,
  type ScoreQuestion,
  type SemanticAnswer
} from "@sculptsdk/core";

function evidence(overrides: Partial<DecisionEvidence> = {}): DecisionEvidence {
  return {
    requestId: "req-1",
    operationId: "op-1",
    point: "test-point",
    model: "jev-1.13",
    questionVersion: "v1",
    policyVersion: "v1",
    origin: "http://fixtures.local",
    frameId: "main",
    navigationEpoch: 1,
    candidateSetDigest: "digest-candidates",
    redactedStateDigest: "digest-state",
    deadline: Date.now() + 1000,
    signal: new AbortController().signal,
    ...overrides
  };
}

const CHOICE_QUESTION: ChoiceQuestion = { kind: "choice", id: "q-target", options: ["a", "b", "none"] };
const SCORE_QUESTION: ScoreQuestion = { kind: "score", id: "q-risk", min: 0, max: 1 };
const PROBABILITY_QUESTION: ProbabilityQuestion = { kind: "probability", id: "q-irreversible" };

function requestOf(...questions: DecisionRequest["questions"]): DecisionRequest {
  return { evidence: evidence(), questions };
}

function responseOf(...answers: SemanticAnswer[]): RawDecisionResponse {
  return { answers };
}

describe("validateDecisionResponse — choice", () => {
  it("accepts a valid, in-set selection", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = { kind: "choice", questionId: "q-target", selected: "a", providerConfidence: 0.9 };
    const result = validateDecisionResponse(request, responseOf(answer));

    expect(result.outcomes).toEqual([
      {
        questionId: "q-target",
        status: "accepted",
        reason: { code: "ok" },
        accepted: { answer, providerConfidence: 0.9, selectedOptionProbability: undefined }
      }
    ]);
    expect(result.unrecognizedAnswers).toEqual([]);
  });

  it("treats a valid 'none' selection as abstained, not a failure", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = { kind: "choice", questionId: "q-target", selected: "none" };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("abstained");
    expect(outcome.reason.code).toBe("provider_abstained");
    expect(outcome.accepted).toBeUndefined();
  });

  it("rejects a foreign candidate ID as invalid", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = { kind: "choice", questionId: "q-target", selected: "not-a-real-option" };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("foreign_candidate");
    expect(outcome.accepted).toBeUndefined();
  });

  it("rejects an unexpected option inside the distribution", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = {
      kind: "choice",
      questionId: "q-target",
      selected: "a",
      distribution: { a: 0.5, b: 0.3, "not-an-option": 0.2 }
    };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("unexpected_option");
  });

  it("rejects a NaN distribution value", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = {
      kind: "choice",
      questionId: "q-target",
      selected: "a",
      distribution: { a: Number.NaN, b: 0.5, none: 0.5 }
    };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("value_out_of_range");
  });

  it("rejects a negative distribution value", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = {
      kind: "choice",
      questionId: "q-target",
      selected: "a",
      distribution: { a: 1.5, b: -0.5, none: 0 }
    };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("value_out_of_range");
  });

  it("rejects a distribution that falls outside the normalization tolerance", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = {
      kind: "choice",
      questionId: "q-target",
      selected: "a",
      distribution: { a: 0.5, b: 0.5, none: 0.5 } // sums to 1.5
    };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("distribution_not_normalized");
  });

  it("accepts a distribution within the documented tolerance without renormalizing it", () => {
    const request = requestOf(CHOICE_QUESTION);
    const withinTolerance = 1 + DISTRIBUTION_SUM_TOLERANCE / 2;
    const answer: ChoiceAnswer = {
      kind: "choice",
      questionId: "q-target",
      selected: "a",
      distribution: { a: withinTolerance, b: 0, none: 0 }
    };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("accepted");
    // Not renormalized: the raw distribution value comes back untouched.
    expect(outcome.accepted?.selectedOptionProbability).toBe(withinTolerance);
  });

  it("reports a missing required answer as invalid", () => {
    const request = requestOf(CHOICE_QUESTION);
    const [outcome] = validateDecisionResponse(request, responseOf()).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("missing_required_answer");
  });

  it("reports a duplicate question ID as invalid and does not pick either answer", () => {
    const request = requestOf(CHOICE_QUESTION);
    const first: ChoiceAnswer = { kind: "choice", questionId: "q-target", selected: "a" };
    const second: ChoiceAnswer = { kind: "choice", questionId: "q-target", selected: "b" };
    const [outcome] = validateDecisionResponse(request, responseOf(first, second)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("duplicate_question_id");
    expect(outcome.accepted).toBeUndefined();
  });

  it("keeps an answer for an unrequested question ID out of control flow, but records it", () => {
    const request = requestOf(CHOICE_QUESTION);
    const foreign: ChoiceAnswer = { kind: "choice", questionId: "q-never-asked", selected: "a" };
    const real: ChoiceAnswer = { kind: "choice", questionId: "q-target", selected: "a" };
    const result = validateDecisionResponse(request, responseOf(foreign, real));

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].questionId).toBe("q-target");
    expect(result.unrecognizedAnswers).toEqual([{ questionId: "q-never-asked" }]);
  });

  it("rejects an out-of-range providerConfidence", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = { kind: "choice", questionId: "q-target", selected: "a", providerConfidence: 1.5 };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("value_out_of_range");
  });
});

describe("validateDecisionResponse — score", () => {
  it("accepts a value within [min, max]", () => {
    const request = requestOf(SCORE_QUESTION);
    const answer: ScoreAnswer = { kind: "score", questionId: "q-risk", value: 0.4 };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("accepted");
    expect(outcome.accepted?.answer).toEqual(answer);
  });

  it("rejects a value outside the range", () => {
    const request = requestOf(SCORE_QUESTION);
    const answer: ScoreAnswer = { kind: "score", questionId: "q-risk", value: 1.2 };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("value_out_of_range");
  });

  it("rejects a NaN value", () => {
    const request = requestOf(SCORE_QUESTION);
    const answer: ScoreAnswer = { kind: "score", questionId: "q-risk", value: Number.NaN };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("value_out_of_range");
  });
});

describe("validateDecisionResponse — probability", () => {
  it("accepts a value in [0, 1]", () => {
    const request = requestOf(PROBABILITY_QUESTION);
    const answer: ProbabilityAnswer = { kind: "probability", questionId: "q-irreversible", value: 0.7 };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("accepted");
  });

  it("rejects a negative value", () => {
    const request = requestOf(PROBABILITY_QUESTION);
    const answer: ProbabilityAnswer = { kind: "probability", questionId: "q-irreversible", value: -0.1 };
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("invalid");
    expect(outcome.reason.code).toBe("value_out_of_range");
  });

  it("ignores a stray providerConfidence field the provider is not supposed to send for a binary answer", () => {
    const request = requestOf(PROBABILITY_QUESTION);
    // Simulates an untrusted provider bolting on a field the type doesn't declare.
    const answer = {
      kind: "probability",
      questionId: "q-irreversible",
      value: 0.5,
      providerConfidence: 999
    } as unknown as ProbabilityAnswer;
    const [outcome] = validateDecisionResponse(request, responseOf(answer)).outcomes;

    expect(outcome.status).toBe("accepted");
  });
});

describe("validateDecisionResponse — coupled groups", () => {
  const keyA: ChoiceQuestion = { kind: "choice", id: "key-a", options: ["field-1", "field-2", "none"] };
  const keyB: ChoiceQuestion = { kind: "choice", id: "key-b", options: ["field-1", "field-2", "none"] };

  it("lets an independent advisory answer survive a partial batch", () => {
    const request: DecisionRequest = { evidence: evidence(), questions: [keyA, SCORE_QUESTION] };
    const goodChoice: ChoiceAnswer = { kind: "choice", questionId: "key-a", selected: "field-1" };
    // SCORE_QUESTION gets no answer at all — that question is independently invalid,
    // but it must not drag keyA down since they're not in a coupled group.
    const result = validateDecisionResponse(request, responseOf(goodChoice));

    const choiceOutcome = result.outcomes.find((o) => o.questionId === "key-a");
    const scoreOutcome = result.outcomes.find((o) => o.questionId === SCORE_QUESTION.id);
    expect(choiceOutcome?.status).toBe("accepted");
    expect(scoreOutcome?.status).toBe("invalid");
  });

  it("abstains the whole coupled group together when one member is invalid", () => {
    const request: DecisionRequest = {
      evidence: evidence(),
      questions: [keyA, keyB],
      coupledGroups: [["key-a", "key-b"]]
    };
    const validAnswer: ChoiceAnswer = { kind: "choice", questionId: "key-a", selected: "field-1" };
    const invalidAnswer: ChoiceAnswer = { kind: "choice", questionId: "key-b", selected: "not-a-field" };
    const result = validateDecisionResponse(request, responseOf(validAnswer, invalidAnswer));

    const a = result.outcomes.find((o) => o.questionId === "key-a")!;
    const b = result.outcomes.find((o) => o.questionId === "key-b")!;
    expect(a.status).toBe("abstained");
    expect(a.reason.code).toBe("coupled_group_incomplete");
    expect(a.accepted).toBeUndefined();
    // The malformed member keeps its own specific reason, not the group reason.
    expect(b.status).toBe("invalid");
    expect(b.reason.code).toBe("foreign_candidate");
  });

  it("accepts a complete, fully valid coupled group", () => {
    const request: DecisionRequest = {
      evidence: evidence(),
      questions: [keyA, keyB],
      coupledGroups: [["key-a", "key-b"]]
    };
    const a: ChoiceAnswer = { kind: "choice", questionId: "key-a", selected: "field-1" };
    const b: ChoiceAnswer = { kind: "choice", questionId: "key-b", selected: "field-2" };
    const result = validateDecisionResponse(request, responseOf(a, b));

    expect(result.outcomes.every((o) => o.status === "accepted")).toBe(true);
  });
});

describe("validateDecisionResponse — provider-supplied identifiers are ignored, never trusted as evidence", () => {
  it("a bogus providerRequestId does not affect validation or appear in any outcome", () => {
    const request = requestOf(CHOICE_QUESTION);
    const answer: ChoiceAnswer = { kind: "choice", questionId: "q-target", selected: "a" };
    const raw: RawDecisionResponse = { answers: [answer], providerRequestId: "provider-invented-id-12345" };

    const result = validateDecisionResponse(request, raw);

    expect(result.outcomes).toEqual([
      {
        questionId: "q-target",
        status: "accepted",
        reason: { code: "ok" },
        accepted: { answer, providerConfidence: undefined, selectedOptionProbability: undefined }
      }
    ]);
    // The evidence the request carried is untouched by anything the provider sent back.
    expect(request.evidence.requestId).toBe("req-1");
  });
});

describe("checkModelSupport", () => {
  function stubProvider(supports: boolean): DecisionProvider {
    return {
      id: "stub",
      supports: () => supports,
      decide: () => Promise.reject(new Error("should not be called"))
    };
  }

  it("returns supported: true without calling decide when the model/calibration is supported", () => {
    const result = checkModelSupport(stubProvider(true), "jev-1.13", "cal-1");
    expect(result).toEqual({ supported: true });
  });

  it("rejects an unsupported model/calibration combination with a typed reason, before any call", () => {
    const result = checkModelSupport(stubProvider(false), "unknown-model", "cal-1");
    expect(result.supported).toBe(false);
    expect(result.reason?.code).toBe("unsupported_model_or_calibration");
  });
});
