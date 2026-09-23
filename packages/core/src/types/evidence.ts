/**
 * Read-only kernel evidence (§15): enough to tell whether the page a
 * candidate or query result came from is still the page it was gathered
 * against. Additive to the kernel protocol — `KERNEL_VERSION` bumped
 * alongside it. See `semantic/freshness.ts` for how it's used.
 */
export interface KernelEvidence {
  /** Identifies this in-page kernel injection; a hard reload gets a new one. */
  documentId: string;
  /** Increments on every observed route/navigation change within the same document. */
  navigationEpoch: number;
  frameId: "main" | "subframe";
  /** The injected kernel's own build version (`KERNEL_VERSION`) — the
   * "candidate-generation version" for anything keyed on it (#25's decision
   * evidence cache). Optional so hand-built evidence (tests, synthetic
   * policies) doesn't need to supply one. */
  kernelVersion?: string;
}
