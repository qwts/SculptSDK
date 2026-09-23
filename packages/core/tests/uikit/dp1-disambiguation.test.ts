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

  it("never sends the URL hash fragment (can carry an OAuth token) as DP-1 route state", async () => {
    let capturedRoute: string | undefined;
    const provider = stubProvider(async (request) => {
      capturedRoute = (request.redactedState as { route: string }).route;
      const options = (request.questions[0] as { options: string[] }).options;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.99 }] };
    });
    const adapter = new TestHarnessAdapter({
      html: DUPLICATE_SAVE_HTML,
      url: `${ORIGIN}/edit#access_token=super-secret-token`
    });
    const sculpt = await Sculpt.attach({ adapter, authority: { semanticResolution: "enabled" }, semantic: { provider } });
    try {
      await expect(sculpt.ui.find({ kind: "button", name: "Save" })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
    } finally {
      await sculpt.dispose();
    }
    expect(capturedRoute).toBeDefined();
    expect(capturedRoute).not.toContain("access_token");
    expect(capturedRoute).not.toContain("#");
    expect(capturedRoute).toBe("/edit");
  });
});

describe("DP-1 disambiguation: an unverifiable predicate on a `within` container propagates to its children", () => {
  const TIE_INSIDE_UNVERIFIABLE_REGION_HTML = `<!doctype html><html><body>
    <div role="dialog" aria-label="Confirm changes">
      <button id="dialog-save-1" type="button">Save</button>
      <button id="dialog-save-2" type="button">Save</button>
    </div>
  </body></html>`;

  it("never spends a semantic call on a tie found inside a container whose own region predicate is unverifiable", async () => {
    let called = false;
    const provider = stubProvider(async (request) => {
      called = true;
      const options = (request.questions[0] as { options: string[] }).options;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.99 }] };
    });
    const adapter = new TestHarnessAdapter({ html: TIE_INSIDE_UNVERIFIABLE_REGION_HTML, url: `${ORIGIN}/` });
    const sculpt = await Sculpt.attach({
      adapter,
      authority: { semanticResolution: "enabled" },
      semantic: { provider, calibration: new StaticCalibrationRegistry([THRESHOLD]) }
    });
    try {
      // happy-dom reports an all-zero bounding rect, so the dialog's own
      // `region: "top"` predicate can never be conclusively verified — and
      // that gap must propagate to both "Save" buttons found inside it.
      await expect(
        sculpt.ui.find({ kind: "button", name: "Save", within: { role: "dialog", region: "top" } })
      ).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
    } finally {
      await sculpt.dispose();
    }
    expect(called).toBe(false); // I9: never spend a call it can't act on
  });
});

