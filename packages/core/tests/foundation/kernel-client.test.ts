import { describe, expect, it } from "vitest";
import { KernelClient, SculptError } from "@sculptsdk/core";
import type {
  BrowserCapabilities,
  EvaluationOptions,
  RuntimeAdapter,
  RuntimeEventHandler,
  RuntimeEventType,
  RuntimeOperation,
  SerializableFunction,
  Subscription
} from "@sculptsdk/core";

type Call = { name: "ensure" } | { name: "call"; op: string; args?: unknown };

/** A minimal RuntimeAdapter double that can simulate a lost (navigated-away) kernel. */
class FakeAdapter implements RuntimeAdapter {
  readonly id = "fake-1";
  readonly kind = "test-harness" as const;
  readonly executionWorld = "main-world" as const;

  calls: Call[] = [];
  kernelPresent: boolean;

  constructor(options: { kernelPresent: boolean }) {
    this.kernelPresent = options.kernelPresent;
  }

  async capabilities(): Promise<BrowserCapabilities> {
    throw new Error("not used in this test");
  }

  async evaluate<T>(_fn: SerializableFunction, _args?: unknown[], _options?: EvaluationOptions): Promise<T> {
    throw new Error("not used in this test");
  }

  async call<T>(operation: RuntimeOperation): Promise<T> {
    if (operation.name === "kernel.ensure") {
      this.calls.push({ name: "ensure" });
      this.kernelPresent = true;
      return undefined as T;
    }
    if (operation.name === "kernel.call") {
      this.calls.push({ name: "call", op: operation.op, args: operation.args });
      if (!this.kernelPresent) {
        return { __noKernel: true } as T;
      }
      if (operation.op === "boom") {
        return { ok: false, error: { code: "TARGET_NOT_FOUND", message: "gone" } } as T;
      }
      return { ok: true, value: { echoedOp: operation.op, args: operation.args } } as T;
    }
    throw new Error(`unexpected operation ${operation.name}`);
  }

  subscribe(_eventType: RuntimeEventType, _handler: RuntimeEventHandler): Subscription {
    throw new Error("not used in this test");
  }

  async dispose(): Promise<void> {}
}

describe("KernelClient", () => {
  it("dispatches directly when the kernel is present", async () => {
    const adapter = new FakeAdapter({ kernelPresent: true });
    const client = new KernelClient(adapter, "SOURCE");

    const value = await client.call<{ echoedOp: string }>("ping");

    expect(value).toEqual({ echoedOp: "ping", args: undefined });
    expect(adapter.calls).toEqual([{ name: "call", op: "ping", args: undefined }]);
  });

  it("reinjects the kernel exactly once and retries after a lost kernel", async () => {
    const adapter = new FakeAdapter({ kernelPresent: false });
    const client = new KernelClient(adapter, "SOURCE");

    const value = await client.call<{ echoedOp: string }>("query", { limit: 5 });

    expect(value).toEqual({ echoedOp: "query", args: { limit: 5 } });
    expect(adapter.calls).toEqual([
      { name: "call", op: "query", args: { limit: 5 } },
      { name: "ensure" },
      { name: "call", op: "query", args: { limit: 5 } }
    ]);
  });

  it("ensure() re-injection actually restores the kernel for subsequent calls too", async () => {
    const adapter = new FakeAdapter({ kernelPresent: false });
    const client = new KernelClient(adapter, "SOURCE");

    await client.call("first");
    adapter.calls.length = 0;
    const value = await client.call<{ echoedOp: string }>("second");

    // The second call finds the kernel already present from the first reinject.
    expect(value).toEqual({ echoedOp: "second", args: undefined });
    expect(adapter.calls).toEqual([{ name: "call", op: "second", args: undefined }]);
  });

  it("throws a SculptError built from the kernel's error envelope", async () => {
    const adapter = new FakeAdapter({ kernelPresent: true });
    const client = new KernelClient(adapter, "SOURCE");

    await expect(client.call("boom")).rejects.toMatchObject({
      code: "TARGET_NOT_FOUND"
    });
    await expect(client.call("boom")).rejects.toBeInstanceOf(SculptError);
  });

  it("explicit ensure() installs the kernel via kernel.ensure with the client's source", async () => {
    const adapter = new FakeAdapter({ kernelPresent: false });
    const client = new KernelClient(adapter, "SOURCE");

    await client.ensure();

    expect(adapter.calls).toEqual([{ name: "ensure" }]);
    expect(adapter.kernelPresent).toBe(true);
  });
});
