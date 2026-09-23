import { test, expect } from "@playwright/test";
import { Sculpt } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * Execution guard on a real rerender (#22's verification: "a Playwright
 * rerender fixture test"). rerender-list.html fully replaces its <li>
 * elements (new DOM identity, same text) on a "Shuffle" click — exactly the
 * case the guard exists to catch: a decision made against one element must
 * never silently act on its replacement.
 */

test.describe("execution guard on a real Chromium rerender", () => {
  test("a target that rerendered between the decision and the click fails closed, never rebinding", async ({
    page,
    baseURL
  }) => {
    await page.goto(`${baseURL}/rerender-list.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      const item = await sculpt.ui.find({ text: "Write report", minConfidence: 0 });
      const evidence = await sculpt.foundation.observers.evidence();
      const guard = item.guardFrom(evidence);

      const shuffle = await sculpt.ui.find({ kind: "button", name: "Shuffle" });
      const shuffled = await shuffle.click();
      expect(shuffled.ok).toBe(true);

      const result = await item.click({ guard, recovery: { retryLimit: 0 } });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TARGET_STALE");
      expect(result.recoverySteps.some((step) => step.step === "rebind" && step.ok)).toBe(false);
    } finally {
      await sculpt.dispose();
    }
  });

  test("without a guard, the same rerendered handle still rebinds (unchanged default behavior)", async ({
    page,
    baseURL
  }) => {
    await page.goto(`${baseURL}/rerender-list.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      const item = await sculpt.ui.find({ text: "Write report", minConfidence: 0 });

      const shuffle = await sculpt.ui.find({ kind: "button", name: "Shuffle" });
      await shuffle.click();

      const result = await item.click();
      expect(result.ok).toBe(true);
      expect(result.recoverySteps.some((step) => step.step === "rebind" && step.ok)).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });
});
