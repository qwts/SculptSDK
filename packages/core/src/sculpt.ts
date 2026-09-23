import type {
  AgentAction,
  AgentActionResponse,
  BrowserCapabilities,
  EvaluationOptions,
  FrameworkSummary,
  PageSnapshot,
  RouteState,
  RuntimeAdapter,
  SculptControlSettings,
  SerializableFunction,
  SnapshotOptions,
  StabilityOptions,
  StableStateReport
} from "./types/index.js";
import { applySettings, assertCapability, resolveSettings } from "./capability/index.js";
import { SculptError } from "./errors.js";
import { createFoundation, KernelClient, type FoundationLayer } from "./foundation/index.js";
import { ConsumedGrantRegistry, DEFAULT_ORCHESTRATION, UIRoot, type ActionEnv, type OrchestrationDefaults } from "./uikit/index.js";
import { AgentOrchestrator } from "./orchestration/executor.js";
import { ModelContext } from "./orchestration/model-context.js";
import { KERNEL_SOURCE } from "./generated/kernel-source.js";
import { SemanticRuntime, type SemanticAttachOptions } from "./semantic/runtime.js";

export interface SculptAttachOptions {
  adapter: RuntimeAdapter;
  authority?: Partial<SculptControlSettings>;
  orchestration?: Partial<OrchestrationDefaults>;
  /** @experimental Semantic Resolution Layer (m0 foundations). No effect
   * unless `authority.semanticResolution` is `"enabled"` — see #14. */
  semantic?: SemanticAttachOptions;
}

/**
 * SculptSDK entry point. Attach to a runtime adapter, get a layered semantic
 * control surface: `ui` (UIKit), `model`/`agent` (orchestration), and the
 * foundation systems for lower-level work.
 */
export class Sculpt {
  readonly ui: UIRoot;
  readonly model: ModelContext;
  private readonly orchestrator: AgentOrchestrator;
  private readonly semantic: SemanticRuntime;
  private readonly consumedGrants: ConsumedGrantRegistry;

  private constructor(
    private readonly adapter: RuntimeAdapter,
    private readonly settingsValue: SculptControlSettings,
    private readonly capabilitiesValue: BrowserCapabilities,
    private readonly kernel: KernelClient,
    readonly foundation: FoundationLayer,
    env: ActionEnv
  ) {
    this.ui = new UIRoot(env);
    this.orchestrator = new AgentOrchestrator(env, this.ui, adapter);
    this.model = new ModelContext(env, this.orchestrator);
    this.semantic = env.semantic;
    this.consumedGrants = env.consumedGrants;
  }

  static async attach(options: SculptAttachOptions): Promise<Sculpt> {
    const settings = resolveSettings(options.authority);
    if (settings.runtimeExecution === "disabled") {
      throw new SculptError(
        "CAPABILITY_UNAVAILABLE",
        "semantic control requires in-page runtime execution; authority.runtimeExecution is disabled",
        { layer: "runtime", details: { setting: "runtimeExecution" } }
      );
    }

    const adapter = options.adapter;
    const reported = await adapter.capabilities();
    const capabilities = applySettings(reported, settings);

    const kernel = new KernelClient(adapter, KERNEL_SOURCE);
    await kernel.ensure();
    await kernel.call("configure", { networkObservation: settings.networkObservation === "enabled" });
    await kernel.call("ping");

    const foundation = createFoundation({ kernel, adapter, capabilities, settings });
    const orchestration: OrchestrationDefaults = { ...DEFAULT_ORCHESTRATION, ...options.orchestration };
    // Disabled parity (ADR-0004): SemanticRuntime itself swaps a passed
    // provider for NullProvider and never touches it when disabled — this
    // constructor call does no I/O and calls no method on options.semantic.provider.
    const semantic = new SemanticRuntime({
      settings,
      provider: options.semantic?.provider,
      points: options.semantic?.points,
      budget: options.semantic?.budget,
      sourceOriginAllowlist: options.semantic?.sourceOriginAllowlist,
      providerEndpointAllowlist: options.semantic?.providerEndpointAllowlist,
      redactionRules: options.semantic?.redactionRules,
      calibration: options.semantic?.calibration,
      dp7RiskDegradation: options.semantic?.dp7RiskDegradation
    });
    const consumedGrants = new ConsumedGrantRegistry();
    const env: ActionEnv = { kernel, foundation, capabilities, orchestration, semantic, consumedGrants };
    return new Sculpt(adapter, settings, capabilities, kernel, foundation, env);
  }

  /** Capability and control plane (§7). */
  readonly capabilities = {
    inspect: async (): Promise<BrowserCapabilities> => this.capabilitiesValue,
    settings: (): SculptControlSettings => ({ ...this.settingsValue })
  };

  /** Agent orchestration (§23). */
  readonly agent = {
    execute: (action: AgentAction): Promise<AgentActionResponse> => this.orchestrator.execute(action)
  };

  /** Page-level operations. */
  readonly page = {
    url: async (): Promise<string> => (await this.kernel.call<RouteState>("routeState")).url,
    snapshot: (options?: SnapshotOptions): Promise<PageSnapshot> => this.foundation.snapshots.page(options),
    waitForStableState: (options?: StabilityOptions): Promise<StableStateReport> =>
      this.foundation.observers.waitForStableState(options),
    navigate: async (url: string): Promise<void> => {
      await this.adapter.call({ name: "page.navigate", url });
      await this.foundation.observers.waitForStableState({});
    }
  };

  /** Application-level inspection. */
  readonly app = {
    frameworks: async (): Promise<FrameworkSummary[]> => {
      if (this.settingsValue.frameworkInspection === "disabled") {
        throw new SculptError("CAPABILITY_UNAVAILABLE", 'operator setting "frameworkInspection" is disabled', {
          layer: "runtime",
          details: { setting: "frameworkInspection" }
        });
      }
      const { frameworks } = await this.kernel.call<{ frameworks: FrameworkSummary[] }>("frameworks");
      return frameworks;
    }
  };

  /**
   * Raw JavaScript escape hatch (§3.2.8): explicitly gated by operator
   * authority and never the default interface.
   */
  readonly runtime = {
    evaluate: async <T>(fn: SerializableFunction, args?: unknown[], options?: EvaluationOptions): Promise<T> => {
      if (this.settingsValue.rawJavaScript === "disabled") {
        throw new SculptError("CAPABILITY_UNAVAILABLE", "raw JavaScript execution is disabled by operator authority", {
          layer: "runtime",
          details: { setting: "rawJavaScript" }
        });
      }
      assertCapability(this.capabilitiesValue, "runtime.evaluate", "runtime");
      return this.adapter.evaluate<T>(fn, args, options);
    }
  };

  async dispose(): Promise<void> {
    this.semantic.dispose();
    this.consumedGrants.clear();
    await this.adapter.dispose();
  }
}
