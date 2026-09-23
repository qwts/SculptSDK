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
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word matching, not a bare substring test — "Sender preferences" and
// "Payroll settings" must never trip on "send"/"pay" the way a plain
// `.includes()` would.
const KEYWORD_PATTERNS: readonly { keyword: string; pattern: RegExp }[] = RISK_FLOOR_KEYWORDS.map((keyword) => ({
  keyword,
  pattern: new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i")
}));

function matchKeyword(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return KEYWORD_PATTERNS.find(({ pattern }) => pattern.test(text))?.keyword;
}

/** Returns the matched keyword, or `undefined` if none of the three signals
 * read as risky. Checked in a fixed order only so the matched keyword in an
 * error/record is deterministic, not because any one signal outranks another. */
export function checkRiskFloor(signals: RiskFloorSignals): string | undefined {
  return matchKeyword(signals.accessibleName) ?? matchKeyword(signals.text) ?? matchKeyword(signals.formAction);
}

export function confirmationRequiredError(keyword: string, summary: TargetSummary | undefined): SculptError {
  return new SculptError(
    "CONFIRMATION_REQUIRED",
    `the deterministic risk floor matched "${keyword}" — this action needs confirmation before it can run`,
    { layer: "uikit", target: summary, details: { matchedKeyword: keyword } }
  );
}
