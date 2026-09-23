import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { createKernel, type KernelCallEnvelope } from "@sculptsdk/core/kernel";

/**
 * Regression (Codex finding on #22/#35): `history.pushState`/`replaceState`
 * are patched at most once per window, closing over the patching call's
 * kernel context. A newer kernel injected over an older one (no reload in
 * between — e.g. two adapter instances, or a version bump between attaches)
 * must still have navigation tracked against *its own* context, not the
 * abandoned old one, or a #22 guard could see a stale, never-incrementing
 * navigationEpoch and let a guarded action through after a real navigation.
 */

describe("route tracking survives a kernel version replacement in the same window", () => {
  it("pushState notifies the newly installed kernel, not the one it replaced", async () => {
    const adapter = new TestHarnessAdapter({ html: `<!doctype html><html><body></body></html>` });
    const win = adapter.pageWindow;

    const oldKernel = createKernel(win);
    // Simulate "another SDK instance already installed an older kernel in
    // this window" without needing two real KERNEL_VERSION builds.
    (win as unknown as { __sculpt__: { version: string } }).__sculpt__.version = "0.0.0-old";

    const newKernel = createKernel(win);
    expect(newKernel).not.toBe(oldKernel);

    win.history.pushState({}, "", "http://fixtures.local/elsewhere");

    const envelope = (await newKernel.call("evidence")) as KernelCallEnvelope;
    expect(envelope.ok).toBe(true);
    expect((envelope.value as { navigationEpoch: number }).navigationEpoch).toBe(1);
  });

  it("replaceState also notifies the newly installed kernel", async () => {
    const adapter = new TestHarnessAdapter({ html: `<!doctype html><html><body></body></html>` });
    const win = adapter.pageWindow;

    createKernel(win);
    (win as unknown as { __sculpt__: { version: string } }).__sculpt__.version = "0.0.0-old";
    const newKernel = createKernel(win);

    win.history.replaceState({}, "", "http://fixtures.local/elsewhere");

    const envelope = (await newKernel.call("evidence")) as KernelCallEnvelope;
    expect((envelope.value as { navigationEpoch: number }).navigationEpoch).toBe(1);
  });

  it("the abandoned old kernel's own context no longer advances (it was replaced, not shared)", async () => {
    const adapter = new TestHarnessAdapter({ html: `<!doctype html><html><body></body></html>` });
    const win = adapter.pageWindow;

    const oldKernel = createKernel(win);
    (win as unknown as { __sculpt__: { version: string } }).__sculpt__.version = "0.0.0-old";
    createKernel(win);

    win.history.pushState({}, "", "http://fixtures.local/elsewhere");

    const envelope = (await oldKernel.call("evidence")) as KernelCallEnvelope;
    expect((envelope.value as { navigationEpoch: number }).navigationEpoch).toBe(0);
  });
});
