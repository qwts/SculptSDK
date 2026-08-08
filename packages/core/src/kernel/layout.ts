import type { BoxModel, VisibilityState } from "../types/layout.js";
import type { KernelContext } from "./context.js";
import { isAriaHidden } from "./ax.js";

/**
 * Layout and visibility verdicts. In real browsers these use geometry and
 * hit-testing; in layout-less environments (happy-dom) the predicate degrades
 * to computed-style checks and reports a lower confidence — degradation is
 * reported, never hidden (§7.4.4).
 */

export function getBox(el: Element): BoxModel | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  };
}

interface StyleVerdict {
  displayed: boolean;
  opacity: number;
  pointerEvents: string;
  reasons: string[];
}

function styleVerdict(ctx: KernelContext, el: Element): StyleVerdict {
  const reasons: string[] = [];
  let displayed = true;
  let opacity = 1;
  let pointerEvents = "auto";

  let current: Element | null = el;
  let depth = 0;
  while (current && depth < 30) {
    const view = current.ownerDocument.defaultView ?? ctx.win;
    const style = view.getComputedStyle(current);
    if (style.display === "none") {
      displayed = false;
      reasons.push(`display:none${current === el ? "" : " on ancestor"}`);
      break;
    }
    if (style.visibility === "hidden" || style.visibility === "collapse") {
      displayed = false;
      reasons.push(`visibility:${style.visibility}${current === el ? "" : " on ancestor"}`);
      break;
    }
    if (current === el) {
      opacity = parseFloat(style.opacity || "1");
      pointerEvents = style.pointerEvents || "auto";
      if (Number.isNaN(opacity)) opacity = 1;
    }
    const parent: Element | null = current.parentElement;
    if (!parent) {
      const root = current.getRootNode?.();
      current = root instanceof ShadowRoot ? root.host : null;
    } else {
      current = parent;
    }
    depth++;
  }

  if (opacity <= 0.05 && displayed) {
    displayed = false;
    reasons.push(`opacity:${opacity}`);
  }
  if ((el as HTMLElement).hidden) {
    displayed = false;
    reasons.push("hidden attribute");
  }
  if (isAriaHidden(el)) {
    displayed = false;
    reasons.push("aria-hidden");
  }
  const closedDetails = el.closest?.("details:not([open])");
  if (closedDetails && el.tagName.toLowerCase() !== "summary" && !el.closest("summary")) {
    displayed = false;
    reasons.push("inside closed <details>");
  }
  if (el.tagName.toLowerCase() !== "dialog") {
    const dialog = el.closest?.("dialog");
    if (dialog && !(dialog as HTMLDialogElement).open) {
      displayed = false;
      reasons.push("inside closed <dialog>");
    }
  } else if (!(el as HTMLDialogElement).open) {
    displayed = false;
    reasons.push("dialog not open");
  }

  return { displayed, opacity, pointerEvents, reasons };
}

/** Cheap visibility check used while ranking query candidates. */
export function isVisibleQuick(ctx: KernelContext, el: Element): boolean {
  if (!el.isConnected) return false;
  const native = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof native === "function") {
    try {
      if (!native.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false;
      return !isAriaHidden(el) && !(el as HTMLElement).hidden;
    } catch {
      // fall through to style walk
    }
  }
  return styleVerdict(ctx, el).displayed;
}

export function computeVisibility(ctx: KernelContext, el: Element | null): VisibilityState {
  const reasons: string[] = [];
  if (!el) {
    return {
      exists: false,
      attached: false,
      rendered: false,
      displayed: false,
      inViewport: false,
      clipped: false,
      occluded: false,
      opacity: 0,
      pointerEvents: "none",
      confidence: 1,
      reasons: ["element does not exist"]
    };
  }
  const attached = el.isConnected;
  if (!attached) reasons.push("not attached to document");

  const style = styleVerdict(ctx, el);
  reasons.push(...style.reasons);

  const box = attached ? getBox(el) : null;
  const layoutAvailable = box !== null;
  const rendered = attached && style.displayed && (layoutAvailable || !hasRealLayout(ctx));
  if (!layoutAvailable && hasRealLayout(ctx) && style.displayed && attached) {
    reasons.push("zero-size box");
  }

  let inViewport = false;
  let occluded = false;
  let confidence = 1;

  if (layoutAvailable && box) {
    const vw = ctx.win.innerWidth || ctx.doc.documentElement.clientWidth;
    const vh = ctx.win.innerHeight || ctx.doc.documentElement.clientHeight;
    inViewport = box.x + box.width > 0 && box.y + box.height > 0 && box.x < vw && box.y < vh;
    if (!inViewport) reasons.push("outside viewport");
    occluded = isOccluded(ctx, el, box);
    if (occluded) reasons.push("covered by another element");
  } else if (rendered) {
    // Layout-less environment: trust computed styles, report reduced confidence.
    inViewport = true;
    confidence = 0.6;
    reasons.push("layout data unavailable; style-based verdict");
  }

  if (style.pointerEvents === "none") reasons.push("pointer-events:none");

  return {
    exists: true,
    attached,
    rendered,
    displayed: style.displayed && attached,
    inViewport,
    clipped: false,
    occluded,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    confidence,
    reasons
  };
}

function hasRealLayout(ctx: KernelContext): boolean {
  const rect = ctx.doc.documentElement.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function isOccluded(ctx: KernelContext, el: Element, box: BoxModel): boolean {
  const doc = el.ownerDocument;
  if (typeof doc.elementFromPoint !== "function") return false;
  const vw = ctx.win.innerWidth || ctx.doc.documentElement.clientWidth;
  const vh = ctx.win.innerHeight || ctx.doc.documentElement.clientHeight;
  const x = Math.min(Math.max(box.center.x, 0), vw - 1);
  const y = Math.min(Math.max(box.center.y, 0), vh - 1);
  let hit = doc.elementFromPoint(x, y);
  if (!hit) return false;
  // Descend through open shadow roots to the deepest hit.
  while (hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === "function") {
    const deeper = hit.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === hit) break;
    hit = deeper;
  }
  if (hit === el || el.contains(hit) || hit.contains(el)) return false;
  // Labels hitting their control (and vice versa) are not occlusion.
  const label = hit.closest?.("label");
  if (label && label.contains(el)) return false;
  return true;
}

/** Best in-viewport point for native pointer input. */
export function clickPoint(ctx: KernelContext, el: Element): { x: number; y: number } | null {
  const box = getBox(el);
  if (!box) return null;
  const vw = ctx.win.innerWidth || ctx.doc.documentElement.clientWidth;
  const vh = ctx.win.innerHeight || ctx.doc.documentElement.clientHeight;
  const x = box.center.x;
  const y = box.center.y;
  if (x < 0 || y < 0 || x >= vw || y >= vh) return null;
  return { x, y };
}

export function scrollIntoView(el: Element): void {
  el.scrollIntoView?.({ block: "center", inline: "center" });
}
