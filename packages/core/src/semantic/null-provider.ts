/**
 * @experimental Default no-op provider (ADR-0004). Used whenever
 * `semanticResolution` is disabled — see #14. Performs no I/O of any kind:
 * no network call, no timer, no file-system access. It never answers.
 */
import { ProviderUnavailableError, type DecisionProvider, type DecisionRequest, type RawDecisionResponse } from "./provider.js";

export class NullProvider implements DecisionProvider {
  readonly id = "null";

  /** Supports nothing — this provider never has real answers to give. */
  supports(): boolean {
    return false;
  }

  async decide(_request: DecisionRequest): Promise<RawDecisionResponse> {
    throw new ProviderUnavailableError(
      "null_provider",
      "NullProvider never answers (semantic resolution is disabled or no provider is configured)"
    );
  }
}
