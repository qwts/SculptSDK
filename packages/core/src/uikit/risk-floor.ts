/**
 * @experimental DP-7 deterministic risk floor (#26). A keyword check against
 * the accessible name, visible text and form action of the target a `click`
 * or `submit` is about to dispatch on — no provider, no semantic evidence,
 * nothing a later answer (stub or real) can clear. The technical review
 * (§2, §5) is explicit that a floor running on its own is degraded
 * enforcement, not proof an action is safe — this is that floor, sticky by
 * construction: it's evaluated once, before dispatch, and a match becomes a
 * non-retryable `CONFIRMATION_REQUIRED` the action-runner's retry loop
 * cannot get past (see `CODE_TRAITS` in `errors.ts`).
 */
import { SculptError } from "../errors.js";
import type { TargetSummary } from "../types/index.js";

/** Starting list (#2) — not final. Extend it as real gaps are found; never
 * narrow it just to quiet a false escalation like "Delete filter" (§26: those
 * are measured results, not something to tune away). */
export const RISK_FLOOR_KEYWORDS: readonly string[] = [
  "delete",
  "remove",
  "pay",
  "purchase",
  "send",
  "transfer",
  "cancel",
  "close account"
];

export interface RiskFloorSignals {
  accessibleName?: string;
  text?: string;
  formAction?: string;
  href?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word matching, not a bare substring test — "Sender preferences" and
// "Payroll settings" must never trip on "send"/"pay" the way a plain
// `.includes()` would. Custom lookaround boundaries, not `\b`: `\b` treats
// `_` as a word character, so `\bdelete\b` misses "delete_account" (common
// in REST paths/ids) even though it catches the hyphenated equivalent —
// only a letter or digit on either side should count as "still inside a
// word".
const KEYWORD_PATTERNS: readonly { keyword: string; pattern: RegExp }[] = RISK_FLOOR_KEYWORDS.map((keyword) => ({
  keyword,
  pattern: new RegExp(`(?<![a-zA-Z0-9])${escapeRegExp(keyword)}(?![a-zA-Z0-9])`, "i")
}));

function matchKeyword(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return KEYWORD_PATTERNS.find(({ pattern }) => pattern.test(text))?.keyword;
}

/** Returns the matched keyword, or `undefined` if none of the signals read
 * as risky. Checked in a fixed order only so the matched keyword in an
 * error/record is deterministic, not because any one signal outranks
 * another. `href` covers a link click, which never goes through a form at
 * all — `formAction` alone would miss a risky navigation entirely. */
export function checkRiskFloor(signals: RiskFloorSignals): string | undefined {
  return (
    matchKeyword(signals.accessibleName) ??
    matchKeyword(signals.text) ??
    matchKeyword(signals.formAction) ??
    matchKeyword(signals.href)
  );
}

/** `matched` is either a keyword this module itself matched, or the literal
 * `"semantic-risk"` a caller passes when #28's semantic predicates escalated
 * where the floor missed — `details.reason` reflects which one actually
 * fired so a host can tell a keyword hit from a semantic-only one apart
 * (they were previously indistinguishable: this always reported
 * `"deterministic-floor"`, even for a semantic-only escalation). */
export function confirmationRequiredError(matched: string, summary: TargetSummary | undefined): SculptError {
  const reason = matched === "semantic-risk" ? "semantic-risk" : "deterministic-floor";
  const description = reason === "semantic-risk" ? "DP-7's semantic risk predicates" : `the deterministic risk floor matched "${matched}"`;
  return new SculptError(
    "CONFIRMATION_REQUIRED",
    `${description} — this action needs confirmation before it can run`,
    { layer: "uikit", target: summary, details: { matchedKeyword: matched, reason } }
  );
}

/** #28: the operator required a DP-7 semantic risk check and it could not
 * produce a usable answer (provider unavailable, timeout, invalid
 * response). A hard stop, never routed through confirmation-grant
 * verification — there is no approved risk decision for a grant to bind
 * to, so none can clear it. */
export function requiredRiskCheckUnavailableError(summary: TargetSummary | undefined): SculptError {
  return new SculptError(
    "CONFIRMATION_REQUIRED",
    "a required DP-7 semantic risk check could not produce an answer — this action cannot proceed",
    { layer: "uikit", target: summary, details: { reason: "required-risk-check-unavailable" } }
  );
}
