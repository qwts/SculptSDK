/**
 * @experimental Freshness binding (ADR-0008): a decision is only usable
 * against the page it was made for. `FreshnessEvidence` is captured when
 * candidates are gathered and compared again right before an answer would be
 * used; any mismatch means the page moved on and the answer is discarded.
 *
 * Scope note (#15): this binds decisions to the page state at candidate-
 * gathering time. It does not add a mutation-time revision check before
 * dispatch, and it does not stop the kernel's own implicit rebind — both are
 * the DP-1 epic's job (#6). Browser state is not atomic across asynchronous
 * adapter calls; this records what was validated and when, not a guarantee
 * that nothing else could possibly race a native input event afterward.
 */
export interface FreshnessEvidence {
  /** Identifies this in-page kernel injection; changes on a hard reload. */
  documentId: string;
  /** Increments on every observed route/navigation change within the same document. */
  navigationEpoch: number;
  frameId: "main" | "subframe";
  /** Per-target digest (the kernel's `ElementIdentity.id`) — enough to
   * detect that the element a decision concerned was replaced. Omitted for
   * decisions that aren't about one specific element. */
  targetDigest?: string;
  /** Digest of the candidate set the questions were built from. */
  candidateSetDigest?: string;
}

/** True when nothing freshness-relevant changed between `captured` and `current`. */
export function isFresh(captured: FreshnessEvidence, current: FreshnessEvidence): boolean {
  if (captured.documentId !== current.documentId) return false;
  if (captured.navigationEpoch !== current.navigationEpoch) return false;
  if (captured.frameId !== current.frameId) return false;
  if (captured.targetDigest !== undefined && captured.targetDigest !== current.targetDigest) return false;
  if (captured.candidateSetDigest !== undefined && captured.candidateSetDigest !== current.candidateSetDigest) return false;
  return true;
}
