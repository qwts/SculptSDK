import { normalizeText } from "../types/matchers.js";
import type { FormFillResult, FormValidationError, FilledField } from "../types/actions.js";
import type { FormFieldSummary } from "../types/snapshot.js";
import type { UIKind } from "../types/kinds.js";
import type { KernelContext } from "./context.js";
import { getAccessibleName, visibleText } from "./ax.js";
import { isVisibleQuick } from "./layout.js";
import { setValue } from "./input.js";

/**
 * Form system: makes forms addressable by visible meaning (§19). Field names
 * resolve through the documented ladder so agents can say "Full name" instead
 * of input[name=fn_3].
 */

export interface ResolvedLabel {
  label: string;
  source:
    | "label"
    | "aria-label"
    | "aria-labelledby"
    | "placeholder"
    | "legend"
    | "nearby-text"
    | "table-row"
    | "name-attribute"
    | "id-attribute"
    | "none";
}

function humanize(raw: string): string {
  return normalizeText(
    raw
      .replace(/[[\]_.-]+/g, " ")
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
  );
}

function labelTextExcludingControls(label: Element): string {
  const clone = label.cloneNode(true) as Element;
  for (const control of Array.from(clone.querySelectorAll("input, select, textarea, button"))) {
    control.remove();
  }
  return visibleText(clone);
}

/** Field label resolution order from design doc §19.3. */
export function resolveFieldLabel(el: Element): ResolvedLabel {
  const doc = el.ownerDocument;

  const id = el.getAttribute("id");
  if (id) {
    for (const label of Array.from(doc.querySelectorAll("label[for]"))) {
      if (label.getAttribute("for") === id) {
        const text = labelTextExcludingControls(label);
        if (text) return { label: text, source: "label" };
      }
    }
  }
  const wrapping = el.closest?.("label");
  if (wrapping) {
    const text = labelTextExcludingControls(wrapping);
    if (text) return { label: text, source: "label" };
  }

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return { label: normalizeText(ariaLabel), source: "aria-label" };

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const texts = labelledBy
      .trim()
      .split(/\s+/)
      .map((refId) => doc.getElementById(refId))
      .filter((ref): ref is HTMLElement => ref !== null)
      .map((ref) => visibleText(ref))
      .filter(Boolean);
    if (texts.length) return { label: normalizeText(texts.join(" ")), source: "aria-labelledby" };
  }

  const placeholder = el.getAttribute("placeholder");
  if (placeholder?.trim()) return { label: normalizeText(placeholder), source: "placeholder" };

  const fieldset = el.closest?.("fieldset");
  if (fieldset) {
    const legend = fieldset.querySelector(":scope > legend");
    if (legend) {
      // Only use the legend when the fieldset holds a single control group.
      const controls = fieldset.querySelectorAll("input, select, textarea");
      if (controls.length === 1) {
        const text = visibleText(legend);
        if (text) return { label: text, source: "legend" };
      }
    }
  }

  const row = el.closest?.("tr");
  if (row) {
    const header = row.querySelector("th");
    if (header) {
      const text = visibleText(header);
      if (text) return { label: text, source: "table-row" };
    }
  }

  const nearby = nearbyText(el);
  if (nearby) return { label: nearby, source: "nearby-text" };

  const name = el.getAttribute("name");
  if (name?.trim()) return { label: humanize(name), source: "name-attribute" };
  if (id?.trim()) return { label: humanize(id), source: "id-attribute" };

  return { label: "", source: "none" };
}

function nearbyText(el: Element): string | null {
  const prev = el.previousElementSibling;
  if (prev && !isControl(prev)) {
    const text = visibleText(prev);
    if (text && text.length <= 60) return text;
  }
  const parent = el.parentElement;
  if (parent) {
    const controls = parent.querySelectorAll("input, select, textarea");
    if (controls.length === 1) {
      const clone = parent.cloneNode(true) as Element;
      for (const control of Array.from(clone.querySelectorAll("input, select, textarea, button"))) control.remove();
      const text = visibleText(clone);
      if (text && text.length <= 60) return text;
    }
  }
  return null;
}

function isControl(el: Element): boolean {
  return ["input", "select", "textarea", "button"].includes(el.tagName.toLowerCase());
}

export function fieldKind(el: Element): UIKind {
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return "select";
  if (tag === "textarea") return "textarea";
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "file") return "file-picker";
  if (["date", "datetime-local", "month", "week", "time"].includes(type)) return "date-picker";
  return "input";
}

export function formControls(form: Element): Element[] {
  const native = (form as HTMLFormElement).elements;
  const source = native ? Array.from(native) : Array.from(form.querySelectorAll("input, select, textarea"));
  return source.filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (!["input", "select", "textarea"].includes(tag)) return false;
    if (tag === "input") {
      const type = ((el as HTMLInputElement).getAttribute("type") ?? "text").toLowerCase();
      return !["hidden", "submit", "button", "reset", "image"].includes(type);
    }
    return true;
  });
}

export function summarizeFields(ctx: KernelContext, form: Element): FormFieldSummary[] {
  return formControls(form).map((el) => {
    const input = el as HTMLInputElement;
    return {
      targetId: ctx.refs.acquire(el),
      label: resolveFieldLabel(el).label,
      kind: fieldKind(el),
      required: input.required === true || el.getAttribute("aria-required") === "true",
      value: summarizeValue(el)
    };
  });
}

function summarizeValue(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return String(input.checked);
    if (type === "password") return input.value ? "•••" : "";
    return input.value || undefined;
  }
  if (tag === "select" || tag === "textarea") return (el as HTMLSelectElement).value || undefined;
  return undefined;
}

