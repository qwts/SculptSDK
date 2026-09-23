import { describe, expect, it } from "vitest";
import { fromKernelError, isSculptError, SculptError, toSculptError } from "@sculptsdk/core";

describe("SculptError", () => {
  it("attaches recoverable/retryable traits per code", () => {
    const ambiguous = new SculptError("TARGET_AMBIGUOUS", "matched more than one element");
    expect(ambiguous.recoverable).toBe(false);
    expect(ambiguous.retryable).toBe(false);

    const notFound = new SculptError("TARGET_NOT_FOUND", "no element matched");
    expect(notFound.recoverable).toBe(true);
    expect(notFound.retryable).toBe(true);

    const capability = new SculptError("CAPABILITY_UNAVAILABLE", "not available");
    expect(capability.recoverable).toBe(false);
    expect(capability.retryable).toBe(false);
  });

  it("defaults layer to foundation and carries target/details", () => {
    const target = { targetId: "t1", role: "button" };
    const error = new SculptError("TARGET_STALE", "target moved", { details: { attempt: 1 }, target });
    expect(error.layer).toBe("foundation");
    expect(error.target).toEqual(target);
    expect(error.details).toEqual({ attempt: 1 });
  });

  it("respects an explicit layer", () => {
    const error = new SculptError("INPUT_FAILED", "click failed", { layer: "uikit" });
    expect(error.layer).toBe("uikit");
  });

  it("toShape() mirrors the wire error shape", () => {
    const error = new SculptError("POSTCONDITION_FAILED", "verdict rejected", {
      layer: "orchestration",
      details: { reason: "timeout" }
    });
    expect(error.toShape()).toEqual({
      code: "POSTCONDITION_FAILED",
      message: "verdict rejected",
      layer: "orchestration",
      target: undefined,
      recoverable: false,
      retryable: false,
      details: { reason: "timeout" }
    });
  });

  it("isSculptError distinguishes SculptError from a plain Error", () => {
    expect(isSculptError(new SculptError("UNKNOWN", "x"))).toBe(true);
    expect(isSculptError(new Error("plain"))).toBe(false);
    expect(isSculptError("not an error")).toBe(false);
  });

  describe("fromKernelError", () => {
    it("maps a known wire code to its typed SculptError", () => {
      const error = fromKernelError({ code: "TARGET_NOT_VISIBLE", message: "hidden", details: { reason: "css" } });
      expect(error.code).toBe("TARGET_NOT_VISIBLE");
      expect(error.recoverable).toBe(true);
      expect(error.details).toEqual({ reason: "css" });
    });

    it("falls back to UNKNOWN for an unrecognized wire code", () => {
      const error = fromKernelError({ code: "SOMETHING_THE_KERNEL_INVENTED", message: "surprise" });
      expect(error.code).toBe("UNKNOWN");
      expect(error.message).toBe("surprise");
    });
  });

  describe("toSculptError", () => {
    it("passes an existing SculptError through unchanged", () => {
      const original = new SculptError("TARGET_OCCLUDED", "covered");
      expect(toSculptError(original)).toBe(original);
    });

    it("wraps a plain Error as UNKNOWN with the original as cause", () => {
      const original = new Error("boom");
      const wrapped = toSculptError(original);
      expect(wrapped.code).toBe("UNKNOWN");
      expect(wrapped.message).toBe("boom");
      expect(wrapped.cause).toBe(original);
    });

    it("wraps a non-Error value as UNKNOWN via String()", () => {
      const wrapped = toSculptError({ weird: true });
      expect(wrapped.code).toBe("UNKNOWN");
      expect(wrapped.message).toBe("[object Object]");
    });
  });
});

describe("CI smoke check (temporary, proves a red test fails CI — removed in the next commit)", () => {
  it("DELIBERATELY FAILS", () => {
    expect(1).toBe(2);
  });
});
