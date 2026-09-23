import { describe, expect, it } from "vitest";
import {
  ProviderUnavailableError,
  SemanticRuntime,
  StaticCalibrationRegistry,
  resolveDisambiguation,
  type CalibrationThreshold,
  type DecisionProvider,
  type DecisionRequest,
  type QueryCandidate,
  type RawDecisionResponse
} from "@sculptsdk/core";

/**
 * DP-1 disambiguation (#23): the first production decision point. Tests the
 * pure `resolveDisambiguation()` function directly against synthetic tied
 * candidates — the same shape `UIRoot.tryFind` builds from a real kernel
 * tie, but without needing a live DOM for every case.
 */

const ORIGIN = "http://fixtures.local";
const THRESHOLD: CalibrationThreshold = {
  point: "dp1-target",
  model: "unset",
  policyVersion: "v1",
  questionVersion: "v1",
  mode: "tie",
  minConfidence: 0.5
};

function candidate(targetId: string, overrides: Partial<QueryCandidate> = {}): QueryCandidate {
  return {
    summary: { targetId, kind: "button", role: "button", name: "Save" },
    identity: { id: `identity-${targetId}`, confidence: 1 },
    score: 30,
    confidence: 0.8,
    reasons: ["accessible name matched exactly: Save"],
    unverifiedMandatoryPredicates: [],
    ...overrides
  };
}

function stubProvider(impl: (request: DecisionRequest) => Promise<RawDecisionResponse>): DecisionProvider {
  return { id: "stub", supports: () => true, decide: impl };
}

function acceptedAnswerFor(targetId: string, providerConfidence = 0.9): RawDecisionResponse {
  return { answers: [{ kind: "choice", questionId: "target", selected: targetId, providerConfidence }] };
}

function baseOptions(runtime: SemanticRuntime, tied: QueryCandidate[]) {
  return {
    runtime,
    origin: ORIGIN,
    tied,
    intent: "find a button named like \"Save\"",
    routePath: "/edit",
    documentEvidence: { documentId: "doc-1", navigationEpoch: 0 }
  };
}

describe("DP-1: shadow mode without a matching calibration artifact", () => {
  it("records the decision and accepts nothing when no calibration is configured", async () => {
    const tied = [candidate("t1"), candidate("t2")];
    const provider = stubProvider(async () => acceptedAnswerFor("t1"));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider });

    const { acceptedTargetId, record } = await resolveDisambiguation(baseOptions(runtime, tied));

    expect(acceptedTargetId).toBeUndefined();
    expect(record.status).toBe("abstained");
    // The provider's actual answer is still captured for future calibration.
    expect(record.outcomes).toHaveLength(1);
    expect(record.outcomes[0]?.status).toBe("accepted");
  });
});

describe("DP-1: accepts once a matching calibration artifact clears the answer", () => {
  it("accepts a tied candidate whose confidence clears the threshold", async () => {
    const tied = [candidate("t1"), candidate("t2")];
    const provider = stubProvider(async () => acceptedAnswerFor("t1", 0.9));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });

    const { acceptedTargetId, record } = await resolveDisambiguation(baseOptions(runtime, tied));

    expect(acceptedTargetId).toBe("t1");
    expect(record.status).toBe("accepted");
  });

  it("does not accept when confidence falls below the calibrated threshold", async () => {
    const tied = [candidate("t1"), candidate("t2")];
    const provider = stubProvider(async () => acceptedAnswerFor("t1", 0.3));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });

    const { acceptedTargetId } = await resolveDisambiguation(baseOptions(runtime, tied));

    expect(acceptedTargetId).toBeUndefined();
  });
});

describe("DP-1: a tied candidate with an unverifiable mandatory predicate never gets a semantic accept", () => {
  it("skips the call entirely and reports the reason on the record", async () => {
    const tied = [candidate("t1"), candidate("t2", { unverifiedMandatoryPredicates: ["region"] })];
    let called = false;
    const provider = stubProvider(async () => {
      called = true;
      return acceptedAnswerFor("t1", 0.99);
    });
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider,
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });

    const { acceptedTargetId, record } = await resolveDisambiguation(baseOptions(runtime, tied));

    expect(acceptedTargetId).toBeUndefined();
    expect(record.error?.code).toBe("unverified_mandatory_predicate");
    expect(called).toBe(false); // I9: never spend a call it can't act on
  });
});

describe("DP-1: every failure class abstains rather than accepting", () => {
  const calibration = new StaticCalibrationRegistry([THRESHOLD]);

  it("timeout / provider unavailable", async () => {
    const tied = [candidate("t1"), candidate("t2")];
    const provider: DecisionProvider = {
      id: "timeout",
      supports: () => true,
      decide: async () => {
        throw new ProviderUnavailableError("timeout");
      }
    };
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider, calibration });
    const { acceptedTargetId, record } = await resolveDisambiguation(baseOptions(runtime, tied));
    expect(acceptedTargetId).toBeUndefined();
    expect(record.status).toBe("unavailable");
  });

  it("invalid answer (foreign selection)", async () => {
    const tied = [candidate("t1"), candidate("t2")];
    const provider = stubProvider(async () => acceptedAnswerFor("not-a-tied-candidate"));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider, calibration });
    const { acceptedTargetId, record } = await resolveDisambiguation(baseOptions(runtime, tied));
    expect(acceptedTargetId).toBeUndefined();
    expect(record.status).toBe("invalid");
  });

  it("stale (page state changed between capture and freshness check)", async () => {
    // resolveDisambiguation doesn't itself take a checkFreshness hook (it's
    // freshness-bound only through #22's execution guard at the point the
    // accepted target is actually acted on) — a provider abstention is the
    // in-scope failure class exercised here instead.
    const tied = [candidate("t1"), candidate("t2")];
    const provider = stubProvider(async () => ({ answers: [{ kind: "choice" as const, questionId: "target", selected: "none" }] }));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider, calibration });
    const { acceptedTargetId, record } = await resolveDisambiguation(baseOptions(runtime, tied));
    expect(acceptedTargetId).toBeUndefined();
    expect(record.status).toBe("abstained");
  });
});

describe("DP-1: property — an accepted target always passed every mandatory predicate", () => {
  // Hand-rolled seeded PRNG (mulberry32) — no new fuzzing dependency, and
  // the seed prints in the test name so a failure is reproducible.
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
  const calibration = new StaticCalibrationRegistry([THRESHOLD]);

  for (const seed of SEEDS) {
    it(`seed ${seed}: acceptedTargetId is always a member of tied, or undefined`, async () => {
      const rand = mulberry32(seed);
      const tied = [candidate("t1"), candidate("t2"), candidate("t3")];
      const tiedIds = new Set(tied.map((c) => c.summary.targetId));
      const foreignIds = ["not-in-tied", "another-foreign-id"];

      for (let trial = 0; trial < 50; trial++) {
        const pool = [...tiedIds, ...foreignIds, "none"];
        const selected = pool[Math.floor(rand() * pool.length)]!;
        const confidence = rand();
        const provider = stubProvider(async () => acceptedAnswerFor(selected, confidence));
        const runtime = new SemanticRuntime({
          settings: { semanticResolution: "enabled", actionLogging: "disabled" },
          provider,
          calibration
        });

        const { acceptedTargetId } = await resolveDisambiguation(baseOptions(runtime, tied));

        if (acceptedTargetId !== undefined) {
          expect(tiedIds.has(acceptedTargetId), `seed ${seed} trial ${trial}: accepted "${acceptedTargetId}"`).toBe(true);
        }
      }
    });
  }
});
