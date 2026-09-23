/**
 * @experimental SemanticRuntime (#14, extended by #15). Holds the effective
 * provider and applies the three degradation classes uniformly (ADR-0003/
 * ADR-0006), binds decisions to freshness evidence (ADR-0008), cancels
 * pending work on lifecycle events, and enforces one shared operation
 * budget. No production decision policy registers with it in m0. Reached
 * through `ActionEnv.semantic` — see `sculpt.ts`.
 */
import type { SculptControlSettings } from "../types/index.js";
import { OperationBudget, type SemanticBudget } from "./budget.js";
import { isFresh, type FreshnessEvidence } from "./freshness.js";
import { NullProvider } from "./null-provider.js";
import { ProviderUnavailableError, type DecisionPoint, type DecisionProvider, type DecisionRequest } from "./provider.js";
import { validateDecisionResponse, type OutcomeReason, type QuestionOutcome } from "./validate.js";

/** A policy declares one of these when it registers a decision point
 * (ADR-0003, ADR-0006). `recovery_or_advisory`: keep today's deterministic
 * fallback on any degradation, tagged with a reason. `required`: an
 * operator-configured condition that explicitly needs semantic evidence —
 * missing or invalid evidence leaves it unsatisfied, never approved. */
export type DegradationClass = "recovery_or_advisory" | "required";

/** Kept minimal per #14's scope: provider, per-point switches, budget,
 * and the two allowlists. No real point exists yet to key `points` by. */
export interface SemanticAttachOptions {
  provider?: DecisionProvider;
  points?: Record<string, boolean>;
  budget?: SemanticBudget;
  /** Origins the redacted state is allowed to be built from. */
  sourceOriginAllowlist?: string[];
  /** Endpoints a provider implementation is allowed to reach. */
  providerEndpointAllowlist?: string[];
}

export interface SemanticPointConfig<TFallback, TAccepted> {
  point: DecisionPoint;
  degradation: DegradationClass;
  /** Today's deterministic behavior for this point, unchanged. */
  fallback: () => TFallback;
  /** Builds the request. Only ever called when semantic resolution is
   * enabled and the operation budget admits it. `evidence.deadline` and
   * `evidence.signal` are set by the runtime, not by this function — ADR-0001
   * assigns ownership of both to the runtime, not the caller. */
  buildRequest: () => DecisionRequest;
  /** Extracts a domain value from fully-validated outcomes. Returning
   * `undefined` is treated as "no usable answer" (falls back/unsatisfied),
   * exactly like an explicit abstention. */
  select: (outcomes: QuestionOutcome[]) => TAccepted | undefined;
  /** Evidence captured when candidates were gathered (ADR-0008). Omit for a
   * point that isn't about a specific, freshness-sensitive target. */
  capturedEvidence?: FreshnessEvidence;
  /** Re-fetches current evidence for the freshness comparison against
   * `capturedEvidence`, called only once an answer would otherwise be
   * accepted. Required when `capturedEvidence` is set. */
  checkFreshness?: () => Promise<FreshnessEvidence>;
}

export type SemanticPointResult<TFallback, TAccepted> =
  | { kind: "disabled"; fallback: TFallback }
  | { kind: "degraded"; fallback: TFallback; reason: OutcomeReason }
  | { kind: "unsatisfied"; reason: OutcomeReason }
  | { kind: "accepted"; value: TAccepted };

export interface EvaluateOptions {
  /** Share one budget across nested calls within the same top-level
   * operation (a UIKit call or `agent.execute`). Omit for a one-off call,
   * which gets its own single-request budget. */
  budget?: OperationBudget;
  /** A later call with the same key cancels an still-pending earlier one
   * for this key ("a superseding request for the same operation"). */
  supersedeKey?: string;
}

export interface SemanticRuntimeOptions {
  settings: Pick<SculptControlSettings, "semanticResolution">;
  provider?: DecisionProvider;
  budget?: SemanticBudget;
}

/**
 * Holds the effective provider and budget defaults; reached through
 * `ActionEnv.semantic`. Disabled parity (ADR-0004) is enforced right here,
 * not by convention: when disabled, `evaluate` returns the fallback without
 * ever constructing a request, touching the caller's provider, or awaiting
 * anything — so a disabled attach makes zero provider calls by construction,
 * whatever provider the caller passed.
 */
export class SemanticRuntime {
  readonly enabled: boolean;
  readonly provider: DecisionProvider;
  private readonly defaultBudget: SemanticBudget;
  private readonly pending = new Set<AbortController>();
  private readonly bySupersedeKey = new Map<string, AbortController>();
  private disposed = false;

