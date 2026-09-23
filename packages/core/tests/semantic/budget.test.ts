import { describe, expect, it } from "vitest";
import {
  OperationBudget,
  SemanticRuntime,
  type ChoiceQuestion,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse,
  type SemanticPointConfig
} from "@sculptsdk/core";

const QUESTION: ChoiceQuestion = { kind: "choice", id: "q1", options: ["yes", "no", "none"] };

function requestOf(overrides: Partial<DecisionRequest["evidence"]> = {}, questions = [QUESTION]): DecisionRequest {
  return {
    evidence: {
      requestId: "r1",
      operationId: "o1",
      point: "synthetic-budget-point",
      model: "test-model",
      questionVersion: "v1",
      policyVersion: "v1",
      origin: "http://fixtures.local",
      frameId: "main",
      navigationEpoch: 0,
      candidateSetDigest: "cd",
      redactedStateDigest: "sd",
      deadline: Date.now() + 5000,
      signal: new AbortController().signal,
      ...overrides
    },
    questions
  };
}

describe("OperationBudget", () => {
  it("admits requests within every limit and reserves capacity", () => {
    const budget = new OperationBudget({ maxRequests: 2, maxConcurrency: 2 });
    expect(budget.admit(requestOf())).toBeNull();
    expect(budget.admit(requestOf())).toBeNull();
  });

  it("rejects once maxRequests is reached", () => {
    const budget = new OperationBudget({ maxRequests: 1 });
    expect(budget.admit(requestOf())).toBeNull();
    const rejection = budget.admit(requestOf());
    expect(rejection?.code).toBe("budget_exhausted");
  });

  it("rejects once the deadline has already passed", () => {
    const budget = new OperationBudget({ maxOperationMs: 1 }, Date.now() - 1000);
    const rejection = budget.admit(requestOf());
    expect(rejection?.code).toBe("budget_exhausted");
  });

  it("rejects once maxConcurrency is reached, and admits again after release()", () => {
    const budget = new OperationBudget({ maxRequests: 5, maxConcurrency: 1 });
    expect(budget.admit(requestOf())).toBeNull(); // 1 active
    const rejection = budget.admit(requestOf());
    expect(rejection?.code).toBe("budget_exhausted");

    budget.release();
    expect(budget.admit(requestOf())).toBeNull(); // slot freed, admits again
  });

  it("rejects an oversized request (too many questions) without reserving capacity", () => {
    const budget = new OperationBudget({ maxRequests: 5, maxQuestionsPerRequest: 1 });
    const tooManyQuestions = requestOf({}, [QUESTION, { ...QUESTION, id: "q2" }]);
    const rejection = budget.admit(tooManyQuestions);
    expect(rejection?.code).toBe("budget_exhausted");
    // Nothing was reserved: a normal-sized request still admits.
    expect(budget.admit(requestOf())).toBeNull();
  });

  it("rejects a question with too many options without reserving capacity", () => {
    const budget = new OperationBudget({ maxOptionsPerQuestion: 2 });
    const tooManyOptions = requestOf({}, [{ kind: "choice", id: "q1", options: ["a", "b", "c", "none"] }]);
    expect(budget.admit(tooManyOptions)?.code).toBe("budget_exhausted");
  });

  it("the default budget admits a full-width #2 candidate cap (32 candidates) plus the implicit 'none' option", () => {
    // Regression (#24): DP1_RECALL_CAP is a candidate count (#2's 32-candidate
    // cap); every choice question also carries an implicit "none" option
    // (ADR-0001), making 33 options total. The default must have room for
    // both, or a full-width recall request is silently budget-rejected
    // before it ever reaches the provider.
    const budget = new OperationBudget();
    const options = [...Array.from({ length: 32 }, (_, i) => `t${i}`), "none"];
    const fullWidth = requestOf({}, [{ kind: "choice", id: "target", options }]);
    expect(budget.admit(fullWidth)).toBeNull();
  });
});

