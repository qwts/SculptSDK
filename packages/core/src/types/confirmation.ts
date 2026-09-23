/**
 * DP-7 single-use confirmation grant (#27). Replaces a reusable
 * `confirmed: true` boolean: a grant authorizes exactly one action, on
 * exactly the target and material state it was reviewed against, exactly
 * once. It satisfies only the deterministic risk floor (#26) — it never
 * grants authority, enables a disabled capability, or waives a
 * precondition; those gates run exactly as they always do whether or not a
 * grant was checked first.
 *
 * The trusted host decides where a grant comes from — existing
 * authorization, a human's response to a prompt — and constructs it itself;
 * the SDK never issues one to itself. See `uikit/confirmation-grant.ts` for
 * verification and the single-use consumption registry.
 */
export interface ConfirmationGrant {
  /** Unique per grant — the single-use token. A reused id is rejected even
   * if every other field would otherwise still match. */
  grantId: string;
  actionType: "click" | "submit";
  /** The target's identity digest (`ElementIdentity.id`) at review time —
   * a rerender changes this, the same way it fails the #22 execution guard. */
  targetDigest: string;
  documentId: string;
  navigationEpoch: number;
  origin: string;
  /** Digest of the material state reviewed alongside the action — a form's
   * current field values for `submit` (see `computeFormValuesDigest`), or
   * the fixed `CLICK_MATERIAL_DIGEST` marker for a `click`, which carries no
   * payload of its own beyond the target itself. */
  materialDigest: string;
  /** Must match the risk floor's own policy version at verification time. */
  policyVersion: string;
  /** The exact keyword the floor matched when this grant was reviewed and
   * approved — a grant for one risk reason never covers a different one. */
  riskDecision: string;
  /** Absolute epoch ms; past this, the grant is expired. */
  expiresAt: number;
}
