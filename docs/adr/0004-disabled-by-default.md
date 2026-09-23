# ADR-0004: Disabled by default, with parity defined in full

## Status

Proposed. See [#2, invariant I6](https://github.com/qwts/SculptSDK/issues/2)
and the [technical review, §2 (I6 row)](https://github.com/qwts/SculptSDK/issues/2#issuecomment-5799549798).

## Context

#2 proposes `SculptControlSettings.semanticResolution: "disabled" | "enabled"`,
defaulting to `"disabled"`, mirroring how `rawJavaScript` already gates
`runtime.evaluate`. The review sharpens "disabled behaves identically to
today" into a testable parity contract: disabled must mean no provider
calls, no background enrichment, no SDK-initiated provider
initialization or key requirement, and no new semantic risk floor — and it
must preserve today's existing public results and side effects exactly, not
approximately.

## Decision

- `SculptControlSettings` gains `semanticResolution: "disabled" | "enabled"`,
  set to `"disabled"` in `DEFAULT_SETTINGS`.
- `SculptAttachOptions` gains an optional `semantic` configuration block
  (provider, per-point switches, thresholds, budgets, cache sizes, an
  origin allowlist) — inert while `semanticResolution` is `"disabled"`.
- A provider instance passed while the setting is disabled is swapped for
  `NullProvider`, and `capabilities.settings()` reports the effective
  setting, the same pattern `rawJavaScript` already uses.
- Disabled parity is defined as all of:
  - **Results**: every public return value (`ActionResult`, `FormFillResult`,
    query results, errors) is byte-for-byte identical to today's behavior
    for the same input and DOM state.
  - **Errors**: the same error codes, the same `recoverable`/`retryable`
    traits, the same `details`.
  - **Input dispatch**: no additional DOM events, no additional kernel
    calls beyond what today's code path makes.
  - **Zero semantic-provider activity or egress**: no provider is
    constructed, no network call is made, no redaction work runs, because
    there is nothing to redact when nothing is sent.
- This is the "disabled" degradation class from ADR-0006, and it is not the
  same as a provider timing out — a disabled provider is never invoked in
  the first place.

## Consequences

- #14's disabled-parity suite is the executable proof of this ADR, run
  against both `NullProvider` (implicit) and `RecordedProvider`, so a
  regression here is a merge-blocking test failure, not a review note.
- Every future decision-point policy (#6-#9) must be written so the
  disabled path never touches `SemanticRuntime` at all, not just never
  gets a positive answer from it.
