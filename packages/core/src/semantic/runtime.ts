/**
 * @experimental SemanticRuntime skeleton (#14). Holds the effective provider
 * and budget config, and applies the three degradation classes from
 * ADR-0003/ADR-0006 uniformly. No production decision policy registers with
 * it in m0 (#4 is explicit: "No production decision policy, DP-1 through
 * DP-7"). Reached through `ActionEnv.semantic` — see `sculpt.ts`.
 */
import type { SculptControlSettings } from "../types/index.js";
import { NullProvider } from "./null-provider.js";
import { ProviderUnavailableError, type DecisionPoint, type DecisionProvider, type DecisionRequest } from "./provider.js";
import { validateDecisionResponse, type OutcomeReason, type QuestionOutcome } from "./validate.js";

/** A policy declares one of these when it registers a decision point
 * (ADR-0003, ADR-0006). `recovery_or_advisory`: keep today's deterministic
 * fallback on any degradation, tagged with a reason. `required`: an
 * operator-configured condition that explicitly needs semantic evidence —
 * missing or invalid evidence leaves it unsatisfied, never approved. */
export type DegradationClass = "recovery_or_advisory" | "required";

export interface SemanticBudget {
  /** Wall-clock budget for the whole operation's semantic work, ms. */
  maxOperationMs?: number;
  /** Max provider requests for the whole operation. */
  maxRequests?: number;
}

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
  /** Builds the request. Only ever called when semantic resolution is enabled. */
  buildRequest: () => DecisionRequest;
  /** Extracts a domain value from fully-validated outcomes. Returning
   * `undefined` is treated as "no usable answer" (falls back/unsatisfied),
   * exactly like an explicit abstention. */
  select: (outcomes: QuestionOutcome[]) => TAccepted | undefined;
}

export type SemanticPointResult<TFallback, TAccepted> =
  | { kind: "disabled"; fallback: TFallback }
  | { kind: "degraded"; fallback: TFallback; reason: OutcomeReason }
  | { kind: "unsatisfied"; reason: OutcomeReason }
  | { kind: "accepted"; value: TAccepted };

export interface SemanticRuntimeOptions {
  settings: Pick<SculptControlSettings, "semanticResolution">;
  provider?: DecisionProvider;
  budget?: SemanticBudget;
}

/**
 * Holds the effective provider and budget; reached through
 * `ActionEnv.semantic`. Disabled parity (ADR-0004) is enforced right here,
 * not by convention: when disabled, `evaluate` returns the fallback without
 * ever constructing a request, touching the caller's provider, or awaiting
 * anything — so a disabled attach makes zero provider calls by construction,
 * whatever provider the caller passed.
 */
export class SemanticRuntime {
  readonly enabled: boolean;
  readonly provider: DecisionProvider;
  readonly budget: SemanticBudget;

  constructor(options: SemanticRuntimeOptions) {
    this.enabled = options.settings.semanticResolution === "enabled";
    // A provider passed while disabled is replaced with NullProvider and
    // never referenced again — no initialization, no capability probe.
    this.provider = this.enabled ? (options.provider ?? new NullProvider()) : new NullProvider();
    this.budget = options.budget ?? {};
  }

  async evaluate<TFallback, TAccepted>(
    config: SemanticPointConfig<TFallback, TAccepted>
  ): Promise<SemanticPointResult<TFallback, TAccepted>> {
    if (!this.enabled) {
      return { kind: "disabled", fallback: config.fallback() };
    }

    const request = config.buildRequest();
    try {
      const raw = await this.provider.decide(request);
      const validated = validateDecisionResponse(request, raw);
      if (validated.outcomes.some((outcome) => outcome.status === "invalid")) {
        return this.degradeOrUnsatisfy(config, { code: "invalid_answer" });
      }
      const value = config.select(validated.outcomes);
      if (value === undefined) {
        return this.degradeOrUnsatisfy(config, { code: "abstained" });
      }
      return { kind: "accepted", value };
    } catch (error) {
      const reason: OutcomeReason =
        error instanceof ProviderUnavailableError
          ? { code: error.reasonCode, detail: error.message }
          : { code: "unavailable", detail: error instanceof Error ? error.message : String(error) };
      return this.degradeOrUnsatisfy(config, reason);
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
}
