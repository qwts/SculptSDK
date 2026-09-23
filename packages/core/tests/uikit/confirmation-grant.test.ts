import { describe, expect, it } from "vitest";
import {
  computeFormValuesDigest,
  verifyConfirmationGrant,
  ConsumedGrantRegistry,
  CLICK_MATERIAL_DIGEST,
  RISK_FLOOR_POLICY_VERSION,
  type ConfirmationGrant
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

describe("computeFormValuesDigest", () => {
  it("is order-independent — field order doesn't change the digest", () => {
    const a = computeFormValuesDigest([
      { targetId: "t1", label: "Name", kind: "input", required: true, value: "Alice" },
      { targetId: "t2", label: "Email", kind: "input", required: true, value: "alice@example.com" }
    ]);
    const b = computeFormValuesDigest([
      { targetId: "t9", label: "Email", kind: "input", required: true, value: "alice@example.com" },
      { targetId: "t8", label: "Name", kind: "input", required: true, value: "Alice" }
    ]);
    expect(a).toBe(b);
  });

  it("ignores each field's own targetId — a rerender assigning new ids doesn't change the digest", () => {
    const a = computeFormValuesDigest([{ targetId: "t1", label: "Name", kind: "input", required: true, value: "Alice" }]);
    const b = computeFormValuesDigest([{ targetId: "t99", label: "Name", kind: "input", required: true, value: "Alice" }]);
    expect(a).toBe(b);
  });

  it("differs when a value actually changes", () => {
    const a = computeFormValuesDigest([{ targetId: "t1", label: "Amount", kind: "input", required: true, value: "100" }]);
    const b = computeFormValuesDigest([{ targetId: "t1", label: "Amount", kind: "input", required: true, value: "1000" }]);
    expect(a).not.toBe(b);
  });
});

describe("ConsumedGrantRegistry", () => {
  it("has() is false before consume(), true after", () => {
    const registry = new ConsumedGrantRegistry();
    expect(registry.has("g1")).toBe(false);
    registry.consume("g1");
    expect(registry.has("g1")).toBe(true);
  });

  it("clear() forgets everything", () => {
    const registry = new ConsumedGrantRegistry();
    registry.consume("g1");
    registry.clear();
    expect(registry.has("g1")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("is bounded — never grows past maxEntries", () => {
    const registry = new ConsumedGrantRegistry(5);
    for (let i = 0; i < 50; i++) registry.consume(`g${i}`);
    expect(registry.size).toBe(5);
  });
});
