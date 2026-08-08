import type { UIKind } from "./kinds.js";

export type FrameId = string;
export type ShadowRootId = string;

/** Stable handle to an element tracked by the in-page kernel. */
export interface TargetRef {
  targetId: string;
  frameId?: FrameId;
}

/** Alias kept for design-document parity; DOM-level refs are target refs. */
export type NodeRef = TargetRef;

/** Compact, model-readable description of a target element. */
export interface TargetSummary {
  targetId: string;
  kind?: UIKind;
  role?: string;
  name?: string;
  tagName?: string;
  visible?: boolean;
  enabled?: boolean;
}

/** Normalized DOM node representation (design doc §9.4). */
export interface DomNode {
  ref: TargetRef;
  nodeType: number;
  tagName?: string;
  attributes: Record<string, string>;
  text?: string;
  value?: string;
  role?: string;
  accessibleName?: string;
  visible: boolean;
  enabled: boolean;
  focusable: boolean;
  editable: boolean;
  frameId: FrameId;
  inShadowRoot: boolean;
}
