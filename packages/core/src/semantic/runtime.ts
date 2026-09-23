/**
 * @experimental SemanticRuntime (#14, extended by #15 and #16). Holds the
 * effective provider and applies the three degradation classes uniformly
 * (ADR-0003/ADR-0006), binds decisions to freshness evidence (ADR-0008),
 * cancels pending work on lifecycle events, enforces one shared operation
 * budget, and gates every request on source-origin admission and the
 * operator's redaction rules (I8). No production decision policy registers
 * with it in m0. Reached through `ActionEnv.semantic` — see `sculpt.ts`.
 */
import type { SculptControlSettings } from "../types/index.js";
import { EMPTY_CALIBRATION_REGISTRY, type CalibrationRegistry } from "./calibration.js";
import { DecisionEvidenceCache } from "./cache.js";
import { OperationBudget, type SemanticBudget } from "./budget.js";
import { isFresh, type FreshnessEvidence } from "./freshness.js";
import { NullProvider } from "./null-provider.js";
import { ProviderUnavailableError, type DecisionPoint, type DecisionProvider, type DecisionRequest } from "./provider.js";
import { Redactor, sanitizeError, type RedactionRule } from "./redaction.js";
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
  /** Origins the redacted state is allowed to be built from — separate from
   * `providerEndpointAllowlist` (§16). A request whose `evidence.origin`
   * isn't listed here sends nothing and returns `unavailable`. */
  sourceOriginAllowlist?: string[];
  /** Endpoints a provider implementation is allowed to reach. Configuration
   * surface for a live provider (#19+); m0's providers reach no network. */
  providerEndpointAllowlist?: string[];
  /** Operator hook for redacting free text beyond the built-in learned-value
   * scrubbing (§16). */
  redactionRules?: RedactionRule[];
  /** Calibrated acceptance thresholds (§21, not built in m1). Defaults to
   * none — every decision point runs in shadow mode until an operator
   * supplies real artifacts. */
  calibration?: CalibrationRegistry;
  /** Bounds the #25 session-scoped decision evidence cache. Defaults to the
   * runtime's own default (100) when omitted. */
  decisionCacheMaxEntries?: number;
}

export interface SemanticPointConfig<TFallback, TAccepted> {
  point: DecisionPoint;
  /** The page origin this request would be built from, checked against
   * `sourceOriginAllowlist` *before* `buildRequest()` is ever called (§16) —
   * a denied origin's page state is never read, not even just to redact it
   * or learn a value from it. */
  origin: string;
  degradation: DegradationClass;
  /** Today's deterministic behavior for this point, unchanged. */
  fallback: () => TFallback;
  /** Builds the request. Only ever called when semantic resolution is
   * enabled, the source origin is admitted, and the operation budget
   * admits it. `evidence.deadline` and `evidence.signal` are set by the
   * runtime, not by this function — ADR-0001 assigns ownership of both to
   * the runtime, not the caller. Every question this builds must already be
   * redacted (see `redactor`) — nothing here re-redacts them. */
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
  settings: Pick<SculptControlSettings, "semanticResolution" | "actionLogging">;
  provider?: DecisionProvider;
  /** Per-point on/off switches (§14). A point not listed here is enabled
   * whenever `semanticResolution` itself is enabled; explicitly listing it
   * as `false` opts it out without touching the global setting. */
  points?: Record<string, boolean>;
  budget?: SemanticBudget;
  sourceOriginAllowlist?: string[];
  providerEndpointAllowlist?: string[];
  redactionRules?: RedactionRule[];
  calibration?: CalibrationRegistry;
  /** Bounds the session-scoped decision evidence cache (#25) — least-
   * recently-used entries are evicted once this is reached. Defaults to 100. */
  decisionCacheMaxEntries?: number;
}

/**
 * One entry per `evaluate()` call, gated by `actionLogging` (§16):
 * `"disabled"` logs nothing at all; `"metadata"` logs this shape with no
 * payload; `"full"` additionally includes `redactedQuestions` — the exact,
 * already-redacted questions that were sent (never raw state, never a form
 * value; nothing here is generated separately from what the provider saw).
 */
