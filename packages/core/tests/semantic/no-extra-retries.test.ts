import { describe, expect, it, vi } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { Sculpt } from "@sculptsdk/core";

/**
 * "No extra retries" (#15's scope): semantic work adds no retries after
 * dispatch and does not multiply the action runner's own retry loop. Since
 * m0 wires no production policy into `runAction` at all, this is also a
 * regression guard for later DP-1/DP-6 work, which must not change this.
 */

const HTML = `<!doctype html><html><body><button id="save-btn">Save</button></body></html>`;

async function clickAndCountResolveCalls(semanticResolution: "disabled" | "enabled"): Promise<number> {
  const adapter = new TestHarnessAdapter({ html: HTML });
  const sculpt = await Sculpt.attach({ adapter, authority: { semanticResolution } });
  try {
    const resolveSpy = vi.spyOn(sculpt.foundation.identity, "resolve");
    const button = await sculpt.ui.find({ kind: "button", name: "Save" });
    const result = await button.click();
    expect(result.ok).toBe(true);
    return resolveSpy.mock.calls.length;
  } finally {
    await sculpt.dispose();
  }
}

describe("no extra retries: semantic resolution on vs. off", () => {
  it("runAction makes the same number of attempts (identity.resolve calls) whether semantic resolution is on or off", async () => {
    const attemptsDisabled = await clickAndCountResolveCalls("disabled");
    const attemptsEnabled = await clickAndCountResolveCalls("enabled");

    expect(attemptsEnabled).toBe(attemptsDisabled);
    // Sanity: a successful click on a present, enabled, visible button takes
    // exactly one attempt — this isn't vacuously comparing two zeros.
    expect(attemptsDisabled).toBe(1);
  });
});
