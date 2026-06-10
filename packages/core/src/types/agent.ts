import type {
  ActionPostconditions,
  ActionPreconditions,
  ActionResult,
  StabilityOptions
} from "./actions.js";
import type { TargetRef } from "./refs.js";
import type { UIQuery } from "./queries.js";
import type { SculptErrorShape } from "./actions.js";

export type AgentActionType =
  | "inspect_page"
  | "find_element"
  | "click"
  | "fill_form"
  | "type_text"
  | "select_option"
  | "open_menu"
  | "close_dialog"
  | "wait_for_state"
  | "navigate"
  | "extract_table"
  | "download_file"
  | "custom";

/** Typed action a model submits to the orchestration layer (§23.3). */
export interface AgentAction {
  type: AgentActionType;
  target?: UIQuery | TargetRef;
  args?: Record<string, unknown> & {
    values?: Record<string, unknown>;
    text?: string;
    value?: string | string[];
    url?: string;
    stability?: StabilityOptions;
  };
  preconditions?: ActionPreconditions;
  postconditions?: ActionPostconditions;
}

export interface PageDelta {
  urlChanged: boolean;
  routeChanged: boolean;
  dialogsOpened: string[];
  dialogsClosed: string[];
  alertsAdded: string[];
  mutationActivity: number;
}

export interface AgentActionSuggestion {
  type: AgentActionType;
  description: string;
  target?: UIQuery | TargetRef;
}

/** Structured response for every agent action (§23.4). */
export interface AgentActionResponse {
  ok: boolean;
  action: AgentAction;
  result: ActionResult;
  pageDelta: PageDelta;
  nextSuggestedActions: AgentActionSuggestion[];
  errors: SculptErrorShape[];
}

export interface ModelActionDescriptor {
  type: AgentActionType;
  description: string;
  target?: UIQuery;
}

export interface ModelActionList {
  actions: ModelActionDescriptor[];
}
