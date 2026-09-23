import { test, expect } from "@playwright/test";
import { RecordedProvider, RECORDING_FORMAT_VERSION, type DecisionRecordingFile } from "@sculptsdk/adapter-testing";
import { Sculpt, StaticCalibrationRegistry, type CalibrationThreshold, type DecisionRequest } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * DP-1 recall on a real Chromium page (#24's verification: "a recorded-
 * provider e2e test on synonym fixtures"), on the #11 `synonym-login.html`
 * fixture: nothing is named "Sign in", but "Log in" is visible and enabled
 * while two distractors carry the same name but fail a non-text predicate.
 * PR CI never calls a live provider (ADR-0007).
 */

const THRESHOLD: CalibrationThreshold = {
  point: "dp1-target",
  model: "unset",
  policyVersion: "v1",
  questionVersion: "v1",
  mode: "miss",
  minConfidence: 0.5
};

test.describe("DP-1 recall on a real Chromium page", () => {
  test("recalls the synonym through a matching RecordedProvider recording; hidden/disabled distractors are never candidates", async ({
    page,
    baseURL
  }) => {
    await page.goto(`${baseURL}/synonym-login.html`);
    const noRecall = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      // Without recall, the synonym is a plain miss — unchanged behavior.
      const found = await noRecall.ui.tryFind({ kind: "button", name: "Sign in", visible: true, enabled: true });
      expect(found).toBeNull();
    } finally {
      await noRecall.dispose();
    }

    // First pass: capture the exact recall request the runtime builds.
    let capturedRequest: DecisionRequest | undefined;
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
            return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.9 }] };
          }
        }
      }
    });
    try {
      await capturing.ui.tryFind({ kind: "button", name: "Sign in", visible: true, enabled: true, recall: true });
    } finally {
      await capturing.dispose();
    }
    expect(capturedRequest).toBeDefined();
    const options = (capturedRequest!.questions[0] as { options: string[] }).options.filter((o) => o !== "none");
    // The hidden and disabled "Log in" buttons never became candidates,
    // even though only name/text were dropped for recall.
    expect(options).toHaveLength(1);
    const chosenId = options[0]!;

    // Second pass: RecordedProvider replays it, and calibration now exists.
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [
        RecordedProvider.recordEntry(capturedRequest!, {
          answers: [{ kind: "choice", questionId: "target", selected: chosenId, providerConfidence: 0.9 }]
        })
      ]
    };
    const replaying = await Sculpt.attach({
      adapter: new PlaywrightAdapter(page),
      authority: { semanticResolution: "enabled" },
      semantic: { provider: new RecordedProvider(file), calibration: new StaticCalibrationRegistry([THRESHOLD]) }
    });
    try {
      const element = await replaying.ui.find({ kind: "button", name: "Sign in", visible: true, enabled: true, recall: true });
      expect(element.name).toBe("Log in");
      const result = await element.click();
      expect(result.ok).toBe(true);
    } finally {
      await replaying.dispose();
    }
  });
});
