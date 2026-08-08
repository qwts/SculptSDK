import type { RuntimeAdapter } from "../types/index.js";
import type { KernelCallEnvelope } from "../kernel/index.js";
import { fromKernelError, SculptError } from "../errors.js";

/**
 * Node-side proxy to the in-page kernel. Every call is a fixed-shape
 * `kernel.call` operation; if a navigation wiped the kernel the client
 * reinjects it once and retries.
 */
export class KernelClient {
  private ensured = false;

  constructor(
    private readonly adapter: RuntimeAdapter,
    private readonly source: string
  ) {}

  async ensure(): Promise<void> {
    await this.adapter.call({ name: "kernel.ensure", source: this.source });
    this.ensured = true;
  }

  async call<T>(op: string, args?: unknown): Promise<T> {
    let envelope = await this.dispatch(op, args);
    if (envelope === null || envelope === undefined || (envelope as { __noKernel?: boolean }).__noKernel) {
      await this.ensure();
      envelope = await this.dispatch(op, args);
    }
    const env = envelope as KernelCallEnvelope;
    if (env && env.ok) return env.value as T;
    if (env && env.error) throw fromKernelError(env.error);
    throw new SculptError("UNKNOWN", `kernel call "${op}" returned no envelope`, { layer: "runtime" });
  }

  private dispatch(op: string, args?: unknown): Promise<unknown> {
    return this.adapter.call({ name: "kernel.call", op, args });
  }
}
