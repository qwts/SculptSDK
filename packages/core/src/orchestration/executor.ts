import type {
  ActionOptions,
  ActionResult,
  AgentAction,
  AgentActionResponse,
  AgentActionSuggestion,
  PageDelta,
  PageSnapshot,
  RuntimeAdapter,
  TargetRef,
  UIQuery
} from "../types/index.js";
import { SculptError, toSculptError } from "../errors.js";
import type { ActionEnv } from "../uikit/action-runner.js";
import { syntheticResult } from "../uikit/action-runner.js";
import { UIDialog, UIElement, UIForm, UIInput, UIRoot, UISelect, UITable } from "../uikit/index.js";

/**
 * Agent Orchestration Layer (§23): converts typed agent actions into UIKit
 * executions, returns a page delta and next-action suggestions with every
 * response so the model can plan without re-reading the whole page.
 */

function isTargetRef(target: UIQuery | TargetRef | undefined): target is TargetRef {
  return target !== undefined && typeof (target as TargetRef).targetId === "string";
}

function diffSnapshots(before: PageSnapshot, after: PageSnapshot): PageDelta {
  const beforeDialogs = new Set(before.dialogs.map((d) => d.title ?? d.targetId));
  const afterDialogs = new Set(after.dialogs.map((d) => d.title ?? d.targetId));
  const beforeAlerts = new Set(before.alerts.map((a) => a.text));
  return {
    urlChanged: before.url !== after.url,
    routeChanged: before.route.url !== after.route.url,
    dialogsOpened: [...afterDialogs].filter((d) => !beforeDialogs.has(d)),
    dialogsClosed: [...beforeDialogs].filter((d) => !afterDialogs.has(d)),
    alertsAdded: after.alerts.map((a) => a.text).filter((t) => !beforeAlerts.has(t)),
    mutationActivity: Math.max(0, after.mutations.totalSinceAttach - before.mutations.totalSinceAttach)
  };
}

function suggestNextActions(snapshot: PageSnapshot): AgentActionSuggestion[] {
  const suggestions: AgentActionSuggestion[] = [];
  const dialog = snapshot.dialogs[0];
  if (dialog) {
    suggestions.push({
      type: "close_dialog",
      description: `close the open dialog${dialog.title ? ` "${dialog.title}"` : ""}`,
      target: dialog.title ? { kind: "dialog", name: dialog.title } : undefined
    });
    for (const button of dialog.buttons.slice(0, 2)) {
      if (button.name) {
        suggestions.push({
          type: "click",
          description: `click "${button.name}" in the dialog`,
          target: { kind: "button", name: button.name, within: dialog.title ? { kind: "dialog", name: dialog.title } : { kind: "dialog" } }
        });
      }
    }
    return suggestions.slice(0, 3);
  }
  const form = snapshot.forms[0];
  if (form && form.fields.length > 0) {
    suggestions.push({
      type: "fill_form",
      description: `fill the "${form.name ?? "page"}" form (${form.fields.length} fields)`,
      target: form.name ? { kind: "form", name: form.name } : { kind: "form" }
    });
  }
  for (const action of snapshot.primaryActions.slice(0, 2)) {
    if (action.name) {
      suggestions.push({
        type: "click",
        description: `click "${action.name}"`,
        target: { kind: "button", name: action.name }
      });
    }
  }
  return suggestions.slice(0, 3);
}

export class AgentOrchestrator {
  constructor(
    private readonly env: ActionEnv,
    private readonly ui: UIRoot,
    private readonly adapter: RuntimeAdapter
  ) {}

  async execute(action: AgentAction): Promise<AgentActionResponse> {
    const before = await this.snapshotSafe();
    let result: ActionResult;
    try {
      result = await this.dispatch(action);
    } catch (caught) {
      const error = toSculptError(caught, "orchestration");
      result = syntheticResult(this.env, action.type, { ok: false, error });
    }
    const after = await this.snapshotSafe();
    return {
      ok: result.ok,
      action,
      result,
      pageDelta: diffSnapshots(before, after),
      nextSuggestedActions: suggestNextActions(after),
      errors: result.error ? [result.error] : []
    };
  }

  private snapshotSafe(): Promise<PageSnapshot> {
    return this.env.foundation.snapshots.page({ maxInteractiveElements: 15 });
  }

  private async findTarget(action: AgentAction, defaults: UIQuery): Promise<UIElement> {
    if (isTargetRef(action.target)) return this.ui.fromRef(action.target);
    return this.ui.find({ ...defaults, ...(action.target ?? {}) });
  }

  private options(action: AgentAction): ActionOptions {
    return { preconditions: action.preconditions, postconditions: action.postconditions };
  }

