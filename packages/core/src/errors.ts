import type { SculptErrorShape, TargetSummary } from "./types/index.js";

export type SculptErrorCode =
  | "CAPABILITY_UNAVAILABLE"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "TARGET_STALE"
  | "TARGET_NOT_VISIBLE"
  | "TARGET_DISABLED"
  | "TARGET_OCCLUDED"
  | "INPUT_FAILED"
  | "POSTCONDITION_FAILED"
  | "STABLE_STATE_TIMEOUT"
  | "NAVIGATION_TIMEOUT"
  | "FRAME_INACCESSIBLE"
  | "SHADOW_ROOT_CLOSED"
  | "FRAMEWORK_ADAPTER_FAILED"
  | "NETWORK_OBSERVATION_UNAVAILABLE"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_GRANT_INVALID"
  | "UNKNOWN";

export type SculptLayer = "runtime" | "foundation" | "uikit" | "orchestration";

/** recoverable: a recovery strategy may fix it; retryable: same action may simply work again. */
const CODE_TRAITS: Record<SculptErrorCode, { recoverable: boolean; retryable: boolean }> = {
  CAPABILITY_UNAVAILABLE: { recoverable: false, retryable: false },
  TARGET_NOT_FOUND: { recoverable: true, retryable: true },
  TARGET_AMBIGUOUS: { recoverable: false, retryable: false },
  TARGET_STALE: { recoverable: true, retryable: true },
  TARGET_NOT_VISIBLE: { recoverable: true, retryable: true },
  TARGET_DISABLED: { recoverable: true, retryable: true },
  TARGET_OCCLUDED: { recoverable: true, retryable: true },
  INPUT_FAILED: { recoverable: true, retryable: true },
  POSTCONDITION_FAILED: { recoverable: false, retryable: false },
  STABLE_STATE_TIMEOUT: { recoverable: true, retryable: true },
  NAVIGATION_TIMEOUT: { recoverable: true, retryable: true },
  FRAME_INACCESSIBLE: { recoverable: false, retryable: false },
  SHADOW_ROOT_CLOSED: { recoverable: false, retryable: false },
  FRAMEWORK_ADAPTER_FAILED: { recoverable: true, retryable: false },
  NETWORK_OBSERVATION_UNAVAILABLE: { recoverable: false, retryable: false },
  // #26: recoverable (a confirmation grant, #27, can clear it) but never
  // retryable — the deterministic risk floor is sticky, so retrying the
  // exact same action can never get past it on its own.
  CONFIRMATION_REQUIRED: { recoverable: true, retryable: false },
  // #27: recoverable (the host can obtain and pass a fresh, valid grant) but
  // never retryable — replaying the exact same rejected grant can't succeed.
  CONFIRMATION_GRANT_INVALID: { recoverable: true, retryable: false },
  UNKNOWN: { recoverable: false, retryable: false }
};

export class SculptError extends Error implements SculptErrorShape {
  readonly code: SculptErrorCode;
  readonly layer: SculptLayer;
  readonly target?: TargetSummary;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SculptErrorCode,
    message: string,
    options: {
      layer?: SculptLayer;
      target?: TargetSummary;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SculptError";
    this.code = code;
    this.layer = options.layer ?? "foundation";
    this.target = options.target;
    this.details = options.details;
    const traits = CODE_TRAITS[code];
    this.recoverable = traits.recoverable;
    this.retryable = traits.retryable;
  }

  toShape(): SculptErrorShape {
    return {
      code: this.code,
      message: this.message,
      layer: this.layer,
      target: this.target,
      recoverable: this.recoverable,
      retryable: this.retryable,
      details: this.details
    };
  }
}

export function isSculptError(value: unknown): value is SculptError {
  return value instanceof SculptError;
}

const KNOWN_CODES = new Set<string>(Object.keys(CODE_TRAITS));

/** Wire error shape produced by the in-page kernel's call envelope. */
export interface KernelWireError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function fromKernelError(wire: KernelWireError, layer: SculptLayer = "foundation"): SculptError {
  const code = (KNOWN_CODES.has(wire.code) ? wire.code : "UNKNOWN") as SculptErrorCode;
  return new SculptError(code, wire.message, { layer, details: wire.details });
}

export function toSculptError(value: unknown, layer: SculptLayer = "foundation"): SculptError {
  if (isSculptError(value)) return value;
  if (value instanceof Error) {
    return new SculptError("UNKNOWN", value.message, { layer, cause: value });
  }
  return new SculptError("UNKNOWN", String(value), { layer });
}
