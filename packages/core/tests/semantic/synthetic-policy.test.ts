import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { RecordedProvider, RECORDING_FORMAT_VERSION, type DecisionRecordingFile } from "@sculptsdk/adapter-testing";
import {
  ProviderUnavailableError,
  Sculpt,
  SemanticRuntime,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse
} from "@sculptsdk/core";
import { gatherAdmittedCandidates, runSyntheticPolicy, type SyntheticCandidate } from "./support/synthetic-policy.js";

/**
 * The synthetic policy consumer (#17): exercises every m0 runtime contract
 * end to end — candidates → DTOs → runtime+budget → validation → typed
 * outcome → fallback → decision record — in both degradation classes, with
 * I3/I5 property tests. Maps every #4 completion criterion to a test; see
 * the PR description for that mapping.
 */

const FIXTURE_HTML = `<!doctype html><html><body>
  <button id="save-btn">Save</button>
  <button id="cancel-btn">Cancel</button>
  <button id="delete-btn" disabled>Delete</button>
  <button id="archive-btn" style="display:none">Archive</button>
</body></html>`;
const ORIGIN = "http://fixtures.local";

function stubProvider(impl: (request: DecisionRequest) => Promise<RawDecisionResponse>): DecisionProvider {
  return { id: "stub", supports: () => true, decide: impl };
}

function acceptedAnswerFor(targetId: string): RawDecisionResponse {
  return { answers: [{ kind: "choice", questionId: "target", selected: targetId }] };
}

async function withFixture<T>(fn: (sculpt: Sculpt) => Promise<T>): Promise<T> {
  const adapter = new TestHarnessAdapter({ html: FIXTURE_HTML, url: ORIGIN + "/" });
  const sculpt = await Sculpt.attach({ adapter });
  try {
    return await fn(sculpt);
  } finally {
    await sculpt.dispose();
  }
}

describe("synthetic policy — deterministic admission", () => {
  it("accepts a valid selection from the admitted set (recovery_or_advisory variant)", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      expect(candidates.map((c) => c.name).sort()).toEqual(["Cancel", "Save"]);

      const saveId = candidates.find((c) => c.name === "Save")!.targetId;
      const provider = stubProvider(async () => acceptedAnswerFor(saveId));
      const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "full" }, provider });

      const outcome = await runSyntheticPolicy({ runtime, admittedCandidates: candidates, origin: ORIGIN, degradation: "recovery_or_advisory" });

      expect(outcome.result).toEqual({ kind: "accepted", value: saveId });
      expect(outcome.record.status).toBe("accepted");
      expect(outcome.record.outcomes).toHaveLength(1);
      expect(outcome.record.provider).toBe("stub");
    });
  });

  it("accepts a valid selection from the admitted set (required variant)", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const saveId = candidates.find((c) => c.name === "Save")!.targetId;
      const provider = stubProvider(async () => acceptedAnswerFor(saveId));
      const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "full" }, provider });

      const outcome = await runSyntheticPolicy({ runtime, admittedCandidates: candidates, origin: ORIGIN, degradation: "required" });

      expect(outcome.result).toEqual({ kind: "accepted", value: saveId });
    });
  });

  it("the disabled 'Delete' and hidden 'Archive' buttons were never admitted at all", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      expect(candidates.map((c) => c.name)).not.toContain("Delete");
      expect(candidates.map((c) => c.name)).not.toContain("Archive");
    });
  });
});

