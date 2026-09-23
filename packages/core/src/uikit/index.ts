import type {
  ActionOptions,
  ActionResult,
  ClearOptions,
  ClickOptions,
  CloseOptions,
  ElementIdentity,
  ExecutionGuard,
  FormFillOptions,
  FormFillResult,
  SetValueOptions,
  SubmitOptions,
  TargetRef,
  TargetSummary,
  UIKind,
  UIQuery
} from "../types/index.js";
import type { QueryCandidate } from "../types/queries.js";
import { serializeQuery } from "../types/queries.js";
import type { DomNode, FormFieldSummary, DialogSummary } from "../types/index.js";
import type { ActionEnv } from "./action-runner.js";
import { runAction } from "./action-runner.js";
import type { KernelTarget } from "../foundation/index.js";
import { SculptError } from "../errors.js";

export { runAction, syntheticResult, DEFAULT_ORCHESTRATION } from "./action-runner.js";
export type { ActionEnv, OrchestrationDefaults, ActionSpec } from "./action-runner.js";

/**
 * UIKit layer (§16): semantic UI objects with typed interactions, built on
 * the foundation systems. Objects are lazy handles — they carry an identity
 * and rebind transparently when the SPA rerenders underneath them.
 */

export interface UIExplanation {
  selected: boolean;
  confidence: number;
  reasons: string[];
}

export class UIElement {
  constructor(
    protected readonly env: ActionEnv,
    public summary: TargetSummary,
    public identity: ElementIdentity,
    public readonly confidence: number,
    public readonly reasons: string[]
  ) {}

  get ref(): TargetRef {
    return { targetId: this.summary.targetId };
  }
  get kind(): UIKind | undefined {
    return this.summary.kind;
  }
  get role(): string | undefined {
    return this.summary.role;
  }
  get name(): string | undefined {
    return this.summary.name;
  }
  get visible(): boolean {
    return this.summary.visible === true;
  }
  get enabled(): boolean {
    return this.summary.enabled !== false;
  }

  protected target(guard?: ExecutionGuard): KernelTarget {
    return { targetId: this.summary.targetId, identity: this.identity, guard };
  }

  /** Builds the #22 guard binding a mutation to this handle's identity at
   * the given evidence — the shape a decision-point policy captures when it
   * makes its choice, e.g. from `queryWithEvidence()` or `observers.evidence()`. */
  guardFrom(evidence: { documentId: string; navigationEpoch: number }): ExecutionGuard {
    return {
      documentId: evidence.documentId,
      navigationEpoch: evidence.navigationEpoch,
      targetDigest: this.identity.id,
      rebind: "forbid"
    };
  }

  /** Keeps the handle fresh after the action runner rebinds a stale target. */
  protected trackResolution(): (resolution: { summary: TargetSummary; identity: ElementIdentity }) => void {
    return (resolution) => {
      this.summary = resolution.summary;
      this.identity = resolution.identity;
    };
  }

  async explain(): Promise<UIExplanation> {
    return { selected: true, confidence: this.confidence, reasons: this.reasons };
  }

  async describe(): Promise<DomNode> {
    return this.env.kernel.call<DomNode>("describe", { target: this.target() });
  }

  async click(options: ClickOptions = {}): Promise<ActionResult> {
    return runAction(this.env, {
      action: "click",
      target: this.target(options.guard),
      options,
      onResolved: this.trackResolution(),
      execute: async (target) => {
        const result = await this.env.foundation.input.click(target, {
          mode: options.mode,
          button: options.button,
          clickCount: options.clickCount
        });
        return { mode: result.mode };
      }
    });
  }
}

export class UIButton extends UIElement {}
export class UILink extends UIElement {}

export class UIInput extends UIElement {
  async value(): Promise<string> {
    const node = await this.describe();
    return node.value ?? "";
  }

  async setValue(value: unknown, options: SetValueOptions = {}): Promise<ActionResult> {
    return runAction(this.env, {
      action: "set-value",
      target: this.target(options.guard),
      options,
      onResolved: this.trackResolution(),
      execute: async (target) => {
        const result = await this.env.foundation.input.setValue(target, value);
        if (options.verify !== false && typeof value === "string" && result.value !== value) {
          throw new SculptError("INPUT_FAILED", `value verification failed: expected "${value}", got "${result.value}"`, {
            layer: "uikit",
            target: this.summary
          });
        }
        return { mode: result.mode, value: result.value };
      }
    });
  }

  async type(text: string, options: ActionOptions = {}): Promise<ActionResult> {
    return runAction(this.env, {
      action: "type",
      target: this.target(options.guard),
      options,
      onResolved: this.trackResolution(),
      execute: async (target) => {
        const result = await this.env.foundation.input.type(target, text, { mode: options.mode });
        return { mode: result.mode, value: result.value };
      }
    });
  }

