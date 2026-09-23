# ADR-0006: Three degradation classes

## Status

Proposed. Revises the ADR-0006 draft in #2 ("Fail closed on timeout, error
or low confidence") per the [technical review, §2](https://github.com/qwts/SculptSDK/issues/2#issuecomment-5799549798).

## Context

#2's original ADR-0006 said timeout, error or low confidence yields "the
same as today," full stop. The review splits that single case into three,
because "the same as today" means different things depending on whether
semantic resolution ran at all, ran and degraded, or was explicitly
required:

| Mode / requirement | Timeout, invalid answer, missing calibration or stale evidence |
| --- | --- |
| Disabled | Existing behavior, no semantic execution (ADR-0004) |
| Enabled, recovery/advisory | That point's deterministic fallback, tagged with a typed degradation reason |
| Explicitly required semantic condition | Leaves the condition unsatisfied — never reinterpreted as approval (ADR-0003) |

## Decision

`SemanticRuntime` (#12) exposes exactly these three degradation classes as
a closed, typed union — not booleans, not a shared "failed" flag:

1. **`disabled`** — the setting is off; no provider was constructed or
   called. See ADR-0004.
2. **`degraded-fallback`** — the provider was called (or would have been)
   and did not produce an accepted answer (timeout, transport error,
   invalid/malformed response, no calibration file for the model, or stale
   evidence per ADR-0008). The decision point's existing deterministic
   behavior applies, and the result carries a machine-readable reason
   (`timeout`, `invalid_answer`, `no_calibration`, `stale`, `unavailable`,
   ...) plus whatever partial evidence exists, for audit.
3. **`evidence-required-unsatisfied`** — an operator-configured condition
   explicitly needs semantic evidence to be satisfied, and none was
   available. The condition stays unsatisfied; nothing "passes" in its
   place.

A decision record always states which class produced its result, per
ADR-0001.

## Consequences

- #4's completion criterion "recovery fallback and explicitly required
  evidence have separate tests" is a direct test of classes 2 and 3 never
  being conflated.
- Every decision-point policy (#6-#9) must declare, per condition it
  exposes, whether that condition is advisory (class 2 on failure) or
  explicitly required (class 3 on failure) — this is policy-specific and
  is not decided by this ADR.
- A DP-7 keyword floor surviving a provider outage is class 2 (degraded
  deterministic enforcement), and is reported as such — never presented as
  equivalent to a successful semantic risk check.
