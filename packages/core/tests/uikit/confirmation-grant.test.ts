import { describe, expect, it } from "vitest";
import {
  computeFormValuesDigest,
  verifyConfirmationGrant,
  ConsumedGrantRegistry,
  CLICK_MATERIAL_DIGEST,
  RISK_FLOOR_POLICY_VERSION,
  type ConfirmationGrant,
  type FormMaterialSnapshot
} from "@sculptsdk/core";

/**
 * DP-7 single-use confirmation grants (#27): pure verification logic, plus
 * the consumption registry. Integration through the real `runAction` path
 * is in `confirmation-grant-action.test.ts`.
 */

function baseGrant(overrides: Partial<ConfirmationGrant> = {}): ConfirmationGrant {
  return {
    grantId: "grant-1",
    actionType: "click",
    targetDigest: "identity-1",
    documentId: "doc-1",
    navigationEpoch: 0,
    origin: "http://fixtures.local",
    materialDigest: CLICK_MATERIAL_DIGEST,
    policyVersion: RISK_FLOOR_POLICY_VERSION,
    riskDecision: "delete",
    expiresAt: Date.now() + 60_000,
    ...overrides
  };
}

function baseContext(overrides: Partial<Parameters<typeof verifyConfirmationGrant>[1]> = {}) {
  return {
    actionType: "click" as const,
    targetDigest: "identity-1",
    rebound: false,
    documentId: "doc-1",
    navigationEpoch: 0,
    origin: "http://fixtures.local",
    materialDigest: CLICK_MATERIAL_DIGEST,
    riskDecision: "delete",
    now: Date.now(),
    ...overrides
  };
}

describe("verifyConfirmationGrant: a matching grant is accepted", () => {
  it("ok when every field matches and it hasn't been consumed", () => {
    const result = verifyConfirmationGrant(baseGrant(), baseContext(), false);
    expect(result.ok).toBe(true);
  });
});

