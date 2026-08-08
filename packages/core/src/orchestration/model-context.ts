import type {
  AgentAction,
  AgentActionResponse,
  ModelActionList,
  ModelPageSummary,
  ModelTargetExplanation,
  PageSnapshot,
  SnapshotOptions,
  TargetRef,
  UIKind
} from "../types/index.js";
import type { ActionEnv } from "../uikit/action-runner.js";
import type { AgentOrchestrator } from "./executor.js";
import type { DomNode, ElementIdentity, VisibilityState } from "../types/index.js";

/**
 * Model Context API (§24): concise state for an LLM. Never the raw DOM —
 * semantic summaries, stable target references, and typed actions only.
 */

const INTERACTIONS_BY_KIND: Partial<Record<UIKind, string[]>> = {
  button: ["click"],
  link: ["click"],
  input: ["type_text", "click"],
  textarea: ["type_text"],
  checkbox: ["click"],
  radio: ["click"],
  select: ["select_option"],
  combobox: ["select_option", "type_text"],
  form: ["fill_form"],
  dialog: ["close_dialog", "click"],
  table: ["extract_table"]
};

export function toModelSummary(snapshot: PageSnapshot): ModelPageSummary {
  const warnings: string[] = [];
  if (snapshot.dialogs.length > 0) {
    warnings.push("a dialog is open and may block interaction with the page behind it");
  }
  if (snapshot.network.observed && snapshot.network.inflight > 0) {
    warnings.push(`${snapshot.network.inflight} network request(s) still in flight`);
  }
  if (!snapshot.network.observed) {
    warnings.push("network observation is disabled; network state is unknown");
  }
  return {
    url: snapshot.url,
    title: snapshot.title,
    route: snapshot.route.path + snapshot.route.hash,
    dialogs: snapshot.dialogs.map((d) => ({
      title: d.title,
      buttons: d.buttons.map((b) => b.name ?? "(unnamed)"),
      targetId: d.targetId
    })),
    forms: snapshot.forms.map((f) => ({
      name: f.name,
      fields: f.fields.map((field) => field.label || "(unlabeled)"),
      targetId: f.targetId
    })),
    primaryActions: snapshot.primaryActions.map((a) => ({ name: a.name, kind: a.kind, targetId: a.targetId })),
    interactiveElements: snapshot.interactiveElements.map((e) => ({
      name: e.name,
      kind: e.kind,
      targetId: e.targetId,
      value: e.value
    })),
    alerts: snapshot.alerts.map((a) => a.text),
    frameworks: snapshot.frameworks.map((f) => (f.version ? `${f.name}@${f.version}` : f.name)),
    warnings
  };
}

export class ModelContext {
  constructor(
    private readonly env: ActionEnv,
    private readonly orchestrator: AgentOrchestrator
  ) {}

  async summarizePage(options?: SnapshotOptions): Promise<ModelPageSummary> {
    const snapshot = await this.env.foundation.snapshots.page(options);
    return toModelSummary(snapshot);
  }

  async listActions(): Promise<ModelActionList> {
    const snapshot = await this.env.foundation.snapshots.page({ maxInteractiveElements: 20 });
    const actions: ModelActionList["actions"] = [{ type: "inspect_page", description: "summarize current page state" }];
    for (const dialog of snapshot.dialogs) {
      actions.push({
        type: "close_dialog",
        description: `close dialog${dialog.title ? ` "${dialog.title}"` : ""}`,
        target: dialog.title ? { kind: "dialog", name: dialog.title } : { kind: "dialog" }
      });
    }
    for (const form of snapshot.forms) {
      actions.push({
        type: "fill_form",
        description: `fill form${form.name ? ` "${form.name}"` : ""} with fields: ${form.fields
          .map((f) => f.label)
          .filter(Boolean)
          .join(", ")}`,
        target: form.name ? { kind: "form", name: form.name } : { kind: "form" }
      });
    }
    for (const action of snapshot.primaryActions.slice(0, 5)) {
      if (action.name) {
        actions.push({ type: "click", description: `click "${action.name}"`, target: { kind: "button", name: action.name } });
      }
    }
    return { actions };
  }

  async explainTarget(ref: TargetRef): Promise<ModelTargetExplanation> {
    const target = { targetId: ref.targetId };
    const [node, visibility, identity] = await Promise.all([
      this.env.kernel.call<DomNode>("describe", { target }),
      this.env.kernel.call<VisibilityState>("visibility", { target }),
      this.env.kernel.call<ElementIdentity>("identity", { target })
    ]);
    return {
      summary: { targetId: ref.targetId, role: node.role, name: node.accessibleName, tagName: node.tagName },
      identity,
      visibility: { visible: visibility.displayed && visibility.inViewport, reasons: visibility.reasons },
      enabled: node.enabled,
      suggestedInteractions: (identity.kind && INTERACTIONS_BY_KIND[identity.kind]) ?? ["click"]
    };
  }

  execute(action: AgentAction): Promise<AgentActionResponse> {
    return this.orchestrator.execute(action);
  }
}
