import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import { Sculpt, type DecisionProvider } from "@sculptsdk/core";

/**
 * DP-7 deterministic risk floor wired into `runAction` (#26): click, submit,
 * and fill-and-submit each run the floor before dispatch. No provider is
 * involved in the floor itself — these tests attach a permissive stub
 * provider anyway, specifically to show it can't clear a hit.
 */

const ORIGIN = "http://fixtures.local";

const DELETE_BUTTON_HTML = `<!doctype html><html><body>
  <button id="delete-btn" type="button">Delete account</button>
  <button id="save-btn" type="button">Save</button>
</body></html>`;

const RISKY_FORM_HTML = `<!doctype html><html><body>
  <form id="risky-form" aria-label="Danger zone" action="/api/delete-account">
    <button id="confirm-btn" type="submit">Confirm</button>
  </form>
  <form id="safe-form" aria-label="Preferences" action="/api/save-preferences">
    <button id="save-submit-btn" type="submit">Submit</button>
  </form>
</body></html>`;

async function attach(html: string, semantic?: Parameters<typeof Sculpt.attach>[0]["semantic"]): Promise<{ sculpt: Sculpt; adapter: TestHarnessAdapter }> {
  const adapter = new TestHarnessAdapter({ html, url: `${ORIGIN}/` });
  const sculpt = await Sculpt.attach({ adapter, authority: { semanticResolution: "enabled" }, semantic });
  return { sculpt, adapter };
}

/** Always answers favorably for anything asked of it — proves the floor
 * doesn't consult a provider at all, let alone get cleared by one. */
const PERMISSIVE_STUB: DecisionProvider = {
  id: "permissive-stub",
  supports: () => true,
  decide: async (request) => ({
    answers: request.questions.map((q) => ({ kind: "choice" as const, questionId: q.id, selected: "yes", providerConfidence: 1 }))
  })
};

describe("DP-7 risk floor: click", () => {
  it("a destructive-named button escalates to CONFIRMATION_REQUIRED, never dispatched", async () => {
    let clicked = false;
    const { sculpt, adapter } = await attach(DELETE_BUTTON_HTML);
    adapter.document.getElementById("delete-btn")?.addEventListener("click", () => {
      clicked = true;
    });
    try {
      const result = await sculpt.ui.button({ name: "Delete account" }).click();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      expect(result.error?.recoverable).toBe(true);
      expect(result.error?.retryable).toBe(false);
      expect(clicked).toBe(false);
    } finally {
      await sculpt.dispose();
    }
  });

  it("a benign button is unaffected", async () => {
    let clicked = false;
    const { sculpt, adapter } = await attach(DELETE_BUTTON_HTML);
    adapter.document.getElementById("save-btn")?.addEventListener("click", () => {
      clicked = true;
    });
    try {
      const result = await sculpt.ui.button({ name: "Save" }).click();
      expect(result.ok).toBe(true);
      expect(clicked).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });

  it("the retry loop cannot get past the gate", async () => {
    const { sculpt } = await attach(DELETE_BUTTON_HTML);
    try {
      const result = await sculpt.ui.button({ name: "Delete account" }).click({ recovery: { retryLimit: 5 } });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      // Never actually retried — a non-retryable error breaks the loop on
      // the first attempt, whatever retryLimit was requested.
      expect(result.recoverySteps.some((step) => step.step === "retry")).toBe(false);
    } finally {
      await sculpt.dispose();
    }
  });

  it("disabled parity: with semanticResolution off, no floor runs at all", async () => {
    const adapter = new TestHarnessAdapter({ html: DELETE_BUTTON_HTML, url: `${ORIGIN}/` });
    let clicked = false;
    adapter.document.getElementById("delete-btn")?.addEventListener("click", () => {
      clicked = true;
    });
    const sculpt = await Sculpt.attach({ adapter }); // no authority.semanticResolution: default disabled
    try {
      const result = await sculpt.ui.button({ name: "Delete account" }).click();
      expect(result.ok).toBe(true);
      expect(clicked).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });

  it("a permissive stub provider cannot clear the floor", async () => {
    let clicked = false;
    const { sculpt, adapter } = await attach(DELETE_BUTTON_HTML, { provider: PERMISSIVE_STUB });
    adapter.document.getElementById("delete-btn")?.addEventListener("click", () => {
      clicked = true;
    });
    try {
      const result = await sculpt.ui.button({ name: "Delete account" }).click();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
      expect(clicked).toBe(false);
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("DP-7 risk floor: submit and fill-and-submit", () => {
  it("a form whose action is risky escalates even though the submit button's own text is benign", async () => {
    const { sculpt } = await attach(RISKY_FORM_HTML);
    try {
      const result = await sculpt.ui.form({ name: "Danger zone" }).submit();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_REQUIRED");
    } finally {
      await sculpt.dispose();
    }
  });

  it("a form with a benign action submits normally", async () => {
    const { sculpt } = await attach(RISKY_FORM_HTML);
    try {
      const result = await sculpt.ui.form({ name: "Preferences" }).submit();
      expect(result.ok).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });

  it("fill-and-submit on a risky form escalates before the submission dispatches", async () => {
    const { sculpt } = await attach(RISKY_FORM_HTML);
    try {
      const result = await sculpt.ui.form({ name: "Danger zone" }).fill({}, { submit: true });
      expect(result.ok).toBe(false);
      expect(result.submitError?.code).toBe("CONFIRMATION_REQUIRED");
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("DP-7 risk floor: property — no combination of caller options or stub provider answer clears a floor hit", () => {
  // Hand-rolled seeded PRNG (mulberry32), matching the pattern already used
  // in dp1-target.test.ts's property test.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const INPUT_MODES = ["native", "synthetic", "dom-mutation", "framework-aware"] as const;
  const SEEDS = [1, 2, 3, 42, 1337];

  for (const seed of SEEDS) {
    it(`seed ${seed}: 30 random ActionOptions combinations, all still escalate`, async () => {
      const rand = mulberry32(seed);
      for (let trial = 0; trial < 30; trial++) {
        const { sculpt } = await attach(DELETE_BUTTON_HTML, { provider: PERMISSIVE_STUB });
        try {
          const result = await sculpt.ui.button({ name: "Delete account" }).click({
            mode: INPUT_MODES[Math.floor(rand() * INPUT_MODES.length)],
            recovery: {
              rebindOnStale: rand() < 0.5,
              scrollIntoView: rand() < 0.5,
              retryLimit: Math.floor(rand() * 6)
            },
            preconditions: {
              mustExist: rand() < 0.5,
              mustBeVisible: rand() < 0.5,
              mustBeEnabled: rand() < 0.5,
              mustNotBeOccluded: rand() < 0.5
            }
          });
          expect(result.ok, `seed ${seed} trial ${trial}`).toBe(false);
          expect(result.error?.code, `seed ${seed} trial ${trial}`).toBe("CONFIRMATION_REQUIRED");
        } finally {
          await sculpt.dispose();
        }
      }
    });
  }
});