describe("verifyConfirmationGrant: each of the acceptance criteria's invalid cases", () => {
  it("a reused grant (alreadyConsumed) is rejected", () => {
    const result = verifyConfirmationGrant(baseGrant(), baseContext(), true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(result.error.details?.reason).toBe("reused");
    }
  });

  it("a target that rerendered (targetDigest mismatch) is rejected", () => {
    const result = verifyConfirmationGrant(baseGrant(), baseContext({ targetDigest: "identity-2" }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("target-stale");
  });

  it("any rebind at all is rejected as target-stale, even if the rebound element computes the same identity digest", () => {
    // ElementIdentity is deliberately designed to match a "similar enough"
    // replacement across a rerender (that's what makes the default,
    // unguarded rebind path work) — the wrong notion of sameness for a
    // grant bound to the exact element a human reviewed.
    const result = verifyConfirmationGrant(baseGrant(), baseContext({ rebound: true }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("target-stale");
  });

  it("a different form-values digest is rejected", () => {
    const grant = baseGrant({ actionType: "submit", materialDigest: "digest-a" });
    const result = verifyConfirmationGrant(grant, baseContext({ actionType: "submit", materialDigest: "digest-b" }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("material-mismatch");
  });

  it("an expired grant is rejected", () => {
    const grant = baseGrant({ expiresAt: Date.now() - 1000 });
    const result = verifyConfirmationGrant(grant, baseContext(), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("expired");
  });

  it("a grant from another document is rejected", () => {
    const result = verifyConfirmationGrant(baseGrant(), baseContext({ documentId: "doc-2" }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("wrong-document");
  });

  it("a grant from a different navigation epoch (same document) is rejected", () => {
    const result = verifyConfirmationGrant(baseGrant(), baseContext({ navigationEpoch: 1 }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("wrong-document");
  });

  it("a grant from another origin is rejected", () => {
    const result = verifyConfirmationGrant(baseGrant(), baseContext({ origin: "http://evil.example" }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("wrong-document");
  });

  it("a grant issued for a different action type is rejected", () => {
    const result = verifyConfirmationGrant(baseGrant({ actionType: "click" }), baseContext({ actionType: "submit" }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("action-mismatch");
  });

  it("a grant approving a different risk decision than the one actually matched is rejected", () => {
    const result = verifyConfirmationGrant(baseGrant({ riskDecision: "delete" }), baseContext({ riskDecision: "transfer" }), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("risk-decision-mismatch");
  });

  it("a grant from a stale policy version is rejected", () => {
    const result = verifyConfirmationGrant(baseGrant({ policyVersion: "v0" }), baseContext(), false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe("policy-version-mismatch");
  });

  it("CONFIRMATION_GRANT_INVALID is recoverable but never retryable", () => {
    const result = verifyConfirmationGrant(baseGrant(), baseContext(), true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.recoverable).toBe(true);
      expect(result.error.retryable).toBe(false);
    }
  });
});

function materialSnapshot(
  fields: { name: string; id?: string; type?: string; value?: string }[],
  overrides: { action?: string; method?: string } = {}
): FormMaterialSnapshot {
  return {
    fields: fields.map((f) => ({ id: "", type: "text", ...f })),
    action: overrides.action ?? "/submit",
    method: overrides.method ?? "post"
  };
}

describe("computeFormValuesDigest", () => {
  it("is order-independent — field order doesn't change the digest", () => {
    const a = computeFormValuesDigest(
      materialSnapshot([
        { name: "name", value: "Alice" },
        { name: "email", value: "alice@example.com" }
      ])
    );
    const b = computeFormValuesDigest(
      materialSnapshot([
        { name: "email", value: "alice@example.com" },
        { name: "name", value: "Alice" }
      ])
    );
    expect(a).toBe(b);
  });

  it("differs when a value actually changes", () => {
    const a = computeFormValuesDigest(materialSnapshot([{ name: "amount", value: "100" }]));
    const b = computeFormValuesDigest(materialSnapshot([{ name: "amount", value: "1000" }]));
    expect(a).not.toBe(b);
  });

  it("differs when a hidden field's value changes — the visible fields alone don't cover this", () => {
    const a = computeFormValuesDigest(
      materialSnapshot([
        { name: "amount", value: "100" },
        { name: "account-id", type: "hidden", value: "acct-1" }
      ])
    );
    const b = computeFormValuesDigest(
      materialSnapshot([
        { name: "amount", value: "100" },
        { name: "account-id", type: "hidden", value: "acct-2" }
      ])
    );
    expect(a).not.toBe(b);
  });

  it("differs when the form's action changes — a retargeted submit is a different material state", () => {
    const fields = [{ name: "amount", value: "100" }];
    const a = computeFormValuesDigest(materialSnapshot(fields, { action: "/checkout/purchase" }));
    const b = computeFormValuesDigest(materialSnapshot(fields, { action: "/checkout/purchase-as-gift-card" }));
    expect(a).not.toBe(b);
  });

  it("differs when the form's method changes", () => {
    const fields = [{ name: "amount", value: "100" }];
    const a = computeFormValuesDigest(materialSnapshot(fields, { method: "post" }));
    const b = computeFormValuesDigest(materialSnapshot(fields, { method: "get" }));
    expect(a).not.toBe(b);
  });

  it("is a collision-resistant SHA-256 hex digest — the 32-bit djb2 this replaced collided on real inputs", () => {
    // "1r" and "30" both hashed to the same 32-bit djb2 value (d60932c8) —
    // this is the exact case the review flagged as a forgeable material
    // digest for a security binding.
    const a = computeFormValuesDigest(materialSnapshot([{ name: "code", value: "1r" }]));
    const b = computeFormValuesDigest(materialSnapshot([{ name: "code", value: "30" }]));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ConsumedGrantRegistry", () => {
  const future = Date.now() + 60_000;
  const past = Date.now() - 60_000;

  it("has() is false before consume(), true after", () => {
    const registry = new ConsumedGrantRegistry();
    expect(registry.has("g1")).toBe(false);
    registry.consume("g1", future);
    expect(registry.has("g1")).toBe(true);
  });

  it("clear() forgets everything", () => {
    const registry = new ConsumedGrantRegistry();
    registry.consume("g1", future);
    registry.clear();
    expect(registry.has("g1")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("retains still-valid entries past maxEntries — a valid grant is never evicted just to make room", () => {
    const registry = new ConsumedGrantRegistry(5);
    for (let i = 0; i < 50; i++) registry.consume(`g${i}`, future);
    expect(registry.size).toBe(50);
    expect(registry.has("g0")).toBe(true);
    expect(registry.has("g49")).toBe(true);
  });

  it("sweeps already-expired entries once the registry grows past maxEntries", () => {
    const registry = new ConsumedGrantRegistry(5);
    for (let i = 0; i < 5; i++) registry.consume(`expired-${i}`, past);
    // The 6th consume crosses maxEntries, triggering a sweep right in that
    // same call — the 5 already-expired entries are dropped, the still-valid
    // one (an unrelated grant consumed around the same time) survives
    // regardless of insertion order.
    registry.consume("still-valid", future);
    expect(registry.size).toBe(1);
    for (let i = 0; i < 5; i++) expect(registry.has(`expired-${i}`)).toBe(false);
    expect(registry.has("still-valid")).toBe(true);
  });
});
