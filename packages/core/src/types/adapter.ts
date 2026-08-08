import type { BrowserCapabilities, ExecutionWorld } from "./capabilities.js";

export type RuntimeAdapterKind =
  | "cdp"
  | "webdriver-bidi"
  | "playwright"
  | "puppeteer"
  | "browser-extension"
  | "injected-script"
  | "embedded-browser"
  | "test-harness";

export type SerializableFunction = (...args: never[]) => unknown;

export interface EvaluationOptions {
  world?: ExecutionWorld;
}

/**
 * Normalized operations every adapter understands (or rejects honestly with
 * CAPABILITY_UNAVAILABLE). Kernel calls are the workhorse: a fixed stub plus
 * JSON arguments — never per-action generated JavaScript.
 */
export type RuntimeOperation =
  | { name: "kernel.ensure"; source: string }
  | { name: "kernel.call"; op: string; args?: unknown }
  | { name: "input.nativeClick"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number }
  | { name: "input.nativeType"; text: string; delayMs?: number }
  | { name: "input.nativeKey"; key: string }
  | { name: "page.navigate"; url: string }
  | { name: "page.url" };

export type RuntimeEventType =
  | "network-request"
  | "network-response"
  | "navigation"
  | "console"
  | "kernel-event";

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export type RuntimeEventHandler<TEvent extends RuntimeEvent = RuntimeEvent> = (event: TEvent) => void;

export interface Subscription {
  unsubscribe(): void;
}

/** Runtime adapter contract (§6.3). */
export interface RuntimeAdapter {
  readonly id: string;
  readonly kind: RuntimeAdapterKind;
  readonly executionWorld: ExecutionWorld;

  capabilities(): Promise<BrowserCapabilities>;

  evaluate<T>(fn: SerializableFunction, args?: unknown[], options?: EvaluationOptions): Promise<T>;

  call<T>(operation: RuntimeOperation): Promise<T>;

  subscribe(eventType: RuntimeEventType, handler: RuntimeEventHandler): Subscription;

  dispose(): Promise<void>;
}
