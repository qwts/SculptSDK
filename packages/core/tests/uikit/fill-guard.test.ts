import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { Sculpt, type UIForm } from "@sculptsdk/core";

/**
 * Regression (Codex + Cursor Bugbot finding on #22/#35): `UIForm.fill({
 * submit: true, guard })` discarded the guarded submit's `ActionResult`, so
 * a caller could see `ok: true` even though the requested submission never
 * happened (e.g. a #22 guard mismatch after a fill-induced rerender).
 */

const FORM_HTML = `<!doctype html><html><body>
  <div id="container">
    <form id="signup">
      <label>Name <input name="name" type="text" /></label>
      <label>Email <input name="email" type="email" /></label>
      <button type="submit">Submit</button>
    </form>
  </div>
</body></html>`;

async function withForm<T>(fn: (sculpt: Sculpt, adapter: TestHarnessAdapter) => Promise<T>): Promise<T> {
  const adapter = new TestHarnessAdapter({ html: FORM_HTML });
  const sculpt = await Sculpt.attach({ adapter });
  try {
    return await fn(sculpt, adapter);
  } finally {
    await sculpt.dispose();
  }
}

describe("fill({ submit: true, guard }): a guarded submit failure is never swallowed", () => {
  it("a rerender during fill (form node swapped) makes fill() report ok: false with submitError, not a false ok: true", async () => {
    await withForm(async (sculpt, adapter) => {
      const form = (await sculpt.ui.find({ kind: "form" })) as UIForm;
      const evidence = await sculpt.foundation.observers.evidence();
      const guard = form.guardFrom(evidence);

      // Swap the form's own DOM node (new identity) synchronously, as a side
      // effect of the last field's "change" event — exactly like a real
      // app's controlled-form rerender happening mid-fill. The guard check
      // for the fill step itself already passed by the time this fires; the
      // follow-up submit() must be the one that catches it.
      adapter.document.querySelector('input[name="email"]')?.addEventListener("change", () => {
        adapter.document.getElementById("container")!.innerHTML = `
          <form id="signup">
            <label>Name <input name="name" type="text" /></label>
            <label>Email <input name="email" type="email" /></label>
            <button type="submit">Submit</button>
          </form>`;
      });

      const result = await form.fill({ Name: "Ada Lovelace", Email: "ada@example.com" }, { submit: true, guard });

      expect(result.ok).toBe(false);
      expect(result.submitError?.code).toBe("TARGET_STALE");
      // The fill itself still ran (against the pre-swap node) and is
      // reported, even though the requested submission never happened.
      expect(result.filled.map((f) => f.label).sort()).toEqual(["Email", "Name"]);
    });
  });

  it("a valid guard through both fill and submit still succeeds end to end", async () => {
    await withForm(async (sculpt, adapter) => {
      let submitted = false;
      adapter.document.getElementById("signup")?.addEventListener("submit", (e) => {
        e.preventDefault();
        submitted = true;
      });

      const form = (await sculpt.ui.find({ kind: "form" })) as UIForm;
      const evidence = await sculpt.foundation.observers.evidence();
      const guard = form.guardFrom(evidence);

      const result = await form.fill({ Name: "Ada Lovelace", Email: "ada@example.com" }, { submit: true, guard });

      expect(result.ok).toBe(true);
      expect(result.submitError).toBeUndefined();
      expect(submitted).toBe(true);
    });
  });
});
