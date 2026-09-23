# ADR-0007: PR CI is deterministic

## Status

Proposed. Extends the ADR-0007 draft in #2 ("Recorded provider in CI; live
eval only in a key-gated job") per the [technical review, §7](https://github.com/qwts/SculptSDK/issues/2#issuecomment-5799549798).

## Context

#2 already proposes that PR CI never calls a live provider, using
`RecordedProvider` instead, with live evaluation as a separate key-gated
nightly job. The review adds that calibration itself is a release artifact
with a provenance chain, not a one-off number: thresholds must be pinned to
the exact model, question/schema version, redaction version, candidate
generation version and policy version they were measured against, because
changing any of those invalidates the calibration.

## Decision

- **PR CI** (`.github/workflows/ci.yml`, #10) runs install, build,
  typecheck, unit, property and integration suites against `NullProvider`
  and `RecordedProvider` only. It needs no secrets and no network access
  beyond the package registry. This is already true as of #10 — there is
  no code path in m0 that can reach a live provider from CI, by
  construction (ADR-0002: the kernel is keyless, and no production
  decision policy exists yet).
- `RecordedProvider` conformance (#13) matches recordings against a
  **request digest** (question set, candidate-set digest, redacted-state
  digest — ADR-0001), not call order alone, so a harmless reordering of
  independent calls doesn't break a recording.
- **Live evaluation** (#5's epic, out of scope for m0) runs only in a
  separate, key-gated job (nightly, or on model change), never on
  `pull_request`.
- **Calibration is a versioned release artifact**: `thresholds/<model>.json`,
  changed only by a calibration-run PR that links the eval output, and
  pinned to the effective model, question/schema version,
  preprocessing/redaction version, candidate-generation version and policy
  version. A model with no thresholds file is disabled for that decision
  point (ADR-0005). Re-run on every one of those version changes; a
  threshold never carries across a version bump.

## Consequences

- m0 delivers the PR-CI half of this ADR in full (#10-#17). The live-eval
  job and the thresholds pipeline belong to #5 and are explicitly out of
  scope here.
- Because thresholds carry their full provenance, a threshold file is
  self-describing evidence in an audit, not just a number a reviewer has to
  trust.
