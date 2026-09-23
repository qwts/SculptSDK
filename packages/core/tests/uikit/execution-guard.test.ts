import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { Sculpt } from "@sculptsdk/core";

/**
 * Execution guard (#22): once a decision has picked a target, the mutation
 * acts on that target or fails with a typed stale error — it never falls
 * back to rebinding a different element the way the unguarded path does.
 */

const FIXTURE_HTML = `<!doctype html><html><body>
  <div id="container"><button id="save-btn">Save</button></div>
</body></html>`;

async function withFixture<T>(fn: (sculpt: Sculpt, adapter: TestHarnessAdapter) => Promise<T>): Promise<T> {
  const adapter = new TestHarnessAdapter({ html: FIXTURE_HTML });
  const sculpt = await Sculpt.attach({ adapter });
  try {
    return await fn(sculpt, adapter);
  } finally {
    await sculpt.dispose();
  }
}

describe("execution guard: never rebinds implicitly", () => {
  it("an unchanged page: the guard matches and the click executes normally", async () => {
    await withFixture(async (sculpt, adapter) => {
      let clicked = false;
      adapter.document.getElementById("save-btn")?.addEventListener("click", () => {
        clicked = true;
      });

      const button = await sculpt.ui.find({ kind: "button", name: "Save" });
      const evidence = await sculpt.foundation.observers.evidence();
      const guard = button.guardFrom(evidence);

      const result = await button.click({ guard });

      expect(result.ok).toBe(true);
      expect(clicked).toBe(true);
    });
  });

  it("target rerendered before the click: a typed stale error, and the replacement is never clicked", async () => {
    await withFixture(async (sculpt, adapter) => {
      const button = await sculpt.ui.find({ kind: "button", name: "Save" });
      const evidence = await sculpt.foundation.observers.evidence();
      const guard = button.guardFrom(evidence);

      // Same visible text, but a genuinely different element (new DOM path) —
      // exactly the rerender case the guard exists to catch.
      let replacementClicked = false;
      adapter.document.getElementById("container")!.innerHTML = '<button id="save-btn-2">Save</button>';
      adapter.document.getElementById("save-btn-2")?.addEventListener("click", () => {
        replacementClicked = true;
      });

      const result = await button.click({ guard, recovery: { retryLimit: 0 } });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TARGET_STALE");
      expect(result.error?.details?.guardReason).toBeDefined();
      expect(replacementClicked).toBe(false);
      // No rebind ever happened — the guard forbids it, unlike the default path.
      expect(result.recoverySteps.some((step) => step.step === "rebind" && step.ok)).toBe(false);
    });
  });

  it("the runAction retry path never rebinds under a guard, even across retries", async () => {
    await withFixture(async (sculpt, adapter) => {
      const button = await sculpt.ui.find({ kind: "button", name: "Save" });
      const evidence = await sculpt.foundation.observers.evidence();
      const guard = button.guardFrom(evidence);

      adapter.document.getElementById("container")!.innerHTML = '<button id="save-btn-2">Save</button>';

      // Default retryLimit (2): the guard fails the same way on every retry,
      // never rebinding to the replacement button.
      const result = await button.click({ guard });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TARGET_STALE");
      expect(result.recoverySteps.every((step) => !(step.step === "rebind" && step.ok))).toBe(true);
    });
  });

  it("a navigation after the guard was captured is also caught as stale", async () => {
    await withFixture(async (sculpt) => {
      const button = await sculpt.ui.find({ kind: "button", name: "Save" });
      const evidence = await sculpt.foundation.observers.evidence();
      const guard = button.guardFrom(evidence);

      await sculpt.page.navigate("http://fixtures.local/elsewhere");

      const result = await button.click({ guard, recovery: { retryLimit: 0 } });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TARGET_STALE");
      expect(result.error?.details?.guardReason).toContain("navigation epoch");
    });
  });

  it("without a guard, the default path still rebinds across a rerender (unchanged behavior)", async () => {
    await withFixture(async (sculpt, adapter) => {
      const button = await sculpt.ui.find({ kind: "button", name: "Save" });

      let replacementClicked = false;
      adapter.document.getElementById("container")!.innerHTML = '<button id="save-btn-2">Save</button>';
      adapter.document.getElementById("save-btn-2")?.addEventListener("click", () => {
        replacementClicked = true;
      });

      const result = await button.click();

      expect(result.ok).toBe(true);
      expect(replacementClicked).toBe(true);
    });
  });
});
