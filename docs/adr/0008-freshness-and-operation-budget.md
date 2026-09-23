# ADR-0008: Freshness binding and shared operation budgets

## Status

Proposed. New — raised during the [technical review, §4 and §6](https://github.com/qwts/SculptSDK/issues/2#issuecomment-5799549798),
not present in #2's original ADR list.

## Context

Two gaps the review found in #2's design as written:

- **Freshness.** Candidate IDs alone are insufficient when an SPA can
  rerender while a provider call is in flight. `resolveTarget()` in the
  current kernel can rebind implicitly, including on a later mutation
  call — a decision made in Node must not be silently replaced by a
  different target during execution. Late results (from a navigation, a
  superseding request, a config change, or `dispose()`) must not touch
  caches, handles or records.
- **Budgets.** #2's per-point latency table ("one call per step," "at most
  two calls," a 32-candidate cap here and a 50-candidate cap there) does
  not compose: DP-1, DP-2 and DP-6 can all run inside a single action, and
  the caps disagree with each other (32 vs. 50). There was no shared
  accounting for total elapsed time, request count, question/option count,
  payload size or concurrency across a whole top-level operation.

## Decision

**Freshness:**

- The kernel's m0 protocol addition (ADR-0002) is a **read-only evidence
  identity**: document/target revision and navigation epoch, attached to
  every candidate and query result.
- Every provider request carries the evidence identity that was true when
  the candidates were generated (ADR-0001). Before any mutation dispatch
  that was gated on a semantic decision, the runtime revalidates that
  identity against the kernel's current state; if it has changed, the
  decision is discarded and the caller's normal recovery path runs within
  the remaining operation budget instead of proceeding on stale evidence.
- Navigation, target replacement, abort, and `dispose()` each invalidate
  every pending decision for that operation. A result that arrives after
  invalidation is dropped before it can touch a cache, a handle, or a
  decision record.
- This guarantee is scoped honestly: it does not promise atomic browser
  state across asynchronous adapter calls, and native input can still race
  with page changes after validation. What was validated is recorded; what
  wasn't is not implied.

**Shared operation budget:**

- One operation budget (deadline, request count, question/option count,
  total payload size, concurrency) covers the *entire* top-level operation
  — including nested `find`/form/rebind work, transport retries, and
  optional/background enrichment (e.g. a future DP-5 kind hint) — not one
  budget per decision point in isolation.
- Budget exhaustion follows each policy's own explicit degradation-class
  fallback (ADR-0006: `degraded-fallback` unless the condition was
  explicitly required). Required checks reserve their share of the budget;
  optional enrichment is dropped first.
- Semantic work adds **no new retries**. It does not add post-dispatch
  retries of its own and does not multiply the existing action-runner
  retries (`packages/core/src/uikit/action-runner.ts`). Transport-level
  retry/timeout settings for a provider call are configured explicitly and
  stay inside the same operation deadline.

## Consequences

- #15 implements this ADR directly: the read-only kernel evidence
  identity, cancellation/lifecycle wiring, and the shared budget type.
  #4's completion criteria ("navigation, target replacement, abort and
  disposal each invalidate pending decisions" and "one shared operation
  budget bounds nested work, retries and optional enrichment") are this
  ADR's tests.
- Per-decision-point latency numbers in #2 (e.g. "DP-1: 800 ms, 1 call")
  become starting allocations within the shared budget, not independent
  guarantees — a later DP epic may need to revisit them once more than one
  decision point can fire in the same operation.
- This ADR does not decide the decision cache (DP-1/DP-2 evidence caching
  in #2's design) — that is explicitly deferred to the DP-1 epic (#6),
  per #4's out-of-scope list.
