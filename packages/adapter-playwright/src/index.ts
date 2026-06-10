import type { Page, Request } from "playwright-core";
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

let instanceCounter = 0;

interface KernelCallPayload {
  op: string;
  args: unknown;
}

/**
 * Playwright runtime adapter. Injects the SculptSDK kernel once (and on every
 * navigation via an init script); afterwards each semantic operation is a
 * fixed stub plus a small JSON payload — never per-action generated code.
 * Native mouse/keyboard input and network observation come from the
 * Playwright protocol.
 */
export class PlaywrightAdapter implements RuntimeAdapter {
  readonly id = `playwright-${++instanceCounter}`;
  readonly kind = "playwright" as const;
  readonly executionWorld = "main-world" as const;

  private initScriptInstalled = false;
  private readonly teardowns: Array<() => void> = [];

  constructor(private readonly page: Page) {}

  async capabilities(): Promise<BrowserCapabilities> {
    return {
      dom: { read: true, write: true, shadowDom: true, iframeTraversal: true, eventListeners: false },
      accessibility: { read: true, roles: true, names: true, states: true },
      layout: { boxModel: true, hitTest: true, occlusion: true, scroll: true },
      input: { syntheticEvents: true, nativeMouse: true, nativeKeyboard: true, dragDrop: false, fileUpload: false },
      runtime: { evaluate: true, mainWorld: true, isolatedWorld: false, sourceMaps: false },
      network: { observe: true, inspectBodies: true, intercept: false },
      storage: { localStorage: true, sessionStorage: true, indexedDb: false, cookies: true },
      framework: { react: true, angular: true, vue: true, svelte: true, webComponents: true }
    };
  }

  async evaluate<T>(fn: SerializableFunction, args?: unknown[], _options?: EvaluationOptions): Promise<T> {
    const expression = `(${fn.toString()})(${(args ?? []).map((arg) => JSON.stringify(arg)).join(", ")})`;
    return this.page.evaluate(expression) as Promise<T>;
  }

  async call<T>(operation: RuntimeOperation): Promise<T> {
    switch (operation.name) {
      case "kernel.ensure": {
        if (!this.initScriptInstalled) {
          await this.page.addInitScript({ content: operation.source });
          this.initScriptInstalled = true;
        }
        await this.page.evaluate(operation.source);
        return undefined as T;
      }
      case "kernel.call": {
        const payload: KernelCallPayload = { op: operation.op, args: operation.args };
        return this.page.evaluate((p: KernelCallPayload) => {
          const kernel = (window as unknown as { __sculpt__?: { call(op: string, args?: unknown): unknown } }).__sculpt__;
          if (!kernel) return { __noKernel: true };
          return kernel.call(p.op, p.args);
        }, payload) as Promise<T>;
      }
      case "input.nativeClick": {
        await this.page.mouse.click(operation.x, operation.y, {
          button: operation.button ?? "left",
          clickCount: operation.clickCount ?? 1
        });
        return undefined as T;
      }
      case "input.nativeType": {
        await this.page.keyboard.type(operation.text, operation.delayMs ? { delay: operation.delayMs } : undefined);
        return undefined as T;
      }
      case "input.nativeKey": {
        await this.page.keyboard.press(operation.key);
        return undefined as T;
      }
      case "page.navigate": {
        await this.page.goto(operation.url);
        return undefined as T;
      }
      case "page.url":
        return this.page.url() as T;
      default: {
        const exhaustive: never = operation;
        throw new SculptError("UNKNOWN", `unsupported operation ${(exhaustive as RuntimeOperation).name}`, {
          layer: "runtime"
        });
      }
    }
  }

  subscribe(eventType: RuntimeEventType, handler: RuntimeEventHandler): Subscription {
    const emit = (data: Record<string, unknown>): void => {
      const event: RuntimeEvent = { type: eventType, timestamp: Date.now(), data };
      handler(event);
    };

    switch (eventType) {
      case "network-request": {
        const listener = (request: Request): void =>
          emit({ url: request.url(), method: request.method(), resourceType: request.resourceType() });
        this.page.on("request", listener);
        return this.tracked(() => this.page.off("request", listener));
      }
      case "network-response": {
        const listener = async (request: Request): Promise<void> => {
          const response = await request.response();
          emit({ url: request.url(), method: request.method(), status: response?.status() });
        };
        this.page.on("requestfinished", listener);
        return this.tracked(() => this.page.off("requestfinished", listener));
      }
      case "navigation": {
        const listener = (frame: { url(): string }): void => {
          if (frame === (this.page.mainFrame() as unknown)) emit({ url: frame.url() });
        };
        this.page.on("framenavigated", listener);
        return this.tracked(() => this.page.off("framenavigated", listener));
      }
      case "console": {
        const listener = (message: { type(): string; text(): string }): void =>
          emit({ level: message.type(), text: message.text() });
        this.page.on("console", listener);
        return this.tracked(() => this.page.off("console", listener));
      }
      case "kernel-event":
        throw new SculptError("CAPABILITY_UNAVAILABLE", "kernel event streaming is not supported by this adapter", {
          layer: "runtime"
        });
      default:
        throw new SculptError("UNKNOWN", `unsupported event type ${eventType as string}`, { layer: "runtime" });
    }
  }

  private tracked(teardown: () => void): Subscription {
    this.teardowns.push(teardown);
    return {
      unsubscribe: () => {
        teardown();
        const index = this.teardowns.indexOf(teardown);
        if (index >= 0) this.teardowns.splice(index, 1);
      }
    };
  }

  /** Detaches listeners; the caller owns the page lifecycle. */
  async dispose(): Promise<void> {
    for (const teardown of this.teardowns.splice(0)) teardown();
  }
}
