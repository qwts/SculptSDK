import { describe, expect, it } from "vitest";
import { RecordedProvider, RECORDING_FORMAT_VERSION } from "@sculptsdk/adapter-testing";
import {
  buildCandidateSummaryDTO,
  SemanticRuntime,
  type ChoiceQuestion,
  type DecisionEvidence,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse,
  type SemanticPointConfig
} from "@sculptsdk/core";

/**
 * Sink-inspection tests (#16's acceptance criteria): a value typed into an
 * input is planted in a validation message, an accessible name, a route
 * segment, an aria-label and the goal — every one of those sinks must come
 * out redacted in the exact outbound request bytes, in a RecordedProvider
 * recording, in a serialized error, and in an emitted log, in both logging
 * modes.
 */

const SECRET_VALUE = "correcthorsebatterystaple";
const QUESTION: ChoiceQuestion = { kind: "choice", id: "q1", options: ["a", "none"] };

function echoedSinks(secret: string) {
  return {
    validationMessage: `Field '${secret}' failed the uniqueness check`,
    accessibleName: `Edit entry for ${secret}`,
    routeSegment: `/records/${secret}/edit`,
    ariaLabel: `Remove ${secret} from the list`,
    goal: `find and update the record for ${secret}`
  };
}

class CaptureProvider implements DecisionProvider {
  readonly id = "capture";
  lastRequest: DecisionRequest | undefined;
  private readonly impl: (request: DecisionRequest) => Promise<RawDecisionResponse>;

  constructor(impl: (request: DecisionRequest) => Promise<RawDecisionResponse>) {
    this.impl = impl;
  }

  supports(): boolean {
    return true;
  }

  decide(request: DecisionRequest): Promise<RawDecisionResponse> {
    this.lastRequest = request;
    return this.impl(request);
  }
}

/** JSON.stringify, but tolerant of the non-serializable AbortSignal field. */
function exactBytes(request: DecisionRequest | undefined): string {
  return JSON.stringify(request, (key, value) => (key === "signal" ? undefined : value));
}

function evidenceFor(overrides: Partial<DecisionEvidence> = {}): DecisionEvidence {
  return {
    requestId: "r1",
    operationId: "o1",
    point: "synthetic-redaction-point",
    model: "test-model",
    questionVersion: "v1",
    policyVersion: "v1",
    origin: "http://fixtures.local",
    frameId: "main",
    navigationEpoch: 0,
    candidateSetDigest: "cd",
    redactedStateDigest: "sd",
    deadline: Date.now() + 5000,
    signal: new AbortController().signal,
    ...overrides
  };
}

function pointConfig(
  runtime: SemanticRuntime,
  overrides: Partial<SemanticPointConfig<string, string>> = {}
): SemanticPointConfig<string, string> {
  const sinks = echoedSinks(SECRET_VALUE);
  // A well-behaved policy: learn the sensitive value, then build every
  // outbound string through the redactor before it ever reaches the request.
  runtime.redactor.learn(SECRET_VALUE);
  return {
    point: "synthetic-redaction-point",
    degradation: "recovery_or_advisory",
    fallback: () => "fallback-value",
    buildRequest: () => ({
      evidence: evidenceFor(),
      questions: [QUESTION],
      redactedState: {
        candidates: [
          buildCandidateSummaryDTO(
            {
              targetId: "t1",
              accessibleName: sinks.accessibleName,
              visibleText: sinks.validationMessage,
              attributes: { "aria-label": sinks.ariaLabel }
            },
            runtime.redactor
          )
        ],
        route: runtime.redactor.text(sinks.routeSegment),
        goal: runtime.redactor.text(sinks.goal)
      }
    }),
    select: (outcomes) => {
      const accepted = outcomes.find((o) => o.status === "accepted");
      return accepted?.accepted?.answer.kind === "choice" ? accepted.accepted.answer.selected : undefined;
    },
    ...overrides
  };
}

