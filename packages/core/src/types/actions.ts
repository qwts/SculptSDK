import type { BrowserCapabilities } from "./capabilities.js";
import type { TargetSummary } from "./refs.js";
import type { ExecutionGuard } from "./identity.js";
import type { TextMatcher, WireMatcher } from "./matchers.js";
import { serializeMatcher } from "./matchers.js";
import type { UIQuery } from "./queries.js";

export type InputMode = "native" | "synthetic" | "dom-mutation" | "framework-aware";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RecoveryStep {
  step: "rebind" | "scroll-into-view" | "wait-for-stable" | "retry";
  ok: boolean;
  detail?: string;
}

/** Preconditions evaluated before user-like input (§11.4, §18.2). */
export interface ActionPreconditions {
  mustExist?: boolean;
  mustBeVisible?: boolean;
  mustBeEnabled?: boolean;
  mustNotBeOccluded?: boolean;
}

/** A postcondition expectation; the action passes when any one holds (§18.2). */
export interface PostconditionExpectation {
  routeIncludes?: TextMatcher;
  toastAppeared?: TextMatcher;
  networkCompleted?: TextMatcher;
  elementVisible?: UIQuery;
}

export interface ActionPostconditions {
  expectOneOf?: PostconditionExpectation[];
  expectNoValidationErrors?: boolean;
}

export interface ActionRecoveryOptions {
  rebindOnStale?: boolean;
  scrollIntoView?: boolean;
  retryLimit?: number;
}

export interface StabilityOptions {
  mutationQuietMs?: number;
  networkQuietMs?: number;
  routeStable?: boolean;
  timeoutMs?: number;
}

export interface StableStateReport {
  stable: boolean;
  elapsedMs: number;
  conditions: {
    mutationsQuiet: boolean;
    networkQuiet: boolean;
    routeStable: boolean;
  };
  reasons: string[];
}

export interface ActionAfterOptions {
  waitFor?: "stable-spa-state" | StabilityOptions;
}

export interface ActionOptions {
  preconditions?: ActionPreconditions;
  postconditions?: ActionPostconditions;
  recovery?: ActionRecoveryOptions;
  after?: ActionAfterOptions;
  /** Force a specific input mode instead of the capability-based preference order. */
  mode?: InputMode;
  /** #22: bind this action to the page state a decision was made against.
   * A mismatch fails closed with a typed stale error; it never rebinds. */
  guard?: ExecutionGuard;
}

export interface ClickOptions extends ActionOptions {
  button?: "left" | "middle" | "right";
  clickCount?: number;
}

export interface SetValueOptions extends ActionOptions {
  /** Verify the value reads back after input. Defaults to true. */
  verify?: boolean;
}

export interface ClearOptions extends ActionOptions {}
export interface SubmitOptions extends ActionOptions {}
export interface CloseOptions extends ActionOptions {}
export interface FormFillOptions extends ActionOptions {
  /** Submit the form after a successful fill. */
  submit?: boolean;
}

export type KeySequence = string | string[];

/** Structured result of every UIKit action (§18.3). */
export interface ActionResult {
  ok: boolean;
  actionId: string;
  action: string;
  target?: TargetSummary;
  inputMode?: InputMode;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  preconditions: CheckResult[];
  postconditions: CheckResult[];
  recoverySteps: RecoveryStep[];
  capabilitySnapshot: BrowserCapabilities;
  /** Optional action payload (e.g. extracted data, read-back value). */
  value?: unknown;
  error?: SculptErrorShape;
}

export interface FilledField {
  label: string;
  targetId: string;
  value: string;
  verified: boolean;
}

export interface FormValidationError {
  field?: string;
  message: string;
  source: "constraint-validation" | "aria-invalid" | "alert-region";
}

/** Structured outcome of UIForm.fill (§19.4). */
export interface FormFillResult {
  ok: boolean;
  filled: FilledField[];
  unmapped: string[];
  ambiguous: { key: string; candidates: string[] }[];
  validationErrors: FormValidationError[];
}

/** Wire-form postconditions for transport into the kernel. */
export interface WirePostconditionExpectation {
  routeIncludes?: WireMatcher;
  toastAppeared?: WireMatcher;
  networkCompleted?: WireMatcher;
}

export function serializeExpectation(e: PostconditionExpectation): WirePostconditionExpectation {
  return {
    routeIncludes: serializeMatcher(e.routeIncludes),
    toastAppeared: serializeMatcher(e.toastAppeared),
    networkCompleted: serializeMatcher(e.networkCompleted)
  };
}

// Re-exported here to avoid a cycle: ActionResult carries the error shape.
export interface SculptErrorShape {
  code: string;
  message: string;
  layer: "runtime" | "foundation" | "uikit" | "orchestration";
  target?: TargetSummary;
  recoverable: boolean;
  retryable: boolean;
  details?: Record<string, unknown>;
}
