import { describe, expect, it, vi } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import {
  ProviderUnavailableError,
  Sculpt,
  SemanticRuntime,
  type ChoiceQuestion,
  type DecisionProvider,
  type DecisionRequest,
  type RawDecisionResponse,
  type SemanticPointConfig
} from "@sculptsdk/core";

/**
 * Freshness, cancellation and lifecycle (#15): a decision is only usable
 * against the page it was made for, pending work is cancelled on lifecycle
 * events, and a late result can never have an observable effect.
 */

const QUESTION: ChoiceQuestion = { kind: "choice", id: "q1", options: ["yes", "no", "none"] };

class ScriptedProvider implements DecisionProvider {
  readonly id = "scripted";
  constructor(private readonly impl: (request: DecisionRequest) => Promise<RawDecisionResponse>) {}
  supports(): boolean {
    return true;
  }
  decide(request: DecisionRequest): Promise<RawDecisionResponse> {
    return this.impl(request);
  }
}

function acceptedAnswer(): RawDecisionResponse {
  return { answers: [{ kind: "choice", questionId: "q1", selected: "yes" }] };
}

function baseConfig(
  provider: DecisionProvider,
  overrides: Partial<SemanticPointConfig<string, string>> = {}
): { runtime: SemanticRuntime; config: SemanticPointConfig<string, string> } {
  const runtime = new SemanticRuntime({ settings: { semanticResolution: "enabled" }, provider });
  const config: SemanticPointConfig<string, string> = {
    point: "synthetic-freshness-point",
    degradation: "recovery_or_advisory",
    fallback: () => "fallback-value",
    buildRequest: () => ({
      evidence: {
        requestId: "r1",
        operationId: "o1",
        point: "synthetic-freshness-point",
        model: "test-model",
        questionVersion: "v1",
        policyVersion: "v1",
        origin: "http://fixtures.local",
        frameId: "main",
        navigationEpoch: 0,
        candidateSetDigest: "cd",
        redactedStateDigest: "sd",
        deadline: Date.now() + 5000,
        signal: new AbortController().signal
      },
      questions: [QUESTION]
    }),
    select: (outcomes) => {
      const accepted = outcomes.find((o) => o.status === "accepted");
      return accepted?.accepted?.answer.kind === "choice" ? accepted.accepted.answer.selected : undefined;
    },
    ...overrides
  };
  return { runtime, config };
}

