/**
 * @experimental Deterministic request digest (ADR-0001, ADR-0008): identifies
 * "the same request" for recording replay (`RecordedProvider`) and, later,
 * evidence-based caching. Covers only what makes two requests semantically
 * interchangeable — model, question schema version, policy version, and the
 * redacted-state/candidate digests. Deliberately excludes `requestId` /
 * `operationId` (per-call, would make every digest unique) and raw state
 * (never available here — only its already-redacted digest is).
 */
import type { DecisionEvidence } from "./provider.js";

export type RequestDigestInput = Pick<
  DecisionEvidence,
  "model" | "questionVersion" | "policyVersion" | "candidateSetDigest" | "redactedStateDigest"
>;

/** Same non-cryptographic, stable string hash the kernel's identity system
 * already uses (djb2) — good enough for "same request" matching, and keeps
 * this module dependency-free and usable in any environment. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export function computeRequestDigest(input: RequestDigestInput): string {
  return djb2(
    JSON.stringify([
      input.model,
      input.questionVersion,
      input.policyVersion,
      input.candidateSetDigest,
      input.redactedStateDigest
    ])
  );
}
