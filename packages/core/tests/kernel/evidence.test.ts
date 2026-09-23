import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { Sculpt } from "@sculptsdk/core";
import { KERNEL_VERSION, type KernelCallEnvelope } from "@sculptsdk/core/kernel";

/**
 * Read-only kernel evidence (#15's kernel-protocol addition): a per-injection
 * document identity, a navigation epoch, and a frame id, returned with query
 * results and through a standalone `evidence` op. Additive — `KERNEL_VERSION`
 * bumped alongside it.
 */

describe("kernel evidence", () => {
  it("KERNEL_VERSION was bumped for the evidence addition", () => {
    expect(KERNEL_VERSION).not.toBe("0.1.0");
  });

  it("ping still reports the (bumped) kernel version", async () => {
    const adapter = new TestHarnessAdapter({ html: `<!doctype html><html><body></body></html>` });
    await adapter.call({ name: "kernel.ensure", source: "" });
    const envelope = await adapter.call<KernelCallEnvelope>({ name: "kernel.call", op: "ping" });
    expect(envelope.ok).toBe(true);
    expect((envelope.value as { version: string }).version).toBe(KERNEL_VERSION);
  });

  it("query results carry documentId/navigationEpoch/frameId, stable across independent queries", async () => {
    const adapter = new TestHarnessAdapter({
      html: `<!doctype html><html><body><button id="a">Save</button></body></html>`
    });
    const sculpt = await Sculpt.attach({ adapter });
    try {
      const first = await sculpt.foundation.dom.queryWithEvidence({ kind: "button", name: "Save" });
      const second = await sculpt.foundation.dom.queryWithEvidence({ kind: "button", name: "Save" });

      expect(first.evidence.documentId).toEqual(expect.any(String));
      expect(first.evidence.frameId).toBe("main");
      expect(first.evidence.navigationEpoch).toBe(0);
      // Same kernel injection, no navigation in between: identical evidence.
      expect(second.evidence).toEqual(first.evidence);
    } finally {
      await sculpt.dispose();
    }
  });

  it("the standalone evidence op matches query results, and navigationEpoch increments on navigation", async () => {
    const adapter = new TestHarnessAdapter({ html: `<!doctype html><html><body></body></html>` });
    const sculpt = await Sculpt.attach({ adapter });
    try {
      const before = await sculpt.foundation.observers.evidence();
      expect(before.navigationEpoch).toBe(0);

      await sculpt.page.navigate("http://fixtures.local/other");

      const after = await sculpt.foundation.observers.evidence();
      expect(after.navigationEpoch).toBe(before.navigationEpoch + 1);
      expect(after.documentId).toBe(before.documentId); // same in-page injection, no reload
    } finally {
      await sculpt.dispose();
    }
  });

  it("existing query() callers are unaffected by the additive evidence field", async () => {
    const adapter = new TestHarnessAdapter({
      html: `<!doctype html><html><body><button id="a">Save</button></body></html>`
    });
    const sculpt = await Sculpt.attach({ adapter });
    try {
      // The pre-#15 call shape: destructuring only `candidates` still works.
      const candidates = await sculpt.foundation.dom.query({ kind: "button", name: "Save" });
      expect(candidates).toHaveLength(1);
    } finally {
      await sculpt.dispose();
    }
  });
});
