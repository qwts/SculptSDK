import { matchText } from "../types/matchers.js";
import type { WireUIQuery } from "../types/queries.js";
import type { UIKind } from "../types/kinds.js";
import type { DomNode } from "../types/refs.js";
import type { KernelContext } from "./context.js";
import {
  getAccessibleName,
  getRole,
  isDisabled,
  isEditable,
  isFocusable,
  shadowHostOf,
  visibleText
} from "./ax.js";
import { getBox, isVisibleQuick } from "./layout.js";
import { resolveFieldLabel } from "./forms.js";

/**
 * Semantic query engine. Walks the live DOM — including open shadow roots and
 * same-origin iframes — and ranks candidates by meaning (§17.4), never by
 * brittle selectors alone.
 */

export function collectElements(ctx: KernelContext, root?: ParentNode): Element[] {
  const out: Element[] = [];
  const visit = (node: ParentNode, depth: number): void => {
    if (depth > 60) return;
    for (const el of Array.from(node.children)) {
      out.push(el);
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      const tag = el.tagName.toLowerCase();
      if (tag === "iframe" || tag === "frame") {
        try {
          const innerDoc = (el as HTMLIFrameElement).contentDocument;
          if (innerDoc) visit(innerDoc, depth + 1);
        } catch {
          // cross-origin frame: inaccessible, skip honestly
        }
      }
      visit(el, depth + 1);
    }
  };
  visit(root ?? ctx.doc, 0);
  return out;
}

export function kindMatches(kind: UIKind, el: Element, role: string | null): boolean {
  const tag = el.tagName.toLowerCase();
  const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : "";
  switch (kind) {
    case "button":
      return role === "button";
    case "link":
      return role === "link";
    case "input":
      return (
        (tag === "input" &&
          !["button", "submit", "reset", "image", "hidden", "checkbox", "radio", "file"].includes(type)) ||
        role === "textbox" ||
        role === "searchbox" ||
        role === "spinbutton" ||
        (el as HTMLElement).isContentEditable === true
      );
    case "textarea":
      return tag === "textarea";
    case "checkbox":
      return role === "checkbox";
    case "radio":
      return role === "radio";
    case "select":
      return tag === "select";
    case "combobox":
      return role === "combobox";
    case "form":
      return tag === "form" || role === "form";
    case "dialog":
      return role === "dialog" || role === "alertdialog";
    case "alert":
      return role === "alert" || role === "alertdialog";
    case "toast":
      return role === "status" || role === "alert";
    case "table":
    case "grid":
      return role === "table" || role === "grid";
    case "list":
      return role === "list" || role === "listbox";
    case "menu":
      return role === "menu" || role === "menubar";
    case "menu-item":
      return role !== null && role.startsWith("menuitem");
    case "tabs":
      return role === "tablist";
    case "tab":
      return role === "tab";
    case "search":
      return role === "search" || role === "searchbox" || (tag === "input" && type === "search");
    case "file-picker":
      return tag === "input" && type === "file";
    case "date-picker":
      return tag === "input" && ["date", "datetime-local", "month", "week", "time"].includes(type);
    case "slider":
      return role === "slider";
    default:
      return role === kind;
  }
}

const KIND_BY_ROLE: Partial<Record<string, UIKind>> = {
  button: "button",
  link: "link",
  textbox: "input",
  searchbox: "search",
  spinbutton: "input",
  checkbox: "checkbox",
  radio: "radio",
  combobox: "combobox",
  listbox: "select",
  slider: "slider",
  dialog: "dialog",
  alertdialog: "dialog",
  alert: "alert",
  status: "toast",
  table: "table",
  grid: "grid",
  list: "list",
  menu: "menu",
  menuitem: "menu-item",
  tab: "tab",
  tablist: "tabs",
  form: "form"
};

export function inferKind(el: Element, role: string | null): UIKind | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  if (tag === "form") return "form";
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "file") return "file-picker";
    if (["date", "datetime-local", "month", "week", "time"].includes(type)) return "date-picker";
  }
  if (role && KIND_BY_ROLE[role]) return KIND_BY_ROLE[role];
  return undefined;
}

export interface RankedElement {
  el: Element;
  score: number;
  confidence: number;
  reasons: string[];
  /** Predicates the query requested but this candidate could not be
   * conclusively checked against (e.g. `region` with no layout data) — never
   * a hard filter rejection, but a semantic policy must not treat these
   * candidates as having verifiably passed everything mandatory (#23). */
  unverifiedPredicates: string[];
}

