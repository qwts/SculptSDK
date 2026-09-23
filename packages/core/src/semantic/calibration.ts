import type { DecisionPoint } from "./provider.js";

/**
 * @experimental Calibration (§21, consumption side only — #21 itself, which
 * builds real artifacts from a labeled corpus, is not part of m1). A
 * decision point may only accept a semantic answer once a calibrated
 * threshold exists for its exact model, policy/question version and mode;
 * until then it runs in shadow mode — the decision is still recorded, but
 * nothing is ever accepted (#2: "the runtime treats a model with no
 * thresholds file as disabled").
 */
export interface CalibrationThreshold {
  point: DecisionPoint;
  model: string;
  policyVersion: string;
  questionVersion: string;
  /** A point can carry more than one threshold for its own modes — e.g.
   * DP-1's "tie" vs "miss" trigger different acceptance bars. */
  mode: string;
  minConfidence: number;
}

export type CalibrationQuery = Omit<CalibrationThreshold, "minConfidence">;

export interface CalibrationRegistry {
  /** Returns the threshold for an exact match, or `undefined` if none is
   * calibrated — the caller's only correct response to `undefined` is
   * shadow mode, never a default confidence bar. */
  lookup(query: CalibrationQuery): CalibrationThreshold | undefined;
}

function key(q: CalibrationQuery): string {
  return [q.point, q.model, q.policyVersion, q.questionVersion, q.mode].join("::");
}

/** A registry backed by a fixed, in-memory list — what a `thresholds/<model>.json`
 * artifact (#21) would be loaded into. Exact match only: no fallback across
 * versions, matching #2's "thresholds never carry across versions". */
export class StaticCalibrationRegistry implements CalibrationRegistry {
  private readonly byKey: ReadonlyMap<string, CalibrationThreshold>;

  constructor(thresholds: readonly CalibrationThreshold[] = []) {
    this.byKey = new Map(thresholds.map((t) => [key(t), t]));
  }

  lookup(query: CalibrationQuery): CalibrationThreshold | undefined {
    return this.byKey.get(key(query));
  }
}

/** The default for every `SemanticRuntime`: no calibration artifacts, so
 * every decision point runs in shadow mode until an operator supplies one. */
export const EMPTY_CALIBRATION_REGISTRY: CalibrationRegistry = new StaticCalibrationRegistry([]);