  async clear(options: ClearOptions = {}): Promise<ActionResult> {
    return runAction(this.env, {
      action: "clear",
      target: this.target(options.guard),
      options,
      onResolved: this.trackResolution(),
      execute: async (target) => {
        const result = await this.env.foundation.input.clear(target);
        return { mode: "framework-aware", value: result.value };
      }
    });
  }
}

export class UISelect extends UIInput {
  async select(value: string | string[], options: ActionOptions = {}): Promise<ActionResult> {
    return runAction(this.env, {
      action: "select",
      target: this.target(options.guard),
      options,
      onResolved: this.trackResolution(),
      execute: async (target) => {
        const result = await this.env.foundation.input.select(target, value);
        return { mode: "framework-aware", value: result.value };
      }
    });
  }
}

export class UIForm extends UIElement {
  async fields(): Promise<Record<string, FormFieldSummary>> {
    const { fields } = await this.env.kernel.call<{ fields: FormFieldSummary[] }>("formFields", {
      target: this.target()
    });
    const map: Record<string, FormFieldSummary> = {};
    for (const field of fields) {
      if (field.label) map[field.label] = field;
    }
    return map;
  }

  async fill(values: Record<string, unknown>, options: FormFillOptions = {}): Promise<FormFillResult> {
    const result = await this.env.kernel.call<FormFillResult>("formFill", {
      target: this.target(options.guard),
      values
    });
    if (options.submit && result.ok) {
      await this.submit(options);
    }
    return result;
  }

  async submit(options: SubmitOptions = {}): Promise<ActionResult> {
    return runAction(this.env, {
      action: "submit",
      target: this.target(options.guard),
      options,
      validationScope: this.target(),
      // Forms themselves are containers; their own occlusion is irrelevant.
      defaultPreconditions: { mustNotBeOccluded: false, mustBeVisible: false },
      onResolved: this.trackResolution(),
      execute: async (target) => {
        const result = await this.env.kernel.call<{ method: string }>("formSubmit", { target });
        return { mode: "synthetic", value: result };
      }
    });
  }
}

export class UIDialog extends UIElement {
  async info(): Promise<DialogSummary> {
    return this.env.kernel.call<DialogSummary>("dialogInfo", { target: this.target() });
  }

  async title(): Promise<string | null> {
    const info = await this.info();
    return info.title ?? null;
  }

  async buttons(): Promise<UIButton[]> {
    const info = await this.info();
    const buttons: UIButton[] = [];
    for (const button of info.buttons) {
      const identity = await this.env.kernel.call<ElementIdentity>("identity", {
        target: { targetId: button.targetId }
      });
      buttons.push(
        new UIButton(
          this.env,
          { targetId: button.targetId, kind: button.kind, role: button.role, name: button.name, enabled: button.enabled },
          identity,
          1,
          ["listed in dialog"]
        )
      );
    }
    return buttons;
  }

  async close(options: CloseOptions = {}): Promise<ActionResult> {
    return runAction(this.env, {
      action: "close-dialog",
      target: this.target(options.guard),
      options,
      defaultPreconditions: { mustNotBeOccluded: false },
      onResolved: this.trackResolution(),
      execute: async (target) => {
        const result = await this.env.kernel.call<{ method: string }>("dialogClose", { target });
        return { mode: "synthetic", value: result };
      }
    });
  }
}

export class UITable extends UIElement {
  async extract(): Promise<{ headers: string[]; rows: string[][]; records: Record<string, string>[] }> {
    return this.env.kernel.call("tableExtract", { target: this.target() });
  }
}

function instantiate(env: ActionEnv, candidate: QueryCandidate, kindHint?: UIKind): UIElement {
  const kind = kindHint ?? candidate.summary.kind;
  const args = [env, candidate.summary, candidate.identity, candidate.confidence, candidate.reasons] as const;
  switch (kind) {
    case "form":
      return new UIForm(...args);
    case "dialog":
      return new UIDialog(...args);
    case "link":
      return new UILink(...args);
    case "select":
    case "combobox":
      return new UISelect(...args);
    case "input":
    case "textarea":
    case "checkbox":
    case "radio":
    case "search":
    case "date-picker":
      return new UIInput(...args);
    case "table":
    case "grid":
      return new UITable(...args);
    case "button":
      return new UIButton(...args);
    default:
      return new UIElement(...args);
  }
}

const DEFAULT_MIN_CONFIDENCE = 0.5;
/** Two candidates within this score margin are reported as ambiguous (§31.12). */
const AMBIGUITY_MARGIN = 2;

export class UIRoot {
  constructor(private readonly env: ActionEnv) {}

