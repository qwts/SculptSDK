import type { UIKind } from "./kinds.js";
import type { ElementIdentity } from "./identity.js";

export interface RouteState {
  url: string;
  path: string;
  hash: string;
}

export interface ViewportState {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export interface FrameworkSummary {
  name: "react" | "angular" | "vue" | "svelte" | "web-components";
  version?: string;
  confidence: number;
  evidence: string[];
}

export interface InteractiveElementSummary {
  targetId: string;
  kind: UIKind;
  role?: string;
  name?: string;
  value?: string;
  enabled: boolean;
}

export interface ActionSummary extends InteractiveElementSummary {
  /** Why this element ranks as a primary action. */
  reasons: string[];
}

export interface FormFieldSummary {
  targetId: string;
  label: string;
  kind: UIKind;
  required: boolean;
  value?: string;
}

export interface FormSummary {
  targetId: string;
  name?: string;
  fields: FormFieldSummary[];
}

/**
 * One field's raw material state for the #27 confirmation-grant digest —
 * deliberately a different shape from `FormFieldSummary`: it's keyed by
 * `name`/`id` (hidden fields have no visible label to key by) and it
 * includes every submittable control, hidden inputs included. Never used to
 * address a field by meaning — that's `FormFieldSummary`'s job.
 */
export interface FormMaterialField {
  name: string;
  id: string;
  type: string;
  value?: string;
}

/**
 * Everything a `submit` actually posts that a page could change after a
 * human reviewed it: every submittable field (hidden included) plus the
 * form's own `action`/`method` — a grant bound only to the visible,
 * labelable fields (`FormFieldSummary`) never covers a hidden field or a
 * retargeted form.
 */
export interface FormMaterialSnapshot {
  fields: FormMaterialField[];
  action: string;
  method: string;
}

export interface DialogSummary {
  targetId: string;
  role: string;
  title?: string;
  buttons: InteractiveElementSummary[];
}

export interface TableSummary {
  targetId: string;
  name?: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
}

export interface AlertSummary {
  targetId: string;
  role: string;
  text: string;
}

export interface NetworkSummary {
  observed: boolean;
  inflight: number;
  recentCompleted: { url: string; method: string; status?: number; endedAt: number }[];
}

export interface MutationSummary {
  totalSinceAttach: number;
  recentCount: number;
  lastMutationAgoMs: number | null;
}

/** Compact, deterministic, model-consumable page state (§15.2). */
export interface PageSnapshot {
  url: string;
  title: string;
  route: RouteState;
  focused?: { targetId: string; role?: string; name?: string };
  viewport: ViewportState;
  dialogs: DialogSummary[];
  forms: FormSummary[];
  primaryActions: ActionSummary[];
  interactiveElements: InteractiveElementSummary[];
  tables: TableSummary[];
  alerts: AlertSummary[];
  network: NetworkSummary;
  mutations: MutationSummary;
  frameworks: FrameworkSummary[];
  timestamp: number;
}

export interface SnapshotOptions {
  maxInteractiveElements?: number;
  includeTables?: boolean;
}

/** Model-facing condensed summary (§24.3). */
export interface ModelPageSummary {
  url: string;
  title: string;
  route?: string;
  dialogs: { title?: string; buttons: string[]; targetId: string }[];
  forms: { name?: string; fields: string[]; targetId: string }[];
  primaryActions: { name?: string; kind: UIKind; targetId: string }[];
  interactiveElements: { name?: string; kind: UIKind; targetId: string; value?: string }[];
  alerts: string[];
  frameworks: string[];
  warnings: string[];
}

export interface ModelTargetExplanation {
  summary: { targetId: string; role?: string; name?: string; tagName?: string };
  identity: ElementIdentity;
  visibility: { visible: boolean; reasons: string[] };
  enabled: boolean;
  suggestedInteractions: string[];
}
