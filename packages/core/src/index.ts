export * from "./types/index.js";
export * from "./errors.js";
export {
  DEFAULT_SETTINGS,
  resolveSettings,
  applySettings,
  hasCapability,
  assertCapability,
  assertSetting
} from "./capability/index.js";
export {
  KernelClient,
  createFoundation,
  DomGraph,
  AccessibilityGraph,
  LayoutEngine,
  InputEngine,
  ObserverSystem,
  IdentitySystem,
  SnapshotSystem
} from "./foundation/index.js";
export type { FoundationLayer, FoundationEnv, KernelTarget, Resolution } from "./foundation/index.js";
export {
  UIRoot,
  UIElement,
  UIButton,
  UILink,
  UIInput,
  UISelect,
  UIForm,
  UIDialog,
  UITable,
  runAction,
  syntheticResult,
  DEFAULT_ORCHESTRATION
} from "./uikit/index.js";
export type { ActionEnv, OrchestrationDefaults, ActionSpec, UIExplanation, LazyHandle } from "./uikit/index.js";
export { AgentOrchestrator } from "./orchestration/executor.js";
export { ModelContext, toModelSummary } from "./orchestration/model-context.js";
export { Sculpt } from "./sculpt.js";
export type { SculptAttachOptions } from "./sculpt.js";
export { KERNEL_SOURCE } from "./generated/kernel-source.js";
