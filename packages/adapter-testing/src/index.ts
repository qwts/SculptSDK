import { Window as HappyWindow } from "happy-dom";
import { createKernel, type AnyWindow, type KernelApi } from "@sculptsdk/core/kernel";
import {
  SculptError,
  type BrowserCapabilities,
  type EvaluationOptions,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventHandler,
  type RuntimeEventType,
  type RuntimeOperation,
  type SerializableFunction,
  type Subscription
} from "@sculptsdk/core";

export { adapterConformanceTests, type ConformanceTest } from "./conformance.js";
export {
  providerConformanceTests,
  CONFORMANCE_QUESTION,
  CONFORMANCE_REQUEST_META,
  type ProviderConformanceTest
} from "./provider-conformance.js";
export {
  RecordedProvider,
  RECORDING_FORMAT_VERSION,
  isDecisionRecordingFile,
  type DecisionRecordingEntry,
  type DecisionRecordingFile,
  type DecisionRecordingRequestMeta
} from "./recorded-provider.js";

export interface TestHarnessOptions {
  html?: string;
  url?: string;
}

let instanceCounter = 0;

/**
 * In-process runtime adapter backed by happy-dom. The kernel is installed by
 * direct function call — same code that ships in the injected bundle — which
 * makes the full SDK stack testable without a browser.
 */
export class TestHarnessAdapter implements RuntimeAdapter {
  readonly id = `test-harness-${++instanceCounter}`;
  readonly kind = "test-harness" as const;
  readonly executionWorld = "main-world" as const;

  readonly window: InstanceType<typeof HappyWindow>;
  private kernel: KernelApi | null = null;
  private readonly listeners = new Map<RuntimeEventType, Set<RuntimeEventHandler>>();

  constructor(options: TestHarnessOptions = {}) {
    this.window = new HappyWindow({ url: options.url ?? "http://fixtures.local/" });
    if (options.html) {
      this.window.document.write(options.html);
    }
  }

  /** The page window, typed for kernel-level interop. */
  get pageWindow(): AnyWindow {
    return this.window as unknown as AnyWindow;
  }

  get document(): Document {
    return this.window.document as unknown as Document;
  }

  async capabilities(): Promise<BrowserCapabilities> {
    return {
      dom: { read: true, write: true, shadowDom: true, iframeTraversal: true, eventListeners: false },
      accessibility: { read: true, roles: true, names: true, states: true },
      // happy-dom computes no real layout; report it honestly.
      layout: { boxModel: false, hitTest: false, occlusion: false, scroll: true },
      input: { syntheticEvents: true, nativeMouse: false, nativeKeyboard: false, dragDrop: false, fileUpload: false },
      runtime: { evaluate: true, mainWorld: true, isolatedWorld: false, sourceMaps: false },
      network: { observe: true, inspectBodies: false, intercept: false },
      storage: { localStorage: true, sessionStorage: true, indexedDb: false, cookies: true },
      framework: { react: false, angular: false, vue: false, svelte: false, webComponents: true }
    };
  }

  async evaluate<T>(fn: SerializableFunction, args?: unknown[], _options?: EvaluationOptions): Promise<T> {
    // In-process equivalent of injected evaluation: shadow the page globals
    // through parameters so `window`/`document` resolve to the harness page.
    const wrapped = new Function(
      "window",
      "document",
      "location",
      "history",
      "__args",
      `return (${fn.toString()})(...__args);`
    );
    return (await wrapped(
      this.window,
      this.window.document,
      this.window.location,
      this.window.history,
      args ?? []
    )) as T;
  }

  async call<T>(operation: RuntimeOperation): Promise<T> {
    switch (operation.name) {
      case "kernel.ensure": {
        this.kernel ??= createKernel(this.pageWindow, {
          networkObservation: false,
          onEvent: (event) => this.emit("kernel-event", { kernel: event.type, ...event.data })
        });
        return undefined as T;
      }
      case "kernel.call": {
        if (!this.kernel) return { __noKernel: true } as T;
        return (await this.kernel.call(operation.op, operation.args)) as T;
      }
      case "page.navigate": {
        // SPA-style navigation: real document loads are out of scope for the
        // in-process harness; history transitions exercise route observation.
        this.window.history.pushState({}, "", operation.url);
        this.emit("navigation", { url: this.window.location.href });
        return undefined as T;
      }
      case "page.url":
        return this.window.location.href as T;
      case "input.nativeClick":
      case "input.nativeType":
      case "input.nativeKey":
        throw new SculptError(
          "CAPABILITY_UNAVAILABLE",
          `test-harness adapter has no native input path (${operation.name})`,
          { layer: "runtime", details: { operation: operation.name } }
        );
      default: {
        const exhaustive: never = operation;
        throw new SculptError("UNKNOWN", `unsupported operation ${(exhaustive as RuntimeOperation).name}`, {
          layer: "runtime"
        });
      }
    }
  }

  subscribe(eventType: RuntimeEventType, handler: RuntimeEventHandler): Subscription {
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    set.add(handler);
    return {
      unsubscribe: () => {
        set.delete(handler);
      }
    };
  }

  private emit(type: RuntimeEventType, data: Record<string, unknown>): void {
    const event: RuntimeEvent = { type, timestamp: Date.now(), data };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  async dispose(): Promise<void> {
    this.kernel?.dispose();
    this.kernel = null;
    this.listeners.clear();
    const happy = (this.window as unknown as { happyDOM?: { abort?: () => Promise<void>; close?: () => Promise<void> } })
      .happyDOM;
    await happy?.abort?.();
    await happy?.close?.();
  }
}
