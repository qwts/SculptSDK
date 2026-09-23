import { describe, expect, it, vi } from "vitest";
import {
  NullProvider,
  ProviderUnavailableError,
  SemanticRuntime,
  type ChoiceQuestion,
  type DecisionEvidence,
  type DecisionPoint,
  type DecisionProvider,
  type DecisionRequest,
  type QuestionOutcome,
  type RawDecisionResponse,
  type SemanticPointConfig
} from "@sculptsdk/core";

function evidence(overrides: Partial<DecisionEvidence> = {}): DecisionEvidence {
  return {
    requestId: "r1",
    operationId: "o1",
    point: "synthetic-point",
    model: "test-model",
    questionVersion: "v1",
    policyVersion: "v1",
    origin: "http://fixtures.local",
    frameId: "main",
    navigationEpoch: 1,
    candidateSetDigest: "cd",
    redactedStateDigest: "sd",
    deadline: Date.now() + 1000,
    signal: new AbortController().signal,
    ...overrides
  };
}

const QUESTION: ChoiceQuestion = { kind: "choice", id: "q1", options: ["yes", "no", "none"] };

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

function pointConfig<TAccepted = string>(
  overrides: Partial<SemanticPointConfig<string, TAccepted>> & { degradation: "recovery_or_advisory" | "required" }
): SemanticPointConfig<string, TAccepted> {
  return {
    point: "synthetic-point" as DecisionPoint,
    fallback: () => "fallback-value",
    buildRequest: () => ({ evidence: evidence(), questions: [QUESTION] }),
    select: ((outcomes: QuestionOutcome[]) => {
      const accepted = outcomes.find((o) => o.status === "accepted");
      return accepted?.accepted?.answer as unknown as TAccepted | undefined;
    }) as SemanticPointConfig<string, TAccepted>["select"],
    ...overrides
  };
}

describe("SemanticRuntime — disabled", () => {
  it("returns the fallback without building a request or touching the provider", async () => {
    const buildRequest = vi.fn(() => ({ evidence: evidence(), questions: [QUESTION] }) as DecisionRequest);
    const decide = vi.fn(async () => ({ answers: [] }) as RawDecisionResponse);
    const provider = new StubProvider(decide);
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "disabled" }, provider });

    const result = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory", buildRequest }));

    expect(result).toEqual({ kind: "disabled", fallback: "fallback-value" });
    expect(buildRequest).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("swaps a passed provider for NullProvider and never references the original", () => {
    const provider = new StubProvider(async () => ({ answers: [] }));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "disabled" }, provider });

    expect(runtime.enabled).toBe(false);
    expect(runtime.provider).toBeInstanceOf(NullProvider);
    expect(runtime.provider).not.toBe(provider);
  });
});

describe("SemanticRuntime — enabled, provider configuration", () => {
  it("uses the passed provider when enabled", () => {
    const provider = new StubProvider(async () => ({ answers: [] }));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });
    expect(runtime.provider).toBe(provider);
  });

  it("defaults to NullProvider when enabled but no provider was passed", () => {
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" } });
    expect(runtime.provider).toBeInstanceOf(NullProvider);
  });
});

describe("SemanticRuntime — degradation classes (ADR-0003/ADR-0006)", () => {
  it("a synthetic recovery-or-advisory point returns its deterministic fallback plus a typed reason when unavailable", async () => {
    const provider = new StubProvider(async () => {
      throw new ProviderUnavailableError("no_calibration", "no thresholds file for this model");
    });
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });

    const result = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }));

    expect(result).toEqual({
      kind: "degraded",
      fallback: "fallback-value",
      reason: { code: "no_calibration", detail: "no thresholds file for this model" }
    });
  });

  it("a synthetic required point stays unsatisfied when unavailable — missing evidence never counts as approval", async () => {
    const provider = new StubProvider(async () => {
      throw new ProviderUnavailableError("no_calibration", "no thresholds file for this model");
    });
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });

    const result = await runtime.evaluate(pointConfig({ degradation: "required" }));

    expect(result).toEqual({ kind: "unsatisfied", reason: { code: "no_calibration", detail: "no thresholds file for this model" } });
    expect(result).not.toHaveProperty("fallback");
    expect(result).not.toHaveProperty("value");
  });

  const unavailableReasons: Array<{ label: string; reasonCode: string }> = [
    { label: "missing calibration", reasonCode: "no_calibration" },
    { label: "timeout", reasonCode: "timeout" },
    // "stale" stands in for #15's real freshness check, which will report
    // through this exact same reason-code path once it exists.
    { label: "stale evidence", reasonCode: "stale" }
  ];

  for (const { label, reasonCode } of unavailableReasons) {
    it(`${label} maps to the declared fallback, never to approval`, async () => {
      const provider = new StubProvider(async () => {
        throw new ProviderUnavailableError(reasonCode);
      });
      const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });

      const advisory = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }));
      expect(advisory).toMatchObject({ kind: "degraded", fallback: "fallback-value", reason: { code: reasonCode } });

      const required = await runtime.evaluate(pointConfig({ degradation: "required" }));
      expect(required).toMatchObject({ kind: "unsatisfied", reason: { code: reasonCode } });
    });
  }

  it("an invalid answer (fails runtime validation) maps to the declared fallback, never to approval", async () => {
    const provider = new StubProvider(async () => ({
      answers: [{ kind: "choice", questionId: "q1", selected: "not-a-real-option" }]
    }));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });

    const advisory = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }));
    expect(advisory).toEqual({ kind: "degraded", fallback: "fallback-value", reason: { code: "invalid_answer" } });

    const required = await runtime.evaluate(pointConfig({ degradation: "required" }));
    expect(required).toEqual({ kind: "unsatisfied", reason: { code: "invalid_answer" } });
  });

  it("a valid but abstaining ('none') answer maps to the declared fallback, never to approval", async () => {
    const provider = new StubProvider(async () => ({
      answers: [{ kind: "choice", questionId: "q1", selected: "none" }]
    }));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });

    const advisory = await runtime.evaluate(pointConfig({ degradation: "recovery_or_advisory" }));
    expect(advisory).toEqual({ kind: "degraded", fallback: "fallback-value", reason: { code: "abstained" } });
  });

  it("a valid, accepted answer is returned as the domain value, not the fallback", async () => {
    const provider = new StubProvider(async () => ({
      answers: [{ kind: "choice", questionId: "q1", selected: "yes" }]
    }));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });

    const result = await runtime.evaluate(
      pointConfig<string>({
        degradation: "recovery_or_advisory",
        select: (outcomes) => {
          const accepted = outcomes.find((o) => o.status === "accepted");
          return accepted?.status === "accepted" && accepted.accepted?.answer.kind === "choice"
            ? accepted.accepted.answer.selected
            : undefined;
        }
      })
    );

    expect(result).toEqual({ kind: "accepted", value: "yes" });
  });
});
