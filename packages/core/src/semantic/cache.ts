/**
 * @experimental Session-scoped decision evidence cache (#25). Memory-only,
 * scoped to one `Sculpt` attachment, bounded in size — never persisted.
 * Stores evidence only (a validated answer and its record), never
 * authorization and never an element handle; a hit still goes through the
 * same freshness (#15) and execution guard (#22) revalidation a fresh
 * decision would.
 */
import type { SemanticDecisionRecord } from "./records.js";

/**
 * Every component that can make a cached answer wrong if it changes. Two
 * requests differing in any single field here must never collide on the
 * same entry — `key()` below folds them all into the lookup key, so a
 * version bump, a navigation, or a policy/config change is a miss by
 * construction rather than something the cache has to be told about.
 */
export interface DecisionCacheKey {
  point: string;
  model: string;
  questionVersion: string;
  policyVersion: string;
  mode: string;
  /** The kernel's own build version (`KernelEvidence.kernelVersion`) — the
   * "candidate-generation version" #25 asks for. */
  candidateGenerationVersion: string;
  /** `Redactor`'s built-in pipeline version (`REDACTION_VERSION`). */
  redactionVersion: string;
  /** The calibration threshold actually in effect, or `"none"` in shadow
   * mode. There's no separate "calibration version" identifier anywhere in
   * the codebase (#21 isn't built) — the threshold value itself stands in
   * for one: a different threshold is a different decision. */
  calibrationMinConfidence: number | "none";
  origin: string;
  frameId: string;
  documentId: string;
  navigationEpoch: number;
  candidateSetDigest: string;
  redactedStateDigest: string;
}

export interface CachedDecision {
  acceptedTargetId: string | undefined;
  record: SemanticDecisionRecord;
}

function keyString(key: DecisionCacheKey): string {
  return [
    key.point,
    key.model,
    key.questionVersion,
    key.policyVersion,
    key.mode,
    key.candidateGenerationVersion,
    key.redactionVersion,
    String(key.calibrationMinConfidence),
    key.origin,
    key.frameId,
    key.documentId,
    String(key.navigationEpoch),
    key.candidateSetDigest,
    key.redactedStateDigest
  ].join("::");
}

/**
 * A bounded, memory-only LRU cache of decision evidence. `get`/`set` are the
 * only ways in or out — nothing here ever stores a `UIElement`, a target
 * handle, or anything resembling an authorization decision, only
 * `{ acceptedTargetId, record }`. Eviction is least-recently-used once
 * `maxEntries` is reached.
 */
export class DecisionEvidenceCache {
  private readonly entries = new Map<string, CachedDecision>();

  constructor(private readonly maxEntries: number = 100) {}

  get(key: DecisionCacheKey): CachedDecision | undefined {
    const k = keyString(key);
    const entry = this.entries.get(k);
    if (!entry) return undefined;
    // Map preserves insertion order; delete+re-set moves this key to the
    // end, marking it most-recently-used for the eviction in `set`.
    this.entries.delete(k);
    this.entries.set(k, entry);
    return entry;
  }

  set(key: DecisionCacheKey, value: CachedDecision): void {
    const k = keyString(key);
    this.entries.delete(k);
    this.entries.set(k, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Drops every entry — navigation/config-change invalidation is already
   * covered by those fields being part of the key (a stale entry simply
   * never matches again), so `clear()` itself is only ever called on
   * `dispose()` to free memory rather than to enforce correctness. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
