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

/**
 * Binds a mutation to the exact page state a decision was made against
 * (#22). A target accepted from semantic evidence must act on that target or
 * fail — it must never be silently swapped for a different element at
 * execution time the way the default handle-goes-stale path can.
 *
 * `rebind: "forbid"` is always the value today; it is a field rather than an
 * implicit rule so a future guard mode (e.g. a bounded rebind) has somewhere
 * to be added without a new shape.
 *
 * Scope note: this guarantees the *target* wasn't swapped. It does not
 * revalidate the mandatory predicates of whatever query originally admitted
 * it — a caller that built the guard from its own query results is
 * responsible for that. Browser state is also not atomic across async
 * adapter calls: native input dispatched after this check passes can still
 * race a page change. This records what was validated and when, not a
 * guarantee nothing else could possibly happen afterward.
 */
export interface ExecutionGuard {
  documentId: string;
  navigationEpoch: number;
  /** The target's `ElementIdentity.id` at decision time. */
  targetDigest: string;
  rebind: "forbid";
}
