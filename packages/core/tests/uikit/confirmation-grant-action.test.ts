import { describe, expect, it } from "vitest";
import { TestHarnessAdapter } from "@sculptsdk/adapter-testing";
import {
  CLICK_MATERIAL_DIGEST,
  computeFormValuesDigest,
  RISK_FLOOR_POLICY_VERSION,
  Sculpt,
  type ConfirmationGrant
} from "@sculptsdk/core";

/**
 * DP-7 single-use confirmation grants wired into the real `runAction` path
 * (#27): a valid grant clears a #26 risk-floor hit exactly once, and only
 * the risk gate — every other one of the acceptance criteria's invalid
 * cases still surfaces a typed error, and a valid grant never gets past a
 * failed precondition.
 */

const ORIGIN = "http://fixtures.local";
const DELETE_BUTTON_HTML = `<!doctype html><html><body>
  <div id="container"><button id="delete-btn" type="button">Delete account</button></div>
  <button id="hidden-delete" type="button" style="display:none">Delete draft</button>
</body></html>`;

async function attach(html: string): Promise<{ sculpt: Sculpt; adapter: TestHarnessAdapter }> {
  const adapter = new TestHarnessAdapter({ html, url: `${ORIGIN}/` });
  const sculpt = await Sculpt.attach({ adapter, authority: { semanticResolution: "enabled" } });
  return { sculpt, adapter };
}

async function grantFor(sculpt: Sculpt, targetDigest: string, overrides: Partial<ConfirmationGrant> = {}): Promise<ConfirmationGrant> {
  const evidence = await sculpt.foundation.observers.evidence();
  const route = await sculpt.foundation.observers.routeState();
  return {
    grantId: `grant-${Math.random()}`,
    actionType: "click",
    targetDigest,
    documentId: evidence.documentId,
    navigationEpoch: evidence.navigationEpoch,
    origin: new URL(route.url).origin,
    materialDigest: CLICK_MATERIAL_DIGEST,
    policyVersion: RISK_FLOOR_POLICY_VERSION,
    riskDecision: "delete",
    expiresAt: Date.now() + 60_000,
    ...overrides
  };
}