  async findAll(query: UIQuery, limit = 10): Promise<UIElement[]> {
    const { candidates } = await this.env.kernel.call<{ candidates: QueryCandidate[] }>("query", {
      query: serializeQuery(query),
      limit
    });
    const min = query.minConfidence ?? 0;
    return candidates.filter((c) => c.confidence >= min).map((c) => instantiate(this.env, c, query.kind));
  }

  async tryFind(query: UIQuery): Promise<UIElement | null> {
    const { candidates } = await this.env.kernel.call<{ candidates: QueryCandidate[] }>("query", {
      query: serializeQuery(query),
      limit: 5
    });
    const min = query.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const best = candidates[0];
    if (!best || best.confidence < min) return null;
    const second = candidates[1];
    if (second && second.confidence >= min && best.score - second.score < AMBIGUITY_MARGIN) {
      throw new SculptError("TARGET_AMBIGUOUS", "query matched multiple equally-ranked elements", {
        layer: "uikit",
        details: {
          candidates: candidates.slice(0, 3).map((c) => ({
            name: c.summary.name,
            role: c.summary.role,
            score: c.score,
            confidence: c.confidence
          }))
        }
      });
    }
    return instantiate(this.env, best, query.kind);
  }

  async find(query: UIQuery): Promise<UIElement> {
    const found = await this.tryFind(query);
    if (!found) {
      throw new SculptError("TARGET_NOT_FOUND", "no element matched the semantic query", {
        layer: "uikit",
        details: { query: JSON.parse(JSON.stringify(serializeQuery(query))) as Record<string, unknown> }
      });
    }
    return found;
  }

  /** Builds a typed handle from an existing target reference. */
  async fromRef(ref: TargetRef): Promise<UIElement> {
    const resolution = await this.env.foundation.identity.resolve({ targetId: ref.targetId });
    const candidate: QueryCandidate = {
      summary: resolution.summary,
      identity: resolution.identity,
      score: 0,
      confidence: 1,
      reasons: ["resolved from explicit target reference"]
    };
    return instantiate(this.env, candidate);
  }

  button(query: UIQuery = {}): LazyHandle<UIButton> {
    return lazy(this.find({ ...query, kind: "button" }) as Promise<UIButton>);
  }
  link(query: UIQuery = {}): LazyHandle<UILink> {
    return lazy(this.find({ ...query, kind: "link" }) as Promise<UILink>);
  }
  input(query: UIQuery = {}): LazyHandle<UIInput> {
    return lazy(this.find({ ...query, kind: query.kind ?? "input" }) as Promise<UIInput>);
  }
  select(query: UIQuery = {}): LazyHandle<UISelect> {
    return lazy(this.find({ ...query, kind: "select" }) as Promise<UISelect>);
  }
  form(query: UIQuery = {}): LazyHandle<UIForm> {
    return lazy(this.find({ ...query, kind: "form" }) as Promise<UIForm>);
  }
  dialog(query: UIQuery = {}): LazyHandle<UIDialog> {
    return lazy(this.find({ ...query, kind: "dialog" }) as Promise<UIDialog>);
  }
  table(query: UIQuery = {}): LazyHandle<UITable> {
    return lazy(this.find({ ...query, kind: "table" }) as Promise<UITable>);
  }
}

/**
 * Awaitable handle supporting both styles from the design doc:
 *   const b = await sculpt.ui.button({...}); await b.click();
 *   await sculpt.ui.button({...}).click();
 */
export type LazyHandle<T> = PromiseLike<T> & {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => Promise<infer R>
    ? (...args: A) => Promise<R>
    : T[K];
};

const LAZY_METHODS = [
  "click",
  "setValue",
  "type",
  "clear",
  "select",
  "fill",
  "submit",
  "fields",
  "close",
  "title",
  "buttons",
  "info",
  "extract",
  "value",
  "explain",
  "describe"
] as const;

function lazy<T extends UIElement>(promise: Promise<T>): LazyHandle<T> {
  const handle: Record<string, unknown> = {
    then: (onFulfilled?: ((v: T) => unknown) | null, onRejected?: ((e: unknown) => unknown) | null) =>
      promise.then(onFulfilled, onRejected)
  };
  for (const method of LAZY_METHODS) {
    handle[method] = (...args: unknown[]) =>
      promise.then((element) => {
        const fn = (element as unknown as Record<string, unknown>)[method];
        if (typeof fn !== "function") {
          throw new SculptError("UNKNOWN", `${element.constructor.name} has no method ${method}`, { layer: "uikit" });
        }
        return (fn as (...a: unknown[]) => unknown).apply(element, args);
      });
  }
  return handle as LazyHandle<T>;
}
