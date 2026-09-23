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
 * DP-1 opt-in recall on a miss (#24): text matchers (`name`/`text`) are
 * dropped, every other predicate stays exactly as mandatory as in #23's
 * disambiguation, retrieval is capped, and it's off by default even with
 * DP-1 enabled.
 */

const ORIGIN = "http://fixtures.local";
const THRESHOLD: CalibrationThreshold = {
  point: "dp1-target",
  model: "unset",
  policyVersion: "v1",
  questionVersion: "v1",
  mode: "miss",
  minConfidence: 0.5
};

const SYNONYM_HTML = `<!doctype html><html><body>
  <button id="hidden-btn" style="display:none">Log in</button>
  <button id="disabled-btn" disabled>Log in</button>
  <button id="real-btn">Log in</button>
</body></html>`;

function stubProvider(impl: (request: DecisionRequest) => Promise<RawDecisionResponse>): DecisionProvider {
  return { id: "stub", supports: () => true, decide: impl };
}

async function attach(html: string, semantic: Parameters<typeof Sculpt.attach>[0]["semantic"]): Promise<Sculpt> {
  const adapter = new TestHarnessAdapter({ html, url: `${ORIGIN}/` });
  return Sculpt.attach({ adapter, authority: { semanticResolution: "enabled" }, semantic });
}

describe("DP-1 recall: off by default even when DP-1 is enabled", () => {
  it("a miss with recall unset returns null and never engages the provider", async () => {
    let called = false;
    const provider = stubProvider(async () => {
      called = true;
      return { answers: [] };
    });
    const sculpt = await attach(SYNONYM_HTML, { provider, calibration: new StaticCalibrationRegistry([THRESHOLD]) });
    try {
      const found = await sculpt.ui.tryFind({ kind: "button", name: "Sign in", visible: true, enabled: true });
      expect(found).toBeNull();
      expect(called).toBe(false);
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("DP-1 recall: every non-text predicate stays mandatory", () => {
  it("the shortlist never includes a hidden or disabled candidate, even though only name/text were dropped", async () => {
    let capturedRequest: DecisionRequest | undefined;
    const provider = stubProvider(async (request) => {
      capturedRequest = request;
      return { answers: [] }; // shadow mode anyway (no calibration) -- capture only
    });
    const sculpt = await attach(SYNONYM_HTML, { provider });
    try {
      const found = await sculpt.ui.tryFind({ kind: "button", name: "Sign in", visible: true, enabled: true, recall: true });
      expect(found).toBeNull(); // no calibration: shadow mode, never accepts
      expect(capturedRequest).toBeDefined();
      const options = (capturedRequest!.questions[0] as { options: string[] }).options.filter((o) => o !== "none");
      expect(options).toHaveLength(1); // only the visible, enabled "Log in" button
    } finally {
      await sculpt.dispose();
    }
  });

  it("accepts the recalled synonym once a calibration artifact exists", async () => {
    // First pass: capture the exact request the runtime builds for recall.
    let capturedRequest: DecisionRequest | undefined;
    const capturing = await attach(SYNONYM_HTML, {
      provider: stubProvider(async (request) => {
        capturedRequest = request;
        const options = (request.questions[0] as { options: string[] }).options;
        return { answers: [{ kind: "choice", questionId: "target", selected: options[0]!, providerConfidence: 0.9 }] };
      })
    });
    try {
      await capturing.ui.tryFind({ kind: "button", name: "Sign in", visible: true, enabled: true, recall: true });
    } finally {
      await capturing.dispose();
    }
    expect(capturedRequest).toBeDefined();
    const chosenId = (capturedRequest!.questions[0] as { options: string[] }).options[0]!;

    // Second pass: RecordedProvider replays it, and calibration now exists.
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [
        RecordedProvider.recordEntry(capturedRequest!, {
          answers: [{ kind: "choice", questionId: "target", selected: chosenId, providerConfidence: 0.9 }]
        })
      ]
    };
    const replaying = await attach(SYNONYM_HTML, {
      provider: new RecordedProvider(file),
      calibration: new StaticCalibrationRegistry([THRESHOLD])
    });
    try {
      const found = await replaying.ui.tryFind({ kind: "button", name: "Sign in", visible: true, enabled: true, recall: true });
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Log in");
    } finally {
      await replaying.dispose();
    }
  });

  it("find() throws TARGET_NOT_FOUND with the recall shortlist and record attached, when nothing was accepted", async () => {
    const provider = stubProvider(async () => ({ answers: [] }));
    const sculpt = await attach(SYNONYM_HTML, { provider });
    try {
      await expect(sculpt.ui.find({ kind: "button", name: "Sign in", visible: true, enabled: true, recall: true })).rejects.toMatchObject(
        {
          code: "TARGET_NOT_FOUND",
          details: { semantic: { point: "dp1-target" } }
        }
      );
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("DP-1 recall: never sends the URL hash fragment as route state", () => {
  it("routePath is the pathname only, even when the page URL carries a token-bearing hash", async () => {
    let capturedRoute: string | undefined;
    const provider = stubProvider(async (request) => {
      capturedRoute = (request.redactedState as { route: string }).route;
      return { answers: [] };
    });
    const adapter = new TestHarnessAdapter({ html: SYNONYM_HTML, url: `${ORIGIN}/login#access_token=super-secret-token` });
    const sculpt = await Sculpt.attach({ adapter, authority: { semanticResolution: "enabled" }, semantic: { provider } });
    try {
      await sculpt.ui.tryFind({ kind: "button", name: "Sign in", visible: true, enabled: true, recall: true });
    } finally {
      await sculpt.dispose();
    }
    expect(capturedRoute).toBeDefined();
    expect(capturedRoute).not.toContain("access_token");
    expect(capturedRoute).not.toContain("#");
    expect(capturedRoute).toBe("/login");
  });
});

describe("DP-1 recall: deterministic, capped retrieval", () => {
  it("never exceeds DP1_RECALL_CAP (32) even with far more structurally-matching candidates", async () => {
    const buttons = Array.from({ length: 40 }, (_, i) => `<button id="btn-${i}">Item ${i}</button>`).join("\n");
    const html = `<!doctype html><html><body>${buttons}</body></html>`;

    let capturedRequest: DecisionRequest | undefined;
    const provider = stubProvider(async (request) => {
      capturedRequest = request;
      return { answers: [] };
    });
    const sculpt = await attach(html, { provider });
    try {
      await sculpt.ui.tryFind({ kind: "button", name: "Nobody has this name", recall: true });
      expect(capturedRequest).toBeDefined();
      const options = (capturedRequest!.questions[0] as { options: string[] }).options.filter((o) => o !== "none");
      expect(options.length).toBeLessThanOrEqual(32);
    } finally {
      await sculpt.dispose();
    }
  });
});
