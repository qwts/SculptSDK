import { test, expect } from "@playwright/test";
import { Sculpt, type UIForm } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * Chromium e2e suite (#11): drives the real Playwright adapter against the
 * static fixtures in packages/fixtures. No decision provider is configured
 * or reachable — this exercises today's deterministic behavior only.
 */

test.describe("Sculpt against a real Chromium page", () => {
  test("find + click a button", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/rerender-list.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      const before = await page.locator("#list li").first().textContent();
      expect(before).toBe("Write report");

      const button = await sculpt.ui.find({ kind: "button", name: "Shuffle" });
      const result = await button.click();

      expect(result.ok).toBe(true);
      const after = await page.locator("#list li").first().textContent();
      expect(after).toBe("Plan sprint");
    } finally {
      await sculpt.dispose();
    }
  });

  test("form fill and submit", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/form.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      const form = (await sculpt.ui.find({ kind: "form" })) as UIForm;
      expect(form.kind).toBe("form");

      const fillResult = await form.fill(
        { Name: "Ada Lovelace", Email: "ada@example.com" },
        { submit: true }
      );

      expect(fillResult.ok).toBe(true);
      expect(fillResult.unmapped).toEqual([]);
      expect(fillResult.ambiguous).toEqual([]);
      expect(fillResult.filled.map((f) => f.label).sort()).toEqual(["Email", "Name"]);

      await expect(page.locator("#status")).toHaveText("submitted: Ada Lovelace <ada@example.com>");
    } finally {
      await sculpt.dispose();
    }
  });

  test("TARGET_AMBIGUOUS on a duplicate Save button", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/duplicate-save.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      await expect(sculpt.ui.find({ kind: "button", name: "Save" })).rejects.toMatchObject({
        code: "TARGET_AMBIGUOUS"
      });
    } finally {
      await sculpt.dispose();
    }
  });
});