describe("freshness: navigation invalidates a pending decision", () => {
  it("gives 'stale' when the page navigates while the provider is deciding", async () => {
    const adapter = new TestHarnessAdapter({ html: `<!doctype html><html><body></body></html>` });
    const sculpt = await Sculpt.attach({ adapter });
    try {
      const capturedEvidence = await sculpt.foundation.observers.evidence();

      const provider = new ScriptedProvider(async () => {
        // The page navigates while this "provider call" is still in flight.
        await sculpt.page.navigate("http://fixtures.local/elsewhere");
        return acceptedAnswer();
      });
      const { runtime, config } = baseConfig(provider, {
        capturedEvidence,
        checkFreshness: () => sculpt.foundation.observers.evidence()
      });

      const result = await runtime.evaluate(config);

      expect(result).toEqual({
        kind: "degraded",
        fallback: "fallback-value",
        reason: { code: "stale", detail: "page state changed since the request was built" }
      });
    } finally {
      await sculpt.dispose();
    }
  });

  it("gives 'stale' when the target element is replaced while the provider is deciding", async () => {
    const adapter = new TestHarnessAdapter({
      html: `<!doctype html><html><body><div id="container"><button id="rename-btn">Rename</button></div></body></html>`
    });
    const sculpt = await Sculpt.attach({ adapter });
    try {
      const before = await sculpt.foundation.dom.queryWithEvidence({ kind: "button", name: "Rename" });
      const targetDigest = before.candidates[0]!.identity.id;
      const capturedEvidence = { ...before.evidence, targetDigest };

      const provider = new ScriptedProvider(async () => {
        // Same visible button, but a different element (new DOM path).
        adapter.document.getElementById("container")!.innerHTML =
          '<span><button id="rename-btn-2">Rename</button></span>';
        return acceptedAnswer();
      });
      const { runtime, config } = baseConfig(provider, {
        capturedEvidence,
        checkFreshness: async () => {
          const after = await sculpt.foundation.dom.queryWithEvidence({ kind: "button", name: "Rename" });
          return { ...after.evidence, targetDigest: after.candidates[0]!.identity.id };
        }
      });

      const result = await runtime.evaluate(config);

      expect(result).toMatchObject({ kind: "degraded", reason: { code: "stale" } });
    } finally {
      await sculpt.dispose();
    }
  });

  it("stays 'accepted' when nothing about the page changed", async () => {
    const adapter = new TestHarnessAdapter({
      html: `<!doctype html><html><body><button id="rename-btn">Rename</button></body></html>`
    });
    const sculpt = await Sculpt.attach({ adapter });
    try {
      const before = await sculpt.foundation.dom.queryWithEvidence({ kind: "button", name: "Rename" });
      const capturedEvidence = { ...before.evidence, targetDigest: before.candidates[0]!.identity.id };

      const provider = new ScriptedProvider(async () => acceptedAnswer());
      const { runtime, config } = baseConfig(provider, {
        capturedEvidence,
        checkFreshness: async () => {
          const after = await sculpt.foundation.dom.queryWithEvidence({ kind: "button", name: "Rename" });
          return { ...after.evidence, targetDigest: after.candidates[0]!.identity.id };
        }
      });

      const result = await runtime.evaluate(config);
      expect(result).toEqual({ kind: "accepted", value: "yes" });
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("cancellation and lifecycle", () => {
  it("aborting (a superseding request) produces no accepted record for the superseded call", async () => {
    let releaseFirst: (() => void) | undefined;
    const provider = new ScriptedProvider((request) => {
      return new Promise((resolve, reject) => {
        request.evidence.signal.addEventListener("abort", () =>
          reject(new ProviderUnavailableError("aborted"))
        );
        releaseFirst = () => resolve(acceptedAnswer());
      });
    });
    const { runtime, config } = baseConfig(provider);

    const first = runtime.evaluate(config, { supersedeKey: "op-1" });
    // Supersede before the first call ever gets to answer.
    const second = runtime.evaluate(
      { ...config, buildRequest: () => ({ ...config.buildRequest(), evidence: { ...config.buildRequest().evidence } }) },
      { supersedeKey: "op-1" }
    );
    releaseFirst?.();

    const [firstResult] = await Promise.all([first, second]);
    expect(firstResult.kind).not.toBe("accepted");
    expect(firstResult).toMatchObject({ reason: { code: "cancelled" } });
  });

  it("dispose() with pending work settles every pending decision as cancelled, with no unhandled rejection", async () => {
    const pendingSignals: AbortSignal[] = [];
    const provider = new ScriptedProvider((request) => {
      pendingSignals.push(request.evidence.signal);
      return new Promise((_resolve, reject) => {
        request.evidence.signal.addEventListener("abort", () => {
          reject(new ProviderUnavailableError("aborted"));
        });
        // Never resolves on its own — only settling via abort proves dispose()
        // itself drives every pending call to a result.
      });
    });
    const { runtime, config } = baseConfig(provider);

    const pending = [runtime.evaluate(config), runtime.evaluate(config), runtime.evaluate(config)];
    // Give each decide() call a chance to actually start before disposing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pendingSignals).toHaveLength(3);

    runtime.dispose();

    const results = await Promise.all(pending); // would hang or unhandled-reject if dispose() didn't settle them
    for (const result of results) {
      expect(result.kind).not.toBe("accepted");
      expect(result).toMatchObject({ reason: { code: "cancelled" } });
    }
  });

  it("a late response (resolves after dispose) has no observable effect", async () => {
    let resolveLate: (() => void) | undefined;
    const provider = new ScriptedProvider((_request) => {
      return new Promise((resolve) => {
        resolveLate = () => resolve(acceptedAnswer());
      });
    });
    const { runtime, config } = baseConfig(provider);

    const pending = runtime.evaluate(config);
    runtime.dispose();
    // The provider now answers successfully, *after* disposal.
    resolveLate?.();

    const result = await pending;
    expect(result.kind).not.toBe("accepted");
    expect(result).toMatchObject({ reason: { code: "cancelled" } });
  });

  it("evaluate() called after dispose() never touches the provider", async () => {
    const decide = vi.fn(async () => acceptedAnswer());
    const provider = new ScriptedProvider(decide);
    const { runtime, config } = baseConfig(provider);

    runtime.dispose();
    const result = await runtime.evaluate(config);

    expect(decide).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reason: { code: "cancelled" } });
  });
});