describe("DP-1 disambiguation: session-scoped decision evidence cache (#25)", () => {
  const CACHE_FIXTURE_HTML = `<!doctype html><html><body>
    <div id="container">
      <button id="page-save" type="button">Save</button>
      <div role="dialog" aria-label="Confirm changes">
        <button id="dialog-save" type="button">Save</button>
      </div>
    </div>
  </body></html>`;

  it("a repeated identical query skips the provider call", async () => {
    let callCount = 0;
    const provider = stubProvider(async (request) => {
      callCount++;
      const options = (request.questions[0] as { options: string[] }).options;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.99 }] };
    });
    const adapter = new TestHarnessAdapter({ html: CACHE_FIXTURE_HTML, url: `${ORIGIN}/` });
    const sculpt = await Sculpt.attach({
      adapter,
      authority: { semanticResolution: "enabled" },
      semantic: { provider, calibration: new StaticCalibrationRegistry([THRESHOLD]) }
    });
    try {
      const first = await sculpt.ui.find({ kind: "button", name: "Save" });
      const second = await sculpt.ui.find({ kind: "button", name: "Save" });
      expect(callCount).toBe(1);
      expect(second.summary.targetId).toBe(first.summary.targetId);
    } finally {
      await sculpt.dispose();
    }
  });

  it("a navigation between two otherwise-identical queries is a miss — the provider is called again", async () => {
    let callCount = 0;
    const provider = stubProvider(async (request) => {
      callCount++;
      const options = (request.questions[0] as { options: string[] }).options;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.99 }] };
    });
    const adapter = new TestHarnessAdapter({ html: CACHE_FIXTURE_HTML, url: `${ORIGIN}/` });
    const sculpt = await Sculpt.attach({
      adapter,
      authority: { semanticResolution: "enabled" },
      semantic: { provider, calibration: new StaticCalibrationRegistry([THRESHOLD]) }
    });
    try {
      await sculpt.ui.find({ kind: "button", name: "Save" });
      await sculpt.page.navigate(`${ORIGIN}/elsewhere`);
      await sculpt.ui.find({ kind: "button", name: "Save" });
      expect(callCount).toBe(2);
    } finally {
      await sculpt.dispose();
    }
  });

  it("a decision served from the cache still fails the #22 guard, and nothing is clicked, once its target has rerendered", async () => {
    let callCount = 0;
    const provider = stubProvider(async (request) => {
      callCount++;
      const options = (request.questions[0] as { options: string[] }).options;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.99 }] };
    });
    const adapter = new TestHarnessAdapter({ html: CACHE_FIXTURE_HTML, url: `${ORIGIN}/` });
    const sculpt = await Sculpt.attach({
      adapter,
      authority: { semanticResolution: "enabled" },
      semantic: { provider, calibration: new StaticCalibrationRegistry([THRESHOLD]) }
    });
    try {
      // First call: a genuine miss, the provider decides.
      await sculpt.ui.find({ kind: "button", name: "Save" });
      // Second call, page unchanged: served from the cache (#25) — the
      // provider is never asked again.
      const cached = await sculpt.ui.find({ kind: "button", name: "Save" });
      expect(callCount).toBe(1);

      const evidence = await sculpt.foundation.observers.evidence();
      const guard = cached.guardFrom(evidence);

      // Now the page moves on — an SPA rerender replaces the tied region
      // with new elements, after the cached decision was already served.
      let replacementClicked = false;
      adapter.document.getElementById("container")!.innerHTML =
        '<button id="page-save-2" type="button">Save</button>' +
        '<div role="dialog" aria-label="Confirm changes"><button id="dialog-save-2" type="button">Save</button></div>';
      adapter.document.getElementById("page-save-2")?.addEventListener("click", () => {
        replacementClicked = true;
      });
      adapter.document.getElementById("dialog-save-2")?.addEventListener("click", () => {
        replacementClicked = true;
      });

      const result = await cached.click({ guard, recovery: { retryLimit: 0 } });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TARGET_STALE");
      expect(replacementClicked).toBe(false);
      // Still just the one provider call from the very first, uncached decision.
      expect(callCount).toBe(1);
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("DP-1 disambiguation: a tied set wider than the tie-detection query's own limit", () => {
  const SIX_WAY_TIE_HTML = `<!doctype html><html><body>
    ${Array.from({ length: 6 }, (_, i) => `<button id="save-${i}" type="button">Save</button>`).join("\n")}
  </body></html>`;

  it("still sees every tied candidate as a DP-1 option, not just the first 5", async () => {
    let optionCount: number | undefined;
    const provider = stubProvider(async (request) => {
      const options = (request.questions[0] as { options: string[] }).options;
      optionCount = options.filter((o) => o !== "none").length;
      return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.99 }] };
    });
    const adapter = new TestHarnessAdapter({ html: SIX_WAY_TIE_HTML, url: `${ORIGIN}/` });
    const sculpt = await Sculpt.attach({ adapter, authority: { semanticResolution: "enabled" }, semantic: { provider } });
    try {
      await expect(sculpt.ui.find({ kind: "button", name: "Save" })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
    } finally {
      await sculpt.dispose();
    }
    expect(optionCount).toBe(6);
  });
});
