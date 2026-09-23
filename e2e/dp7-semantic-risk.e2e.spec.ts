import { test, expect } from "@playwright/test";
import { RecordedProvider, RECORDING_FORMAT_VERSION, type DecisionRecordingFile } from "@sculptsdk/adapter-testing";
import { Sculpt, StaticCalibrationRegistry, DP7_CALIBRATION_MODE, type CalibrationThreshold, type DecisionRequest } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * DP-7 semantic risk predicates on a real Chromium page (#28's
 * verification: "recorded-provider e2e on the DP-7 fixtures, including a
 * mislabelled destructive button"). mislabeled-destructive.html's "Archive"
 * button matches none of #26's deterministic keywords but is genuinely
 * destructive — exactly the gap semantic evidence exists to catch. PR CI
 * never calls a live provider (ADR-0007).
 */

const THRESHOLD: CalibrationThreshold = {
  point: "dp7-risk",
  model: "unset",
  policyVersion: "v1",
  questionVersion: "v1",
  mode: DP7_CALIBRATION_MODE,
  minConfidence: 0.5
};

test.describe("DP-7 semantic risk predicates on a real Chromium page", () => {
  test("a mislabeled destructive button escalates through a matching RecordedProvider recording", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/mislabeled-destructive.html`);

    // Without semantic resolution, the floor never runs at all — unchanged behavior.
    const disabled = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      const result = await disabled.ui.button({ name: "Archive" }).click();
      expect(result.ok).toBe(true);
    } finally {
      await disabled.dispose();
    }
    await page.reload();

    // First pass: capture the exact DP-7 request the runtime builds.
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
            const answers = request.questions.map((q) => ({
              kind: "probability" as const,
              questionId: q.id,
              value: q.id === "destructive" ? 0.95 : 0
            }));
            return { answers };
          }
        }
      }
    });
    try {
      const result = await capturing.ui.button({ name: "Archive" }).click();
      // No calibration configured yet: shadow mode, never blocks.
      expect(result.ok).toBe(true);
    } finally {
      await capturing.dispose();
    }
    expect(capturedRequest).toBeDefined();
    await page.reload();

    // Second pass: RecordedProvider replays it, and calibration now exists.
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [
        RecordedProvider.recordEntry(capturedRequest!, {
          answers: capturedRequest!.questions.map((q) => ({
            kind: "probability" as const,
            questionId: q.id,
            value: q.id === "destructive" ? 0.95 : 0
          }))
        })
      ]
    };
    const replaying = await Sculpt.attach({
      adapter: new PlaywrightAdapter(page),
      authority: { semanticResolution: "enabled" },
      semantic: { provider: new RecordedProvider(file), calibration: new StaticCalibrationRegistry([THRESHOLD]) }
    });
    try {
      const result = await replaying.ui.button({ name: "Archive" }).click();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      await expect(page.locator("#status")).toHaveText("");
    } finally {
      await replaying.dispose();
    }
  });
});
