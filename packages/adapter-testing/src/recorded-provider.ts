/**
 * @experimental Fixture-replay decision provider (ADR-0007): deterministic
 * PR CI never calls a live provider. Answers are looked up by request
 * digest, never by call order, so reordering independent calls in a test
 * can never change the result.
 */
import {
  computeRequestDigest,
  ProviderUnavailableError,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse
} from "@sculptsdk/core";

export const RECORDING_FORMAT_VERSION = 1;

/** What a recording stores about the request it answers: identifying
 * metadata and digests only — never raw state, never a candidate's text. */
export interface DecisionRecordingRequestMeta {
  point: string;
  model: string;
  questionVersion: string;
  policyVersion: string;
  candidateSetDigest: string;
  redactedStateDigest: string;
}

export interface DecisionRecordingEntry {
  digest: string;
  request: DecisionRecordingRequestMeta;
  response: RawDecisionResponse;
}

export interface DecisionRecordingFile {
  formatVersion: typeof RECORDING_FORMAT_VERSION;
  recordings: DecisionRecordingEntry[];
}

export function isDecisionRecordingFile(value: unknown): value is DecisionRecordingFile {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { formatVersion?: unknown }).formatVersion === RECORDING_FORMAT_VERSION &&
    Array.isArray((value as { recordings?: unknown }).recordings)
  );
}

export class RecordedProvider implements DecisionProvider {
  readonly id = "recorded";

  private readonly byDigest = new Map<string, DecisionRecordingEntry>();

  constructor(file: DecisionRecordingFile) {
    if (file.formatVersion !== RECORDING_FORMAT_VERSION) {
      throw new Error(
        `RecordedProvider: unsupported recording format version ${String(file.formatVersion)} (expected ${RECORDING_FORMAT_VERSION})`
      );
    }
    for (const entry of file.recordings) {
      this.byDigest.set(entry.digest, entry);
    }
  }

  /** Recordings are digest-addressed; whether a given model/calibration is
   * "supported" is really "is there a recording for it", decided per request
   * in `decide`, not up front. */
  supports(): boolean {
    return true;
  }

  async decide(request: DecisionRequest): Promise<RawDecisionResponse> {
    if (request.evidence.signal.aborted) {
      throw new ProviderUnavailableError("aborted", "RecordedProvider: request was already aborted");
    }
    if (Date.now() > request.evidence.deadline) {
      throw new ProviderUnavailableError("deadline_exceeded", "RecordedProvider: request deadline already passed");
    }
    const digest = computeRequestDigest(request.evidence);
    const entry = this.byDigest.get(digest);
    if (!entry) {
      throw new ProviderUnavailableError(
        "recording_missing",
        `RecordedProvider: no recording for digest "${digest}" (point "${request.evidence.point}"). ` +
          "It never falls through to a live call — record one explicitly instead."
      );
    }
    return entry.response;
  }

  /**
   * Builds a recording entry from a request/response pair. This is the only
   * way a recording is ever produced — an explicit developer command calls
   * it (e.g. against a live provider during a calibration run, #19+); it is
   * never called by `RecordedProvider` itself, and CI never calls it.
   */
  static recordEntry(request: DecisionRequest, response: RawDecisionResponse): DecisionRecordingEntry {
    return {
      digest: computeRequestDigest(request.evidence),
      request: {
        point: request.evidence.point,
        model: request.evidence.model,
        questionVersion: request.evidence.questionVersion,
        policyVersion: request.evidence.policyVersion,
        candidateSetDigest: request.evidence.candidateSetDigest,
        redactedStateDigest: request.evidence.redactedStateDigest
      },
      response
    };
  }
}
