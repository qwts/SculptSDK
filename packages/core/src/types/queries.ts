import type { UIKind, LayoutRegion } from "./kinds.js";
import type { TextMatcher, WireMatcher } from "./matchers.js";
import { serializeMatcher } from "./matchers.js";
import type { ElementIdentity } from "./identity.js";
import type { TargetSummary } from "./refs.js";

/** Semantic UI query (§17.3). RegExp values are allowed for all text fields. */
export interface UIQuery {
  kind?: UIKind;
  role?: string;
  name?: TextMatcher;
  text?: TextMatcher;
  label?: TextMatcher;
  placeholder?: TextMatcher;
  value?: TextMatcher;
  visible?: boolean;
  enabled?: boolean;
  focused?: boolean;
  within?: UIQuery;
  near?: UIQuery;
  route?: TextMatcher;
  region?: LayoutRegion;
  state?: Record<string, unknown>;
  minConfidence?: number;
  /** Opt in to DP-1 recall on a miss (#24): `name`/`text` are dropped and
   * every other predicate stays mandatory, deterministic and capped. Off by
   * default even when DP-1 is enabled — never sent to the kernel, Node
   * decides whether to run a second, structural-only query. */
  recall?: boolean;
}

/** UIQuery in serialization-safe form for transport into the page. */
export interface WireUIQuery {
  kind?: UIKind;
  role?: string;
  name?: WireMatcher;
  text?: WireMatcher;
  label?: WireMatcher;
  placeholder?: WireMatcher;
  value?: WireMatcher;
  visible?: boolean;
  enabled?: boolean;
  focused?: boolean;
  within?: WireUIQuery;
  near?: WireUIQuery;
  route?: WireMatcher;
  region?: LayoutRegion;
  state?: Record<string, unknown>;
  minConfidence?: number;
}

export function serializeQuery(query: UIQuery): WireUIQuery {
  const { recall: _recall, ...rest } = query;
  return {
    ...rest,
    name: serializeMatcher(query.name),
    text: serializeMatcher(query.text),
    label: serializeMatcher(query.label),
    placeholder: serializeMatcher(query.placeholder),
    value: serializeMatcher(query.value),
    route: serializeMatcher(query.route),
    within: query.within ? serializeQuery(query.within) : undefined,
    near: query.near ? serializeQuery(query.near) : undefined
  };
}

/** One ranked query result as returned by the kernel. */
export interface QueryCandidate {
  summary: TargetSummary;
  identity: ElementIdentity;
  score: number;
  confidence: number;
  reasons: string[];
  /** Mandatory predicates the query requested but this candidate could not
   * be conclusively verified against (#23) — e.g. `region` with no layout
   * data. Empty unless the query used a predicate with this gap. */
  unverifiedMandatoryPredicates: string[];
}
