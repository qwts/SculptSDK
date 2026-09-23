/**
 * @experimental DP-7 single-use confirmation grants (#27) — verification and
 * consumption for the `ConfirmationGrant` shape (`types/confirmation.ts`).
 * A grant satisfies only the deterministic risk floor (#26); it never
 * grants authority, enables a disabled capability, or waives a
 * precondition. The SDK never constructs or issues a grant to itself —
 * only verifies and consumes what the trusted host supplies.
 */
import { SculptError } from "../errors.js";
import type { ConfirmationGrant, FormFieldSummary } from "../types/index.js";

/** The risk floor's own policy version — bump alongside a real change to
 * the keyword list or matching logic (`risk-floor.ts`) so a grant reviewed
 * under an earlier floor policy can never silently clear a hit produced by
 * a different one. */
export const RISK_FLOOR_POLICY_VERSION = "v1";

/** A `click` carries no material payload of its own beyond the target it's
 * bound to (already covered by `targetDigest`) — this fixed marker stands
 * in for "material state" so the field is never left meaningless. */
export const CLICK_MATERIAL_DIGEST = "click:no-material";

function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** Deterministic digest of a form's current field values — the "form-plan
 * digest" a `submit` grant is bound to. Excludes each field's own
 * `targetId` (a rerender assigns a new one even for the "same" field, per
 * `RefRegistry`) — only `label`/`kind`/`required`/`value` make two states
 * the same or different. The host uses this same function to compute the
 * digest it binds a grant to, so a later mismatch here is a real material
 * change, never just a coincidence of hashing differently. */
export function computeFormValuesDigest(fields: readonly FormFieldSummary[]): string {
  const normalized = [...fields]
    .map((f) => ({ label: f.label, kind: f.kind, required: f.required, value: f.value ?? "" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return djb2(JSON.stringify(normalized));
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
 */
export class ConsumedGrantRegistry {
  private readonly consumed = new Set<string>();

  constructor(private readonly maxEntries: number = 1000) {}

  has(grantId: string): boolean {
    return this.consumed.has(grantId);
  }

  consume(grantId: string): void {
    this.consumed.add(grantId);
    if (this.consumed.size > this.maxEntries) {
      const oldest = this.consumed.values().next().value;
      if (oldest !== undefined) this.consumed.delete(oldest);
    }
  }

  clear(): void {
    this.consumed.clear();
  }

  get size(): number {
    return this.consumed.size;
  }
}