  constructor(options: SemanticRuntimeOptions) {
    this.enabled = options.settings.semanticResolution === "enabled";
    // A provider passed while disabled is replaced with NullProvider and
    // never referenced again — no initialization, no capability probe.
    this.provider = this.enabled ? (options.provider ?? new NullProvider()) : new NullProvider();
    this.defaultBudget = options.budget ?? {};
  }

  /** Creates a budget for one top-level operation (a UIKit call or
   * `agent.execute`), to pass into every `evaluate()` call nested inside it. */
  createOperationBudget(overrides: SemanticBudget = {}): OperationBudget {
    return new OperationBudget({ ...this.defaultBudget, ...overrides });
  }

  async evaluate<TFallback, TAccepted>(
    config: SemanticPointConfig<TFallback, TAccepted>,
    options: EvaluateOptions = {}
  ): Promise<SemanticPointResult<TFallback, TAccepted>> {
    if (!this.enabled) {
      return { kind: "disabled", fallback: config.fallback() };
    }
    if (this.disposed) {
      return this.degradeOrUnsatisfy(config, { code: "cancelled", detail: "semantic runtime is disposed" });
    }

    if (options.supersedeKey) {
      this.bySupersedeKey.get(options.supersedeKey)?.abort();
    }
    const controller = new AbortController();
    this.pending.add(controller);
    if (options.supersedeKey) this.bySupersedeKey.set(options.supersedeKey, controller);

    const budget = options.budget ?? this.createOperationBudget();

    try {
      const request = config.buildRequest();
      const admitted = budget.admit(request);
      if (admitted) {
        return this.degradeOrUnsatisfy(config, admitted);
      }
      try {
        // The runtime alone owns the deadline and cancellation signal
        // (ADR-0001) — whatever buildRequest() put there is replaced.
        request.evidence.deadline = budget.deadline;
        request.evidence.signal = controller.signal;

        let raw;
        try {
          raw = await this.provider.decide(request);
        } catch (error) {
          if (controller.signal.aborted) {
            return this.degradeOrUnsatisfy(config, { code: "cancelled", detail: "cancelled before the provider answered" });
          }
          const reason: OutcomeReason =
            error instanceof ProviderUnavailableError
              ? { code: error.reasonCode, detail: error.message }
              : { code: "unavailable", detail: error instanceof Error ? error.message : String(error) };
          return this.degradeOrUnsatisfy(config, reason);
        }

        if (controller.signal.aborted) {
          // A late result: discard it even if it looks valid. Never touches
          // a cache, a handle, a kind hint, or produces an accepted record.
          return this.degradeOrUnsatisfy(config, { code: "cancelled", detail: "cancelled before the answer could be used" });
        }

        const validated = validateDecisionResponse(request, raw);
        if (validated.outcomes.some((outcome) => outcome.status === "invalid")) {
          return this.degradeOrUnsatisfy(config, { code: "invalid_answer" });
        }
        const value = config.select(validated.outcomes);
        if (value === undefined) {
          return this.degradeOrUnsatisfy(config, { code: "abstained" });
        }

        if (config.capturedEvidence && config.checkFreshness) {
          const current = await config.checkFreshness();
          if (controller.signal.aborted) {
            return this.degradeOrUnsatisfy(config, { code: "cancelled", detail: "cancelled while checking freshness" });
          }
          if (!isFresh(config.capturedEvidence, current)) {
            return this.degradeOrUnsatisfy(config, { code: "stale", detail: "page state changed since the request was built" });
          }
        }

        return { kind: "accepted", value };
      } finally {
        budget.release();
      }
    } finally {
      this.pending.delete(controller);
      if (options.supersedeKey && this.bySupersedeKey.get(options.supersedeKey) === controller) {
        this.bySupersedeKey.delete(options.supersedeKey);
      }
    }
  }

  private degradeOrUnsatisfy<TFallback, TAccepted>(
    config: SemanticPointConfig<TFallback, TAccepted>,
    reason: OutcomeReason
  ): SemanticPointResult<TFallback, TAccepted> {
    if (config.degradation === "required") {
      return { kind: "unsatisfied", reason };
    }
    return { kind: "degraded", fallback: config.fallback(), reason };
  }

  /**
   * Cancels every pending decision and settles them (never rejects) as
   * cancelled; any further `evaluate()` call resolves the same way — this is
   * also how "the setting being disabled at runtime" is expressed, since m0
   * has no separate live-settings-mutation API.
   *
   * Navigation is deliberately *not* wired to this: a decision made, then
   * invalidated by navigation before it's used, surfaces through the
   * freshness check (`stale`) instead of cancellation (`cancelled`) — the
   * two are different causes with different typed reasons, even though both
   * mean "this answer can't be used." A superseding `evaluate()` call for the
   * same `supersedeKey` cancels the prior one directly, without going
   * through this method.
   */
  dispose(): void {
    this.disposed = true;
    for (const controller of this.pending) controller.abort();
  }
}
