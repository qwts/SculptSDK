import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { RecordedProvider, RECORDING_FORMAT_VERSION, type DecisionRecordingFile } from "@sculptsdk/adapter-testing";
import {
  Sculpt,
  StaticCalibrationRegistry,
  type CalibrationThreshold,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse
} from "@sculptsdk/core";

/**
 * DP-1 disambiguation wired into `UIRoot.tryFind` (#23): a real kernel tie —
 * two identically-scored "Save" buttons — triggers DP-1, exactly the
 * technical review's duplicate-Save-in-page-and-dialog fixture from #2.
 */

const ORIGIN = "http://fixtures.local";
const DUPLICATE_SAVE_HTML = `<!doctype html><html><body>
  <button id="page-save" type="button">Save</button>
  <div role="dialog" aria-label="Confirm changes">
    <button id="dialog-save" type="button">Save</button>
  </div>
</body></html>`;

const THRESHOLD: CalibrationThreshold = {
  point: "dp1-target",
  model: "unset",
  policyVersion: "v1",
  questionVersion: "v1",
  mode: "tie",
  minConfidence: 0.5
};

async function attachDuplicateSave(semantic: Parameters<typeof Sculpt.attach>[0]["semantic"]): Promise<Sculpt> {
  const adapter = new TestHarnessAdapter({ html: DUPLICATE_SAVE_HTML, url: `${ORIGIN}/` });
  return Sculpt.attach({ adapter, authority: { semanticResolution: "enabled" }, semantic });
}

function stubProvider(impl: (request: DecisionRequest) => Promise<RawDecisionResponse>): DecisionProvider {
  return { id: "stub", supports: () => true, decide: impl };
}

describe("DP-1 disambiguation on a real kernel tie (duplicate Save in page and dialog)", () => {
  it("without semantic resolution enabled, ties still throw TARGET_AMBIGUOUS unchanged", async () => {
    const adapter = new TestHarnessAdapter({ html: DUPLICATE_SAVE_HTML, url: `${ORIGIN}/` });
    const sculpt = await Sculpt.attach({ adapter });
    try {
      await expect(sculpt.ui.find({ kind: "button", name: "Save" })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
    } finally {
      await sculpt.dispose();
    }
  });

  it("enabled but no calibration artifact: still TARGET_AMBIGUOUS, with the DP-1 record attached", async () => {
    const provider = stubProvider(async (request) => {
      const options = (request.questions[0] as { options: string[] }).options;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.99 }] };
    });
    const sculpt = await attachDuplicateSave({ provider });
    try {
      await expect(sculpt.ui.find({ kind: "button", name: "Save" })).rejects.toMatchObject({
        code: "TARGET_AMBIGUOUS",
        details: { semantic: { point: "dp1-target", status: "abstained" } }
      });
    } finally {
      await sculpt.dispose();
    }
  });

  it("a mandatory predicate the kernel couldn't verify (region, no layout data) never gets a semantic accept", async () => {
    const provider = stubProvider(async (request) => {
      const options = (request.questions[0] as { options: string[] }).options;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.99 }] };
    });
    const sculpt = await attachDuplicateSave({ provider, calibration: new StaticCalibrationRegistry([THRESHOLD]) });
    try {
      // happy-dom reports an all-zero bounding rect, so a geometric region
      // predicate can never be conclusively verified here.
      await expect(sculpt.ui.find({ kind: "button", name: "Save", region: "top" })).rejects.toMatchObject({
        code: "TARGET_AMBIGUOUS"
      });
    } finally {
      await sculpt.dispose();
    }
  });

  it("accepts through a matching RecordedProvider recording once a calibration artifact exists", async () => {
    // First pass: capture the exact request the runtime builds.
    let capturedRequest: DecisionRequest | undefined;
    const captureProvider = stubProvider(async (request) => {
      capturedRequest = request;
      const options = (request.questions[0] as { options: string[] }).options;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.95 }] };
    });
    const capturing = await attachDuplicateSave({ provider: captureProvider });
    let acceptedName: string | undefined;
    try {
      await expect(capturing.ui.find({ kind: "button", name: "Save" })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
    } finally {
      await capturing.dispose();
    }
    expect(capturedRequest).toBeDefined();
    const chosenId = (capturedRequest!.questions[0] as { options: string[] }).options[0]!;

    // Second pass: a fresh Sculpt instance, RecordedProvider replays the
    // captured request/answer pair, and a calibration artifact now exists.
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [
        RecordedProvider.recordEntry(capturedRequest!, {
          answers: [{ kind: "choice", questionId: "target", selected: chosenId, providerConfidence: 0.95 }]
        })
      ]
    };
    const replaying = await attachDuplicateSave({
      provider: new RecordedProvider(file),
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });
    try {
      const element = await replaying.ui.find({ kind: "button", name: "Save" });
      expect(element.summary.targetId).toBeDefined();
      acceptedName = element.name;
    } finally {
      await replaying.dispose();
    }
    expect(acceptedName).toBe("Save");
  });
});
