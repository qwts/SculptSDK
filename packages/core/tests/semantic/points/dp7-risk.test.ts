import { describe, expect, it } from "vitest";
import {
  ProviderUnavailableError,
  SemanticRuntime,
  StaticCalibrationRegistry,
  resolveRiskPredicates,
  DP7_PREDICATE_IDS,
  DP7_CALIBRATION_MODE,
  type CalibrationThreshold,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse
} from "@sculptsdk/core";

/**
 * DP-7 semantic risk predicates (#28): the pure `resolveRiskPredicates()`
 * function, tested directly against synthetic stub answers — the same
 * shape `runAction` builds from a real kernel `riskSignals` read, without
 * needing a live DOM for every case.
 */

const ORIGIN = "http://fixtures.local";
const THRESHOLD: CalibrationThreshold = {
  point: "dp7-risk",
  model: "unset",
  policyVersion: "v1",
  questionVersion: "v1",
  mode: DP7_CALIBRATION_MODE,
  minConfidence: 0.5
};

function stubProvider(impl: (request: DecisionRequest) => Promise<RawDecisionResponse>): DecisionProvider {
  return { id: "stub", supports: () => true, decide: impl };
}

/** All five predicates answered, defaulting to "definitely not risky" (0),
 * with per-predicate overrides. */
function probabilityAnswers(overrides: Partial<Record<(typeof DP7_PREDICATE_IDS)[number], number>> = {}): RawDecisionResponse {
  return {
    answers: DP7_PREDICATE_IDS.map((id) => ({
      kind: "probability" as const,
      questionId: id,
      value: overrides[id] ?? 0
    }))
  };
}

function baseOptions(runtime: SemanticRuntime) {
  return {
    runtime,
    origin: ORIGIN,
    actionType: "click" as const,
    signals: { accessibleName: "Archive", text: "Archive this item" },
    intent: "click on button \"Archive\"",
    routePath: "/items/42",
    documentEvidence: { documentId: "doc-1", navigationEpoch: 0, frameId: "main" as const }
  };
}

describe("DP-7: shadow mode without a matching calibration artifact", () => {
  it("records the decision and never escalates when no calibration is configured", async () => {
    const provider = stubProvider(async () => probabilityAnswers({ destructive: 0.99 }));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider });

    const { escalate, requiredButUnavailable, record } = await resolveRiskPredicates(baseOptions(runtime));

    expect(escalate).toBe(false);
    expect(requiredButUnavailable).toBe(false);
    expect(record.status).toBe("abstained");
    // The provider's actual answers are still captured for future calibration.
    expect(record.outcomes).toHaveLength(5);
  });
});

describe("DP-7: escalates once a matching calibration artifact clears any single predicate", () => {
  it("escalates when only one of the five predicates clears the threshold", async () => {
    const provider = stubProvider(async () => probabilityAnswers({ destructive: 0.9 }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });

    const { escalate } = await resolveRiskPredicates(baseOptions(runtime));
    expect(escalate).toBe(true);
  });

  it("never sums the marginals — five predicates each just under the bar still don't escalate", async () => {
    // §28 rejects summing overlapping probabilities to reach a bar (#2's
    // 0.30 design). Five answers of 0.4 each would sum well past any
    // reasonable threshold, but combined with OR (not sum), none alone
    // clears 0.5, so nothing escalates.
    const provider = stubProvider(async () =>
      probabilityAnswers({ destructive: 0.4, financial: 0.4, "external-communication": 0.4, "account-security": 0.4, "requires-confirmation": 0.4 })
    );
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });

    const { escalate } = await resolveRiskPredicates(baseOptions(runtime));
    expect(escalate).toBe(false);
  });

  it("does not escalate when every predicate falls below the threshold", async () => {
    const provider = stubProvider(async () => probabilityAnswers());
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });

    const { escalate } = await resolveRiskPredicates(baseOptions(runtime));
    expect(escalate).toBe(false);
  });

  it("the direct 'requires confirmation' question alone can escalate", async () => {
    const provider = stubProvider(async () => probabilityAnswers({ "requires-confirmation": 0.75 }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });

    const { escalate } = await resolveRiskPredicates(baseOptions(runtime));
    expect(escalate).toBe(true);
  });
});

describe("DP-7: degradation classes", () => {
  it("advisory (default): a provider outage never escalates and never blocks the action", async () => {
    const provider: DecisionProvider = {
      id: "outage",
      supports: () => true,
      decide: async () => {
        throw new ProviderUnavailableError("timeout");
      }
    };
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });

    const { escalate, requiredButUnavailable } = await resolveRiskPredicates(baseOptions(runtime));
    expect(escalate).toBe(false);
    expect(requiredButUnavailable).toBe(false);
  });

  it("required: a provider outage is reported as requiredButUnavailable, never as an escalation", async () => {
    const provider: DecisionProvider = {
      id: "outage",
      supports: () => true,
      decide: async () => {
        throw new ProviderUnavailableError("timeout");
      }
    };
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD]),
      dp7RiskDegradation: "required"
    });

    const { escalate, requiredButUnavailable } = await resolveRiskPredicates(baseOptions(runtime));
    expect(requiredButUnavailable).toBe(true);
    expect(escalate).toBe(false);
  });

  it("required: an unsupported model is also requiredButUnavailable", async () => {
    const provider: DecisionProvider = { id: "unsupported", supports: () => false, decide: async () => probabilityAnswers() };
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD]),
      dp7RiskDegradation: "required"
    });

    const { requiredButUnavailable } = await resolveRiskPredicates(baseOptions(runtime));
    expect(requiredButUnavailable).toBe(true);
  });
});

describe("DP-7: property — for any stub answers, escalation never depends on unrelated fields", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SEEDS = [1, 2, 3, 42, 1337];

  for (const seed of SEEDS) {
    it(`seed ${seed}: escalate is true iff at least one predicate clears the threshold`, async () => {
      const rand = mulberry32(seed);
      for (let trial = 0; trial < 20; trial++) {
        const values: Partial<Record<(typeof DP7_PREDICATE_IDS)[number], number>> = {};
        for (const id of DP7_PREDICATE_IDS) values[id] = rand();
        const provider = stubProvider(async () => probabilityAnswers(values));
        const runtime = new SemanticRuntime({
          settings: { semanticResolution: "enabled", actionLogging: "disabled" },
          provider,
          calibration: new StaticCalibrationRegistry([THRESHOLD])
        });

        const { escalate } = await resolveRiskPredicates(baseOptions(runtime));
        const expected = DP7_PREDICATE_IDS.some((id) => (values[id] ?? 0) >= THRESHOLD.minConfidence);
        expect(escalate, `seed ${seed} trial ${trial}: values=${JSON.stringify(values)}`).toBe(expected);
      }
    });
  }
});