  private async dispatch(action: AgentAction): Promise<ActionResult> {
    switch (action.type) {
      case "inspect_page": {
        const snapshot = await this.env.foundation.snapshots.page();
        return syntheticResult(this.env, action.type, { ok: true, value: snapshot });
      }

      case "find_element": {
        const element = await this.findTarget(action, {});
        return syntheticResult(this.env, action.type, {
          ok: true,
          value: { summary: element.summary, identity: element.identity, confidence: element.confidence }
        });
      }

      case "click":
      case "open_menu": {
        const element = await this.findTarget(action, { kind: "button" });
        return element.click(this.options(action));
      }

      case "type_text": {
        const element = await this.findTarget(action, { kind: "input" });
        if (!(element instanceof UIInput)) {
          throw new SculptError("TARGET_NOT_FOUND", "type_text target is not an editable input", {
            layer: "orchestration",
            target: element.summary
          });
        }
        return element.setValue(String(action.args?.text ?? ""), this.options(action));
      }

      case "select_option": {
        const element = await this.findTarget(action, { kind: "select" });
        const value = action.args?.value;
        if (value === undefined) {
          throw new SculptError("INPUT_FAILED", "select_option requires args.value", { layer: "orchestration" });
        }
        if (element instanceof UISelect) return element.select(value, this.options(action));
        if (element instanceof UIInput) return element.setValue(value, this.options(action));
        throw new SculptError("TARGET_NOT_FOUND", "select_option target is not selectable", {
          layer: "orchestration",
          target: element.summary
        });
      }

      case "fill_form": {
        const element = await this.findTarget(action, { kind: "form" });
        if (!(element instanceof UIForm)) {
          throw new SculptError("TARGET_NOT_FOUND", "fill_form target is not a form", {
            layer: "orchestration",
            target: element.summary
          });
        }
        const startedAt = Date.now();
        const values = (action.args?.values ?? {}) as Record<string, unknown>;
        const fill = await element.fill(values);
        let error: SculptError | undefined;
        if (!fill.ok) {
          const hasValidationErrors = fill.validationErrors.length > 0;
          error = new SculptError(
            hasValidationErrors ? "POSTCONDITION_FAILED" : "INPUT_FAILED",
            hasValidationErrors
              ? `form reported validation errors: ${fill.validationErrors.map((e) => e.message).join("; ")}`
              : `form fill incomplete (unmapped: ${fill.unmapped.join(", ") || "none"}; ambiguous: ${fill.ambiguous.map((a) => a.key).join(", ") || "none"})`,
            { layer: "orchestration", target: element.summary, details: { fill: JSON.parse(JSON.stringify(fill)) as Record<string, unknown> } }
          );
        }
        return syntheticResult(this.env, action.type, { ok: fill.ok, value: fill, error, startedAt });
      }

      case "close_dialog": {
        const element = await this.findTarget(action, { kind: "dialog" });
        if (!(element instanceof UIDialog)) {
          throw new SculptError("TARGET_NOT_FOUND", "close_dialog target is not a dialog", {
            layer: "orchestration",
            target: element.summary
          });
        }
        return element.close(this.options(action));
      }

      case "wait_for_state": {
        const startedAt = Date.now();
        const report = await this.env.foundation.observers.waitForStableState(action.args?.stability ?? {});
        return syntheticResult(this.env, action.type, {
          ok: report.stable,
          value: report,
          startedAt,
          error: report.stable
            ? undefined
            : new SculptError("STABLE_STATE_TIMEOUT", `page did not stabilize: ${report.reasons.join("; ")}`, {
                layer: "orchestration"
              })
        });
      }

      case "navigate": {
        const url = action.args?.url;
        if (typeof url !== "string") {
          throw new SculptError("INPUT_FAILED", "navigate requires args.url", { layer: "orchestration" });
        }
        const startedAt = Date.now();
        await this.adapter.call({ name: "page.navigate", url });
        const report = await this.env.foundation.observers.waitForStableState(action.args?.stability ?? {});
        return syntheticResult(this.env, action.type, { ok: true, value: { url, stable: report.stable }, startedAt });
      }

      case "extract_table": {
        const element = await this.findTarget(action, { kind: "table" });
        if (!(element instanceof UITable)) {
          throw new SculptError("TARGET_NOT_FOUND", "extract_table target is not a table", {
            layer: "orchestration",
            target: element.summary
          });
        }
        const data = await element.extract();
        return syntheticResult(this.env, action.type, { ok: true, value: data });
      }

      case "download_file":
      case "custom":
        return syntheticResult(this.env, action.type, {
          ok: false,
          error: new SculptError("CAPABILITY_UNAVAILABLE", `agent action "${action.type}" is not supported in this release`, {
            layer: "orchestration"
          })
        });
    }
  }
}