export interface SemanticLogEntry {
  point: DecisionPoint;
  status: SemanticPointResult<unknown, unknown>["kind"];
  reason?: OutcomeReason;
  redactedQuestions?: DecisionRequest["questions"];
  redactedState?: unknown;
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
  /** Learns sensitive values a policy encounters and scrubs them from every
   * outbound string (§16, I8). Shared across every `evaluate()` call on this
   * runtime, so a value learned building one request is redacted in later
   * ones too. */
  readonly redactor: Redactor;
  readonly sourceOriginAllowlist: readonly string[] | undefined;
  readonly providerEndpointAllowlist: readonly string[] | undefined;
  /** Calibrated acceptance thresholds (§21). Empty until an operator
   * supplies real artifacts — every point runs in shadow mode until then. */
  readonly calibration: CalibrationRegistry;
  /** Session-scoped decision evidence cache (#25) — memory-only, bounded,
   * scoped to this attachment. A decision point consults it directly
   * (`SemanticRuntime` itself never reads or writes it); this just owns its
   * lifetime, clearing it on `dispose()`. */
  readonly decisionCache: DecisionEvidenceCache;

  private readonly points: Readonly<Record<string, boolean>>;
  private readonly defaultBudget: SemanticBudget;
  private readonly actionLogging: SculptControlSettings["actionLogging"];
  private readonly logs: SemanticLogEntry[] = [];
  private readonly pending = new Set<AbortController>();
  private readonly bySupersedeKey = new Map<string, AbortController>();
  private disposed = false;

  constructor(options: SemanticRuntimeOptions) {
    this.enabled = options.settings.semanticResolution === "enabled";
    // A provider passed while disabled is replaced with NullProvider and
    // never referenced again — no initialization, no capability probe.
    this.provider = this.enabled ? (options.provider ?? new NullProvider()) : new NullProvider();
    this.calibration = options.calibration ?? EMPTY_CALIBRATION_REGISTRY;
    this.points = options.points ?? {};
    this.defaultBudget = options.budget ?? {};
    this.actionLogging = options.settings.actionLogging;
    this.redactor = new Redactor(options.redactionRules ?? []);
    this.sourceOriginAllowlist = options.sourceOriginAllowlist;
    this.providerEndpointAllowlist = options.providerEndpointAllowlist;
    this.decisionCache = new DecisionEvidenceCache(options.decisionCacheMaxEntries);
  }

  /** Creates a budget for one top-level operation (a UIKit call or
   * `agent.execute`), to pass into every `evaluate()` call nested inside it. */
  createOperationBudget(overrides: SemanticBudget = {}): OperationBudget {
    return new OperationBudget({ ...this.defaultBudget, ...overrides });
  }

  /** Whether a specific decision point should run at all — `enabled` (the
   * global setting) is necessary but not sufficient; a caller may also have
   * opted this one point out via `points`. */
  isPointEnabled(point: DecisionPoint): boolean {
    return this.enabled && this.points[point] !== false;
  }

  /** Entries logged so far, per `actionLogging` (§16). Bounded by the
   * process lifetime of this runtime; there is no persistence in m0. */
  getLogs(): readonly SemanticLogEntry[] {
    return this.logs;
  }

