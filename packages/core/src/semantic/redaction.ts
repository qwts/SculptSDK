/**
 * @experimental Redaction (#16, I8: minimal data). Builds the allowlisted
 * DTOs every outbound request, recording, error and log is made from — no
 * generic snapshot-serialization path ever reaches a provider. A value the
 * current operation knows is sensitive (typed or filled into a field) is
 * scrubbed wherever it appears in any outbound string, not just the field it
 * came from: a validation message, an accessible name, a route segment, an
 * attribute, or goal text can all echo it back.
 *
 * Residual risk, stated plainly and not claimed away: sensitive free text
 * the SDK has no way to know about (page copy that happens to contain a
 * secret, for example) can still leave the process when semantic resolution
 * is enabled. This redacts what the current operation *learned*, not
 * arbitrary page content.
 */
import type { ElementIdentity } from "../types/identity.js";
import type { RouteState } from "../types/snapshot.js";

export type ValueShape = "email" | "phone" | "date" | "number" | "boolean" | "short-text" | "long-text";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9()\-.\s]{6,}[0-9]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/** Computes a value's *shape* locally, in Node, so the value itself never
 * has to leave the process just to describe what kind of field it fills. */
export function computeValueShape(value: unknown): ValueShape {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  if (EMAIL_RE.test(text)) return "email";
  if (DATE_RE.test(text.trim())) return "date";
  if (PHONE_RE.test(text.replace(/\s+/g, " ").trim())) return "phone";
  return text.length > 60 ? "long-text" : "short-text";
}

/** ARIA and attribute allowlist (§6): only these ever appear in an outbound DTO. */
export const ALLOWED_ATTRIBUTES: readonly string[] = [
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "aria-disabled",
  "aria-required",
  "aria-invalid",
  "aria-current",
  "aria-pressed",
  "role",
  "data-testid",
  "placeholder",
  "title",
  "alt"
];

const EXCLUDED_FIELD_TYPES: ReadonlySet<string> = new Set(["password", "hidden", "file"]);

/** True for a field an outbound DTO must never describe by value or name:
 * password, hidden, file, and any `autocomplete="cc-*"` payment field. */
export function isExcludedField(field: { type?: string; autocomplete?: string }): boolean {
  if (field.type && EXCLUDED_FIELD_TYPES.has(field.type.toLowerCase())) return true;
  if (field.autocomplete?.toLowerCase().startsWith("cc-")) return true;
  return false;
}

/** Keeps only allowlisted attributes — never "everything except a few fields". */
export function allowlistAttributes(attributes: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) return out;
  for (const key of ALLOWED_ATTRIBUTES) {
    const value = attributes[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Route path only — query string and fragment are stripped (§6), even if
 * a caller passes a `path` that still has them (defense in depth: this
 * function's contract is "path only", so it enforces that itself rather
 * than trusting every caller to have already stripped them). */
export function redactRoute(route: Pick<RouteState, "path">): string {
  return route.path.split("?")[0]!.split("#")[0]!;
}

export type RedactionRule = (text: string) => string;

const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Tracks values the current operation has learned are sensitive (typed or
 * filled into a field) and scrubs them from any outbound string, plus runs
 * operator-supplied free-text rules. One `Redactor` per `SemanticRuntime`.
 */
export class Redactor {
  private readonly learned = new Set<string>();
  private readonly operatorRules: readonly RedactionRule[];

  constructor(operatorRules: readonly RedactionRule[] = []) {
    this.operatorRules = operatorRules;
  }

  /** Registers a value as sensitive so it's stripped from every outbound
   * string from now on, wherever it echoes — not just where it was entered. */
  learn(value: unknown): void {
    const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
    // Values under 2 chars are too likely to appear coincidentally (e.g. "a")
    // and would make ordinary text unreadable if scrubbed everywhere.
    if (text.length >= 2) this.learned.add(text);
  }

  text(input: string | undefined): string | undefined {
    if (input === undefined) return undefined;
    let out = input;
    for (const value of this.learned) {
      if (out.includes(value)) out = out.split(value).join(REDACTED_PLACEHOLDER);
    }
    for (const rule of this.operatorRules) out = rule(out);
    return out;
  }

  attributes(attributes: Record<string, string> | undefined): Record<string, string> {
    const allowlisted = allowlistAttributes(attributes);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(allowlisted)) {
      out[key] = this.text(value) ?? value;
    }
    return out;
  }
}

function truncate(text: string | undefined, maxLength: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * The one DTO m0 ships (the framework's worked example, used by the #17
 * synthetic consumer): a redacted, allowlisted summary of one candidate.
 * Never carries a value, only what the candidate *is*.
 */
export interface CandidateSummaryDTO {
  candidateId: string;
  kind?: string;
  role?: string;
  accessibleName?: string;
  visibleText?: string;
  attributes: Record<string, string>;
}

export interface BuildCandidateSummaryInput {
  targetId: string;
  kind?: string;
  role?: string;
  accessibleName?: string;
  visibleText?: string;
  attributes?: Record<string, string>;
}

export function buildCandidateSummaryDTO(
  candidate: BuildCandidateSummaryInput,
  redactor: Redactor,
  options: { maxTextLength?: number } = {}
): CandidateSummaryDTO {
  const maxLength = options.maxTextLength ?? 120;
  // Redact the *complete* string first, then truncate: truncating first
  // could cut a learned value in half, leaving an unredacted fragment of it
  // (e.g. a long token) in the outbound DTO.
  return {
    candidateId: candidate.targetId,
    kind: candidate.kind,
    role: candidate.role,
    accessibleName: truncate(redactor.text(candidate.accessibleName), maxLength),
    visibleText: truncate(redactor.text(candidate.visibleText), maxLength),
    attributes: redactor.attributes(candidate.attributes)
  };
}

/** Best-effort stringification that can never itself throw — a circular
 * object, a BigInt, or a throwing `toJSON`/`toString` must never turn a
 * sanitization step into an unhandled rejection. */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // fall through to String()
  }
  try {
    return String(value);
  } catch {
    return "[unserializable error value]";
  }
}

/** Sanitizes an arbitrary thrown value into a safe-to-store error shape —
 * never trusts a provider's or a bug's raw message not to echo a learned
 * value, and never throws itself (a malformed provider failure must still
 * reach the runtime's typed degraded/unsatisfied result, not reject it). */
export function sanitizeError(error: unknown, redactor: Redactor): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : safeStringify(error);
  return { code: "UNKNOWN", message: redactor.text(raw) ?? "" };
}

/** Re-exported so callers building a DTO have the shape without importing kernel identity types directly. */
export type { ElementIdentity };
