import { test, expect } from "@playwright/test";
import { ProviderUnavailableError, Sculpt, SemanticRuntime, type DecisionProvider, type RawDecisionResponse } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";
import { gatherAdmittedCandidates, runSyntheticPolicy } from "../packages/core/tests/semantic/support/synthetic-policy.js";

/**
 * One Playwright variant of the synthetic policy consumer (#17), on the
 * #11 fixtures: the same candidates -> DTOs -> runtime+budget -> validate ->
 * fallback -> record pipeline, run once against a real Chromium page.
 */

test.describe("synthetic policy consumer on a real Chromium page", () => {
  test("accepts a valid selection from the admitted set, and rejects a foreign one", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/duplicate-save.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      const { candidates } = await gatherAdmittedCandidates(sculpt, { kind: "button", name: "Save" });
      expect(candidates.length).toBeGreaterThanOrEqual(2); // page-level and dialog Save

      const chosenId = candidates[0]!.targetId;
      const provider: DecisionProvider = {
        id: "e2e-stub",
        supports: () => true,
        decide: async (): Promise<RawDecisionResponse> => ({
          answers: [{ kind: "choice", questionId: "target", selected: chosenId }]
        })
      };
      const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "full" }, provider });

      const accepted = await runSyntheticPolicy({
        runtime,
        admittedCandidates: candidates,
        origin: new URL(baseURL!).origin,
        degradation: "recovery_or_advisory"
      });
      expect(accepted.result).toEqual({ kind: "accepted", value: chosenId });
      expect(accepted.record.status).toBe("accepted");

      // A real foreign selection (not one of the admitted candidate ids) must
      // be rejected by validation, never accepted — I3 (never admits outside
      // the deterministic set) on a real Chromium page, not just in unit tests.
      const foreignProvider: DecisionProvider = {
        id: "e2e-stub-foreign",
        supports: () => true,
        decide: async (): Promise<RawDecisionResponse> => ({
          answers: [{ kind: "choice", questionId: "target", selected: "not-an-admitted-candidate" }]
        })
      };
      const runtimeRequired = new SemanticRuntime({
        settings: { semanticResolution: "enabled", actionLogging: "disabled" },
        provider: foreignProvider
      });
      const rejected = await runSyntheticPolicy({
        runtime: runtimeRequired,
        admittedCandidates: candidates,
        origin: new URL(baseURL!).origin,
        degradation: "required"
      });
      expect(rejected.result.kind).toBe("unsatisfied");
      if (rejected.result.kind === "unsatisfied") {
        expect(rejected.result.reason.code).toBe("invalid_answer");
      }

      // Separately: a transport failure (timeout) is its own, distinct
      // unsatisfied reason — not to be confused with a rejected foreign answer.
      const timeoutProvider: DecisionProvider = {
        id: "e2e-stub-timeout",
        supports: () => true,
        decide: async () => {
          throw new ProviderUnavailableError("timeout");
        }
      };
      const runtimeTimeout = new SemanticRuntime({
        settings: { semanticResolution: "enabled", actionLogging: "disabled" },
        provider: timeoutProvider
      });
      const unsatisfied = await runSyntheticPolicy({
        runtime: runtimeTimeout,
        admittedCandidates: candidates,
        origin: new URL(baseURL!).origin,
        degradation: "required"
      });
      expect(unsatisfied.result.kind).toBe("unsatisfied");
    } finally {
      await sculpt.dispose();
    }
  });
});