  async evaluate<TFallback, TAccepted>(
    config: SemanticPointConfig<TFallback, TAccepted>,
    options: EvaluateOptions = {}
  ): Promise<SemanticPointResult<TFallback, TAccepted>> {
    if (!this.enabled) {
      const result: SemanticPointResult<TFallback, TAccepted> = { kind: "disabled", fallback: config.fallback() };
      this.record(config.point, result);
      return result;
    }
    if (this.disposed) {
      return this.finish(config, this.degradeOrUnsatisfy(config, { code: "cancelled", detail: "semantic runtime is disposed" }));
    }

    if (options.supersedeKey) {
      this.bySupersedeKey.get(options.supersedeKey)?.abort();
    }
    const controller = new AbortController();
    this.pending.add(controller);
    if (options.supersedeKey) this.bySupersedeKey.set(options.supersedeKey, controller);

    const budget = options.budget ?? this.createOperationBudget();

    try {
      // Origin admission happens strictly before buildRequest() — a denied
      // origin's page state must never be read at all, not even to redact
      // it or learn a value from it (§16 review finding).
      if (this.sourceOriginAllowlist && !this.sourceOriginAllowlist.includes(config.origin)) {
        return this.finish(
          config,
          this.degradeOrUnsatisfy(config, {
            code: "origin_not_allowed",
            detail: `origin "${config.origin}" is not in the configured source-origin allowlist`
          })
        );
      }

      const request = config.buildRequest();
      const admitted = budget.admit(request);
      if (admitted) {
        return this.finish(config, this.degradeOrUnsatisfy(config, admitted));
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
            return this.finish(
              config,
              this.degradeOrUnsatisfy(config, { code: "cancelled", detail: "cancelled before the provider answered" }),
              request
            );
          }
          const reason: OutcomeReason =
            error instanceof ProviderUnavailableError
              ? { code: error.reasonCode, detail: this.redactor.text(error.message) }
              : { code: "unavailable", detail: sanitizeError(error, this.redactor).message };
          return this.finish(config, this.degradeOrUnsatisfy(config, reason), request);
        }

        if (controller.signal.aborted) {
          // A late result: discard it even if it looks valid. Never touches
          // a cache, a handle, a kind hint, or produces an accepted record.
          return this.finish(
            config,
            this.degradeOrUnsatisfy(config, { code: "cancelled", detail: "cancelled before the answer could be used" }),
            request
          );
        }

        const validated = validateDecisionResponse(request, raw);
        if (validated.outcomes.some((outcome) => outcome.status === "invalid")) {
          return this.finish(config, this.degradeOrUnsatisfy(config, { code: "invalid_answer" }), request);
        }
        const value = config.select(validated.outcomes);
        if (value === undefined) {
          return this.finish(config, this.degradeOrUnsatisfy(config, { code: "abstained" }), request);
        }

        if (config.capturedEvidence && config.checkFreshness) {
          const current = await config.checkFreshness();
          if (controller.signal.aborted) {
            return this.finish(
              config,
              this.degradeOrUnsatisfy(config, { code: "cancelled", detail: "cancelled while checking freshness" }),
              request
            );
          }
          if (!isFresh(config.capturedEvidence, current)) {
            return this.finish(
              config,
              this.degradeOrUnsatisfy(config, { code: "stale", detail: "page state changed since the request was built" }),
              request
            );
          }
        }

        return this.finish(config, { kind: "accepted", value }, request);
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

  /** Single exit point: every `evaluate()` return goes through here so
   * logging (§16) happens exactly once, consistently, for every outcome. */
  private finish<TFallback, TAccepted>(
    config: SemanticPointConfig<TFallback, TAccepted>,
    result: SemanticPointResult<TFallback, TAccepted>,
    request?: DecisionRequest
  ): SemanticPointResult<TFallback, TAccepted> {
    this.record(config.point, result, request);
    return result;
  }

  private record(
    point: DecisionPoint,
    result: SemanticPointResult<unknown, unknown>,
    request?: DecisionRequest
  ): void {
    if (this.actionLogging === "disabled") return;
    const reason = "reason" in result ? result.reason : undefined;
    const entry: SemanticLogEntry = { point, status: result.kind, reason };
    // "full" adds only the redacted state — the exact, already-redacted
    // questions and state that were (or would have been) sent. Never raw state.
    if (this.actionLogging === "full" && request) {
      entry.redactedQuestions = request.questions;
      entry.redactedState = request.redactedState;
    }
    this.logs.push(entry);
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
    this.decisionCache.clear();
  }
}
