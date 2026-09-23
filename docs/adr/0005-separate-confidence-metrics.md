# ADR-0005: Confidence metrics stay separate

## Status

Proposed. See [#2, invariant I7](https://github.com/qwts/SculptSDK/issues/2)
and the [technical review, §3](https://github.com/qwts/SculptSDK/issues/2#issuecomment-5799549798)
("Do not call raw Jev confidence a calibrated probability of correctness").

## Context

#2 already separates heuristic `confidence` (today's `score / 40` or
`score / 12` ranking, uncalibrated) from a new `semantic.confidence` field.
The review adds a sharper distinction: TypeSafe documents Choice/Score
confidence as a statistic derived from the answer distribution, not a
calibrated probability of correctness, and Noul (binary) has no confidence
field at all. Conflating "the model's own confidence in its distribution",
"the probability mass on the selected option", and "an empirically
calibrated estimate of correctness from the eval corpus" would let a
threshold silently gate on the wrong number.

## Decision

Four fields, never sharing a name, a threshold, or a merge:

1. **Heuristic confidence** — today's deterministic ranking score, computed
   entirely without a provider. Unchanged by this work.
2. **Provider confidence** — the raw statistic the provider's SDK returns
   for a Choice/Score answer (undefined for Noul/binary answers).
3. **Selected-option probability** — the probability mass on the option the
   runtime selected, read directly off the answer's distribution.
4. **Calibrated estimate** — an empirically derived probability of
   correctness for that decision point, only available once a calibration
   run (thresholds/`<model>.json`, #5's epic) exists for the deployed
   model/policy/question version. Absent for any model with no thresholds
   file.

Each threshold used to accept or reject a decision names the exact metric
it gates (e.g. "DP-1 accepts at calibrated-estimate ≥ 0.80", never just
"confidence ≥ 0.80"). A model with no thresholds file is treated as
disabled for that decision point, per #2's calibration procedure.

## Consequences

- The runtime validation layer (#12, ADR-0001) can check these four values
  independently and reject a malformed distribution without guessing which
  "confidence" it was supposed to check.
- Decision records (#4's completion criteria) carry all four fields where
  applicable, so a post-hoc audit can tell whether a rejection was a low
  provider statistic, a low selected-option probability, or a missing
  calibration file.
- m0 ships the type shape and the "missing calibration file ⇒ disabled"
  rule; it does not ship any actual calibrated estimate, since no
  production decision policy or live provider exists yet (out of scope,
  per #4).