describe("synthetic policy — I3 (never admits outside the deterministic set; never changes authority)", () => {
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
    it(`seed ${seed}: a fuzzed answer is never accepted outside the admitted candidate set`, async () => {
      await withFixture(async (sculpt) => {
        const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
        // Include the *never-admitted* disabled/hidden buttons' real ids as
        // adversarial choices the provider might "guess".
        const { candidates: allButtons } = await gatherAdmittedCandidates(sculpt, { kind: "button" });
        const foreignIds = allButtons
          .filter((c) => !candidates.some((admitted) => admitted.targetId === c.targetId))
          .map((c) => c.targetId);
        const pool = [...candidates.map((c) => c.targetId), ...foreignIds, "not-a-real-id-at-all", "none"];

        const rand = mulberry32(seed);
        for (let trial = 0; trial < 50; trial++) {
          const selected = pool[Math.floor(rand() * pool.length)]!;
          const provider = stubProvider(async () => acceptedAnswerFor(selected));
          const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider });

          const outcome = await runSyntheticPolicy({
            runtime,
            admittedCandidates: candidates,
            origin: ORIGIN,
            degradation: "recovery_or_advisory"
          });

          if (outcome.result.kind === "accepted") {
            expect(outcome.admittedCandidateIds, `seed ${seed} trial ${trial}: selected "${selected}"`).toContain(
              outcome.result.value
            );
          }
        }
      });
    });
  }

  it("running the policy (including with a foreign/adversarial answer) never changes operator authority or settings", async () => {
    await withFixture(async (sculpt) => {
      const before = sculpt.capabilities.settings();
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });

      const adversarial = stubProvider(async () => acceptedAnswerFor("some-foreign-id-the-provider-invented"));
      const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider: adversarial });
      await runSyntheticPolicy({ runtime, admittedCandidates: candidates, origin: ORIGIN, degradation: "recovery_or_advisory" });
      await runSyntheticPolicy({ runtime, admittedCandidates: candidates, origin: ORIGIN, degradation: "required" });

      const after = sculpt.capabilities.settings();
      expect(after).toEqual(before);
    });
  });

  it("a disabled/hidden candidate's real id, even if 'selected', never becomes an accepted value", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const { candidates: allButtons } = await gatherAdmittedCandidates(sculpt, { kind: "button" });
      const deleteButton = allButtons.find((c) => c.name === "Delete")!;

      const provider = stubProvider(async () => acceptedAnswerFor(deleteButton.targetId));
      const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider });

      const outcome = await runSyntheticPolicy({ runtime, admittedCandidates: candidates, origin: ORIGIN, degradation: "recovery_or_advisory" });

      expect(outcome.result.kind).not.toBe("accepted");
    });
  });
});

describe("synthetic policy — I5 (every failure class produces the declared fallback; required stays unsatisfied)", () => {
  async function runBothVariants(
    runtimeFactory: () => SemanticRuntime,
    admittedCandidates: SyntheticCandidate[],
    extra: Parameters<typeof runSyntheticPolicy>[0] = {} as never
  ) {
    const recovery = await runSyntheticPolicy({
      runtime: runtimeFactory(),
      admittedCandidates,
      origin: ORIGIN,
      degradation: "recovery_or_advisory",
      ...extra
    });
    const required = await runSyntheticPolicy({
      runtime: runtimeFactory(),
      admittedCandidates,
      origin: ORIGIN,
      degradation: "required",
      ...extra
    });
    return { recovery, required };
  }

  it("timeout: recovery falls back to the declared fallback; required stays unsatisfied", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const provider = stubProvider(async () => {
        throw new ProviderUnavailableError("timeout");
      });
      const { recovery, required } = await runBothVariants(
        () => new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider }),
        candidates
      );
      expect(recovery.result).toEqual({ kind: "degraded", fallback: null, reason: { code: "timeout", detail: "timeout" } });
      expect(required.result.kind).toBe("unsatisfied");
    });
  });

  it("abort: recovery falls back; required stays unsatisfied", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const provider = stubProvider(() => new Promise(() => {})); // never resolves on its own

      const runtimeR = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider });
      runtimeR.dispose(); // aborted before the call is even made
      const recovery = await runSyntheticPolicy({ runtime: runtimeR, admittedCandidates: candidates, origin: ORIGIN, degradation: "recovery_or_advisory" });

      const runtimeQ = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider });
      runtimeQ.dispose();
      const required = await runSyntheticPolicy({ runtime: runtimeQ, admittedCandidates: candidates, origin: ORIGIN, degradation: "required" });

      expect(recovery.result).toMatchObject({ kind: "degraded", fallback: null, reason: { code: "cancelled" } });
      expect(required.result.kind).toBe("unsatisfied");
    });
  });

  it("invalid: a foreign selection degrades/unsatisfies rather than ever being accepted", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const provider = stubProvider(async () => acceptedAnswerFor("not-in-the-option-set"));
      const { recovery, required } = await runBothVariants(
        () => new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider }),
        candidates
      );
      expect(recovery.result).toEqual({ kind: "degraded", fallback: null, reason: { code: "invalid_answer" } });
      expect(required.result.kind).toBe("unsatisfied");
    });
  });

  it("stale: freshness mismatch degrades/unsatisfies even though the answer itself validated", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const saveId = candidates.find((c) => c.name === "Save")!.targetId;
      const provider = stubProvider(async () => acceptedAnswerFor(saveId));

      const staleExtra = {
        capturedEvidence: { documentId: "doc-1", navigationEpoch: 0, frameId: "main" as const },
        checkFreshness: async () => ({ documentId: "doc-1", navigationEpoch: 1, frameId: "main" as const })
      };
      const { recovery, required } = await runBothVariants(
        () => new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider }),
        candidates,
        staleExtra
      );
      expect(recovery.result).toMatchObject({ kind: "degraded", fallback: null, reason: { code: "stale" } });
      expect(required.result.kind).toBe("unsatisfied");
    });
  });

  it("missing calibration: recovery falls back; required stays unsatisfied", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const provider = stubProvider(async () => {
        throw new ProviderUnavailableError("no_calibration");
      });
      const { recovery, required } = await runBothVariants(
        () => new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider }),
        candidates
      );
      expect(recovery.result).toMatchObject({ kind: "degraded", fallback: null, reason: { code: "no_calibration" } });
      expect(required.result.kind).toBe("unsatisfied");
    });
  });

  it("budget exhausted: recovery falls back; required stays unsatisfied", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const saveId = candidates.find((c) => c.name === "Save")!.targetId;
      const provider = stubProvider(async () => acceptedAnswerFor(saveId));

      const runtimeR = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider });
      const budgetR = runtimeR.createOperationBudget({ maxRequests: 1 });
      await runSyntheticPolicy({ runtime: runtimeR, admittedCandidates: candidates, origin: ORIGIN, degradation: "recovery_or_advisory", budget: budgetR }); // spends it
      const recovery = await runSyntheticPolicy({ runtime: runtimeR, admittedCandidates: candidates, origin: ORIGIN, degradation: "recovery_or_advisory", budget: budgetR });

      const runtimeQ = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider });
      const budgetQ = runtimeQ.createOperationBudget({ maxRequests: 1 });
      await runSyntheticPolicy({ runtime: runtimeQ, admittedCandidates: candidates, origin: ORIGIN, degradation: "required", budget: budgetQ }); // spends it
      const required = await runSyntheticPolicy({ runtime: runtimeQ, admittedCandidates: candidates, origin: ORIGIN, degradation: "required", budget: budgetQ });

      expect(recovery.result).toMatchObject({ kind: "degraded", fallback: null, reason: { code: "budget_exhausted" } });
      expect(required.result.kind).toBe("unsatisfied");
    });
  });

  it("missing recording (RecordedProvider): recovery falls back; required stays unsatisfied", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const emptyFile: DecisionRecordingFile = { formatVersion: RECORDING_FORMAT_VERSION, recordings: [] };
      const { recovery, required } = await runBothVariants(
        () => new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "disabled" }, provider: new RecordedProvider(emptyFile) }),
        candidates
      );
      expect(recovery.result).toMatchObject({ kind: "degraded", fallback: null, reason: { code: "recording_missing" } });
      expect(required.result.kind).toBe("unsatisfied");
    });
  });
});

