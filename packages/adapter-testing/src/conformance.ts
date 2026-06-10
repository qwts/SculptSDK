import type { RuntimeAdapter } from "@sculptsdk/core";
import type { KernelCallEnvelope } from "@sculptsdk/core/kernel";

/**
 * Adapter conformance suite (§6): framework-agnostic checks every
 * RuntimeAdapter implementation must pass. Run each entry inside your test
 * runner of choice:
 *
 *   for (const t of adapterConformanceTests(() => new MyAdapter(...)))
 *     it(t.name, () => t.run());
 */

export interface ConformanceTest {
  name: string;
  run: () => Promise<void>;
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`adapter conformance: ${message}`);
}

const CAPABILITY_GROUPS = [
  "dom",
  "accessibility",
  "layout",
  "input",
  "runtime",
  "network",
  "storage",
  "framework"
] as const;

export function adapterConformanceTests(
  factory: () => RuntimeAdapter | Promise<RuntimeAdapter>,
  options: { kernelSource?: string } = {}
): ConformanceTest[] {
  const withAdapter = async (use: (adapter: RuntimeAdapter) => Promise<void>): Promise<void> => {
    const adapter = await factory();
    try {
      await use(adapter);
    } finally {
      await adapter.dispose();
    }
  };

  return [
    {
      name: "declares id, kind, and execution world",
      run: () =>
        withAdapter(async (adapter) => {
          expect(typeof adapter.id === "string" && adapter.id.length > 0, "id must be a non-empty string");
          expect(typeof adapter.kind === "string", "kind must be set");
          expect(typeof adapter.executionWorld === "string", "executionWorld must be exposed");
        })
    },
    {
      name: "reports a complete capability object",
      run: () =>
        withAdapter(async (adapter) => {
          const caps = await adapter.capabilities();
          for (const group of CAPABILITY_GROUPS) {
            expect(typeof caps[group] === "object" && caps[group] !== null, `capability group "${group}" missing`);
          }
        })
    },
    {
      name: "kernel.ensure installs the kernel and ping responds",
      run: () =>
        withAdapter(async (adapter) => {
          await adapter.call({ name: "kernel.ensure", source: options.kernelSource ?? "" });
          const envelope = await adapter.call<KernelCallEnvelope>({ name: "kernel.call", op: "ping" });
          expect(envelope.ok === true, "ping must return an ok envelope");
          const value = envelope.value as { version?: string };
          expect(typeof value?.version === "string", "ping must report a kernel version");
        })
    },
    {
      name: "unknown kernel ops fail with a structured envelope, not a throw",
      run: () =>
        withAdapter(async (adapter) => {
          await adapter.call({ name: "kernel.ensure", source: options.kernelSource ?? "" });
          const envelope = await adapter.call<KernelCallEnvelope>({
            name: "kernel.call",
            op: "definitely-not-an-op"
          });
          expect(envelope.ok === false, "unknown op must produce ok:false");
          expect(typeof envelope.error?.code === "string", "error envelope must carry a code");
        })
    },
    {
      name: "subscriptions can be created and torn down",
      run: () =>
        withAdapter(async (adapter) => {
          const subscription = adapter.subscribe("navigation", () => {});
          expect(typeof subscription.unsubscribe === "function", "subscribe must return an unsubscribe handle");
          subscription.unsubscribe();
        })
    },
    {
      name: "evaluate honors the declared runtime capability",
      run: () =>
        withAdapter(async (adapter) => {
          const caps = await adapter.capabilities();
          if (!caps.runtime.evaluate) return;
          const result = await adapter.evaluate<number>((a: number, b: number) => a + b, [20, 22]);
          expect(result === 42, "evaluate must execute the provided function");
        })
    }
  ];
}
