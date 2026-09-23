import type { StabilityOptions, StableStateReport } from "../types/actions.js";
import type { AnyWindow, KernelContext } from "./context.js";
import { currentRoute } from "./context.js";

/**
 * Dynamic-state tracking: mutations, route changes, and in-page network
 * activity. SPAs update without reloads; these signals feed waitForStableState
 * so actions never rely on blind sleeps.
 */

/** `history.pushState`/`replaceState` are patched at most once per window
 * (see below) — but a page can receive a newer kernel injection over an
 * older one without a reload (e.g. two adapter instances, or a version
 * bump between attaches). The patched functions call through this
 * window-level indirection rather than closing over one `onRouteChange`,
 * so every `installObservers()` call — including a later kernel replacing
 * an earlier one — takes over live route notification immediately, and a
 * navigation is never silently tracked only by an abandoned old context. */
type RouteTrackingWindow = AnyWindow & {
  __sculptRouteChange__?: (source: string) => void;
};

export function installObservers(ctx: KernelContext): () => void {
  const { win, doc, state } = ctx;
  const teardowns: Array<() => void> = [];

  const MutationObserverCtor = win.MutationObserver;
  if (MutationObserverCtor && doc.documentElement) {
    const observer = new MutationObserverCtor((records) => {
      state.lastMutationAt = Date.now();
      state.mutationCount += records.length;
      ctx.emit({ type: "mutation", data: { count: records.length } });
    });
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
    state.activeObservers++;
    teardowns.push(() => {
      observer.disconnect();
      state.activeObservers--;
    });
  }

  const onRouteChange = (source: string): void => {
    const route = currentRoute(win);
    if (route.url !== state.route.url) {
      state.route = route;
      state.routeChangedAt = Date.now();
      state.navigationEpoch++;
      ctx.emit({ type: "route", data: { ...route, source } });
    }
  };

  // Reassigned on every installObservers() call — this is what lets a later
  // kernel injection take over route tracking from an earlier one.
  const routeWin = win as RouteTrackingWindow;
  routeWin.__sculptRouteChange__ = onRouteChange;
  teardowns.push(() => {
    if (routeWin.__sculptRouteChange__ === onRouteChange) delete routeWin.__sculptRouteChange__;
  });

  const history = win.history as History & { __sculptPatched?: boolean };
  if (history && typeof history.pushState === "function" && !history.__sculptPatched) {
    const originalPush = history.pushState.bind(history);
    const originalReplace = history.replaceState.bind(history);
    history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
      originalPush(data, unused, url);
      routeWin.__sculptRouteChange__?.("pushState");
    };
    history.replaceState = function (data: unknown, unused: string, url?: string | URL | null) {
      originalReplace(data, unused, url);
      routeWin.__sculptRouteChange__?.("replaceState");
    };
    history.__sculptPatched = true;
  }

  const popstateListener = (): void => onRouteChange("popstate");
  const hashListener = (): void => onRouteChange("hashchange");
  const unloadListener = (): void => {
    state.pendingNavigation = true;
  };
  win.addEventListener("popstate", popstateListener);
  win.addEventListener("hashchange", hashListener);
  win.addEventListener("beforeunload", unloadListener);
  teardowns.push(() => {
    win.removeEventListener("popstate", popstateListener);
    win.removeEventListener("hashchange", hashListener);
    win.removeEventListener("beforeunload", unloadListener);
  });

  if (state.networkObservation) installNetworkObservation(ctx);

  return () => {
    for (const teardown of teardowns) teardown();
  };
}

function recordRequest(ctx: KernelContext, url: string, method: string, status?: number): void {
  const { state } = ctx;
  state.completedRequests.push({ url, method: method.toUpperCase(), status, endedAt: Date.now() });
  if (state.completedRequests.length > 100) state.completedRequests.splice(0, 50);
  state.lastNetworkAt = Date.now();
  ctx.emit({ type: "network", data: { url, method, status } });
}

/**
 * Observation-only wrappers around fetch/XHR. Idempotent; never alters
 * request or response semantics.
 */