interface MatchOutcome {
  score: number;
  reasons: string[];
  hadTextualMatcher: boolean;
  unverifiedPredicates: string[];
}

function matchAgainst(ctx: KernelContext, el: Element, q: WireUIQuery): MatchOutcome | null {
  const reasons: string[] = [];
  const unverifiedPredicates: string[] = [];
  let score = 0;
  let hadTextualMatcher = false;

  const role = getRole(el);
  if (q.kind !== undefined) {
    if (!kindMatches(q.kind, el, role)) return null;
    score += 5;
    reasons.push(`kind matched: ${q.kind}`);
  }
  if (q.role !== undefined) {
    if (role !== q.role) return null;
    score += 5;
    reasons.push(`role matched: ${q.role}`);
  }

  if (q.name !== undefined) {
    hadTextualMatcher = true;
    const name = getAccessibleName(el);
    const quality = matchText(name, q.name);
    if (!quality) return null;
    score += quality === "exact" ? 30 : 26;
    reasons.push(`accessible name ${quality === "exact" ? "matched exactly" : "matched"}: ${name}`);
  }

  if (q.label !== undefined) {
    hadTextualMatcher = true;
    const resolved = resolveFieldLabel(el);
    const quality = matchText(resolved.label, q.label);
    if (!quality) return null;
    score += quality === "exact" ? 28 : 24;
    reasons.push(`label ${quality === "exact" ? "matched exactly" : "matched"}: ${resolved.label}`);
  }

  if (q.text !== undefined) {
    hadTextualMatcher = true;
    const quality = matchText(visibleText(el), q.text);
    if (!quality) return null;
    score += quality === "exact" ? 12 : 9;
    reasons.push("visible text matched");
  }

  if (q.placeholder !== undefined) {
    hadTextualMatcher = true;
    const quality = matchText(el.getAttribute("placeholder"), q.placeholder);
    if (!quality) return null;
    score += quality === "exact" ? 10 : 8;
    reasons.push("placeholder matched");
  }

  if (q.value !== undefined) {
    const current = (el as HTMLInputElement).value;
    const quality = matchText(typeof current === "string" ? current : null, q.value);
    if (!quality) return null;
    score += quality === "exact" ? 8 : 6;
    reasons.push("value matched");
  }

  const visible = isVisibleQuick(ctx, el);
  if (q.visible !== undefined && visible !== q.visible) return null;
  if (visible) {
    score += 3;
    reasons.push("element is visible");
  }

  const enabled = !isDisabled(el);
  if (q.enabled !== undefined && enabled !== q.enabled) return null;
  if (enabled) score += 2;
  else reasons.push("element is disabled");

  if (q.focused !== undefined) {
    const active = activeElementDeep(ctx);
    const focused = active === el;
    if (focused !== q.focused) return null;
    if (focused) {
      score += 2;
      reasons.push("element is focused");
    }
  }

  if (q.route !== undefined) {
    const loc = ctx.win.location;
    if (!matchText(loc.pathname + loc.hash, q.route)) return null;
    reasons.push("route matched");
  }

  if (q.state !== undefined) {
    for (const [key, value] of Object.entries(q.state)) {
      if (el.getAttribute(`aria-${key}`) !== String(value)) return null;
    }
    reasons.push("aria state matched");
  }

  if (q.region !== undefined) {
    const verdict = regionMatches(ctx, el, q.region);
    if (verdict === false) return null;
    if (verdict === true) {
      reasons.push(`in ${q.region} region`);
    } else {
      reasons.push("region check skipped: no layout data");
      unverifiedPredicates.push("region");
    }
  }

  return { score, reasons, hadTextualMatcher, unverifiedPredicates };
}

function regionMatches(ctx: KernelContext, el: Element, region: string): boolean | null {
  if (region === "header" || region === "footer" || region === "main") {
    const tag = region === "main" ? "main" : region;
    return el.closest?.(tag) !== null || el.closest?.(`[role="${region === "header" ? "banner" : region === "footer" ? "contentinfo" : "main"}"]`) !== null;
  }
  const box = getBox(el);
  if (!box) return null;
  const vw = ctx.win.innerWidth || ctx.doc.documentElement.clientWidth;
  const vh = ctx.win.innerHeight || ctx.doc.documentElement.clientHeight;
  switch (region) {
    case "top":
      return box.center.y < vh / 3;
    case "bottom":
      return box.center.y > (2 * vh) / 3;
    case "left":
      return box.center.x < vw / 3;
    case "right":
      return box.center.x > (2 * vw) / 3;
    case "center":
      return box.center.x >= vw / 4 && box.center.x <= (3 * vw) / 4 && box.center.y >= vh / 4 && box.center.y <= (3 * vh) / 4;
    default:
      return null;
  }
}

