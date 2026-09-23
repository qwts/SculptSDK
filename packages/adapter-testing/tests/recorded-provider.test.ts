import { describe, expect, it } from "vitest";
import { computeRequestDigest, ProviderUnavailableError, type ChoiceQuestion, type DecisionEvidence, type DecisionRequest } from "@sculptsdk/core";
import { RecordedProvider, RECORDING_FORMAT_VERSION, type DecisionRecordingFile } from "@sculptsdk/adapter-testing";

const QUESTION: ChoiceQuestion = { kind: "choice", id: "q1", options: ["a", "b", "none"] };

function evidence(overrides: Partial<DecisionEvidence> = {}): DecisionEvidence {
  return {
    requestId: "r1",
    operationId: "o1",
    point: "dp-test",
    model: "jev-1.13",
    questionVersion: "v1",
    policyVersion: "v1",
    origin: "http://fixtures.local",
    frameId: "main",
    navigationEpoch: 1,
    candidateSetDigest: "candidates-1",
    redactedStateDigest: "state-1",
    deadline: Date.now() + 1000,
    signal: new AbortController().signal,
    ...overrides
  };
}

function requestFor(ev: DecisionEvidence): DecisionRequest {
  return { evidence: ev, questions: [QUESTION] };
}

describe("RecordedProvider", () => {
  it("replays the recorded answer for a matching request", async () => {
    const ev = evidence();
    const response = { answers: [{ kind: "choice" as const, questionId: "q1", selected: "a" }] };
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [RecordedProvider.recordEntry(requestFor(ev), response)]
    };
    const provider = new RecordedProvider(file);

    const result = await provider.decide(requestFor(ev));
    expect(result).toEqual(response);
  });

  it("matches by request digest, not call order: two differently-shaped calls with the same identifying fields both hit", async () => {
    const ev = evidence();
    const response = { answers: [{ kind: "choice" as const, questionId: "q1", selected: "b" }] };
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [RecordedProvider.recordEntry(requestFor(ev), response)]
    };
    const provider = new RecordedProvider(file);

    // Different requestId/operationId (a fresh call), same identifying evidence otherwise.
    const laterCall = requestFor(evidence({ requestId: "different-request-id", operationId: "different-op-id" }));
    const result = await provider.decide(laterCall);
    expect(result).toEqual(response);
  });

  it("returns unavailable/recording_missing for a request with no matching recording, never falling through", async () => {
    const provider = new RecordedProvider({ formatVersion: RECORDING_FORMAT_VERSION, recordings: [] });

    await expect(provider.decide(requestFor(evidence()))).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(provider.decide(requestFor(evidence()))).rejects.toMatchObject({ reasonCode: "recording_missing" });
  });

  it("a changed redacted-state digest returns recording_missing rather than the old (now stale) answer", async () => {
    const original = evidence({ redactedStateDigest: "state-v1" });
    const response = { answers: [{ kind: "choice" as const, questionId: "q1", selected: "a" }] };
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [RecordedProvider.recordEntry(requestFor(original), response)]
    };
    const provider = new RecordedProvider(file);

    // Same request, but the page state that was redacted has since changed.
    const changed = evidence({ redactedStateDigest: "state-v2" });
    await expect(provider.decide(requestFor(changed))).rejects.toMatchObject({ reasonCode: "recording_missing" });
  });

  it("honors an already-aborted signal and an already-passed deadline even when a recording exists", async () => {
    const ev = evidence();
    const response = { answers: [{ kind: "choice" as const, questionId: "q1", selected: "a" }] };
    const file: DecisionRecordingFile = {
      formatVersion: RECORDING_FORMAT_VERSION,
      recordings: [RecordedProvider.recordEntry(requestFor(ev), response)]
    };
    const provider = new RecordedProvider(file);

    const controller = new AbortController();
    controller.abort();
    await expect(provider.decide(requestFor(evidence({ signal: controller.signal })))).rejects.toMatchObject({
      reasonCode: "aborted"
    });
    await expect(provider.decide(requestFor(evidence({ deadline: Date.now() - 1000 })))).rejects.toMatchObject({
      reasonCode: "deadline_exceeded"
    });
  });

  it("rejects a recording file with an unsupported format version", () => {
    const badFile = { formatVersion: 999, recordings: [] } as unknown as DecisionRecordingFile;
    expect(() => new RecordedProvider(badFile)).toThrow(/unsupported recording format version/);
  });

  it("computeRequestDigest ignores requestId/operationId but is sensitive to every identifying field", () => {
    const base = evidence();
    const sameIdentity = evidence({ requestId: "totally-different", operationId: "also-different" });
    const differentModel = evidence({ model: "a-different-model" });

    expect(computeRequestDigest(base)).toBe(computeRequestDigest(sameIdentity));
    expect(computeRequestDigest(base)).not.toBe(computeRequestDigest(differentModel));
  });
});
