import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import {
  Sculpt,
  SculptError,
  type ActionResult,
  type AgentActionResponse,
  type DecisionProvider,
  type DecisionRequest,
  type FormFillResult,
  type RawDecisionResponse,
  type UIForm
} from "@sculptsdk/core";

/**
 * Disabled-parity suite (#14's acceptance criteria): the same representative
 * flows, run three ways — authority absent, semanticResolution explicitly
 * "disabled", and "disabled" with a provider passed anyway — must produce
 * identical results, error codes/details, dispatched input, and page deltas.
 * A spy provider must record zero calls in every configuration.
 */

const FIXTURE_HTML = `<!doctype html><html><body>
  <button id="page-save">Save</button>
  <div role="dialog" aria-label="Confirm">
    <button id="dialog-save">Save</button>
  </div>
  <button id="delete-btn">Delete</button>
  <button id="archive-btn">Archive</button>
  <form id="signup">
    <label>Name <input name="name" type="text" /></label>
    <label>Email <input name="email" type="email" /></label>
    <button type="submit">Submit</button>
  </form>
  <div id="status"></div>
</body></html>`;

class SpyProvider implements DecisionProvider {
  readonly id = "spy";
  calls = 0;

  supports(): boolean {
    this.calls++;
    return true;
  }

  async decide(_request: DecisionRequest): Promise<RawDecisionResponse> {
    this.calls++;
    return { answers: [] };
  }
}

function buildAdapter(): TestHarnessAdapter {
  const adapter = new TestHarnessAdapter({ html: FIXTURE_HTML });
  const status = adapter.document.getElementById("status")!;
  adapter.document.getElementById("delete-btn")!.addEventListener("click", () => {
    status.textContent += "deleted;";
  });
  adapter.document.getElementById("archive-btn")!.addEventListener("click", () => {
    status.textContent += "archived;";
  });
  adapter.document.getElementById("signup")!.addEventListener("submit", (event: Event) => {
    event.preventDefault();
    status.textContent += "submitted;";
  });
  return adapter;
}

function projectActionResult(result: ActionResult) {
  return {
    ok: result.ok,
    action: result.action,
    errorCode: result.error?.code,
    inputMode: result.inputMode,
    preconditions: result.preconditions.map((c) => ({ name: c.name, ok: c.ok })),
    postconditions: result.postconditions.map((c) => ({ name: c.name, ok: c.ok })),
    recoverySteps: result.recoverySteps.map((s) => ({ step: s.step, ok: s.ok })),
    value: result.value
  };
}

function projectFillResult(result: FormFillResult) {
  return {
    ok: result.ok,
    filled: result.filled.map((f) => ({ label: f.label, value: f.value, verified: f.verified })),
    unmapped: result.unmapped,
    ambiguous: result.ambiguous,
    validationErrors: result.validationErrors
  };
}

function projectAgentResponse(response: AgentActionResponse) {
  return {
    ok: response.ok,
    actionType: response.action.type,
    result: projectActionResult(response.result),
    pageDelta: response.pageDelta,
    errorCodes: response.errors.map((e) => e.code)
  };
}

async function runFlows(sculpt: Sculpt, adapter: TestHarnessAdapter) {
  const findHitElement = await sculpt.ui.tryFind({ kind: "button", name: "Delete" });
  const findHit = findHitElement && {
    kind: findHitElement.kind,
    name: findHitElement.name,
    visible: findHitElement.visible,
    enabled: findHitElement.enabled,
    confidence: findHitElement.confidence
  };

  const findMissElement = await sculpt.ui.tryFind({ kind: "button", name: "Does Not Exist At All" });

  let findAmbiguous: { code: string; recoverable: boolean; retryable: boolean; candidateCount: number } | null = null;
  try {
    await sculpt.ui.find({ kind: "button", name: "Save" });
  } catch (error) {
    const e = error as SculptError;
    findAmbiguous = {
      code: e.code,
      recoverable: e.recoverable,
      retryable: e.retryable,
      candidateCount: ((e.details?.candidates as unknown[] | undefined) ?? []).length
    };
  }

  const deleteButton = await sculpt.ui.find({ kind: "button", name: "Delete" });
  const click = projectActionResult(await deleteButton.click());

  const form = (await sculpt.ui.find({ kind: "form" })) as UIForm;
  const fill = projectFillResult(
    await form.fill({ Name: "Ada Lovelace", Email: "ada@example.com" }, { submit: true })
  );

  const agentResponse = await sculpt.agent.execute({ type: "click", target: { kind: "button", name: "Archive" } });
  const agentExecute = projectAgentResponse(agentResponse);

  return {
    findHit,
    findMissWasNull: findMissElement === null,
    findAmbiguous,
    click,
    fill,
    agentExecute,
    statusText: adapter.document.getElementById("status")!.textContent,
    settings: sculpt.capabilities.settings()
  };
}

describe("disabled parity: authority absent vs. explicitly disabled vs. disabled with a provider passed", () => {
  it("produces identical results, errors, input dispatch, and page deltas across all three configurations", async () => {
    const spy = new SpyProvider();

    const adapterA = buildAdapter();
    const sculptA = await Sculpt.attach({ adapter: adapterA });

    const adapterB = buildAdapter();
    const sculptB = await Sculpt.attach({ adapter: adapterB, authority: { semanticResolution: "disabled" } });

    const adapterC = buildAdapter();
    const sculptC = await Sculpt.attach({
      adapter: adapterC,
      authority: { semanticResolution: "disabled" },
      semantic: { provider: spy }
    });

    try {
      const resultA = await runFlows(sculptA, adapterA);
      const resultB = await runFlows(sculptB, adapterB);
      const resultC = await runFlows(sculptC, adapterC);

      expect(resultB).toEqual(resultA);
      expect(resultC).toEqual(resultA);

      // Sanity: the flows actually exercised the interesting paths, so this
      // comparison isn't vacuously trivial.
      expect(resultA.findHit).toMatchObject({ kind: "button", name: "Delete" });
      expect(resultA.findMissWasNull).toBe(true);
      expect(resultA.findAmbiguous).toMatchObject({ code: "TARGET_AMBIGUOUS" });
      expect(resultA.click.ok).toBe(true);
      expect(resultA.fill.ok).toBe(true);
      expect(resultA.agentExecute.ok).toBe(true);
      expect(resultA.statusText).toBe("deleted;submitted;archived;");
    } finally {
      await sculptA.dispose();
      await sculptB.dispose();
      await sculptC.dispose();
    }

    expect(spy.calls).toBe(0);
  });

  it("makes zero requests to a configured provider endpoint when disabled", async () => {
    // "Endpoint" here is the provider object itself — the only surface this
    // process could dispatch a network call through. Zero method calls on
    // it is exactly zero requests to whatever endpoint it wraps.
    const spy = new SpyProvider();
    const adapter = buildAdapter();
    const sculpt = await Sculpt.attach({
      adapter,
      authority: { semanticResolution: "disabled" },
      semantic: { provider: spy }
    });
    try {
      await sculpt.ui.find({ kind: "button", name: "Delete" }).then((el) => el.click());
    } finally {
      await sculpt.dispose();
    }
    expect(spy.calls).toBe(0);
  });
});