describe("synthetic policy — RecordedProvider-backed integration (PR CI never calls a live provider)", () => {
  it("accepts through a matching recording", async () => {
    await withFixture(async (sculpt) => {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", visible: true, enabled: true });
      const saveId = candidates.find((c) => c.name === "Save")!.targetId;
      const optionIds = [...candidates.map((c) => c.targetId), "none"].sort();
      const candidateSetDigest = optionIds.filter((id) => id !== "none").sort().join(",");

      // Seed a recording matching exactly what runSyntheticPolicy will build.
      const recordingRequest: DecisionRequest = {
        evidence: {
          requestId: "seed",
          operationId: "synthetic-op",
          point: "synthetic-consumer",
          model: "synthetic-model",
          questionVersion: "v1",
          policyVersion: "v1",
          origin: ORIGIN,
          frameId: "main",
          navigationEpoch: 0,
          candidateSetDigest,
          redactedStateDigest: candidateSetDigest,
          deadline: Date.now() + 5000,
          signal: new AbortController().signal
        },
        questions: [{ kind: "choice", id: "target", options: [...candidates.map((c) => c.targetId), "none"] }]
      };
      const file: DecisionRecordingFile = {
        formatVersion: RECORDING_FORMAT_VERSION,
        recordings: [RecordedProvider.recordEntry(recordingRequest, acceptedAnswerFor(saveId))]
      };

      const runtime = new SemanticRuntime({
        settings: { semanticResolution: "enabled", actionLogging: "metadata" },
        provider: new RecordedProvider(file)
      });
      const outcome = await runSyntheticPolicy({ runtime, admittedCandidates: candidates, origin: ORIGIN, degradation: "recovery_or_advisory", operationId: "synthetic-op" });

      expect(outcome.result).toEqual({ kind: "accepted", value: saveId });
    });
  });
});