export function installNetworkObservation(ctx: KernelContext): void {
  const { win, state } = ctx;
  const w = win as unknown as Record<string, unknown> & Window;

  if (typeof win.fetch === "function" && !(w as { __sculptFetchPatched?: boolean }).__sculptFetchPatched) {
    const originalFetch = win.fetch.bind(win);
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url ?? String(input);
      const method = init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
      state.inflightRequests++;
      try {
        const response = await originalFetch(input, init);
        recordRequest(ctx, url, method, response.status);
        return response;
      } catch (error) {
        recordRequest(ctx, url, method, undefined);
        throw error;
      } finally {
        state.inflightRequests = Math.max(0, state.inflightRequests - 1);
      }
    };
    (w as { __sculptFetchPatched?: boolean }).__sculptFetchPatched = true;
  }

  type PatchedXhr = XMLHttpRequest & { __sculptReq?: { method: string; url: string } };
  const XhrCtor = win.XMLHttpRequest as (typeof XMLHttpRequest & { prototype: PatchedXhr }) | undefined;
  if (XhrCtor && !(XhrCtor.prototype as { __sculptPatched?: boolean }).__sculptPatched) {
    const originalOpen = XhrCtor.prototype.open;
    const originalSend = XhrCtor.prototype.send;
    XhrCtor.prototype.open = function (this: PatchedXhr, method: string, url: string | URL, ...rest: unknown[]) {
      this.__sculptReq = { method, url: String(url) };
      return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    };
    XhrCtor.prototype.send = function (this: PatchedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
      state.inflightRequests++;
      this.addEventListener("loadend", () => {
        state.inflightRequests = Math.max(0, state.inflightRequests - 1);
        recordRequest(ctx, this.__sculptReq?.url ?? "", this.__sculptReq?.method ?? "GET", this.status || undefined);
      });
      return originalSend.call(this, body);
    };
    (XhrCtor.prototype as { __sculptPatched?: boolean }).__sculptPatched = true;
  }
}

export interface StabilityProbe {
  now: number;
  lastMutationAt: number;
  lastNetworkAt: number;
  inflightRequests: number;
  routeChangedAt: number;
  pendingNavigation: boolean;
  networkObservation: boolean;
}

export function stabilityProbe(ctx: KernelContext): StabilityProbe {
  const { state } = ctx;
  return {
    now: Date.now(),
    lastMutationAt: state.lastMutationAt,
    lastNetworkAt: state.lastNetworkAt,
    inflightRequests: state.inflightRequests,
    routeChangedAt: state.routeChangedAt,
    pendingNavigation: state.pendingNavigation,
    networkObservation: state.networkObservation
  };
}

function delay(ctx: KernelContext, ms: number): Promise<void> {
  return new Promise((resolve) => ctx.win.setTimeout(resolve, ms));
}

export async function waitForStable(ctx: KernelContext, options: StabilityOptions = {}): Promise<StableStateReport> {
  const mutationQuietMs = options.mutationQuietMs ?? 200;
  const networkQuietMs = options.networkQuietMs ?? 300;
  const timeoutMs = options.timeoutMs ?? 5000;
  const started = Date.now();

  for (;;) {
    const now = Date.now();
    const { state } = ctx;

    const mutationsQuiet = state.lastMutationAt === 0 || now - state.lastMutationAt >= mutationQuietMs;
    const networkQuiet = !state.networkObservation
      ? true
      : state.inflightRequests === 0 && (state.lastNetworkAt === 0 || now - state.lastNetworkAt >= networkQuietMs);
    const routeStable = !options.routeStable
      ? true
      : !state.pendingNavigation &&
        (state.routeChangedAt === 0 || now - state.routeChangedAt >= Math.max(200, mutationQuietMs));

    if (mutationsQuiet && networkQuiet && routeStable) {
      return {
        stable: true,
        elapsedMs: now - started,
        conditions: { mutationsQuiet, networkQuiet, routeStable },
        reasons: state.networkObservation ? [] : ["network observation disabled; network condition skipped"]
      };
    }

    if (now - started >= timeoutMs) {
      const reasons: string[] = [];
      if (!mutationsQuiet) reasons.push("mutations still occurring");
      if (!networkQuiet) reasons.push(`network busy (${state.inflightRequests} inflight)`);
      if (!routeStable) reasons.push("route recently changed or navigation pending");
      return {
        stable: false,
        elapsedMs: now - started,
        conditions: { mutationsQuiet, networkQuiet, routeStable },
        reasons
      };
    }

    await delay(ctx, 25);
  }
}
