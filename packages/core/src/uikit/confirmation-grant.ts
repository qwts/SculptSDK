/**
 * @experimental DP-7 single-use confirmation grants (#27) — verification and
 * consumption for the `ConfirmationGrant` shape (`types/confirmation.ts`).
 * A grant satisfies only the deterministic risk floor (#26); it never
 * grants authority, enables a disabled capability, or waives a
 * precondition. The SDK never constructs or issues a grant to itself —
 * only verifies and consumes what the trusted host supplies.
 */
import { createHash } from "node:crypto";
import { SculptError } from "../errors.js";
import type { ConfirmationGrant, FormMaterialSnapshot } from "../types/index.js";

/** The risk floor's own policy version — bump alongside a real change to
 * the keyword list or matching logic (`risk-floor.ts`) so a grant reviewed
 * under an earlier floor policy can never silently clear a hit produced by
 * a different one. */
export const RISK_FLOOR_POLICY_VERSION = "v1";

/** A `click` carries no material payload of its own beyond the target it's
 * bound to (already covered by `targetDigest`) — this fixed marker stands
 * in for "material state" so the field is never left meaningless. */
export const CLICK_MATERIAL_DIGEST = "click:no-material";

/** Deterministic digest of what a `submit` actually posts — the "form-plan
 * digest" a `submit` grant is bound to. Built from `FormMaterialSnapshot`
 * (`kernel/forms.ts`'s `formMaterialSnapshot` op), not `FormFieldSummary`:
 * the material state a page can change after a human reviewer sees the form
 * includes hidden fields and the form's own `action`/`method`, neither of
 * which a label-keyed, visible-fields-only summary ever carries. Keyed by
 * `name`+`id` (a hidden field has no visible label), and excludes nothing
 * else — every field the browser will actually submit is in scope. The host
 * uses this same function to compute the digest it binds a grant to, so a
 * later mismatch here is a real material change, never just a coincidence
 * of hashing differently.
 *
 * SHA-256, not a fast non-cryptographic hash: unlike a cache/recording-match
 * digest, this one is a security binding — a grant is only as trustworthy as
 * the guarantee that no two materially different field states can produce
 * the same digest. A 32-bit hash (the original djb2 here) is trivially
 * collidable by construction and must never be used for this. */
export function computeFormValuesDigest(snapshot: FormMaterialSnapshot): string {
  const normalized = {
    action: snapshot.action,
    method: snapshot.method,
    fields: [...snapshot.fields]
      .map((f) => ({ name: f.name, id: f.id, type: f.type, value: f.value ?? "" }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id))
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export type GrantInvalidReason =
  | "reused"
  | "action-mismatch"
  | "wrong-document"
  | "target-stale"
  | "material-mismatch"
  | "policy-version-mismatch"
  | "risk-decision-mismatch"
  | "expired";

export function confirmationGrantInvalidError(reason: GrantInvalidReason, grantId: string): SculptError {
  return new SculptError("CONFIRMATION_GRANT_INVALID", `confirmation grant rejected: ${reason}`, {
    layer: "uikit",
    details: { reason, grantId }
  });
}

export interface GrantVerificationContext {
  actionType: "click" | "submit";
  targetDigest: string;
  /** True when this resolve had to rebind to a replacement element at all
   * (the original ref was gone) — a grant is bound to the exact element a
   * human reviewed, so any rebind invalidates it even when the replacement
   * happens to compute the same identity digest (`ElementIdentity` is
   * deliberately designed to match a "similar enough" element across a
   * rerender for the default, unguarded path — the wrong notion of
   * sameness for a grant, which is why #27 depends on #22's stricter,
   * never-rebind guarantee instead). */
  rebound: boolean;
  documentId: string;
  navigationEpoch: number;
  origin: string;
  materialDigest: string;
  riskDecision: string;
  now: number;
}

/**
 * Pure verification — every field is checked independently so the specific
 * mismatch is always the one reported, never a generic rejection. Takes
 * `alreadyConsumed` as a plain boolean rather than a registry so this stays
 * testable without any stateful dependency; `ConsumedGrantRegistry` below is
 * what a caller checks it against.
 */
export function verifyConfirmationGrant(
  grant: ConfirmationGrant,
  context: GrantVerificationContext,
  alreadyConsumed: boolean
): { ok: true } | { ok: false; error: SculptError } {
  if (alreadyConsumed) return { ok: false, error: confirmationGrantInvalidError("reused", grant.grantId) };
  if (grant.actionType !== context.actionType) {
    return { ok: false, error: confirmationGrantInvalidError("action-mismatch", grant.grantId) };
  }
  if (grant.documentId !== context.documentId || grant.navigationEpoch !== context.navigationEpoch || grant.origin !== context.origin) {
    return { ok: false, error: confirmationGrantInvalidError("wrong-document", grant.grantId) };
  }
  if (context.rebound || grant.targetDigest !== context.targetDigest) {
    return { ok: false, error: confirmationGrantInvalidError("target-stale", grant.grantId) };
  }
  if (grant.materialDigest !== context.materialDigest) {
    return { ok: false, error: confirmationGrantInvalidError("material-mismatch", grant.grantId) };
  }
  if (grant.policyVersion !== RISK_FLOOR_POLICY_VERSION) {
    return { ok: false, error: confirmationGrantInvalidError("policy-version-mismatch", grant.grantId) };
  }
  if (grant.riskDecision !== context.riskDecision) {
    return { ok: false, error: confirmationGrantInvalidError("risk-decision-mismatch", grant.grantId) };
  }
  if (grant.expiresAt <= context.now) {
    return { ok: false, error: confirmationGrantInvalidError("expired", grant.grantId) };
  }
  return { ok: true };
}

/**
 * Memory-only, bounded record of consumed grant ids — scoped to one
 * `Sculpt` attachment, same lifetime discipline as #25's decision cache
 * (owned by `ActionEnv`, cleared on `dispose()`). A grant is consumed the
 * instant it clears the floor, whether or not the action goes on to
 * succeed for an unrelated reason (a failed precondition afterward doesn't
 * un-consume it) — "single-use" means the confirmation was spent, not that
 * the click happened.
 *
 * Retention is expiry-aware, not insertion-order LRU: a consumed id must
 * outlive its own grant's `expiresAt`, however many *other* grants get
 * consumed in the meantime, or a still-valid grant could be evicted and
 * then replayed. `maxEntries` is only a defensive cap against unbounded
 * growth, applied by sweeping everything already expired first.
 */
export class ConsumedGrantRegistry {
  private readonly consumed = new Map<string, number>();

  constructor(private readonly maxEntries: number = 1000) {}

  has(grantId: string): boolean {
    return this.consumed.has(grantId);
  }

  consume(grantId: string, expiresAt: number): void {
    this.consumed.set(grantId, expiresAt);
    if (this.consumed.size > this.maxEntries) this.sweepExpired();
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.consumed) {
      if (expiresAt <= now) this.consumed.delete(id);
    }
  }

  clear(): void {
    this.consumed.clear();
  }

  get size(): number {
    return this.consumed.size;
  }
}
