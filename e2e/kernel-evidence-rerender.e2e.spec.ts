import { test, expect } from "@playwright/test";
import { Sculpt } from "@sculptsdk/core";
import { PlaywrightAdapter } from "@sculptsdk/adapter-playwright";

/**
 * Kernel evidence on a real rerender (#15's verification: "one Playwright
 * rerender case on the #11 fixtures"). rerender-list.html fully replaces its
 * <li> elements (new DOM identity, same text) on a "Shuffle" click — exactly
 * the case the target evidence digest exists to catch.
 */

test.describe("kernel evidence survives a real-browser SPA-style rerender", () => {
  test("the target digest for a moved item changes; the document identity and navigation epoch do not", async ({
    page,
    baseURL
  }) => {
    await page.goto(`${baseURL}/rerender-list.html`);
    const sculpt = await Sculpt.attach({ adapter: new PlaywrightAdapter(page) });
    try {
      const before = await sculpt.foundation.dom.queryWithEvidence({ text: "Write report" });
      expect(before.candidates.length).toBeGreaterThan(0);
      const digestBefore = before.candidates[0]!.identity.id;

      const shuffle = await sculpt.ui.find({ kind: "button", name: "Shuffle" });
      const click = await shuffle.click();
      expect(click.ok).toBe(true);

      const after = await sculpt.foundation.dom.queryWithEvidence({ text: "Write report" });
      const digestAfter = after.candidates[0]!.identity.id;

      // A pure DOM rerender: no navigation, no reload — the page-level
      // evidence is unchanged, but the element itself is a new node at a
      // new position, so its target digest changes.
      expect(after.evidence.documentId).toBe(before.evidence.documentId);
      expect(after.evidence.navigationEpoch).toBe(before.evidence.navigationEpoch);
      expect(digestAfter).not.toBe(digestBefore);
    } finally {
      await sculpt.dispose();
    }
  });
});
