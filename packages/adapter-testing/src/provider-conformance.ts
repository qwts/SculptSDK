import {
  ProviderUnavailableError,
  validateDecisionResponse,
  type ChoiceQuestion,
  type DecisionEvidence,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse
} from "@sculptsdk/core";

/**
 * Provider conformance suite (#13): framework-agnostic checks every
 * `DecisionProvider` implementation must pass, following the pattern of the
 * existing `adapterConformanceTests`. Run each entry inside your test runner
 * of choice:
 *
 *   for (const t of providerConformanceTests(() => new MyProvider(...)))
 *     it(t.name, t.run);
 *
 * The fixed request this suite sends is exported below so a `RecordedProvider`
 * under test can be pre-seeded with a matching recording.
 */

export interface ProviderConformanceTest {
  name: string;
  run: () => Promise<void>;
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`provider conformance: ${message}`);
}

/** Identifying metadata for the fixed request this suite sends — stable
 * across runs so a pre-built recording can match it by digest. */
export const CONFORMANCE_REQUEST_META = {
  point: "conformance-point",
  model: "conformance-model",
  questionVersion: "v1",
  policyVersion: "v1",
  candidateSetDigest: "conformance-candidates-digest",
  redactedStateDigest: "conformance-state-digest"
} as const;

export const CONFORMANCE_QUESTION: ChoiceQuestion = {
  kind: "choice",
  id: "conformance-question",
  options: ["candidate-a", "candidate-b", "none"]
};

function conformanceEvidence(overrides: Partial<DecisionEvidence> = {}): DecisionEvidence {
  return {
    requestId: "conformance-request",
    operationId: "conformance-operation",
    ...CONFORMANCE_REQUEST_META,
    origin: "http://conformance.local",
    frameId: "main",
    navigationEpoch: 1,
    deadline: Date.now() + 5000,
    signal: new AbortController().signal,
    ...overrides
  };
}

function conformanceRequest(overrides: Partial<DecisionEvidence> = {}): DecisionRequest {
  return { evidence: conformanceEvidence(overrides), questions: [CONFORMANCE_QUESTION] };
}

type Attempt =
  | { ok: true; response: RawDecisionResponse }
  | { ok: false; error: unknown };

async function attempt(provider: DecisionProvider, request: DecisionRequest): Promise<Attempt> {
  try {
    return { ok: true, response: await provider.decide(request) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function providerConformanceTests(
  factory: () => DecisionProvider | Promise<DecisionProvider>
): ProviderConformanceTest[] {
  return [
    {
      name: "an answer, when returned, passes the port's runtime validation",
      run: async () => {
        const provider = await factory();
        const request = conformanceRequest();
        const result = await attempt(provider, request);
        if (!result.ok) {
          expect(result.error instanceof ProviderUnavailableError, "a thrown error must be a ProviderUnavailableError");
          return;
        }
        const validated = validateDecisionResponse(request, result.response);
        for (const outcome of validated.outcomes) {
          expect(
            outcome.status !== "invalid",
            `answer for "${outcome.questionId}" failed validation: ${outcome.reason.code}`
          );
        }
      }
    },
    {
      name: "honors an already-aborted signal instead of answering",
      run: async () => {
        const provider = await factory();
        const controller = new AbortController();
        controller.abort();
        const result = await attempt(provider, conformanceRequest({ signal: controller.signal }));
        expect(!result.ok, "an already-aborted request must not be answered");
        if (!result.ok) {
          expect(result.error instanceof ProviderUnavailableError, "abort must surface as ProviderUnavailableError");
        }
      }
    },
    {
      name: "honors an already-passed deadline instead of answering",
      run: async () => {
        const provider = await factory();
        const result = await attempt(provider, conformanceRequest({ deadline: Date.now() - 1000 }));
        expect(!result.ok, "a request past its deadline must not be answered");
        if (!result.ok) {
          expect(result.error instanceof ProviderUnavailableError, "an expired deadline must surface as ProviderUnavailableError");
        }
      }
    },
    {
      name: "every failure carries a non-empty, typed reason code",
      run: async () => {
        const provider = await factory();
        const controller = new AbortController();
        controller.abort();
        const result = await attempt(provider, conformanceRequest({ signal: controller.signal }));
        if (result.ok) return; // this provider always answers; nothing to check here.
        expect(result.error instanceof ProviderUnavailableError, "must throw ProviderUnavailableError, not an opaque error");
        const reasonCode = (result.error as ProviderUnavailableError).reasonCode;
        expect(typeof reasonCode === "string" && reasonCode.length > 0, "must carry a non-empty reasonCode");
      }
    },
    {
      name: "never returns an option that was not in the request",
      run: async () => {
        const provider = await factory();
        const result = await attempt(provider, conformanceRequest());
        if (!result.ok) return;
        for (const answer of result.response.answers) {
          if (answer.kind === "choice") {
            expect(
              CONFORMANCE_QUESTION.options.includes(answer.selected),
              `returned option "${answer.selected}" is not in the request`
            );
          }
        }
      }
    },
    {
      name: "answers identical requests identically, regardless of call order",
      run: async () => {
        const provider = await factory();
        const second = await attempt(provider, conformanceRequest());
        const first = await attempt(provider, conformanceRequest());
        expect(first.ok === second.ok, "identical requests must both succeed or both fail the same way");
        if (first.ok && second.ok) {
          expect(
            JSON.stringify(first.response) === JSON.stringify(second.response),
            "identical requests must produce identical answers"
          );
        } else if (!first.ok && !second.ok) {
          expect(
            (first.error as ProviderUnavailableError).reasonCode === (second.error as ProviderUnavailableError).reasonCode,
            "identical requests must fail with the same reason code"
          );
        }
      }
    }
  ];
}
