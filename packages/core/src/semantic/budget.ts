/**
 * @experimental Shared operation budget (ADR-0008): one budget per top-level
 * operation (a UIKit call or `agent.execute`), passed into nested semantic
 * work so DP-1/DP-2/DP-6 running inside one action can never together exceed
 * any limit. Bounds provider requests, question/option counts, payload
 * bytes, concurrency, and elapsed time against one absolute deadline.
 * Required checks should call `admit()` before optional enrichment —
 * whichever asks first claims the remaining capacity.
 */
import type { DecisionRequest } from "./provider.js";
import type { OutcomeReason } from "./validate.js";

export interface SemanticBudget {
  /** Wall-clock budget for the whole operation's semantic work, ms. */
  maxOperationMs?: number;
  /** Max provider requests for the whole operation. */
  maxRequests?: number;
  /** Max provider requests in flight at once for the whole operation. */
  maxConcurrency?: number;
  maxQuestionsPerRequest?: number;
  maxOptionsPerQuestion?: number;
  maxPayloadBytes?: number;
}

export const DEFAULT_SEMANTIC_BUDGET: Required<SemanticBudget> = {
  maxOperationMs: 2000,
  maxRequests: 4,
  maxConcurrency: 2,
  maxQuestionsPerRequest: 32,
  // #2's 32-candidate cap (DP1_RECALL_CAP) is a candidate count; every
  // choice question also carries an implicit "none" option (ADR-0001), so
  // the option-count limit needs room for 32 candidates + 1, not 32 total —
  // otherwise a full-width recall request is silently budget-rejected
  // before it ever reaches the provider (#24).
  maxOptionsPerQuestion: 33,
  maxPayloadBytes: 32_000
};

export class OperationBudget {
  private readonly limits: Required<SemanticBudget>;
  private readonly deadlineAt: number;
  private requestCount = 0;
  private activeCount = 0;

  constructor(overrides: SemanticBudget = {}, startedAt: number = Date.now()) {
    this.limits = { ...DEFAULT_SEMANTIC_BUDGET, ...overrides };
    this.deadlineAt = startedAt + this.limits.maxOperationMs;
  }

  /** Absolute epoch-ms deadline every request under this budget shares. */
  get deadline(): number {
    return this.deadlineAt;
  }

  private remainingMs(): number {
    return this.deadlineAt - Date.now();
  }

  get exhausted(): boolean {
    return this.remainingMs() <= 0 || this.requestCount >= this.limits.maxRequests;
  }

  /**
   * Admits one request against every limit. Returns `null` and reserves
   * capacity (request count + a concurrency slot) on success; returns a
   * typed reason and reserves nothing otherwise. Never silently truncates a
   * request that's too big — an oversized request is rejected outright.
   */
  admit(request: DecisionRequest): OutcomeReason | null {
    if (this.remainingMs() <= 0) {
      return { code: "budget_exhausted", detail: "operation deadline already passed" };
    }
    if (this.requestCount >= this.limits.maxRequests) {
      return {
        code: "budget_exhausted",
        detail: `max ${this.limits.maxRequests} provider request(s) per operation reached`
      };
    }
    if (this.activeCount >= this.limits.maxConcurrency) {
      return {
        code: "budget_exhausted",
        detail: `max ${this.limits.maxConcurrency} concurrent provider request(s) reached`
      };
    }
    if (request.questions.length > this.limits.maxQuestionsPerRequest) {
      return {
        code: "budget_exhausted",
        detail: `request has ${request.questions.length} questions, over the ${this.limits.maxQuestionsPerRequest} limit`
      };
    }
    for (const question of request.questions) {
      if (question.kind === "choice" && question.options.length > this.limits.maxOptionsPerQuestion) {
        return {
          code: "budget_exhausted",
          detail: `question "${question.id}" has ${question.options.length} options, over the ${this.limits.maxOptionsPerQuestion} limit`
        };
      }
    }
    const payloadBytes = JSON.stringify(request.questions).length;
    if (payloadBytes > this.limits.maxPayloadBytes) {
      return {
        code: "budget_exhausted",
        detail: `request payload is ${payloadBytes} bytes, over the ${this.limits.maxPayloadBytes} limit`
      };
    }
    this.requestCount++;
    this.activeCount++;
    return null;
  }

  /** Frees the concurrency slot `admit()` reserved. Call once the request settles, success or not. */
  release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }
}
