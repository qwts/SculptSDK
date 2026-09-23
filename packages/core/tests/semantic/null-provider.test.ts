import { afterEach, describe, expect, it, vi } from "vitest";
import { NullProvider, ProviderUnavailableError, type DecisionEvidence, type DecisionRequest } from "@sculptsdk/core";

function request(): DecisionRequest {
  const evidence: DecisionEvidence = {
    requestId: "r1",
    operationId: "o1",
    point: "test-point",
    model: "any-model",
    questionVersion: "v1",
    policyVersion: "v1",
    origin: "http://fixtures.local",
    frameId: "main",
    navigationEpoch: 1,
    candidateSetDigest: "cd",
    redactedStateDigest: "sd",
    deadline: Date.now() + 1000,
    signal: new AbortController().signal
  };
  return { evidence, questions: [{ kind: "choice", id: "q1", options: ["a", "none"] }] };
}

describe("NullProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports() is always false — it has no real answers for any model", () => {
    const provider = new NullProvider();
    expect(provider.supports("any-model", "any-calibration")).toBe(false);
  });

  it("decide() always rejects with a typed ProviderUnavailableError, reason null_provider", async () => {
    const provider = new NullProvider();
    await expect(provider.decide(request())).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(provider.decide(request())).rejects.toMatchObject({ reasonCode: "null_provider" });
  });

  it("makes no network or timer calls", async () => {
    const fetchSpy = typeof globalThis.fetch === "function" ? vi.spyOn(globalThis, "fetch") : null;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const provider = new NullProvider();
    await provider.decide(request()).catch(() => {
      // Expected to reject — we only care that it did so without I/O.
    });

    if (fetchSpy) expect(fetchSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("imports no I/O module (network, fs, or timers) at all — static proof, not just a spy", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(fileURLToPath(new URL("../../src/semantic/null-provider.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bsetTimeout\s*\(/);
    expect(source).not.toMatch(/from\s+"node:(fs|net|http|https|dgram|dns)/);
    expect(source).not.toMatch(/require\(/);
  });
});