describe("confirmation grants: a valid grant clears the floor exactly once", () => {
  it("clears a click, and the underlying element actually dispatches", async () => {
    let clicked = false;
    const { sculpt, adapter } = await attach(DELETE_BUTTON_HTML);
    adapter.document.getElementById("delete-btn")?.addEventListener("click", () => {
      clicked = true;
    });
    try {
      const button = await sculpt.ui.button({ name: "Delete account" });
      const grant = await grantFor(sculpt, button.identity.id);

      const result = await button.click({ confirmation: grant });
      expect(result.ok).toBe(true);
      expect(clicked).toBe(true);
    } finally {
      await sculpt.dispose();
    }
  });

  it("a second click reusing the same grant is rejected as CONFIRMATION_GRANT_INVALID", async () => {
    const { sculpt } = await attach(DELETE_BUTTON_HTML);
    try {
      const button = await sculpt.ui.button({ name: "Delete account" });
      const grant = await grantFor(sculpt, button.identity.id);

      const first = await button.click({ confirmation: grant });
      expect(first.ok).toBe(true);

      const second = await button.click({ confirmation: grant });
      expect(second.ok).toBe(false);
      expect(second.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(second.error?.details?.reason).toBe("reused");
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("confirmation grants: each invalid case still surfaces a typed error", () => {
  it("a target that rerendered between grant issuance and use", async () => {
    const { sculpt, adapter } = await attach(DELETE_BUTTON_HTML);
    try {
      const button = await sculpt.ui.button({ name: "Delete account" });
      const grant = await grantFor(sculpt, button.identity.id);

      // Rerender: a genuinely different element, same accessible name. Reuse
      // the original (now-stale) `button` handle, not a fresh query — a
      // fresh query would happily resolve the replacement directly and
      // never exercise the ref-based staleness this grant binding relies
      // on (see #22: identity alone is deliberately designed to tolerate a
      // "similar enough" rebind, which is the wrong notion of sameness for
      // a grant reviewed against one exact element).
      adapter.document.getElementById("container")!.innerHTML = '<button id="delete-btn-2" type="button">Delete account</button>';

      const result = await button.click({ confirmation: grant, recovery: { retryLimit: 0 } });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(result.error?.details?.reason).toBe("target-stale");
    } finally {
      await sculpt.dispose();
    }
  });

  it("an expired grant", async () => {
    const { sculpt } = await attach(DELETE_BUTTON_HTML);
    try {
      const button = await sculpt.ui.button({ name: "Delete account" });
      const grant = await grantFor(sculpt, button.identity.id, { expiresAt: Date.now() - 1000 });

      const result = await button.click({ confirmation: grant });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(result.error?.details?.reason).toBe("expired");
    } finally {
      await sculpt.dispose();
    }
  });

  it("a grant from another document", async () => {
    const { sculpt } = await attach(DELETE_BUTTON_HTML);
    try {
      const button = await sculpt.ui.button({ name: "Delete account" });
      const grant = await grantFor(sculpt, button.identity.id, { documentId: "some-other-document" });

      const result = await button.click({ confirmation: grant });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(result.error?.details?.reason).toBe("wrong-document");
    } finally {
      await sculpt.dispose();
    }
  });

  it("a different form-values digest on a fill-and-submit", async () => {
    const RISKY_FORM_HTML = `<!doctype html><html><body>
      <form id="risky-form" aria-label="Danger zone" action="/api/delete-account">
        <input name="confirmation-text" />
        <button id="confirm-btn" type="submit">Confirm</button>
      </form>
    </body></html>`;
    const { sculpt } = await attach(RISKY_FORM_HTML);
    try {
      const form = await sculpt.ui.form({ name: "Danger zone" });
      const evidence = await sculpt.foundation.observers.evidence();
      const route = await sculpt.foundation.observers.routeState();
      const grant: ConfirmationGrant = {
        grantId: "grant-form",
        actionType: "submit",
        targetDigest: form.identity.id,
        documentId: evidence.documentId,
        navigationEpoch: evidence.navigationEpoch,
        origin: new URL(route.url).origin,
        // Bound to a form-values digest that will never match what's
        // actually filled in, simulating the material state having
        // changed since the human reviewed it.
        materialDigest: "stale-digest-from-a-different-review",
        policyVersion: RISK_FLOOR_POLICY_VERSION,
        riskDecision: "delete",
        expiresAt: Date.now() + 60_000
      };

      const result = await sculpt.ui.form({ name: "Danger zone" }).submit({ confirmation: grant });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(result.error?.details?.reason).toBe("material-mismatch");
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("confirmation grants: satisfy only the risk gate, never a precondition", () => {
  it("a valid grant does not get past a failed precondition (the target is hidden)", async () => {
    const { sculpt } = await attach(DELETE_BUTTON_HTML);
    try {
      const button = await sculpt.ui.button({ name: "Delete draft" });
      const grant = await grantFor(sculpt, button.identity.id, { riskDecision: "delete" });

      const result = await button.click({ confirmation: grant, recovery: { retryLimit: 0 } });
      expect(result.ok).toBe(false);
      // Not CONFIRMATION_REQUIRED/CONFIRMATION_GRANT_INVALID — the grant
      // cleared the floor; the ordinary visibility precondition still runs
      // and still fails on its own terms.
      expect(result.error?.code).toBe("TARGET_NOT_VISIBLE");
    } finally {
      await sculpt.dispose();
    }
  });
});

describe("confirmation grants: review-flagged hardening", () => {
  it("a password value changed since the grant was issued is caught, not masked by a fixed placeholder", async () => {
    const RISKY_FORM_HTML = `<!doctype html><html><body>
      <form id="risky-form" aria-label="Danger zone" action="/api/delete-account">
        <input type="password" name="confirm-password" />
        <button id="confirm-btn" type="submit">Confirm</button>
      </form>
    </body></html>`;
    const { sculpt, adapter } = await attach(RISKY_FORM_HTML);
    try {
      const password = adapter.document.querySelector('input[type="password"]') as HTMLInputElement;
      password.value = "first-password";

      const form = await sculpt.ui.form({ name: "Danger zone" });
      const fieldsBefore = await form.fields();
      const materialDigest = computeFormValuesDigest(Object.values(fieldsBefore));
      const evidence = await sculpt.foundation.observers.evidence();
      const route = await sculpt.foundation.observers.routeState();
      const grant: ConfirmationGrant = {
        grantId: "grant-password",
        actionType: "submit",
        targetDigest: form.identity.id,
        documentId: evidence.documentId,
        navigationEpoch: evidence.navigationEpoch,
        origin: new URL(route.url).origin,
        materialDigest,
        policyVersion: RISK_FLOOR_POLICY_VERSION,
        riskDecision: "delete",
        expiresAt: Date.now() + 60_000
      };

      // A non-empty password used to always summarize to the same fixed
      // "•••" placeholder — this change would have been invisible to the
      // material digest, letting a grant reviewed against one password
      // silently clear a submit with a different one.
      password.value = "a-completely-different-password";

      const result = await sculpt.ui.form({ name: "Danger zone" }).submit({ confirmation: grant });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(result.error?.details?.reason).toBe("material-mismatch");
    } finally {
      await sculpt.dispose();
    }
  });

  it("form values changed after the grant clears but before dispatch are caught at dispatch time", async () => {
    const RISKY_FORM_HTML = `<!doctype html><html><body>
      <form id="risky-form" aria-label="Danger zone" action="/api/delete-account">
        <input name="amount" value="100" />
        <button id="confirm-btn" type="submit">Confirm</button>
      </form>
    </body></html>`;
    const { sculpt, adapter } = await attach(RISKY_FORM_HTML);
    let dispatched = false;
    let formFieldsCalls = 0;
    const originalCall = adapter.call.bind(adapter);
    // "formFields" is read twice per attempt when a submit grant is used:
    // once inside the risk gate (to bind the grant's materialDigest), once
    // again right before dispatch (the #5 revalidation this test targets).
    // Mutating on the 2nd call simulates the value changing in the gap
    // between the grant clearing verification and the actual dispatch.
    adapter.call = (async (operation: Parameters<typeof originalCall>[0]) => {
      if ("op" in operation && operation.op === "formFields") {
        formFieldsCalls++;
        if (formFieldsCalls === 2) {
          (adapter.document.querySelector('input[name="amount"]') as HTMLInputElement).value = "999999";
        }
      }
      if ("op" in operation && operation.op === "formSubmit") dispatched = true;
      return originalCall(operation);
    }) as typeof adapter.call;

    try {
      const form = await sculpt.ui.form({ name: "Danger zone" });
      const fieldsBefore = await form.fields();
      const materialDigest = computeFormValuesDigest(Object.values(fieldsBefore));
      const evidence = await sculpt.foundation.observers.evidence();
      const route = await sculpt.foundation.observers.routeState();
      const grant: ConfirmationGrant = {
        grantId: "grant-amount",
        actionType: "submit",
        targetDigest: form.identity.id,
        documentId: evidence.documentId,
        navigationEpoch: evidence.navigationEpoch,
        origin: new URL(route.url).origin,
        materialDigest,
        policyVersion: RISK_FLOOR_POLICY_VERSION,
        riskDecision: "delete",
        expiresAt: Date.now() + 60_000
      };

      const result = await sculpt.ui.form({ name: "Danger zone" }).submit({ confirmation: grant, recovery: { retryLimit: 0 } });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFIRMATION_GRANT_INVALID");
      expect(result.error?.details?.reason).toBe("material-mismatch");
      // The mutation happened inside the intercepted formSubmit call, so if
      // dispatch reached the kernel at all the revalidation failed to stop it.
      expect(dispatched).toBe(false);
    } finally {
      await sculpt.dispose();
    }
  });

  it("no rebind is allowed between grant verification and dispatch — a swap right before click fails closed", async () => {
    const { sculpt, adapter } = await attach(DELETE_BUTTON_HTML);
    let clickedReplacement = false;
    const originalCall = adapter.call.bind(adapter);
    // Simulates a rerender landing in the window between the guard being
    // attached (right after grant verification) and the click actually
    // dispatching — without a guard bound to the verified target, the
    // default resolve path would happily rebind to this "similar enough"
    // replacement and click it instead.
    adapter.call = (async (operation: Parameters<typeof originalCall>[0]) => {
      if ("op" in operation && operation.op === "click") {
        adapter.document.getElementById("container")!.innerHTML =
          '<button id="delete-btn-2" type="button">Delete account</button>';
        adapter.document.getElementById("delete-btn-2")?.addEventListener("click", () => {
          clickedReplacement = true;
        });
      }
      return originalCall(operation);
    }) as typeof adapter.call;

    try {
      const button = await sculpt.ui.button({ name: "Delete account" });
      const grant = await grantFor(sculpt, button.identity.id);

      const result = await button.click({ confirmation: grant, recovery: { retryLimit: 0 } });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TARGET_STALE");
      expect(clickedReplacement).toBe(false);
    } finally {
      await sculpt.dispose();
    }
  });
});
