import { test, expect } from "@playwright/test";
import {
  CLICK_MATERIAL_DIGEST,
  RISK_FLOOR_POLICY_VERSION,
  Sculpt,
  type ConfirmationGrant
} from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * DP-7 single-use confirmation grants on a real Chromium page (#27's
 * verification: "Playwright tests on the DP-7 fixtures"). Reuses
 * delete-account.html from #26.
 */

test.describe("DP-7 confirmation grants on a real Chromium page", () => {
  test("a valid grant clears the floor once; reusing it is rejected", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/delete-account.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page), authority: { semanticResolution: "enabled" } });
    try {
      const button = await sculpt.ui.button({ name: "Delete my account" });
      const evidence = await sculpt.foundation.observers.evidence();
      const route = await sculpt.foundation.observers.routeState();
      const grant: ConfirmationGrant = {
        grantId: "grant-e2e-1",
        actionType: "click",
        targetDigest: button.identity.id,
        documentId: evidence.documentId,
        navigationEpoch: evidence.navigationEpoch,
        origin: new URL(route.url).origin,
        materialDigest: CLICK_MATERIAL_DIGEST,
        policyVersion: RISK_FLOOR_POLICY_VERSION,
        riskDecision: "delete",
        expiresAt: Date.now() + 60_000
      };

      const first = await button.click({ confirmation: grant });
      expect(first.ok).toBe(true);
      await expect(page.locator("#status")).toHaveText("account deleted");

      const second = await button.click({ confirmation: grant });
      expect(second.ok).toBe(false);
      expect(second.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(second.error?.details?.reason).toBe("reused");
    } finally {
      await sculpt.dispose();
    }
  });

  test("an expired grant is rejected, and nothing is clicked", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/delete-account.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page), authority: { semanticResolution: "enabled" } });
    try {
      const button = await sculpt.ui.button({ name: "Delete my account" });
      const evidence = await sculpt.foundation.observers.evidence();
      const route = await sculpt.foundation.observers.routeState();
      const grant: ConfirmationGrant = {
        grantId: "grant-e2e-2",
        actionType: "click",
        targetDigest: button.identity.id,
        documentId: evidence.documentId,
        navigationEpoch: evidence.navigationEpoch,
        origin: new URL(route.url).origin,
        materialDigest: CLICK_MATERIAL_DIGEST,
        policyVersion: RISK_FLOOR_POLICY_VERSION,
        riskDecision: "delete",
        expiresAt: Date.now() - 1000
      };

      const result = await button.click({ confirmation: grant });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(result.error?.details?.reason).toBe("expired");
      await expect(page.locator("#status")).toHaveText("");
    } finally {
      await sculpt.dispose();
    }
  });
});
