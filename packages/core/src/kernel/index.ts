import type { TargetSummary } from "../types/refs.js";
import type { ElementIdentity } from "../types/identity.js";
import type { KernelEvidence } from "../types/evidence.js";
import type { WireUIQuery, QueryCandidate } from "../types/queries.js";
import type { AnyWindow, KernelContext, KernelOptions } from "./context.js";
import { createContext, KernelError } from "./context.js";
import { getAccessibleName, getRole, isDisabled } from "./ax.js";
import { describeNode, inferKind, queryUI } from "./dom.js";
import { computeVisibility, getBox, clickPoint, isVisibleQuick, scrollIntoView } from "./layout.js";
import {
  clearValue,
  dispatchKeySequence,
  focusElement,
  setValue,
  syntheticClick,
  typeText
} from "./input.js";
import { fillForm, submitForm, summarizeFields, collectValidationErrors } from "./forms.js";
import { installNetworkObservation, installObservers, stabilityProbe, waitForStable } from "./observers.js";
import { computeIdentity, rebindIdentity } from "./identity.js";
import { buildSnapshot, closeDialog, dialogInfo, extractTable } from "./snapshot.js";
import { detectFrameworks } from "./frameworks.js";

// Bumped for §15: query results and the new `evidence` op carry read-only
// per-injection document identity, a navigation epoch, and a frame id.
export const KERNEL_VERSION = "0.2.0";

