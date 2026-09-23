import { describe, it } from "vitest";
import { NullProvider, type DecisionEvidence, type DecisionRequest } from "@sculptsdk/core";
import {
  CONFORMANCE_QUESTION,
  CONFORMANCE_REQUEST_META,
  providerConformanceTests,
  RecordedProvider,
  RECORDING_FORMAT_VERSION,
  type DecisionRecordingFile
} from "@sculptsdk/adapter-testing";

/**
 * Both offline providers pass the exact same suite (#13's acceptance
 * criterion): "Both providers pass the same suite in PR CI."
 */

describe("provider conformance — NullProvider", () => {
  for (const test of providerConformanceTests(() => new NullProvider())) {
    it(test.name, test.run);
  }
});

function conformanceRequestFor(overrides: Partial<DecisionEvidence> = {}): DecisionRequest {
  const evidence: DecisionEvidence = {
    requestId: "seed-request",
    operationId: "seed-operation",
    ...CONFORMANCE_REQUEST_META,
    origin: "http://conformance.local",
    frameId: "main",
    navigationEpoch: 1,
    deadline: Date.now() + 5000,
    signal: new AbortController().signal,
    ...overrides
  };
  return { evidence, questions: [CONFORMANCE_QUESTION] };
}

function recordedProviderWithConformanceAnswer(): RecordedProvider {
  const file: DecisionRecordingFile = {
    formatVersion: RECORDING_FORMAT_VERSION,
    recordings: [
      RecordedProvider.recordEntry(conformanceRequestFor(), {
        answers: [{ kind: "choice", questionId: CONFORMANCE_QUESTION.id, selected: "candidate-a" }]
      })
    ]
  };
  return new RecordedProvider(file);
}

describe("provider conformance — RecordedProvider (pre-seeded with a matching recording)", () => {
  for (const test of providerConformanceTests(() => recordedProviderWithConformanceAnswer())) {
    it(test.name, test.run);
  }
});