describe("sink redaction: a value echoed into every sink is redacted everywhere", () => {
  it("the exact outbound request bytes never contain the secret", async () => {
    const provider = new CaptureProvider(async () => ({
      answers: [{ kind: "choice", questionId: "q1", selected: "a" }]
    }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "metadata" },
      provider
    });

    const result = await runtime.evaluate(pointConfig(runtime));

    expect(result).toEqual({ kind: "accepted", value: "a" });
    const bytes = exactBytes(provider.lastRequest);
    expect(bytes).not.toContain(SECRET_VALUE);
    expect(bytes).toContain("[redacted]");
  });

  it("a RecordedProvider recording built from the same request never contains the secret", async () => {
    const provider = new CaptureProvider(async () => ({
      answers: [{ kind: "choice", questionId: "q1", selected: "a" }]
    }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "metadata" },
      provider
    });
    await runtime.evaluate(pointConfig(runtime));

    const recording = RecordedProvider.recordEntry(provider.lastRequest!, {
      answers: [{ kind: "choice", questionId: "q1", selected: "a" }]
    });
    expect(JSON.stringify(recording)).not.toContain(SECRET_VALUE);

    // And a full recording FILE (the on-disk unit) built around it — the
    // shape #13 already keeps minimal (metadata + digest + answer, no raw
    // state), re-verified here as a redaction guarantee too.
    const file = { formatVersion: RECORDING_FORMAT_VERSION, recordings: [recording] };
    expect(JSON.stringify(file)).not.toContain(SECRET_VALUE);
  });

  it("a serialized error (e.g. a buggy or hostile provider echoing input back) is redacted", async () => {
    const provider: DecisionProvider = {
      id: "hostile",
      supports: () => true,
      decide: async () => {
        throw new Error(`upstream rejected candidate: ${SECRET_VALUE}`);
      }
    };
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "metadata" },
      provider
    });

    const result = await runtime.evaluate(pointConfig(runtime));

    expect(result.kind).toBe("degraded");
    const bytes = JSON.stringify(result);
    expect(bytes).not.toContain(SECRET_VALUE);
  });

  it("actionLogging 'metadata' logs no payload at all", async () => {
    const provider = new CaptureProvider(async () => ({
      answers: [{ kind: "choice", questionId: "q1", selected: "a" }]
    }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "metadata" },
      provider
    });
    await runtime.evaluate(pointConfig(runtime));

    const [entry] = runtime.getLogs();
    expect(entry).toBeDefined();
    expect(entry.redactedQuestions).toBeUndefined();
    expect(entry.redactedState).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(SECRET_VALUE);
  });

  it("actionLogging 'full' adds only the already-redacted state — never the secret", async () => {
    const provider = new CaptureProvider(async () => ({
      answers: [{ kind: "choice", questionId: "q1", selected: "a" }]
    }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "full" },
      provider
    });
    await runtime.evaluate(pointConfig(runtime));

    const [entry] = runtime.getLogs();
    expect(entry.redactedState).toBeDefined();
    const bytes = JSON.stringify(entry);
    expect(bytes).not.toContain(SECRET_VALUE);
    expect(bytes).toContain("[redacted]");
  });

  it("actionLogging 'disabled' logs nothing", async () => {
    const provider = new CaptureProvider(async () => ({
      answers: [{ kind: "choice", questionId: "q1", selected: "a" }]
    }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "disabled" },
      provider
    });
    await runtime.evaluate(pointConfig(runtime));

    expect(runtime.getLogs()).toEqual([]);
  });
});

describe("source-origin allowlist is separate from the provider-endpoint allowlist", () => {
  it("a request from an origin outside the allowlist sends nothing and returns unavailable", async () => {
    const provider = new CaptureProvider(async () => ({ answers: [{ kind: "choice", questionId: "q1", selected: "a" }] }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "metadata" },
      provider,
      sourceOriginAllowlist: ["https://allowed.example"],
      providerEndpointAllowlist: ["https://provider.example"] // deliberately unrelated to the source-origin check
    });

    const config = pointConfig(runtime, {
      buildRequest: () => ({
        evidence: evidenceFor({ origin: "https://not-allowed.example" }),
        questions: [QUESTION]
      })
    });

    const result = await runtime.evaluate(config);

    expect(result).toMatchObject({ kind: "degraded", reason: { code: "origin_not_allowed" } });
    expect(provider.lastRequest).toBeUndefined(); // never called
  });

  it("stores the two allowlists independently — configuring one never affects the other", () => {
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "metadata" },
      sourceOriginAllowlist: ["https://a.example"],
      providerEndpointAllowlist: ["https://b.example"]
    });
    expect(runtime.sourceOriginAllowlist).toEqual(["https://a.example"]);
    expect(runtime.providerEndpointAllowlist).toEqual(["https://b.example"]);
  });

  it("an allowed origin proceeds normally", async () => {
    const provider = new CaptureProvider(async () => ({ answers: [{ kind: "choice", questionId: "q1", selected: "a" }] }));
    const runtime = new SemanticRuntime({
      settings: { semanticResolution: "enabled", actionLogging: "metadata" },
      provider,
      sourceOriginAllowlist: ["http://fixtures.local"]
    });

    const result = await runtime.evaluate(pointConfig(runtime));
    expect(result).toEqual({ kind: "accepted", value: "a" });
  });

  it("no allowlist configured means no origin restriction (unchanged from #14)", async () => {
    const provider = new CaptureProvider(async () => ({ answers: [{ kind: "choice", questionId: "q1", selected: "a" }] }));
    const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled", actionLogging: "metadata" }, provider });
    const result = await runtime.evaluate(pointConfig(runtime));
    expect(result).toEqual({ kind: "accepted", value: "a" });
  });
});
