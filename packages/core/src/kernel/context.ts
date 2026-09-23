import type { RouteState } from "../types/snapshot.js";

/**
 * The kernel runs inside the page (real browser or happy-dom). Everything it
 * touches goes through this context so unit tests can hand it any window.
 */
export type AnyWindow = Window & typeof globalThis;

export class KernelError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Maps stable target ids to live elements. Elements are held weakly so the
 * registry never keeps detached subtrees alive; stale ids simply fail to
 * resolve and trigger identity rebinding.
 */
export class RefRegistry {
  private byId = new Map<string, WeakRef<Element>>();
  private ids = new WeakMap<Element, string>();
  private seq = 0;

  acquire(el: Element): string {
    const existing = this.ids.get(el);
    if (existing) return existing;
    const id = `t${++this.seq}`;
    this.ids.set(el, id);
    this.byId.set(id, new WeakRef(el));
    if (this.byId.size > 2000) this.prune();
    return id;
  }

  get(id: string): Element | null {
    return this.byId.get(id)?.deref() ?? null;
  }

  size(): number {
    return this.byId.size;
  }

  private prune(): void {
    for (const [id, ref] of this.byId) {
      if (ref.deref() === undefined) this.byId.delete(id);
    }
  }
}

export interface CompletedRequest {
  url: string;
  method: string;
  status?: number;
  endedAt: number;
}

export interface KernelState {
  startedAt: number;
  lastMutationAt: number;
  mutationCount: number;
  inflightRequests: number;
  lastNetworkAt: number;
  completedRequests: CompletedRequest[];
  route: RouteState;
  routeChangedAt: number;
  pendingNavigation: boolean;
  networkObservation: boolean;
  activeObservers: number;
  /** Identifies this in-page kernel injection; a hard reload gets a new one. */
  documentId: string;
  /** Increments on every observed route/navigation change (§15 freshness evidence). */
  navigationEpoch: number;
}

export interface KernelEvent {
  type: "mutation" | "route" | "network";
  data: Record<string, unknown>;
}

export interface KernelOptions {
  networkObservation?: boolean;
  onEvent?: (event: KernelEvent) => void;
}

export interface KernelContext {
  win: AnyWindow;
  doc: Document;
  refs: RefRegistry;
  state: KernelState;
  emit: (event: KernelEvent) => void;
}

export function currentRoute(win: AnyWindow): RouteState {
  const loc = win.location;
  return { url: loc.href, path: loc.pathname, hash: loc.hash };
}

/** No cryptographic requirement — just unique enough to tell two injections apart. */
function generateDocumentId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createContext(win: AnyWindow, options: KernelOptions = {}): KernelContext {
  const startedAt = Date.now();
  return {
    win,
    doc: win.document,
    refs: new RefRegistry(),
    state: {
      startedAt,
      // Start "quiet": an idle page is stable immediately after attach.
      lastMutationAt: 0,
      mutationCount: 0,
      inflightRequests: 0,
      lastNetworkAt: 0,
      completedRequests: [],
      route: currentRoute(win),
      routeChangedAt: 0,
      pendingNavigation: false,
      networkObservation: options.networkObservation ?? false,
      activeObservers: 0,
      documentId: generateDocumentId(),
      navigationEpoch: 0
    },
    emit: options.onEvent ?? (() => {})
  };
}
