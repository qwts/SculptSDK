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

      const foreignProvider: DecisionProvider = {
        id: "e2e-stub-foreign",
        supports: () => true,
        decide: async () => {
          throw new ProviderUnavailableError("timeout");
        }
      };
      const runtimeRequired = new SemanticRuntime({
        settings: { semanticResolution: "enabled", actionLogging: "disabled" },
        provider: foreignProvider
      });
      const unsatisfied = await runSyntheticPolicy({
        runtime: runtimeRequired,
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
