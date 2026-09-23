import { describe, expect, it } from "vitest";
import { checkRiskFloor, RISK_FLOOR_KEYWORDS, confirmationRequiredError } from "@sculptsdk/core";

/**
 * DP-7 deterministic risk floor (#26): pure keyword matching against the
 * three signals `runAction` gathers before dispatch — no kernel, no
 * provider, nothing async.
 */

describe("checkRiskFloor", () => {
  it("matches every keyword in the starting list, case-insensitively", () => {
    for (const keyword of RISK_FLOOR_KEYWORDS) {
      expect(checkRiskFloor({ accessibleName: `${keyword.toUpperCase()} now` })).toBe(keyword);
      expect(checkRiskFloor({ accessibleName: `please ${keyword}` })).toBe(keyword);
    }
  });

  it("matches on accessible name, visible text, or form action independently", () => {
    expect(checkRiskFloor({ accessibleName: "Delete" })).toBe("delete");
    expect(checkRiskFloor({ text: "This will delete your data" })).toBe("delete");
    expect(checkRiskFloor({ formAction: "/api/delete-account" })).toBe("delete");
  });

  it("returns undefined when none of the three signals read as risky", () => {
    expect(checkRiskFloor({ accessibleName: "Save", text: "Save your changes", formAction: "/api/save" })).toBeUndefined();
    expect(checkRiskFloor({})).toBeUndefined();
  });

  it("a benign substring match is still a match — the floor doesn't try to disambiguate intent", () => {
    // "Delete filter" is the story's own example of a measured false
    // escalation (#26) — not something to special-case away.
    expect(checkRiskFloor({ accessibleName: "Delete filter" })).toBe("delete");
  });

  it("only whole keywords match, not arbitrary substrings of unrelated words", () => {
    expect(checkRiskFloor({ accessibleName: "Sender preferences" })).toBeUndefined();
    expect(checkRiskFloor({ accessibleName: "Payroll settings" })).toBeUndefined();
  });
});

describe("confirmationRequiredError", () => {
  it("is recoverable and not retryable", () => {
    const error = confirmationRequiredError("delete", { targetId: "t1", name: "Delete account" });
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
    expect(error.recoverable).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.details?.matchedKeyword).toBe("delete");
  });
});
