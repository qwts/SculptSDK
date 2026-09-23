import { describe, expect, it } from "vitest";
import {
  ALLOWED_ATTRIBUTES,
  allowlistAttributes,
  buildCandidateSummaryDTO,
  computeValueShape,
  isExcludedField,
  Redactor,
  redactRoute,
  sanitizeError
} from "@sculptsdk/core";

describe("computeValueShape", () => {
  it("classifies without ever needing the raw value to leave the process", () => {
    expect(computeValueShape(true)).toBe("boolean");
    expect(computeValueShape(42)).toBe("number");
    expect(computeValueShape("ada@example.com")).toBe("email");
    expect(computeValueShape("+1 (555) 123-4567")).toBe("phone");
    expect(computeValueShape("2024-01-15")).toBe("date");
    expect(computeValueShape("01/15/2024")).toBe("date");
    expect(computeValueShape("hi")).toBe("short-text");
    expect(computeValueShape("x".repeat(61))).toBe("long-text");
  });
});

describe("isExcludedField", () => {
  it("excludes password, hidden, file, and cc-* autocomplete fields", () => {
    expect(isExcludedField({ type: "password" })).toBe(true);
    expect(isExcludedField({ type: "hidden" })).toBe(true);
    expect(isExcludedField({ type: "file" })).toBe(true);
    expect(isExcludedField({ type: "text", autocomplete: "cc-number" })).toBe(true);
    expect(isExcludedField({ type: "text", autocomplete: "CC-EXP" })).toBe(true);
  });

  it("does not exclude an ordinary field", () => {
    expect(isExcludedField({ type: "text" })).toBe(false);
    expect(isExcludedField({ type: "email", autocomplete: "email" })).toBe(false);
    expect(isExcludedField({})).toBe(false);
  });
});

describe("allowlistAttributes", () => {
  it("keeps only allowlisted keys, dropping everything else", () => {
    const result = allowlistAttributes({
      "aria-label": "Close",
      "data-secret-token": "abc123",
      style: "display:none",
      role: "button"
    });
    expect(result).toEqual({ "aria-label": "Close", role: "button" });
    expect(result).not.toHaveProperty("data-secret-token");
    expect(result).not.toHaveProperty("style");
  });

  it("every key it can return is in the documented allowlist", () => {
    const everything = Object.fromEntries([...ALLOWED_ATTRIBUTES, "value", "onclick"].map((k) => [k, "x"]));
    const result = allowlistAttributes(everything);
    for (const key of Object.keys(result)) {
      expect(ALLOWED_ATTRIBUTES).toContain(key);
    }
    expect(result).not.toHaveProperty("value");
    expect(result).not.toHaveProperty("onclick");
  });

  it("returns an empty object for undefined input", () => {
    expect(allowlistAttributes(undefined)).toEqual({});
  });
});

describe("redactRoute", () => {
  it("keeps only the path, stripping anything the caller passes beyond it", () => {
    expect(redactRoute({ path: "/checkout/step-2" })).toBe("/checkout/step-2");
  });
});

describe("Redactor", () => {
  it("scrubs a learned value wherever it appears in outbound text", () => {
    const redactor = new Redactor();
    redactor.learn("ada@example.com");
    expect(redactor.text("Field 'ada@example.com' failed validation")).toBe("Field '[redacted]' failed validation");
    expect(redactor.text("aria-label mentions ada@example.com here")).toBe("aria-label mentions [redacted] here");
  });

  it("scrubs the same learned value from every distinct sink text", () => {
    const redactor = new Redactor();
    redactor.learn("Ada Lovelace");
    const sinks = {
      validationMessage: "Name 'Ada Lovelace' is already taken",
      accessibleName: "Edit profile for Ada Lovelace",
      routeSegment: "/users/Ada Lovelace/edit",
      ariaLabel: "Remove Ada Lovelace from list",
      goal: "find the profile named Ada Lovelace"
    };
    for (const [name, text] of Object.entries(sinks)) {
      expect(redactor.text(text), name).not.toContain("Ada Lovelace");
      expect(redactor.text(text), name).toContain("[redacted]");
    }
  });

  it("does not touch text that never contained a learned value", () => {
    const redactor = new Redactor();
    redactor.learn("secret-value");
    expect(redactor.text("nothing sensitive here")).toBe("nothing sensitive here");
  });

  it("ignores values under 2 characters to avoid mangling ordinary text", () => {
    const redactor = new Redactor();
    redactor.learn("a");
    expect(redactor.text("a cat sat on a mat")).toBe("a cat sat on a mat");
  });

  it("runs operator-supplied free-text rules in addition to learned-value scrubbing", () => {
    const redactor = new Redactor([(text) => text.replace(/\bSSN:\s*\d{3}-\d{2}-\d{4}\b/g, "SSN:[redacted]")]);
    redactor.learn("Ada");
    const result = redactor.text("Ada's SSN: 123-45-6789");
    expect(result).toBe("[redacted]'s SSN:[redacted]");
  });

  it("attributes() allowlists and redacts learned values in one step", () => {
    const redactor = new Redactor();
    redactor.learn("ada@example.com");
    const result = redactor.attributes({ "aria-label": "Contact ada@example.com", "data-secret": "ada@example.com" });
    expect(result).toEqual({ "aria-label": "Contact [redacted]" });
  });

  it("undefined text passes through as undefined", () => {
    const redactor = new Redactor();
    expect(redactor.text(undefined)).toBeUndefined();
  });
});

describe("buildCandidateSummaryDTO", () => {
  it("never carries a raw value, only allowlisted description fields", () => {
    const redactor = new Redactor();
    redactor.learn("ada@example.com");
    const dto = buildCandidateSummaryDTO(
      {
        targetId: "t1",
        kind: "input",
        role: "textbox",
        accessibleName: "Email (ada@example.com)",
        visibleText: "ada@example.com",
        attributes: { "aria-label": "Email field for ada@example.com", value: "ada@example.com", style: "color:red" }
      },
      redactor
    );

    expect(dto.candidateId).toBe("t1");
    expect(dto.accessibleName).toBe("Email ([redacted])");
    expect(dto.visibleText).toBe("[redacted]");
    expect(dto.attributes).toEqual({ "aria-label": "Email field for [redacted]" });
    expect(JSON.stringify(dto)).not.toContain("ada@example.com");
  });

  it("truncates long text before it ever reaches the DTO", () => {
    const redactor = new Redactor();
    const longText = "x".repeat(500);
    const dto = buildCandidateSummaryDTO({ targetId: "t1", visibleText: longText }, redactor, { maxTextLength: 10 });
    expect(dto.visibleText?.length).toBeLessThanOrEqual(11); // 10 chars + ellipsis
  });
});

describe("sanitizeError", () => {
  it("redacts a learned value out of an arbitrary thrown error's message", () => {
    const redactor = new Redactor();
    redactor.learn("ada@example.com");
    const error = new Error("upstream rejected value ada@example.com");
    const sanitized = sanitizeError(error, redactor);
    expect(sanitized.message).not.toContain("ada@example.com");
    expect(sanitized.message).toContain("[redacted]");
  });

  it("handles a non-Error thrown value without throwing itself", () => {
    const redactor = new Redactor();
    const sanitized = sanitizeError("a bare string throw", redactor);
    expect(sanitized.code).toBe("UNKNOWN");
    expect(typeof sanitized.message).toBe("string");
  });
});
