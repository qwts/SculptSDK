/**
 * Text matchers cross the evaluate boundary between the Node side and the
 * in-page kernel, where RegExp instances do not survive serialization.
 * They are converted to a wire form before transport and revived in the page.
 */
export type TextMatcher = string | RegExp;

export type WireMatcher = string | { regex: string; flags: string };

export function serializeMatcher(matcher: TextMatcher): WireMatcher;
export function serializeMatcher(matcher: TextMatcher | undefined): WireMatcher | undefined;
export function serializeMatcher(matcher: TextMatcher | undefined): WireMatcher | undefined {
  if (matcher === undefined) return undefined;
  if (matcher instanceof RegExp) return { regex: matcher.source, flags: matcher.flags };
  return matcher;
}

export type MatchQuality = "exact" | "match" | null;

const WS = /\s+/g;

export function normalizeText(value: string): string {
  return value.replace(WS, " ").trim();
}

/**
 * Matches a candidate string against a wire matcher.
 * Strings compare case-insensitively: equality is "exact", substring is "match".
 * Regexes always report "match" so exact string hits rank above them.
 */
export function matchText(value: string | null | undefined, matcher: WireMatcher): MatchQuality {
  if (value == null) return null;
  const normalized = normalizeText(value);
  if (typeof matcher === "string") {
    const expected = normalizeText(matcher);
    if (normalized.toLowerCase() === expected.toLowerCase()) return "exact";
    if (expected.length > 0 && normalized.toLowerCase().includes(expected.toLowerCase())) return "match";
    return null;
  }
  return new RegExp(matcher.regex, matcher.flags).test(normalized) ? "match" : null;
}