function activeElementDeep(ctx: KernelContext): Element | null {
  let active: Element | null = ctx.doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function domDistance(a: Element, b: Element): number {
  const ancestorsOfA = new Map<Element, number>();
  let current: Element | null = a;
  let steps = 0;
  while (current) {
    ancestorsOfA.set(current, steps);
    current = current.parentElement;
    steps++;
  }
  current = b;
  steps = 0;
  while (current) {
    const up = ancestorsOfA.get(current);
    if (up !== undefined) return up + steps;
    current = current.parentElement;
    steps++;
  }
  return 99;
}

/**
 * Runs a semantic query. Confidence normalizes the score against what a
 * fully-matching candidate could achieve for this query shape, so kind-only
 * queries are not penalized for having no name matcher.
 */
export function queryUI(ctx: KernelContext, q: WireUIQuery): RankedElement[] {
  // Each scope carries forward any unverified predicate from the `within`
  // query that selected it (e.g. `within: { region: "top" }` with no layout
  // data) — every element found inside an unverifiable container inherits
  // that gap too, or a semantic policy would wrongly treat it as having
  // verifiably passed everything mandatory (#23).
  let scopes: { el: ParentNode; unverifiedPredicates: string[] }[] = [{ el: ctx.doc, unverifiedPredicates: [] }];
  if (q.within) {
    const containers = queryUI(ctx, q.within);
    if (containers.length === 0) return [];
    scopes = containers.slice(0, 3).map((c) => ({ el: c.el, unverifiedPredicates: c.unverifiedPredicates }));
  }

  const seen = new Set<Element>();
  const ranked: RankedElement[] = [];

  let nearAnchor: Element | null = null;
  if (q.near) {
    const anchors = queryUI(ctx, { ...q.near, near: undefined });
    nearAnchor = anchors[0]?.el ?? null;
  }

  for (const scope of scopes) {
    for (const el of collectElements(ctx, scope.el)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const outcome = matchAgainst(ctx, el, q);
      if (!outcome) continue;
      let { score } = outcome;
      const reasons = [...outcome.reasons];
      if (q.within) {
        score += 4;
        reasons.push("inside requested container");
      }
      if (nearAnchor && nearAnchor !== el) {
        const distance = domDistance(el, nearAnchor);
        const bonus = Math.max(0, 8 - Math.floor(distance / 2));
        if (bonus > 0) {
          score += bonus;
          reasons.push(`near anchor (distance ${distance})`);
        }
      }
      const denominator = outcome.hadTextualMatcher ? 40 : 12;
      const confidence = Math.min(1, score / denominator);
      const unverifiedPredicates =
        scope.unverifiedPredicates.length === 0
          ? outcome.unverifiedPredicates
          : [...new Set([...outcome.unverifiedPredicates, ...scope.unverifiedPredicates])];
      ranked.push({ el, score, confidence, reasons, unverifiedPredicates });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export function describeNode(ctx: KernelContext, el: Element): DomNode {
  const role = getRole(el);
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    attributes[attr.name] = attr.value.length > 200 ? `${attr.value.slice(0, 200)}…` : attr.value;
  }
  const value = (el as HTMLInputElement).value;
  const ownerDoc = el.ownerDocument;
  return {
    ref: { targetId: ctx.refs.acquire(el) },
    nodeType: el.nodeType,
    tagName: el.tagName.toLowerCase(),
    attributes,
    text: visibleText(el).slice(0, 300) || undefined,
    value: typeof value === "string" && el.tagName.toLowerCase() !== "a" ? value : undefined,
    role: role ?? undefined,
    accessibleName: getAccessibleName(el) || undefined,
    visible: isVisibleQuick(ctx, el),
    enabled: !isDisabled(el),
    focusable: isFocusable(el),
    editable: isEditable(el),
    frameId: ownerDoc === ctx.doc ? "main" : "subframe",
    inShadowRoot: shadowHostOf(el.getRootNode?.()) !== null
  };
}
