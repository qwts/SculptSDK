import type {
  ActionResult,
  BoxModel,
  BrowserCapabilities,
  ClickOptions,
  DomNode,
  ElementIdentity,
  ExecutionGuard,
  InputMode,
  KernelEvidence,
  KeySequence,
  PageSnapshot,
  RebindResult,
  RuntimeAdapter,
  RuntimeEventHandler,
  SculptControlSettings,
  SnapshotOptions,
  StabilityOptions,
  StableStateReport,
  Subscription,
  TargetRef,
  TargetSummary,
  UIQuery,
  VisibilityState
} from "../types/index.js";
import { serializeQuery, type QueryCandidate } from "../types/queries.js";
import { KernelClient } from "./kernel-client.js";
import { SculptError } from "../errors.js";

export { KernelClient } from "./kernel-client.js";

/** A target as the kernel expects it: a handle plus the identity to rebind with. */
export interface KernelTarget {
  targetId: string;
  identity?: ElementIdentity;
  /** #22: when set, every kernel op resolving this target enforces it — a
   * mismatch fails closed with a typed stale error and never rebinds. */
  guard?: ExecutionGuard;
}

export interface Resolution {
  summary: TargetSummary;
  identity: ElementIdentity;
  rebound: { confidence: number; strategy: string } | null;
}

export interface FoundationEnv {
  kernel: KernelClient;
  adapter: RuntimeAdapter;
  capabilities: BrowserCapabilities;
  settings: SculptControlSettings;
}

/** DOM Graph (§9): semantic queries over live DOM state. */
export class DomGraph {
  constructor(private readonly env: FoundationEnv) {}

  async query(query: UIQuery, limit = 10): Promise<QueryCandidate[]> {
    const { candidates } = await this.env.kernel.call<{ candidates: QueryCandidate[] }>("query", {
      query: serializeQuery(query),
      limit
    });
    return candidates;
  }

  /** Like `query`, plus the read-only page evidence (§15) a caller can bind
   * a decision's freshness to. Additive — `query` above is unchanged. */
  async queryWithEvidence(
    query: UIQuery,
    limit = 10
  ): Promise<{ candidates: QueryCandidate[]; evidence: KernelEvidence }> {
    return this.env.kernel.call<{ candidates: QueryCandidate[]; evidence: KernelEvidence }>("query", {
      query: serializeQuery(query),
      limit
    });
  }

  async getNode(ref: TargetRef): Promise<DomNode> {
    return this.env.kernel.call<DomNode>("describe", { target: { targetId: ref.targetId } });
  }

  async resolveIdentity(identity: ElementIdentity): Promise<RebindResult | null> {
    return this.env.kernel.call<RebindResult | null>("rebind", { identity });
  }
}

/** Accessibility Graph (§10): role/name centric discovery and explanation. */
export class AccessibilityGraph {
  constructor(private readonly env: FoundationEnv) {}

  async find(query: { role?: string; name?: UIQuery["name"]; visible?: boolean }, limit = 10): Promise<QueryCandidate[]> {
    const { candidates } = await this.env.kernel.call<{ candidates: QueryCandidate[] }>("query", {
      query: serializeQuery(query as UIQuery),
      limit
    });
    return candidates;
  }

  async explain(ref: TargetRef): Promise<{ node: DomNode; visibility: VisibilityState }> {
    const target = { targetId: ref.targetId };
    const [node, visibility] = await Promise.all([
      this.env.kernel.call<DomNode>("describe", { target }),
      this.env.kernel.call<VisibilityState>("visibility", { target })
    ]);
    return { node, visibility };
  }
}

/** Layout Engine (§11). */
export class LayoutEngine {
  constructor(private readonly env: FoundationEnv) {}

  async box(target: KernelTarget): Promise<BoxModel | null> {
    return this.env.kernel.call<BoxModel | null>("box", { target });
  }

  async visible(target: KernelTarget): Promise<VisibilityState> {
    return this.env.kernel.call<VisibilityState>("visibility", { target });
  }

  async scrollIntoView(target: KernelTarget): Promise<void> {
    await this.env.kernel.call("scrollIntoView", { target });
  }
}

/**
 * Input Engine (§12): prefers native protocol input when the adapter has it,
 * falling back to framework-aware synthetic input from the kernel.
 * Preference order: native → framework-aware → synthetic (§12.3).
 */
export class InputEngine {
  constructor(private readonly env: FoundationEnv) {}

