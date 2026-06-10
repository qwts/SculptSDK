/** What the attached runtime can inspect, mutate, execute, and observe (§7.2). */
export interface BrowserCapabilities {
  dom: {
    read: boolean;
    write: boolean;
    shadowDom: boolean;
    iframeTraversal: boolean;
    eventListeners: boolean;
  };
  accessibility: {
    read: boolean;
    roles: boolean;
    names: boolean;
    states: boolean;
  };
  layout: {
    boxModel: boolean;
    hitTest: boolean;
    occlusion: boolean;
    scroll: boolean;
  };
  input: {
    syntheticEvents: boolean;
    nativeMouse: boolean;
    nativeKeyboard: boolean;
    dragDrop: boolean;
    fileUpload: boolean;
  };
  runtime: {
    evaluate: boolean;
    mainWorld: boolean;
    isolatedWorld: boolean;
    sourceMaps: boolean;
  };
  network: {
    observe: boolean;
    inspectBodies: boolean;
    intercept: boolean;
  };
  storage: {
    localStorage: boolean;
    sessionStorage: boolean;
    indexedDb: boolean;
    cookies: boolean;
  };
  framework: {
    react: boolean;
    angular: boolean;
    vue: boolean;
    svelte: boolean;
    webComponents: boolean;
  };
}

/** Operator-selected authority settings (§7.3). */
export interface SculptControlSettings {
  runtimeExecution: "disabled" | "enabled";
  mainWorldInjection: "disabled" | "enabled";
  frameworkInspection: "disabled" | "enabled";
  networkObservation: "disabled" | "enabled";
  storageInspection: "disabled" | "operator-controlled" | "enabled";
  sourceMapConsumption: "disabled" | "enabled";
  actionLogging: "disabled" | "metadata" | "full";
  rawJavaScript: "disabled" | "escape-hatch" | "enabled";
}

export type ExecutionWorld =
  | "main-world"
  | "isolated-world"
  | "automation-world"
  | "extension-content-script"
  | "native-protocol";
