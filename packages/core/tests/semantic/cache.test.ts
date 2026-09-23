import { describe, expect, it } from "vitest";
import { DecisionEvidenceCache, type DecisionCacheKey, type CachedDecision } from "@sculptsdk/core";
import type { SemanticDecisionRecord } from "@sculptsdk/core";

/**
 * Session-scoped decision evidence cache (#25): a bounded, memory-only
 * key/value store. These tests exercise `DecisionEvidenceCache` directly —
 * every versioned/identity component of the key is varied one at a time to
 * show a change in any one of them is a miss, per #25's acceptance criteria.
 */

function baseKey(overrides: Partial<DecisionCacheKey> = {}): DecisionCacheKey {
  return {
    point: "dp1-target",
    model: "unset",
    questionVersion: "v1",
    policyVersion: "v1",
    mode: "tie",
    candidateGenerationVersion: "0.5.0",
    redactionVersion: "v1",
    calibrationMinConfidence: 0.5,
    origin: "http://fixtures.local",
    frameId: "main",
    documentId: "doc-1",
    navigationEpoch: 0,
    candidateSetDigest: "t1,t2",
    redactedStateDigest: "digest-1",
    ...overrides
  };
}

function record(): SemanticDecisionRecord {
  return {
    point: "dp1-target",
    provider: "stub",
    model: "unset",
    questionVersion: "v1",
    policyVersion: "v1",
    candidateSetDigest: "t1,t2",
    redactedStateDigest: "digest-1",
    outcomes: [],
    status: "accepted",
    latencyMs: 1
  };
}

function entry(acceptedTargetId = "t1"): CachedDecision {
  return { acceptedTargetId, record: record() };
}

describe("DecisionEvidenceCache: basic get/set", () => {
  it("a miss returns undefined", () => {
    const cache = new DecisionEvidenceCache();
    expect(cache.get(baseKey())).toBeUndefined();
  });

  it("set then get with the identical key returns the stored entry", () => {
    const cache = new DecisionEvidenceCache();
    const value = entry();
    cache.set(baseKey(), value);
    expect(cache.get(baseKey())).toEqual(value);
  });

  it("clear() empties the cache", () => {
    const cache = new DecisionEvidenceCache();
    cache.set(baseKey(), entry());
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get(baseKey())).toBeUndefined();
  });
});

describe("DecisionEvidenceCache: changing any single versioned component is a miss", () => {
  const variants: [string, Partial<DecisionCacheKey>][] = [
    ["point", { point: "dp2-other" }],
    ["model", { model: "gpt-x" }],
    ["questionVersion", { questionVersion: "v2" }],
    ["policyVersion", { policyVersion: "v2" }],
    ["mode", { mode: "miss" }],
    ["candidateGenerationVersion (kernel version)", { candidateGenerationVersion: "0.6.0" }],
    ["redactionVersion", { redactionVersion: "v2" }],
    ["calibrationMinConfidence", { calibrationMinConfidence: 0.9 }],
    ["calibrationMinConfidence (shadow mode)", { calibrationMinConfidence: "none" }],
    ["origin", { origin: "http://other.local" }],
    ["frameId", { frameId: "subframe" }],
    ["documentId", { documentId: "doc-2" }],
    ["navigationEpoch", { navigationEpoch: 1 }],
    ["candidateSetDigest", { candidateSetDigest: "t3,t4" }],
    ["redactedStateDigest", { redactedStateDigest: "digest-2" }]
  ];

  for (const [label, override] of variants) {
    it(`differs by ${label}`, () => {
      const cache = new DecisionEvidenceCache();
      cache.set(baseKey(), entry());
      expect(cache.get(baseKey(override))).toBeUndefined();
      // The original key still hits — this isn't a global cache-busting bug.
      expect(cache.get(baseKey())).toBeDefined();
    });
  }
});

describe("DecisionEvidenceCache: bounded size, least-recently-used eviction", () => {
  it("evicts the least-recently-used entry once maxEntries is exceeded", () => {
    const cache = new DecisionEvidenceCache(2);
    cache.set(baseKey({ candidateSetDigest: "a" }), entry("a"));
    cache.set(baseKey({ candidateSetDigest: "b" }), entry("b"));
    expect(cache.size).toBe(2);

    cache.set(baseKey({ candidateSetDigest: "c" }), entry("c"));
    expect(cache.size).toBe(2);
    // "a" was the least recently used (never re-read) — evicted first.
    expect(cache.get(baseKey({ candidateSetDigest: "a" }))).toBeUndefined();
    expect(cache.get(baseKey({ candidateSetDigest: "b" }))).toBeDefined();
    expect(cache.get(baseKey({ candidateSetDigest: "c" }))).toBeDefined();
  });

  it("a get() refreshes recency, protecting it from the next eviction", () => {
    const cache = new DecisionEvidenceCache(2);
    cache.set(baseKey({ candidateSetDigest: "a" }), entry("a"));
    cache.set(baseKey({ candidateSetDigest: "b" }), entry("b"));

    // Touch "a" so "b" becomes the least-recently-used one instead.
    cache.get(baseKey({ candidateSetDigest: "a" }));
    cache.set(baseKey({ candidateSetDigest: "c" }), entry("c"));

    expect(cache.get(baseKey({ candidateSetDigest: "a" }))).toBeDefined();
    expect(cache.get(baseKey({ candidateSetDigest: "b" }))).toBeUndefined();
    expect(cache.get(baseKey({ candidateSetDigest: "c" }))).toBeDefined();
  });

  it("never grows past maxEntries however many distinct keys are set", () => {
    const cache = new DecisionEvidenceCache(5);
    for (let i = 0; i < 50; i++) {
      cache.set(baseKey({ candidateSetDigest: `t${i}` }), entry(`t${i}`));
    }
    expect(cache.size).toBe(5);
  });
});

describe("DecisionEvidenceCache: stores evidence only", () => {
  it("a stored entry carries only { acceptedTargetId, record } — nothing else", () => {
    const cache = new DecisionEvidenceCache();
    const value = entry();
    cache.set(baseKey(), value);
    const got = cache.get(baseKey());
    expect(Object.keys(got!).sort()).toEqual(["acceptedTargetId", "record"]);
  });
});
