# ADR-0002: The kernel proposes, Node decides

## Status

Proposed. See [#2, invariant I2](https://github.com/qwts/SculptSDK/issues/2)
and the [technical review, §1 and §4](https://github.com/qwts/SculptSDK/issues/2#issuecomment-5799549798).

## Context

The in-page kernel (`packages/core/src/kernel/`) is synchronous and keyless
today: it walks the live DOM, ranks candidates, and returns structured
results through a fixed `kernel.call(op, args)` envelope. No decision
provider call can happen inside the kernel — it has no network access, no
provider key, and no async boundary in its call surface.

#2 proposes keeping that shape and letting the kernel's protocol grow only
enough to support the seven decision points (structural query mode,
`formPlan`/`formApply`, rebind candidates, kind hints). The review points
out two sharp edges in the *current* kernel that a semantic layer sitting
beside it must not inherit silently: `resolveTarget()` can rebind
implicitly, including during a later mutation call, and `UIForm.fill()`
bypasses `runAction` and discards its own `submit()` result. A decision
made in Node must not be silently replaced by a different target the
kernel picks on its own during execution (see ADR-0008).

## Decision

- The kernel stays synchronous, keyless, and the sole owner of DOM
  traversal, ranking, and structural admission. It never calls a decision
  provider, directly or indirectly.
- Node (the `SemanticRuntime`, once it exists) is the only caller that
  invokes a `DecisionProvider`. The kernel returns candidates and features;
  Node asks the provider and applies the answer.
- **m0 scope for the kernel protocol is read-only**: the only kernel
  addition in scope for m0 is the evidence identity that freshness checks
  need (document/target revision, navigation epoch — ADR-0008). The
  structural query mode, `formPlan`/`formApply`, rebind candidates and kind
  hints described in #2 are out of scope for m0 and belong to the DP-1,
  DP-2, DP-5 and DP-6 epics (#6-#9).
- Any kernel-side implicit rebind path that could replace a Node-selected
  target during execution is a mutation-time bug for the relevant DP epic
  to close (not m0), not something m0's read-only evidence identity can
  paper over.

## Consequences

- m0 ships no kernel protocol version bump. The kernel is unchanged except
  for exposing existing-shape read-only evidence for freshness checks.
- DP work in m1+ that needs `formPlan`/`formApply` or rebind candidates
  will need its own kernel protocol version bump and adapter/host
  compatibility story — deferred, not decided here.
- Keeping the kernel keyless means PR CI (ADR-0007) never has a code path
  that could reach a live provider, by construction, not by configuration.
