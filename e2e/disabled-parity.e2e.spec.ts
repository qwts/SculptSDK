import { test, expect } from "@playwright/test";
import { Sculpt, type DecisionProvider, type DecisionRequest, type RawDecisionResponse, type UIForm } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * Disabled-parity, run once against a real browser (#14's acceptance
 * criteria: "The parity suite also runs once on the Playwright fixtures
 * from #11."). The happy-dom suite (packages/core/tests/semantic/
 * disabled-parity.test.ts) covers the full flow matrix; this confirms the
 * same guarantee holds end to end through the real Playwright adapter.
 */

class SpyProvider implements DecisionProvider {
  readonly id = "spy";
  calls = 0;
  supports(): boolean {
    this.calls++;
    return true;
  }
  async decide(_request: DecisionRequest): Promise<RawDecisionResponse> {
    this.calls++;
    return { answers: [] };
  }
}

test.describe("disabled parity on a real Chromium page", () => {
  test("form fill+submit is identical with authority absent vs. disabled-with-a-provider-passed, and the provider sees zero calls", async ({
    page,
    baseURL
  }) => {
    await page.goto(`${baseURL}/form.html`);
    const sculptAbsent = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    let resultAbsent: { ok: boolean; filled: string[] };
    try {
      const form = (await sculptAbsent.ui.find({ kind: "form" })) as UIForm;
      const fill = await form.fill({ Name: "Ada Lovelace", Email: "ada@example.com" }, { submit: true });
      resultAbsent = { ok: fill.ok, filled: fill.filled.map((f) => f.label).sort() };
    } finally {
      await sculptAbsent.dispose();
    }
    const statusAbsent = await page.locator("#status").textContent();

    await page.goto(`${baseURL}/form.html`);
    const spy = new SpyProvider();
    const sculptDisabled = await Sculpt.attach({
      adapter: new PlaywrightAdapter(page),
      authority: { semanticResolution: "disabled" },
      semantic: { provider: spy }
    });
    let resultDisabled: { ok: boolean; filled: string[] };
    try {
      const form = (await sculptDisabled.ui.find({ kind: "form" })) as UIForm;
      const fill = await form.fill({ Name: "Ada Lovelace", Email: "ada@example.com" }, { submit: true });
      resultDisabled = { ok: fill.ok, filled: fill.filled.map((f) => f.label).sort() };
    } finally {
      await sculptDisabled.dispose();
    }
    const statusDisabled = await page.locator("#status").textContent();

    expect(resultDisabled).toEqual(resultAbsent);
    expect(statusDisabled).toBe(statusAbsent);
    expect(spy.calls).toBe(0);
  });
});
