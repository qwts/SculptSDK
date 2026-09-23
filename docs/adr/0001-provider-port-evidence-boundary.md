# ADR-0001: The provider port is an evidence boundary

## Status

Proposed. Supersedes the draft ADR-0001 in #2's architecture document
("`DecisionProvider` port speaks choice, score and yes/no; Jev is an
adapter"). See [#2](https://github.com/qwts/SculptSDK/issues/2) and the
[technical review, §3](https://github.com/qwts/SculptSDK/issues/2#issuecomment-5799549798).

## Context

#2 proposes a vendor-neutral `DecisionProvider` port speaking three question
types — choice over named options, ordinal score, and binary probability —
so a live provider (TypeSafe's Jev) can be swapped without touching the
seven decision-point policies.

The technical review accepts that shape but treats the boundary as an
**evidence boundary**, not just a typed RPC call: the runtime, not the
provider, must own every identifier that admits a decision into control
flow, and every answer must be validated before it becomes a domain
decision. TypeScript types alone are insufficient at a process boundary —
they check what the SDK sends, not what a provider (or a bug in the
transport) sends back.

## Decision

- Keep Choice, Score and binary probability as a discriminated union.
- For every request, the runtime attaches: a request/operation ID and
  decision point, the exact model, question/schema version and
  policy/calibration version, origin, frame/document identity, navigation
  epoch and the relevant target revision, a candidate-set digest and a
  redacted-state digest, and an absolute operation deadline plus a
  cancellation signal. The provider cannot invent or replace this evidence.
- Every response is validated before use: question IDs, answer kinds,
  selected-option membership against the candidates the runtime sent,
  finite values in range, and complete probability distributions within a
  documented normalization tolerance. Missing required answers and
  unexpected options are rejected, not silently dropped or normalized.
- Responses carry explicit machine-readable outcomes — `accepted`,
  `abstained`, `unavailable`, `invalid`, `stale` — instead of collapsing
  everything into ok/error. A valid `none` answer is abstention, not a
  transport failure.
- Raw provider confidence (a distribution statistic Jev documents, not a
  calibrated probability of correctness) is never treated as a calibrated
  estimate. See ADR-0005.
- Independent advisory answers may survive a partial batch; coupled
  assignments (e.g. one field per form key) require a complete, valid
  decision for the whole affected group or the group abstains together.

## Consequences

- A vendor swap (or an LLM-backed provider later) only has to satisfy this
  validated envelope, not the union type alone.
- Runtime validation is real production code with its own tests (#12), not
  a formality — malformed, partial or foreign-candidate answers are a
  tested, first-class path, not an afterthought.
- Every decision has forensic provenance: which model, which policy
  version, which candidate set, and whether the evidence was fresh when it
  was used (ADR-0008).
