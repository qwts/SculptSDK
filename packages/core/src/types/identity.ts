import type { UIKind } from "./kinds.js";

export interface FormSignature {
  formName?: string;
  fieldLabel?: string;
}

export interface RouteSignature {
  path: string;
}

/**
 * Semantic element identity designed to survive SPA rerenders (§14.2).
 * Every component is optional except the derived id and the confidence of
 * the binding that produced it.
 */
export interface ElementIdentity {
  id: string;
  kind?: UIKind;
  role?: string;
  accessibleName?: string;
  textSignature?: string;
  domPath?: string;
  formSignature?: FormSignature;
  routeSignature?: RouteSignature;
  confidence: number;
}

export type RebindStrategy =
  | "live-handle"
  | "dom-path"
  | "role-and-name"
  | "form-association"
  | "text-signature";

export interface RebindResult {
  targetId: string;
  confidence: number;
  strategy: RebindStrategy;
}
