# ADR-0003: Semantic evidence never changes authority

## Status

Proposed. Rewrites the ADR-0003 draft in #2 ("Provider answers can only
tighten authority") per the [technical review, §2](https://github.com/qwts/SculptSDK/issues/2#issuecomment-5799549798).

## Context

#2's invariant I3 ("Tighten, never loosen") says answers pick among
admitted candidates or add friction, and never grant authority, waive a
precondition, or clear a risk flag. The review found this needed to be an
enforceable contract, not a slogan: a keyword floor that survives a DP-7
provider outage by falling back to itself is **degraded deterministic
enforcement**, which is fine — but if an operator has configured a
condition that explicitly *requires* semantic evidence, an unavailable
provider must leave that condition unsatisfied, not quietly pass on the
deterministic floor alone. Reinterpreting "no evidence" as "approved" would
be loosening authority through unavailability instead of through a wrong
answer.

## Decision

- Semantic evidence may only improve matching **inside a deterministically
  admitted set**. It can never change operator authority (`SculptControlSettings`),
  a mandatory query predicate, an action capability, or a required
  precondition.
- Three cases are kept explicitly distinct (see ADR-0006 for the full
  degradation taxonomy):
  1. **Disabled** — existing behavior, no semantic execution at all.
  2. **Enabled, recovery/advisory** — on timeout, invalid answer, missing
     calibration or stale evidence, the policy's deterministic fallback
     applies, tagged with a typed degradation reason.
  3. **Explicitly required evidence** — when an operator has configured a
     condition that requires a semantic answer, missing or invalid
     evidence leaves the condition *unsatisfied*. It never falls back to
     "approved."
- A keyword floor (DP-7) surviving a provider outage is degraded
  deterministic enforcement, not proof of safety, and is documented as
  such wherever it is reported.
- `outcome: succeeded` (DP-3) can never be set on a provider timeout or
  error; only an actual, verified outcome sets it.

## Consequences

- The three degradation cases each need their own test (#4's completion
  criteria: "recovery fallback and explicitly required evidence have
  separate tests"), not one shared "provider failed" test.
- Any future decision-point policy that wants to bypass this ADR (e.g. "if
  the provider can't answer, assume yes") is a new decision that must be
  raised in #2, not something a policy PR can decide locally.
- This does not by itself define *what* "required" means per decision
  point — that is each DP epic's job (#6-#9) once semantic policies exist.
  m0 only builds the runtime machinery (`SemanticRuntime`, degradation
  classes) that those policies will rely on.
