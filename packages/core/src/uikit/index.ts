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
  KernelEvidence,
  SetValueOptions,
  SubmitOptions,
  TargetRef,
  TargetSummary,
  TextMatcher,
  UIKind,
  UIQuery
} from "../types/index.js";
import type { QueryCandidate } from "../types/queries.js";
import { serializeQuery } from "../types/queries.js";
import type { DomNode, FormFieldSummary, DialogSummary } from "../types/index.js";
import type { ActionEnv } from "./action-runner.js";
import { runAction, checkRiskFloorForTarget } from "./action-runner.js";
import type { KernelTarget } from "../foundation/index.js";
import { SculptError } from "../errors.js";
import { DP1_POINT, DP1_RECALL_CAP, resolveDisambiguation, type SemanticDecisionRecord } from "../semantic/index.js";

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
    if (options.submit) {
      // #26: check the floor against the form's *pre-fill* state.
      // `formFill` below dispatches input/change events that a page's own
      // handlers could react to by altering the form's action/text — an
      // already-laundered, benign-looking state is exactly what
      // `submit()`'s own post-fill check could otherwise be fooled by.
      // Reported the same way `submit()`'s own failure is (a resolved
      // `{ ok: false, submitError }`, never a thrown rejection) so callers
      // don't need two different failure shapes for the same option.
      try {
        await checkRiskFloorForTarget(this.env, this.target(options.guard), this.summary);
      } catch (caught) {
        if (!(caught instanceof SculptError)) throw caught;
        return { ok: false, filled: [], unmapped: [], ambiguous: [], validationErrors: [], submitError: caught };
      }
    }
    const result = await this.env.kernel.call<FormFillResult>("formFill", {
      target: this.target(options.guard),
      values
    });
    if (options.submit && result.ok) {
      const submitResult = await this.submit(options);
      if (!submitResult.ok) {
        // The fill itself succeeded, but the caller asked for submit and
        // didn't get it — never report success for a submission that never
        // happened (e.g. a #22 guard mismatch after a fill-induced rerender).
        return { ...result, ok: false, submitError: submitResult.error };
      }
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

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function matcherText(matcher: TextMatcher): string {
  return matcher instanceof RegExp ? matcher.source : matcher;
}

/** One intent sentence describing a query (§2's DP-1 state shape) — free
 * text, learned by the runtime's redactor like any other outbound string. */
function describeQueryIntent(query: UIQuery): string {
  const parts: string[] = [query.kind ?? "element"];
  if (query.name !== undefined) parts.push(`named like "${matcherText(query.name)}"`);
  if (query.label !== undefined) parts.push(`labelled like "${matcherText(query.label)}"`);
  if (query.text !== undefined) parts.push(`with text like "${matcherText(query.text)}"`);
  return `find a ${parts.join(" ")}`;
}

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
    return (await this.tryFindDetailed(query)).element;
  }

  /** Shared by `tryFind` and `find` so a miss carries its DP-1 recall
   * shortlist/record through to `find`'s thrown error without changing
   * `tryFind`'s "returns null on a miss" contract (#24). */
  private async tryFindDetailed(query: UIQuery): Promise<{
    element: UIElement | null;
    missShortlist?: QueryCandidate[];
    missRecord?: SemanticDecisionRecord;
  }> {
    const TIE_QUERY_LIMIT = 5;
    const { candidates, total, evidence } = await this.env.kernel.call<{
      candidates: QueryCandidate[];
      total: number;
      evidence: KernelEvidence;
    }>("query", { query: serializeQuery(query), limit: TIE_QUERY_LIMIT });
    const min = query.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const best = candidates[0];
    if (!best || best.confidence < min) {
      if (query.recall && this.env.semantic.isPointEnabled(DP1_POINT)) {
        const recalled = await this.resolveViaDp1Recall(query, evidence);
        if (recalled.element) return { element: recalled.element };
        return { element: null, missShortlist: recalled.shortlist, missRecord: recalled.record };
      }
      return { element: null };
    }
    const second = candidates[1];
    if (!(second && second.confidence >= min && best.score - second.score < AMBIGUITY_MARGIN)) {
      return { element: instantiate(this.env, best, query.kind) };
    }

    // A genuine tie: every candidate here already passed every mandatory
    // matcher deterministically (I1/I3) — DP-1 only helps pick among them,
    // it never widens the admitted set (#23).
    let tied = candidates.filter((c) => c.confidence >= min && best.score - c.score < AMBIGUITY_MARGIN);
    // The tied set filled the query's own limit while more candidates exist
    // beyond it (`total`): a candidate we never saw could also be tied, so
    // this set isn't provably complete — re-query wide enough to know for
    // sure rather than silently disambiguating among a truncated subset.
    if (tied.length === candidates.length && total > candidates.length) {
      const widened = await this.env.kernel.call<{ candidates: QueryCandidate[] }>("query", {
        query: serializeQuery(query),
        limit: total
      });
      tied = widened.candidates.filter((c) => c.confidence >= min && best.score - c.score < AMBIGUITY_MARGIN);
    }
    let dp1Record: SemanticDecisionRecord | undefined;
    if (this.env.semantic.isPointEnabled(DP1_POINT)) {
      const disambiguated = await this.resolveViaDp1(query, tied, evidence);
      dp1Record = disambiguated.record;
      if (disambiguated.element) return { element: disambiguated.element };
    }

    throw new SculptError("TARGET_AMBIGUOUS", "query matched multiple equally-ranked elements", {
      layer: "uikit",
      details: {
        candidates: candidates.slice(0, 3).map((c) => ({
          name: c.summary.name,
          role: c.summary.role,
          score: c.score,
          confidence: c.confidence
        })),
        ...(dp1Record ? { semantic: dp1Record } : {})
      }
    });
  }

  /** DP-1 disambiguation (#23): never throws, never widens `tied` — either
   * it accepts one of the already-admitted tied candidates or it doesn't,
   * and the caller falls through to today's TARGET_AMBIGUOUS unchanged. */
  private async resolveViaDp1(
    query: UIQuery,
    tied: QueryCandidate[],
    evidence: KernelEvidence
  ): Promise<{ element: UIElement | null; record: SemanticDecisionRecord }> {
    const route = await this.env.foundation.observers.routeState();
    const { acceptedTargetId, record } = await resolveDisambiguation({
      runtime: this.env.semantic,
      origin: safeOrigin(route.url),
      tied,
      mode: "tie",
      intent: describeQueryIntent(query),
      // The hash fragment can carry OAuth tokens and other sensitive state
      // (page state, never a form value) — never send it to a provider.
      routePath: route.path,
      documentEvidence: evidence,
      checkFreshness: () => this.env.foundation.observers.evidence()
    });
    const accepted = acceptedTargetId ? tied.find((c) => c.summary.targetId === acceptedTargetId) : undefined;
    return { element: accepted ? instantiate(this.env, accepted, query.kind) : null, record };
  }

  /** DP-1 recall (#24): re-queries with only `name`/`text` dropped — every
   * other predicate, including `within`/`route`/`region`/`state`, stays
   * exactly as mandatory as in the original query. Deterministic, capped
   * retrieval (`DP1_RECALL_CAP`); never throws, never widens beyond that
   * capped shortlist. */
  private async resolveViaDp1Recall(
    query: UIQuery,
    evidence: KernelEvidence
  ): Promise<{ element: UIElement | null; shortlist: QueryCandidate[]; record: SemanticDecisionRecord }> {
    const recallQuery: UIQuery = { ...query, name: undefined, text: undefined, recall: undefined, minConfidence: undefined };
    const { candidates: shortlist } = await this.env.kernel.call<{ candidates: QueryCandidate[] }>("query", {
      query: serializeQuery(recallQuery),
      limit: DP1_RECALL_CAP
    });
    const route = await this.env.foundation.observers.routeState();
    const { acceptedTargetId, record } = await resolveDisambiguation({
      runtime: this.env.semantic,
      origin: safeOrigin(route.url),
      tied: shortlist,
      mode: "miss",
      intent: describeQueryIntent(query),
      // The hash fragment can carry OAuth tokens and other sensitive state
      // (page state, never a form value) — never send it to a provider.
      routePath: route.path,
      documentEvidence: evidence,
      checkFreshness: () => this.env.foundation.observers.evidence()
    });
    const accepted = acceptedTargetId ? shortlist.find((c) => c.summary.targetId === acceptedTargetId) : undefined;
    return { element: accepted ? instantiate(this.env, accepted, query.kind) : null, shortlist, record };
  }

  async find(query: UIQuery): Promise<UIElement> {
    const { element, missShortlist, missRecord } = await this.tryFindDetailed(query);
    if (!element) {
      throw new SculptError("TARGET_NOT_FOUND", "no element matched the semantic query", {
        layer: "uikit",
        details: {
          query: JSON.parse(JSON.stringify(serializeQuery(query))) as Record<string, unknown>,
          ...(missShortlist
            ? { shortlist: missShortlist.slice(0, 3).map((c) => ({ name: c.summary.name, role: c.summary.role, score: c.score })) }
            : {}),
          ...(missRecord ? { semantic: missRecord } : {})
        }
      });
    }
    return element;
  }

  /** Builds a typed handle from an existing target reference. */
  async fromRef(ref: TargetRef): Promise<UIElement> {
    const resolution = await this.env.foundation.identity.resolve({ targetId: ref.targetId });
    const candidate: QueryCandidate = {
      summary: resolution.summary,
      identity: resolution.identity,
      score: 0,
      confidence: 1,
      reasons: ["resolved from explicit target reference"],
      unverifiedMandatoryPredicates: []
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
  // The runtime always defers through the underlying promise, so every lazy
  // method call is async regardless of whether the resolved method itself
  // is sync (e.g. `guardFrom`) or already async — the type must say so too,
  // or a lazy call on a sync method type-checks as sync but returns a
  // Promise at runtime.
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
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
  "describe",
  "guardFrom"
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
