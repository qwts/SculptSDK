export interface Point {
  x: number;
  y: number;
}

export interface BoxModel {
  x: number;
  y: number;
  width: number;
  height: number;
  center: Point;
}

/** Layered visibility verdict with reasons (§11.3). */
export interface VisibilityState {
  exists: boolean;
  attached: boolean;
  rendered: boolean;
  displayed: boolean;
  inViewport: boolean;
  clipped: boolean;
  occluded: boolean;
  opacity: number;
  pointerEvents: string;
  /** 0..1 — lowered when the environment cannot provide real layout data. */
  confidence: number;
  reasons: string[];
}

export interface OcclusionReport {
  occluded: boolean;
  occludedBy?: string;
  confidence: number;
}
