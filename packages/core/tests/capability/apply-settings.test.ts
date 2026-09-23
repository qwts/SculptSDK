import { describe, expect, it } from "vitest";
import { applySettings, DEFAULT_SETTINGS } from "@sculptsdk/core";
import type { BrowserCapabilities, SculptControlSettings } from "@sculptsdk/core";

const ALL_TRUE_CAPABILITIES: BrowserCapabilities = {
  dom: { read: true, write: true, shadowDom: true, iframeTraversal: true, eventListeners: true },
  accessibility: { read: true, roles: true, names: true, states: true },
  layout: { boxModel: true, hitTest: true, occlusion: true, scroll: true },
  input: { syntheticEvents: true, nativeMouse: true, nativeKeyboard: true, dragDrop: true, fileUpload: true },
  runtime: { evaluate: true, mainWorld: true, isolatedWorld: true, sourceMaps: true },
  network: { observe: true, inspectBodies: true, intercept: true },
  storage: { localStorage: true, sessionStorage: true, indexedDb: true, cookies: true },
  framework: { react: true, angular: true, vue: true, svelte: true, webComponents: true }
};

function flatten(capabilities: BrowserCapabilities): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [group, section] of Object.entries(capabilities)) {
    for (const [key, value] of Object.entries(section as Record<string, boolean>)) {
      out[`${group}.${key}`] = value;
    }
  }
  return out;
}

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof SculptControlSettings)[];

/** Every value each setting can hold, "enabled"/its most-permissive value excluded is fine since DEFAULT_SETTINGS already covers that case. */
const SETTING_VALUES: Record<keyof SculptControlSettings, string[]> = {
  runtimeExecution: ["disabled", "enabled"],
  mainWorldInjection: ["disabled", "enabled"],
  frameworkInspection: ["disabled", "enabled"],
  networkObservation: ["disabled", "enabled"],
  storageInspection: ["disabled", "operator-controlled", "enabled"],
  sourceMapConsumption: ["disabled", "enabled"],
  actionLogging: ["disabled", "metadata", "full"],
  rawJavaScript: ["disabled", "escape-hatch", "enabled"],
  semanticResolution: ["disabled", "enabled"]
};

describe("applySettings", () => {
  it("never turns a false (unreported) capability into true", () => {
    const allFalse: BrowserCapabilities = JSON.parse(
      JSON.stringify(ALL_TRUE_CAPABILITIES).replace(/true/g, "false")
    );
    for (const key of SETTING_KEYS) {
      for (const value of SETTING_VALUES[key]) {
        const settings = { ...DEFAULT_SETTINGS, [key]: value } as SculptControlSettings;
        const result = flatten(applySettings(allFalse, settings));
        for (const flag of Object.values(result)) {
          expect(flag).toBe(false);
        }
      }
    }
  });

  it("only narrows: every resulting flag is <= the reported flag", () => {
    for (const key of SETTING_KEYS) {
      for (const value of SETTING_VALUES[key]) {
        const settings = { ...DEFAULT_SETTINGS, [key]: value } as SculptControlSettings;
        const before = flatten(ALL_TRUE_CAPABILITIES);
        const after = flatten(applySettings(ALL_TRUE_CAPABILITIES, settings));
        for (const path of Object.keys(before)) {
          if (after[path] === true) {
            expect(before[path]).toBe(true);
          }
        }
      }
    }
  });

  it("does not mutate the input capabilities object", () => {
    const original = structuredClone(ALL_TRUE_CAPABILITIES);
    applySettings(ALL_TRUE_CAPABILITIES, { ...DEFAULT_SETTINGS, runtimeExecution: "disabled" });
    expect(ALL_TRUE_CAPABILITIES).toEqual(original);
  });

  it("DEFAULT_SETTINGS narrows only what it disables by default (sourceMapConsumption)", () => {
    const result = applySettings(ALL_TRUE_CAPABILITIES, DEFAULT_SETTINGS);
    expect(result).toEqual({ ...ALL_TRUE_CAPABILITIES, runtime: { ...ALL_TRUE_CAPABILITIES.runtime, sourceMaps: false } });
  });

  it("runtimeExecution: disabled clears every runtime capability", () => {
    const result = applySettings(ALL_TRUE_CAPABILITIES, {
      ...DEFAULT_SETTINGS,
      runtimeExecution: "disabled",
      sourceMapConsumption: "enabled"
    });
    expect(result.runtime).toEqual({ evaluate: false, mainWorld: false, isolatedWorld: false, sourceMaps: true });
  });

  it("frameworkInspection: disabled clears every framework flag", () => {
    const result = applySettings(ALL_TRUE_CAPABILITIES, { ...DEFAULT_SETTINGS, frameworkInspection: "disabled" });
    expect(result.framework).toEqual({ react: false, angular: false, vue: false, svelte: false, webComponents: false });
  });

  it("storageInspection: disabled clears every storage flag, but operator-controlled leaves them reported", () => {
    const disabled = applySettings(ALL_TRUE_CAPABILITIES, { ...DEFAULT_SETTINGS, storageInspection: "disabled" });
    expect(disabled.storage).toEqual({ localStorage: false, sessionStorage: false, indexedDb: false, cookies: false });

    const operatorControlled = applySettings(ALL_TRUE_CAPABILITIES, {
      ...DEFAULT_SETTINGS,
      storageInspection: "operator-controlled"
    });
    expect(operatorControlled.storage).toEqual(ALL_TRUE_CAPABILITIES.storage);
  });
});
