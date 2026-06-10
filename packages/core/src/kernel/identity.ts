import type { ElementIdentity, RebindStrategy } from "../types/identity.js";
import { normalizeText } from "../types/matchers.js";
import type { KernelContext } from "./context.js";
import { getAccessibleName, getRole, visibleText } from "./ax.js";
import { collectElements, inferKind, queryUI } from "./dom.js";
import { resolveFieldLabel, formName, formControls } from "./forms.js";
import { isVisibleQuick } from "./layout.js";

/**
 * Identity system (§14): DOM handles die on every SPA rerender, semantic
 * identities survive. When a handle goes stale the rebinding ladder walks
 * from the most structural signal (DOM path) to the most semantic one
 * (text signature), always reporting its confidence.
 */

function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function computeDomPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  let depth = 0;
  while (current && depth < 30) {
    const tag = current.tagName.toLowerCase();
    if (tag === "html" || tag === "body") {
      parts.unshift(tag);
      break;
    }
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    const parent: Element | null = current.parentElement;
    if (!parent) {
      const root = current.getRootNode?.();
      if (root instanceof ShadowRoot) {
        parts.unshift("::shadow");
        current = root.host;
      } else {
        break;
      }
    } else {
      current = parent;
    }
    depth++;
  }
  return parts.join(">");
}

const SEGMENT = /^([a-z][a-z0-9-]*):nth-of-type\((\d+)\)$/;

export function resolveDomPath(ctx: KernelContext, path: string): Element | null {
  const segments = path.split(">");
  let scope: ParentNode | null = null;
  let current: Element | null = null;

  for (const segment of segments) {
    if (segment === "html") {
      current = ctx.doc.documentElement;
      scope = current;
      continue;
    }
    if (segment === "body") {
      current = ctx.doc.body;
      scope = current;
      continue;
    }
    if (segment === "::shadow") {
      scope = current?.shadowRoot ?? null;
      if (!scope) return null;
      continue;
    }
    const match = SEGMENT.exec(segment);
    if (!match || !scope) return null;
    const [, tag, nth] = match;
    let count = 0;
    let found: Element | null = null;
    for (const child of Array.from(scope.children)) {
      if (child.tagName.toLowerCase() === tag) {
        count++;
        if (count === Number(nth)) {
          found = child;
          break;
        }
      }
    }
    if (!found) return null;
    current = found;
    scope = found;
  }
  return current;
}

export function computeIdentity(ctx: KernelContext, el: Element): ElementIdentity {
  const role = getRole(el) ?? undefined;
  const accessibleName = getAccessibleName(el) || undefined;
  const text = visibleText(el);
  const textSignature = text ? text.slice(0, 80) : undefined;
  const domPath = computeDomPath(el);
  const form = el.closest?.("form");
  const formSignature =
    form && form !== el
      ? { formName: formName(form), fieldLabel: resolveFieldLabel(el).label || undefined }
      : undefined;
  return {
    id: `e${djb2([role ?? "", accessibleName ?? "", domPath, textSignature ?? ""].join("|"))}`,
    kind: inferKind(el, role ?? null),
    role,
    accessibleName,
    textSignature,
    domPath,
    formSignature,
    routeSignature: { path: ctx.win.location.pathname + ctx.win.location.hash },
    confidence: 1
  };
}

export interface KernelRebindResult {
  el: Element;
  confidence: number;
  strategy: RebindStrategy;
}

export function rebindIdentity(ctx: KernelContext, identity: ElementIdentity): KernelRebindResult | null {
  const candidates: KernelRebindResult[] = [];

  if (identity.domPath) {
    const el = resolveDomPath(ctx, identity.domPath);
    if (el?.isConnected) {
      const role = getRole(el) ?? undefined;
      const name = getAccessibleName(el) || undefined;
      const roleMatches = (identity.role ?? undefined) === role;
      const nameMatches = !identity.accessibleName || identity.accessibleName === name;
      candidates.push({
        el,
        confidence: roleMatches && nameMatches ? 0.9 : roleMatches ? 0.55 : 0.4,
        strategy: "dom-path"
      });
    }
  }

  if (identity.role && identity.accessibleName) {
    const wanted = normalizeText(identity.accessibleName).toLowerCase();
    let ranked = queryUI(ctx, { role: identity.role, name: identity.accessibleName, visible: true });
    if (ranked.length === 0) {
      ranked = queryUI(ctx, { role: identity.role, name: identity.accessibleName });
    }
    const exact = ranked.filter((r) => normalizeText(getAccessibleName(r.el)).toLowerCase() === wanted);
    const pool = exact.length > 0 ? exact : ranked;
    if (pool.length === 1) {
      candidates.push({ el: pool[0]!.el, confidence: 0.85, strategy: "role-and-name" });
    } else if (pool.length > 1) {
      const refined = pool.find((r) => {
        if (identity.formSignature?.fieldLabel) {
          return resolveFieldLabel(r.el).label === identity.formSignature.fieldLabel;
        }
        if (identity.textSignature) {
          return visibleText(r.el).startsWith(identity.textSignature);
        }
        return false;
      });
      candidates.push(
        refined
          ? { el: refined.el, confidence: 0.75, strategy: "role-and-name" }
          : { el: pool[0]!.el, confidence: 0.55, strategy: "role-and-name" }
      );
    }
  }

  if (identity.formSignature?.fieldLabel) {
    const wantedForm = identity.formSignature.formName;
    for (const form of Array.from(ctx.doc.querySelectorAll("form"))) {
      if (wantedForm && formName(form) !== wantedForm) continue;
      for (const control of formControls(form)) {
        if (resolveFieldLabel(control).label === identity.formSignature.fieldLabel) {
          candidates.push({ el: control, confidence: 0.8, strategy: "form-association" });
          break;
        }
      }
    }
  }

  if (identity.textSignature && identity.textSignature.length >= 4) {
    for (const el of collectElements(ctx)) {
      if ((getRole(el) ?? undefined) !== identity.role) continue;
      if (!isVisibleQuick(ctx, el)) continue;
      if (visibleText(el).startsWith(identity.textSignature)) {
        candidates.push({ el, confidence: 0.6, strategy: "text-signature" });
        break;
      }
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  return best && best.confidence >= 0.5 ? best : null;
}
