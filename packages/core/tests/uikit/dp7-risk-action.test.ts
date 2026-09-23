import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import {
  ProviderUnavailableError,
  Sculpt,
  StaticCalibrationRegistry,
  DP7_CALIBRATION_MODE,
  type CalibrationThreshold,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse
} from "@sculptsdk/core";

/**
 * DP-7 semantic risk predicates wired into the real `runAction` path
 * (#28): escalate-only, combined with the #26 floor via OR — semantic
 * evidence only ever runs when the floor missed, and can only add
 * friction, never remove it.
 */

const ORIGIN = "http://fixtures.local";
const THRESHOLD: CalibrationThreshold = {
  point: "dp7-risk",
  model: "unset",
  policyVersion: "v1",
  questionVersion: "v1",
  mode: DP7_CALIBRATION_MODE,
  minConfidence: 0.5
};

// Mislabeled: "Archive" doesn't match any #26 keyword, but it permanently
// removes the item — exactly the gap DP-7 exists to catch.
const MISLABELED_HTML = `<!doctype html><html><body>
  <button id="archive-btn" type="button">Archive</button>
</body></html>`;

function stubProvider(impl: (request: DecisionRequest) => Promise<RawDecisionResponse>): DecisionProvider {
  return { id: "stub", supports: () => true, decide: impl };
}

function escalateAnswers(): RawDecisionResponse {
  return {
    answers: [
      { kind: "probability", questionId: "destructive", value: 0.95 },
      { kind: "probability", questionId: "financial", value: 0 },
      { kind: "probability", questionId: "external-communication", value: 0 },
      { kind: "probability", questionId: "account-security", value: 0 },
      { kind: "probability", questionId: "requires-confirmation", value: 0.9 }
    ]
  };
}

function noRiskAnswers(): RawDecisionResponse {
  return {
    answers: [
      { kind: "probability", questionId: "destructive", value: 0 },
      { kind: "probability", questionId: "financial", value: 0 },
      { kind: "probability", questionId: "external-communication", value: 0 },
      { kind: "probability", questionId: "account-security", value: 0 },
      { kind: "probability", questionId: "requires-confirmation", value: 0 }
    ]
  };
}

async function attach(semantic?: Parameters<typeof Sculpt.attach>[0]["semantic"]): Promise<Sculpt> {
  const adapter = new TestHarnessAdapter({ html: MISLABELED_HTML, url: `${ORIGIN}/` });
  return Sculpt.attach({ adapter, authority: { semanticResolution: "enabled" }, semantic });
}

describe("DP-7: semantic evidence escalates a mislabeled destructive action the floor misses", () => {
  it("a calibrated escalating answer produces CONFIRMATION_REQUIRED even though no keyword matched", async () => {
    const sculpt = await attach({ provider: stubProvider(async () => escalateAnswers()), calibration: new StaticCalibrationRegistry([THRESHOLD]) });
    try {
      const result = await sculpt.ui.button({ name: "Archive" }).click();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
    } finally {
      await sculpt.dispose();
    }
  });

  it("without calibration (shadow mode), the same escalating answer never blocks the action", async () => {
    let clicked = false;
    const adapter = new TestHarnessAdapter({ html: MISLABELED_HTML, url: `${ORIGIN}/` });
    adapter.document.getElementById("archive-btn")?.addEventListener("click", () => {
      clicked = true;
    });
    const sculpt = await Sculpt.attach({
      adapter,
      authority: { semanticResolution: "enabled" },
      semantic: { provider: stubProvider(async () => escalateAnswers()) }
    });
    try {
      const result = await sculpt.ui.button({ name: "Archive" }).click();
      expect(result.ok).toBe(true);
      expect(clicked).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });

  it("a non-escalating answer never blocks the action", async () => {
    const sculpt = await attach({ provider: stubProvider(async () => noRiskAnswers()), calibration: new StaticCalibrationRegistry([THRESHOLD]) });
    try {
      const result = await sculpt.ui.button({ name: "Archive" }).click();
      expect(result.ok).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });

  it("a confirmation grant clears a semantic-only escalation the same way it clears a floor hit", async () => {
    const sculpt = await attach({ provider: stubProvider(async () => escalateAnswers()), calibration: new StaticCalibrationRegistry([THRESHOLD]) });
    try {
      const button = await sculpt.ui.button({ name: "Archive" });
      const evidence = await sculpt.foundation.observers.evidence();
      const route = await sculpt.foundation.observers.routeState();
      const result = await button.click({
        confirmation: {
          grantId: "grant-dp7",
          actionType: "click",
          targetDigest: button.identity.id,
          documentId: evidence.documentId,
          navigationEpoch: evidence.navigationEpoch,
          origin: new URL(route.url).origin,
          materialDigest: "click:no-material",
          policyVersion: "v1",
          riskDecision: "semantic-risk",
          expiresAt: Date.now() + 60_000
        }
      });
      expect(result.ok).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("DP-7: degradation classes wired into the action", () => {
  const outageProvider = stubProvider(async () => {
    throw new ProviderUnavailableError("timeout");
  });

  it("advisory (default): a provider outage never blocks an action the floor didn't already flag", async () => {
    const sculpt = await attach({ provider: outageProvider, calibration: new StaticCalibrationRegistry([THRESHOLD]) });
    try {
      const result = await sculpt.ui.button({ name: "Archive" }).click();
      expect(result.ok).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });

  it("required: a provider outage stops the action outright, with no grant able to clear it", async () => {
    const adapter = new TestHarnessAdapter({ html: MISLABELED_HTML, url: `${ORIGIN}/` });
    const sculpt = await Sculpt.attach({
      adapter,
      authority: { semanticResolution: "enabled" },
      semantic: { provider: outageProvider, calibration: new StaticCalibrationRegistry([THRESHOLD]), dp7RiskDegradation: "required" }
    });
    try {
      const button = await sculpt.ui.button({ name: "Archive" });
      const evidence = await sculpt.foundation.observers.evidence();
      const route = await sculpt.foundation.observers.routeState();
      const result = await button.click({
        confirmation: {
          grantId: "grant-required-outage",
          actionType: "click",
          targetDigest: button.identity.id,
          documentId: evidence.documentId,
          navigationEpoch: evidence.navigationEpoch,
          origin: new URL(route.url).origin,
          materialDigest: "click:no-material",
          policyVersion: "v1",
          riskDecision: "semantic-risk",
          expiresAt: Date.now() + 60_000
        }
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      expect(result.error?.details?.reason).toBe("required-risk-check-unavailable");
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("DP-7: escalate-only — never clears a floor hit, whatever the stub answers", () => {
  const DELETE_HTML = `<!doctype html><html><body><button id="delete-btn" type="button">Delete account</button></body></html>`;

  it("a semantic answer that says 'not risky' does not clear a keyword floor hit", async () => {
    const adapter = new TestHarnessAdapter({ html: DELETE_HTML, url: `${ORIGIN}/` });
    let called = false;
    const provider = stubProvider(async () => {
      called = true;
      return noRiskAnswers();
    });
    const sculpt = await Sculpt.attach({
      adapter,
      authority: { semanticResolution: "enabled" },
      semantic: { provider, calibration: new StaticCalibrationRegistry([THRESHOLD]) }
    });
    try {
      const result = await sculpt.ui.button({ name: "Delete account" }).click();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      // DP-7 is never even consulted when the floor already matched (I9).
      expect(called).toBe(false);
    } finally {
      await sculpt.dispose();
    }
  });
});
