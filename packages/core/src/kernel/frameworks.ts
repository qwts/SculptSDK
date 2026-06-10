import type { FrameworkSummary } from "../types/snapshot.js";
import type { KernelContext } from "./context.js";

/**
 * Framework detection from runtime evidence only: globals, per-element
 * expando keys, and DOM markers. Works on minified production bundles;
 * confidence is reported instead of pretending certainty (§21, §22).
 */

function sampleElements(ctx: KernelContext, limit = 300): Element[] {
  return Array.from(ctx.doc.querySelectorAll("*")).slice(0, limit);
}

export function detectFrameworks(ctx: KernelContext): FrameworkSummary[] {
  const out: FrameworkSummary[] = [];
  const w = ctx.win as unknown as Record<string, unknown>;
  const sample = sampleElements(ctx);

  // React
  {
    const evidence: string[] = [];
    let confidence = 0;
    let version: string | undefined;
    const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__ as { renderers?: Map<number, { version?: string }> } | undefined;
    if (hook) {
      evidence.push("__REACT_DEVTOOLS_GLOBAL_HOOK__ present");
      confidence = Math.max(confidence, 0.6);
      const renderer = hook.renderers && Array.from(hook.renderers.values())[0];
      if (renderer?.version) version = renderer.version;
    }
    for (const el of sample) {
      const keys = Object.keys(el);
      if (keys.some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$") || k.startsWith("__reactContainer$"))) {
        evidence.push("React fiber keys on DOM nodes");
        confidence = Math.max(confidence, 0.95);
        break;
      }
    }
    if (ctx.doc.querySelector("[data-reactroot]")) {
      evidence.push("data-reactroot attribute");
      confidence = Math.max(confidence, 0.8);
    }
    if (confidence > 0) out.push({ name: "react", version, confidence, evidence });
  }

  // Vue
  {
    const evidence: string[] = [];
    let confidence = 0;
    let version: string | undefined;
    if (w.__VUE__) {
      evidence.push("__VUE__ global present");
      confidence = Math.max(confidence, 0.7);
    }
    for (const el of sample) {
      const vueEl = el as Element & { __vue_app__?: { version?: string }; __vueParentComponent?: unknown };
      if (vueEl.__vue_app__ || vueEl.__vueParentComponent) {
        evidence.push("Vue app instance on DOM nodes");
        confidence = Math.max(confidence, 0.95);
        if (vueEl.__vue_app__?.version) version = vueEl.__vue_app__.version;
        break;
      }
    }
    if (ctx.doc.querySelector("[data-v-app]")) {
      evidence.push("data-v-app attribute");
      confidence = Math.max(confidence, 0.8);
    }
    if (confidence > 0) out.push({ name: "vue", version, confidence, evidence });
  }

  // Angular
  {
    const evidence: string[] = [];
    let confidence = 0;
    let version: string | undefined;
    const versionEl = ctx.doc.querySelector("[ng-version]");
    if (versionEl) {
      version = versionEl.getAttribute("ng-version") ?? undefined;
      evidence.push("ng-version attribute");
      confidence = 0.95;
    }
    if (typeof w.getAllAngularRootElements === "function") {
      evidence.push("getAllAngularRootElements global");
      confidence = Math.max(confidence, 0.8);
    } else if (w.ng) {
      evidence.push("ng global present");
      confidence = Math.max(confidence, 0.6);
    }
    if (confidence > 0) out.push({ name: "angular", version, confidence, evidence });
  }

  // Svelte
  {
    const evidence: string[] = [];
    let confidence = 0;
    if (w.__svelte) {
      evidence.push("__svelte global present");
      confidence = 0.8;
    }
    for (const el of sample) {
      if (/\bsvelte-[a-z0-9]+\b/.test(el.className && typeof el.className === "string" ? el.className : "")) {
        evidence.push("svelte-scoped class names");
        confidence = Math.max(confidence, 0.85);
        break;
      }
    }
    if (confidence > 0) out.push({ name: "svelte", confidence, evidence });
  }

  // Web Components
  {
    const registry = ctx.win.customElements;
    if (registry) {
      const names = new Set<string>();
      for (const el of sample) {
        const tag = el.tagName.toLowerCase();
        if (tag.includes("-") && typeof registry.get === "function" && registry.get(tag)) {
          names.add(tag);
          if (names.size >= 3) break;
        }
      }
      if (names.size > 0) {
        out.push({
          name: "web-components",
          confidence: 0.9,
          evidence: [`custom elements: ${Array.from(names).join(", ")}`]
        });
      }
    }
  }

  return out;
}