class StubProvider implements DecisionProvider {
  readonly id = "stub";
  constructor(private readonly impl: (request: DecisionRequest) => Promise<RawDecisionResponse>) {}
  supports(): boolean {
    return true;
  }
  decide(request: DecisionRequest): Promise<RawDecisionResponse> {
    return this.impl(request);
  }
}

function acceptedAnswer(): RawDecisionResponse {
  return { answers: [{ kind: "choice", questionId: "q1", selected: "yes" }] };
}

function pointConfig(
  overrides: Partial<SemanticPointConfig<string, string>> & { degradation: "recovery_or_advisory" | "required" }
): SemanticPointConfig<string, string> {
  return {
    point: "synthetic-budget-point",
    fallback: () => "fallback-value",
    buildRequest: () => requestOf(),
    select: (outcomes) => {
      const accepted = outcomes.find((o) => o.status === "accepted");
      return accepted?.accepted?.answer.kind === "choice" ? accepted.accepted.answer.selected : undefined;
    },
    ...overrides
  };
}

describe("SemanticRuntime — shared operation budget", () => {
  it("a nested synthetic operation (inner call from within an outer provider) never exceeds the shared budget", async () => {
    const provider = new StubProvider(async () => acceptedAnswer());
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });
    const budget = runtime.createOperationBudget({ maxRequests: 2, maxConcurrency: 2 });

    let innerResult: Awaited<ReturnType<SemanticRuntime["evaluate"]>> | undefined;
    const outerProvider = new StubProvider(async () => {
      // The outer call's own provider triggers a nested inner call sharing
      // the same operation budget — exactly the DP-1-inside-an-action shape.
      innerResult = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }), { budget });
      return acceptedAnswer();
    });
    const outerRuntime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider: outerProvider });

    const outerResult = await outerRuntime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }), { budget });

    expect(outerResult).toEqual({ kind: "accepted", value: "yes" });
    expect(innerResult).toEqual({ kind: "accepted", value: "yes" });

    // The budget is now exhausted (2/2 requests): a third call sharing it must fall back.
    const third = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }), { budget });
    expect(third).toEqual({
      kind: "degraded",
      fallback: "fallback-value",
      reason: { code: "budget_exhausted", detail: "max 2 provider request(s) per operation reached" }
    });
  });

  it("a required check gets its reserved capacity while optional enrichment, queued behind it, is dropped first", async () => {
    const provider = new StubProvider(async () => acceptedAnswer());
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });
    const budget = runtime.createOperationBudget({ maxRequests: 1 });

    // Required check claims capacity first.
    const required = await runtime.evaluate(pointConfig({ degradation: "required" }), { budget });
    expect(required).toEqual({ kind: "accepted", value: "yes" });

    // Optional enrichment, queued behind it, finds the budget already spent.
    const optional = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }), { budget });
    expect(optional).toEqual({
      kind: "degraded",
      fallback: "fallback-value",
      reason: { code: "budget_exhausted", detail: "max 1 provider request(s) per operation reached" }
    });
  });

  it("budget_exhausted on a required point leaves the condition unsatisfied, never approved", async () => {
    const provider = new StubProvider(async () => acceptedAnswer());
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });
    const budget = runtime.createOperationBudget({ maxRequests: 1 });

    await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }), { budget }); // spends the only slot
    const result = await runtime.evaluate(pointConfig({ degradation: "required" }), { budget });

    expect(result).toEqual({ kind: "unsatisfied", reason: { code: "budget_exhausted", detail: "max 1 provider request(s) per operation reached" } });
  });

  it("without an explicit shared budget, each evaluate() call gets its own one-shot budget", async () => {
    const provider = new StubProvider(async () => acceptedAnswer());
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });

    const first = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }));
    const second = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }));

    expect(first).toEqual({ kind: "accepted", value: "yes" });
    expect(second).toEqual({ kind: "accepted", value: "yes" });
  });
});
