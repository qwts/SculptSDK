import { describe, expect, it } from "vitest";
import { adapterConformanceTests, TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { Sculpt } from "@sculptsdk/core";

describe("adapter conformance (TestHarnessAdapter / happy-dom)", () => {
  for (const test of adapterConformanceTests(() => new TestHarnessAdapter())) {
    it(test.name, test.run);
  }
});

describe("Sculpt.attach -> ui.find -> click (happy-dom round trip)", () => {
  it("finds a button by its accessible name and clicks it", async () => {
    const adapter = new TestHarnessAdapter({
      html: `<!doctype html><html><body>
        <button id="save-btn">Save</button>
      </body></html>`
    });

    let clicked = false;
    adapter.document.getElementById("save-btn")?.addEventListener("click", () => {
      clicked = true;
    });

    const sculpt = await Sculpt.attach({ adapter });
    try {
      const button = await sculpt.ui.find({ kind: "button", name: "Save" });
      expect(button.kind).toBe("button");
      expect(button.name).toBe("Save");

      const result = await button.click();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("click");
      expect(result.error).toBeUndefined();
      expect(clicked).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });

  it("reports TARGET_NOT_FOUND for a query that matches nothing", async () => {
    const adapter = new TestHarnessAdapter({ html: `<!doctype html><html><body></body></html>` });
    const sculpt = await Sculpt.attach({ adapter });
    try {
      await expect(sculpt.ui.find({ kind: "button", name: "Does not exist" })).rejects.toMatchObject({
        code: "TARGET_NOT_FOUND"
      });
    } finally {
      await sculpt.dispose();
    }
  });
});