function normalizeKey(key: string): string {
  return normalizeText(key.replace(/[:*]+\s*$/, "")).toLowerCase();
}

interface IndexedField {
  el: Element;
  label: string;
  normalized: string;
  nameAttr: string;
  idAttr: string;
}

function indexFields(form: Element): IndexedField[] {
  return formControls(form).map((el) => {
    const { label } = resolveFieldLabel(el);
    return {
      el,
      label,
      normalized: normalizeKey(label),
      nameAttr: normalizeKey(el.getAttribute("name") ?? ""),
      idAttr: normalizeKey(el.getAttribute("id") ?? "")
    };
  });
}

function findMatches(fields: IndexedField[], key: string): IndexedField[] {
  const wanted = normalizeKey(key);
  let matches = fields.filter((f) => f.normalized === wanted);
  if (matches.length === 0) {
    matches = fields.filter((f) => (f.nameAttr && f.nameAttr === wanted) || (f.idAttr && f.idAttr === wanted));
  }
  if (matches.length === 0 && wanted.length > 2) {
    matches = fields.filter(
      (f) => f.normalized.length > 0 && (f.normalized.includes(wanted) || wanted.includes(f.normalized))
    );
  }
  return matches;
}

export function fillForm(ctx: KernelContext, form: Element, values: Record<string, unknown>): FormFillResult {
  const fields = indexFields(form);
  const filled: FilledField[] = [];
  const unmapped: string[] = [];
  const ambiguous: { key: string; candidates: string[] }[] = [];
  const filledElements = new Set<Element>();

  for (const [key, value] of Object.entries(values)) {
    let matches = findMatches(fields, key);
    if (matches.length > 1) {
      const interactable = matches.filter((f) => isVisibleQuick(ctx, f.el));
      if (interactable.length >= 1) matches = interactable;
    }
    // Radio groups: several inputs share a label/name; pick by option value.
    if (matches.length > 1 && matches.every((f) => fieldKind(f.el) === "radio")) {
      const byValue = matches.find(
        (f) => (f.el as HTMLInputElement).value.toLowerCase() === String(value).toLowerCase()
      );
      if (byValue) matches = [byValue];
    }
    if (matches.length === 0) {
      unmapped.push(key);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push({ key, candidates: matches.map((m) => m.label || m.nameAttr || m.idAttr) });
      continue;
    }
    const field = matches[0]!;
    const kind = fieldKind(field.el);
    const report = setValue(ctx, field.el, kind === "radio" ? true : value);
    const verified = verifyValue(field.el, value, report.value);
    filled.push({
      label: field.label || key,
      targetId: ctx.refs.acquire(field.el),
      value: report.value ?? "",
      verified
    });
    filledElements.add(field.el);
  }

  const validationErrors = collectValidationErrors(ctx, form);
  const blockingErrors = validationErrors.filter((err) =>
    filled.some((f) => f.label === err.field) || err.source === "alert-region"
  );

  return {
    ok:
      unmapped.length === 0 &&
      ambiguous.length === 0 &&
      filled.every((f) => f.verified) &&
      blockingErrors.length === 0,
    filled,
    unmapped,
    ambiguous,
    validationErrors
  };
}

function verifyValue(el: Element, requested: unknown, readback: string | undefined): boolean {
  const kind = fieldKind(el);
  if (kind === "checkbox") {
    const want = requested === true || requested === "true" || requested === "on" || requested === 1;
    return (el as HTMLInputElement).checked === want;
  }
  if (kind === "radio") return (el as HTMLInputElement).checked;
  if (kind === "select") {
    const select = el as HTMLSelectElement;
    const selectedText = (select.selectedOptions[0]?.textContent ?? "").trim().toLowerCase();
    const want = String(requested).trim().toLowerCase();
    return select.value.toLowerCase() === want || selectedText === want;
  }
  return (readback ?? "") === String(requested ?? "");
}

export function collectValidationErrors(ctx: KernelContext, form: Element): FormValidationError[] {
  const errors: FormValidationError[] = [];
  for (const el of formControls(form)) {
    const input = el as HTMLInputElement;
    const label = resolveFieldLabel(el).label || el.getAttribute("name") || el.tagName.toLowerCase();
    if (input.validity && !input.validity.valid) {
      errors.push({
        field: label,
        message: input.validationMessage || "constraint validation failed",
        source: "constraint-validation"
      });
    } else if (el.getAttribute("aria-invalid") === "true") {
      errors.push({ field: label, message: "field marked aria-invalid", source: "aria-invalid" });
    }
  }
  for (const alert of Array.from(form.querySelectorAll('[role="alert"]'))) {
    if (!isVisibleQuick(ctx, alert)) continue;
    const text = visibleText(alert);
    if (text) errors.push({ message: text, source: "alert-region" });
  }
  return errors;
}

export function submitForm(ctx: KernelContext, form: Element): { method: string } {
  const htmlForm = form as HTMLFormElement;
  if (typeof htmlForm.requestSubmit === "function") {
    htmlForm.requestSubmit();
    return { method: "requestSubmit" };
  }
  const win = form.ownerDocument.defaultView ?? ctx.win;
  const event = new win.Event("submit", { bubbles: true, cancelable: true });
  const proceeded = form.dispatchEvent(event);
  if (proceeded && typeof htmlForm.submit === "function") htmlForm.submit();
  return { method: "dispatch-submit" };
}

export function formName(form: Element): string | undefined {
  return getAccessibleName(form) || form.getAttribute("name") || form.getAttribute("id") || undefined;
}
