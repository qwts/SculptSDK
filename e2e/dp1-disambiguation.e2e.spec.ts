import { test, expect } from "@playwright/test";
import { RecordedProvider, RECORDING_FORMAT_VERSION, type DecisionRecordingFile } from "@sculptsdk/adapter-testing";
import { Sculpt, StaticCalibrationRegistry, type CalibrationThreshold, type DecisionRequest } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * DP-1 disambiguation on a real Chromium page (#23's verification: "a
 * RecordedProvider e2e test on the fixtures"), on the #11 duplicate-Save
 * fixture — the exact case #2's technical review names: a page-level Save
 * button and a dialog with its own Save button visible at the same time.
 * PR CI never calls a live provider (ADR-0007).
 */

const THRESHOLD: CalibrationThreshold = {
  point: "dp1-target",
  model: "unset",
  policyVersion: "v1",
  questionVersion: "v1",
  mode: "tie",
  minConfidence: 0.5
};

test.describe("DP-1 disambiguation on a real Chromium page", () => {
  test("accepts through a matching RecordedProvider recording for the duplicate-Save tie", async ({ page, baseURL }) => {
    // First pass: capture the exact request the runtime builds for this tie.
    let capturedRequest: DecisionRequest | undefined;
    await page.goto(`${baseURL}/duplicate-save.html`);
    const capturing = await Sculpt.attach({
      adapter: new PlaywrightAdapter(page),
      authority: { semanticResolution: "enabled" },
      semantic: {
        provider: {
          id: "capture",
          supports: () => true,
          decide: async (request) => {
            capturedRequest = request;
            const options = (request.questions[0] as { options: string[] }).options;
            return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.95 }] };
          }
        }
      }
    });
    try {
      await expect(capturing.ui.find({ kind: "button", name: "Save" })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
    } finally {
      await capturing.dispose();
    }
    expect(capturedRequest).toBeDefined();
    const chosenId = (capturedRequest!.questions[0] as { options: string[] }).options[0]!;

    // Second pass: a fresh page and Sculpt instance, RecordedProvider
    // replays the captured request/answer pair — no live provider call.
    await page.goto(`${baseURL}/duplicate-save.html`);
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [
        RecordedProvider.recordEntry(capturedRequest!, {
          answers: [{ kind: "choice", questionId: "target", selected: chosenId, providerConfidence: 0.95 }]
        })
      ]
    };
    const replaying = await Sculpt.attach({
      adapter: new PlaywrightAdapter(page),
      authority: { semanticResolution: "enabled" },
      semantic: { provider: new RecordedProvider(file), calibration: new StaticCalibrationRegistry([THRESHOLD]) }
    });
    try {
      const element = await replaying.ui.find({ kind: "button", name: "Save" });
      expect(element.name).toBe("Save");

      // The accepted target executes through #22's guard, unchanged from
      // any other UIElement — no separate DP-1 click path exists.
      const evidence = await replaying.foundation.observers.evidence();
      const result = await element.click({ guard: element.guardFrom(evidence) });
      expect(result.ok).toBe(true);
    } finally {
      await replaying.dispose();
    }
  });
});