export interface KernelCallEnvelope {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface KernelApi {
  readonly version: string;
  call(op: string, args?: unknown): Promise<KernelCallEnvelope>;
  dispose(): void;
}

interface TargetArg {
  target?: { targetId?: string; identity?: ElementIdentity };
}

export type { AnyWindow, KernelOptions } from "./context.js";

/**
 * Installs the SculptSDK kernel on a window. All semantic operations are
 * dispatched through `call(op, args)` — a fixed entry point that keeps the
 * per-action payload to a tiny JSON message instead of generated JavaScript.
 */
export function createKernel(win: AnyWindow, options: KernelOptions = {}): KernelApi {
  const w = win as AnyWindow & { __sculpt__?: KernelApi };
  if (w.__sculpt__ && w.__sculpt__.version === KERNEL_VERSION) {
    return w.__sculpt__;
  }

  const ctx = createContext(win, options);
  const disposeObservers = installObservers(ctx);

  const summarize = (el: Element): TargetSummary => {
    const role = getRole(el);
    return {
      targetId: ctx.refs.acquire(el),
      kind: inferKind(el, role),
      role: role ?? undefined,
      name: getAccessibleName(el) || undefined,
      tagName: el.tagName.toLowerCase(),
      visible: isVisibleQuick(ctx, el),
      enabled: !isDisabled(el)
    };
  };

  interface Resolution {
    el: Element;
    rebound: { confidence: number; strategy: string } | null;
  }

  const resolveTarget = (args: TargetArg | undefined): Resolution => {
    const target = args?.target;
    if (!target?.targetId && !target?.identity) {
      throw new KernelError("TARGET_NOT_FOUND", "no target reference provided");
    }
    if (target.targetId) {
      const el = ctx.refs.get(target.targetId);
      if (el?.isConnected) return { el, rebound: null };
    }
    if (target.identity) {
      const rebound = rebindIdentity(ctx, target.identity);
      if (rebound) {
        return { el: rebound.el, rebound: { confidence: rebound.confidence, strategy: rebound.strategy } };
      }
    }
    throw new KernelError(
      target.targetId && ctx.refs.get(target.targetId) ? "TARGET_STALE" : "TARGET_NOT_FOUND",
      target.identity
        ? "target handle is stale and identity rebinding found no replacement"
        : "target handle is stale or unknown and no identity was provided for rebinding",
      { targetId: target.targetId }
    );
  };

  const el = (args: TargetArg | undefined): Element => resolveTarget(args).el;

  /** Read-only evidence for freshness checks (§15). The kernel is always
   * injected into the main document; cross-frame evidence isn't tracked yet. */
  const pageEvidence = (): KernelEvidence => ({
    documentId: ctx.state.documentId,
    navigationEpoch: ctx.state.navigationEpoch,
    frameId: "main"
  });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ops: Record<string, (args: any) => unknown | Promise<unknown>> = {
    ping: () => ({ version: KERNEL_VERSION, now: Date.now() }),

    configure: (a: { networkObservation?: boolean }) => {
      if (a?.networkObservation === true && !ctx.state.networkObservation) {
        ctx.state.networkObservation = true;
        installNetworkObservation(ctx);
      }
      return { networkObservation: ctx.state.networkObservation };
    },

    query: (a: { query: WireUIQuery; limit?: number }) => {
      const ranked = queryUI(ctx, a.query);
      const candidates: QueryCandidate[] = ranked.slice(0, a.limit ?? 10).map((r) => ({
        summary: summarize(r.el),
        identity: computeIdentity(ctx, r.el),
        score: r.score,
        confidence: r.confidence,
        reasons: r.reasons
      }));
      return { candidates, total: ranked.length, evidence: pageEvidence() };
    },

    evidence: () => pageEvidence(),

    resolve: (a: TargetArg) => {
      const { el: element, rebound } = resolveTarget(a);
      return { summary: summarize(element), identity: computeIdentity(ctx, element), rebound };
    },

    describe: (a: TargetArg) => describeNode(ctx, el(a)),
    visibility: (a: TargetArg) => {
      try {
        return computeVisibility(ctx, el(a));
      } catch (error) {
        if (error instanceof KernelError && error.code !== "TARGET_STALE") return computeVisibility(ctx, null);
        throw error;
      }
    },
    box: (a: TargetArg) => getBox(el(a)),
    clickPoint: (a: TargetArg) => clickPoint(ctx, el(a)),
    scrollIntoView: (a: TargetArg) => {
      scrollIntoView(el(a));
      return { done: true };
    },

    click: (a: TargetArg & { options?: { button?: "left" | "middle" | "right"; clickCount?: number } }) =>
      syntheticClick(ctx, el(a), a.options ?? {}),
    setValue: (a: TargetArg & { value: unknown }) => setValue(ctx, el(a), a.value),
    type: (a: TargetArg & { text?: string }) => typeText(ctx, el(a), String(a.text ?? "")),
    clear: (a: TargetArg) => clearValue(ctx, el(a)),
    focus: (a: TargetArg) => focusElement(ctx, el(a)),
    key: (a: { target?: TargetArg["target"]; sequence: string | string[] }) =>
      dispatchKeySequence(ctx, a.target ? el(a as TargetArg) : null, a.sequence),

    formFields: (a: TargetArg) => ({ fields: summarizeFields(ctx, el(a)) }),
    formFill: (a: TargetArg & { values?: Record<string, unknown> }) => fillForm(ctx, el(a), a.values ?? {}),
    formSubmit: (a: TargetArg) => submitForm(ctx, el(a)),
    formValidationErrors: (a: TargetArg) => ({ errors: collectValidationErrors(ctx, el(a)) }),

    identity: (a: TargetArg) => computeIdentity(ctx, el(a)),
    rebind: (a: { identity: ElementIdentity }) => {
      const result = rebindIdentity(ctx, a.identity);
      return result
        ? { targetId: ctx.refs.acquire(result.el), confidence: result.confidence, strategy: result.strategy }
        : null;
    },

    snapshot: (a: { options?: Parameters<typeof buildSnapshot>[1] } | undefined) => buildSnapshot(ctx, a?.options),
    frameworks: () => ({ frameworks: detectFrameworks(ctx) }),

    stability: () => stabilityProbe(ctx),
    waitForStable: (a: { options?: Parameters<typeof waitForStable>[1] } | undefined) =>
      waitForStable(ctx, a?.options ?? {}),

    dialogInfo: (a: TargetArg) => dialogInfo(ctx, el(a)),
    dialogClose: (a: TargetArg) => closeDialog(ctx, el(a)),
    tableExtract: (a: TargetArg) => extractTable(ctx, el(a)),

    routeState: () => ({ ...ctx.state.route }),
    networkLog: () => ({
      observed: ctx.state.networkObservation,
      inflight: ctx.state.inflightRequests,
      completed: ctx.state.completedRequests.slice(-30)
    }),
    observerStats: () => ({ activeObservers: ctx.state.activeObservers, trackedRefs: ctx.refs.size() })
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const api: KernelApi = {
    version: KERNEL_VERSION,
    async call(op: string, args?: unknown): Promise<KernelCallEnvelope> {
      try {
        const handler = ops[op];
        if (!handler) throw new KernelError("UNKNOWN", `unknown kernel op: ${op}`);
        return { ok: true, value: await handler(args) };
      } catch (error) {
        if (error instanceof KernelError) {
          return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
        }
        return { ok: false, error: { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    dispose(): void {
      disposeObservers();
      delete w.__sculpt__;
    }
  };

  w.__sculpt__ = api;
  return api;
}

export { KernelError } from "./context.js";
