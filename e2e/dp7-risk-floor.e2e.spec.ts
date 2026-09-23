import { test, expect } from "@playwright/test";
import { Sculpt } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * DP-7 deterministic risk floor on real Chromium pages (#26's verification:
 * "Playwright tests on the DP-7 fixtures"). Each fixture carries the risk
 * keyword through a different signal — delete-account via the clicked
 * button's own accessible name, place-order via the submitted form's
 * `action` attribute, send-message via the form's visible text — so all
 * three of the floor's inputs get real-browser coverage.
 */

test.describe("DP-7 risk floor on real Chromium pages", () => {
  test("delete-account: a destructive click escalates, never dispatched", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/delete-account.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page), authority: { semanticResolution: "enabled" } });
    try {
      const result = await sculpt.ui.button({ name: "Delete my account" }).click();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      await expect(page.locator("#status")).toHaveText("");
    } finally {
      await sculpt.dispose();
    }
  });

  test("place-order: a benign button text still escalates via the form's own action attribute", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/place-order.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page), authority: { semanticResolution: "enabled" } });
    try {
      const result = await sculpt.ui.form().submit();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      await expect(page.locator("#status")).toHaveText("");
    } finally {
      await sculpt.dispose();
    }
  });

  test("send-message: escalates via the form's own visible text, not the submit button's name", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/send-message.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page), authority: { semanticResolution: "enabled" } });
    try {
      const result = await sculpt.ui.form().submit();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      await expect(page.locator("#status")).toHaveText("");
    } finally {
      await sculpt.dispose();
    }
  });

  test("disabled parity: with semanticResolution off, the same destructive click dispatches normally", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/delete-account.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      const result = await sculpt.ui.button({ name: "Delete my account" }).click();
      expect(result.ok).toBe(true);
      await expect(page.locator("#status")).toHaveText("account deleted");
    } finally {
      await sculpt.dispose();
    }
  });
});
