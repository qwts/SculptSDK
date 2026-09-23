import type { BrowserCapabilities, SculptControlSettings } from "../types/index.js";
import { SculptError, type SculptLayer } from "../errors.js";

/**
 * Capability and Control Plane (§7): the operator grants authority, the
 * adapter reports powers, and the SDK never pretends an unsupported operation
 * is available.
 */

export const DEFAULT_SETTINGS: SculptControlSettings = {
  runtimeExecution: "enabled",
  mainWorldInjection: "enabled",
  frameworkInspection: "enabled",
  networkObservation: "enabled",
  storageInspection: "operator-controlled",
  sourceMapConsumption: "disabled",
  actionLogging: "metadata",
  rawJavaScript: "escape-hatch",
  semanticResolution: "disabled"
};

export function resolveSettings(authority?: Partial<SculptControlSettings>): SculptControlSettings {
  return { ...DEFAULT_SETTINGS, ...authority };
}

/** Authority settings constrain reported capabilities — never widen them. */
export function applySettings(
  capabilities: BrowserCapabilities,
  settings: SculptControlSettings
): BrowserCapabilities {
  const caps: BrowserCapabilities = structuredClone(capabilities);
  if (settings.runtimeExecution === "disabled") {
    caps.runtime.evaluate = false;
    caps.runtime.mainWorld = false;
    caps.runtime.isolatedWorld = false;
  }
  if (settings.mainWorldInjection === "disabled") {
    caps.runtime.mainWorld = false;
  }
  if (settings.frameworkInspection === "disabled") {
    caps.framework = { react: false, angular: false, vue: false, svelte: false, webComponents: false };
  }
  if (settings.networkObservation === "disabled") {
    caps.network = { observe: false, inspectBodies: false, intercept: false };
  }
  if (settings.storageInspection === "disabled") {
    caps.storage = { localStorage: false, sessionStorage: false, indexedDb: false, cookies: false };
  }
  if (settings.sourceMapConsumption === "disabled") {
    caps.runtime.sourceMaps = false;
  }
  return caps;
}

type CapabilityPath =
  `${keyof BrowserCapabilities}.${string}`;

export function hasCapability(capabilities: BrowserCapabilities, path: CapabilityPath): boolean {
  const [group, key] = path.split(".") as [keyof BrowserCapabilities, string];
  const section = capabilities[group] as Record<string, boolean> | undefined;
  return section?.[key] === true;
}

export function assertCapability(
  capabilities: BrowserCapabilities,
  path: CapabilityPath,
  layer: SculptLayer = "foundation"
): void {
  if (!hasCapability(capabilities, path)) {
    throw new SculptError("CAPABILITY_UNAVAILABLE", `capability "${path}" is not available in this runtime`, {
      layer,
      details: { capability: path }
    });
  }
}

export function assertSetting(
  settings: SculptControlSettings,
  key: keyof SculptControlSettings,
  layer: SculptLayer = "runtime"
): void {
  if (settings[key] === "disabled") {
    throw new SculptError("CAPABILITY_UNAVAILABLE", `operator setting "${key}" is disabled`, {
      layer,
      details: { setting: key }
    });
  }
}