  async click(
    target: KernelTarget,
    options: { mode?: InputMode; button?: "left" | "middle" | "right"; clickCount?: number } = {}
  ): Promise<{ mode: InputMode; events: string[] }> {
    const wantsNative = options.mode === undefined || options.mode === "native";
    if (wantsNative && this.env.capabilities.input.nativeMouse) {
      const point = await this.env.kernel.call<{ x: number; y: number } | null>("clickPoint", { target });
      if (point) {
        await this.env.adapter.call({
          name: "input.nativeClick",
          x: point.x,
          y: point.y,
          button: options.button,
          clickCount: options.clickCount
        });
        return { mode: "native", events: ["native pointer click"] };
      }
      if (options.mode === "native") {
        throw new SculptError("INPUT_FAILED", "no in-viewport click point available for native input", {
          layer: "foundation"
        });
      }
    }
    const report = await this.env.kernel.call<{ events: string[] }>("click", {
      target,
      options: { button: options.button, clickCount: options.clickCount }
    });
    return { mode: "synthetic", events: report.events };
  }

  async setValue(target: KernelTarget, value: unknown): Promise<{ mode: InputMode; value?: string; events: string[] }> {
    const report = await this.env.kernel.call<{ events: string[]; value?: string }>("setValue", { target, value });
    return { mode: "framework-aware", ...report };
  }

  async type(
    target: KernelTarget,
    text: string,
    options: { mode?: InputMode } = {}
  ): Promise<{ mode: InputMode; value?: string; events: string[] }> {
    const wantsNative = options.mode === undefined || options.mode === "native";
    if (wantsNative && this.env.capabilities.input.nativeKeyboard) {
      await this.env.kernel.call("focus", { target });
      await this.env.adapter.call({ name: "input.nativeType", text });
      const node = await this.env.kernel.call<DomNode>("describe", { target });
      return { mode: "native", value: node.value, events: ["native keyboard input"] };
    }
    const report = await this.env.kernel.call<{ events: string[]; value?: string }>("type", { target, text });
    return { mode: "synthetic", ...report };
  }

  async clear(target: KernelTarget): Promise<{ events: string[]; value?: string }> {
    return this.env.kernel.call("clear", { target });
  }

  async select(target: KernelTarget, value: string | string[]): Promise<{ events: string[]; value?: string }> {
    return this.env.kernel.call("setValue", { target, value });
  }

  async key(sequence: KeySequence, target?: KernelTarget): Promise<{ events: string[] }> {
    return this.env.kernel.call("key", { target, sequence });
  }

  async focus(target: KernelTarget): Promise<{ events: string[] }> {
    return this.env.kernel.call("focus", { target });
  }
}

/** Observer System (§13). */
export class ObserverSystem {
  constructor(private readonly env: FoundationEnv) {}

  async waitForStableState(options: StabilityOptions = {}): Promise<StableStateReport> {
    return this.env.kernel.call<StableStateReport>("waitForStable", { options });
  }

  async networkLog(): Promise<{
    observed: boolean;
    inflight: number;
    completed: { url: string; method: string; status?: number; endedAt: number }[];
  }> {
    return this.env.kernel.call("networkLog");
  }

  async routeState(): Promise<{ url: string; path: string; hash: string }> {
    return this.env.kernel.call("routeState");
  }

  /** Read-only page evidence (§15) for a freshness check that doesn't need a query. */
  async evidence(): Promise<KernelEvidence> {
    return this.env.kernel.call<KernelEvidence>("evidence");
  }

  observeNetwork(handler: RuntimeEventHandler): Subscription {
    return this.env.adapter.subscribe("network-request", handler);
  }

  observeNavigation(handler: RuntimeEventHandler): Subscription {
    return this.env.adapter.subscribe("navigation", handler);
  }
}

/** Identity System (§14). */
export class IdentitySystem {
  constructor(private readonly env: FoundationEnv) {}

  async identify(ref: TargetRef): Promise<ElementIdentity> {
    return this.env.kernel.call<ElementIdentity>("identity", { target: { targetId: ref.targetId } });
  }

  async rebind(identity: ElementIdentity): Promise<RebindResult | null> {
    return this.env.kernel.call<RebindResult | null>("rebind", { identity });
  }

  async resolve(target: KernelTarget): Promise<Resolution> {
    return this.env.kernel.call<Resolution>("resolve", { target });
  }
}

/** Snapshot System (§15). */
export class SnapshotSystem {
  constructor(private readonly env: FoundationEnv) {}

  async page(options?: SnapshotOptions): Promise<PageSnapshot> {
    return this.env.kernel.call<PageSnapshot>("snapshot", { options });
  }
}

export interface FoundationLayer {
  dom: DomGraph;
  ax: AccessibilityGraph;
  layout: LayoutEngine;
  input: InputEngine;
  observers: ObserverSystem;
  identity: IdentitySystem;
  snapshots: SnapshotSystem;
}

export function createFoundation(env: FoundationEnv): FoundationLayer {
  return {
    dom: new DomGraph(env),
    ax: new AccessibilityGraph(env),
    layout: new LayoutEngine(env),
    input: new InputEngine(env),
    observers: new ObserverSystem(env),
    identity: new IdentitySystem(env),
    snapshots: new SnapshotSystem(env)
  };
}

/** Re-exported so UIKit can type ActionResult assembly without cycles. */
export type { ActionResult, ClickOptions };
