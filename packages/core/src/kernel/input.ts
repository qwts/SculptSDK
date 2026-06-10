import type { KernelContext } from "./context.js";
import { KernelError } from "./context.js";
import { isDisabled, isFocusable } from "./ax.js";

/**
 * User-like synthetic input. Events follow browser-equivalent sequences and
 * values are written through the native prototype setters, which is what makes
 * controlled inputs in React (and similar frameworks) observe the change as a
 * real user edit instead of a silenced programmatic assignment.
 */

export interface DispatchReport {
  events: string[];
  value?: string;
}

function eventInit(win: Window): MouseEventInit {
  return { bubbles: true, cancelable: true, composed: true, view: win as Window & typeof globalThis };
}

export function syntheticClick(
  ctx: KernelContext,
  el: Element,
  options: { button?: "left" | "middle" | "right"; clickCount?: number } = {}
): DispatchReport {
  if (isDisabled(el)) {
    throw new KernelError("TARGET_DISABLED", "cannot click a disabled element");
  }
  const win = el.ownerDocument.defaultView ?? ctx.win;
  const events: string[] = [];
  const init = { ...eventInit(win), button: options.button === "right" ? 2 : options.button === "middle" ? 1 : 0, detail: options.clickCount ?? 1 };

  if (isFocusable(el)) {
    (el as HTMLElement).focus?.();
    events.push("focus");
  }

  const PointerEventCtor = (win as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent;
  const fire = (type: string, Ctor: typeof MouseEvent): void => {
    el.dispatchEvent(new Ctor(type, init));
    events.push(type);
  };

  if (PointerEventCtor) fire("pointerdown", PointerEventCtor);
  fire("mousedown", win.MouseEvent);
  if (PointerEventCtor) fire("pointerup", PointerEventCtor);
  fire("mouseup", win.MouseEvent);

  // Native click() runs default activation behavior (submit, toggle, navigate).
  if (typeof (el as HTMLElement).click === "function" && (options.clickCount ?? 1) === 1 && init.button === 0) {
    (el as HTMLElement).click();
    events.push("click");
  } else {
    fire("click", win.MouseEvent);
    if ((options.clickCount ?? 1) === 2) fire("dblclick", win.MouseEvent);
  }
  return { events };
}

function setNativeValue(win: Window & typeof globalThis, el: Element, value: string): void {
  const tag = el.tagName.toLowerCase();
  const w = win as unknown as {
    HTMLInputElement?: { prototype: object };
    HTMLTextAreaElement?: { prototype: object };
    HTMLSelectElement?: { prototype: object };
  };
  const proto =
    tag === "textarea" ? w.HTMLTextAreaElement?.prototype : tag === "select" ? w.HTMLSelectElement?.prototype : w.HTMLInputElement?.prototype;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : undefined;
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
}

function fireInputAndChange(win: Window & typeof globalThis, el: Element, data: string | null, events: string[]): void {
  const InputEventCtor = (win as unknown as { InputEvent?: typeof InputEvent }).InputEvent;
  if (InputEventCtor) {
    el.dispatchEvent(
      new InputEventCtor("input", {
        bubbles: true,
        composed: true,
        data,
        inputType: data === null ? "deleteContentBackward" : "insertReplacementText"
      })
    );
  } else {
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  }
  events.push("input");
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
  events.push("change");
}

export function setValue(ctx: KernelContext, el: Element, rawValue: unknown): DispatchReport {
  if (isDisabled(el)) {
    throw new KernelError("TARGET_DISABLED", "cannot set value on a disabled element");
  }
  const win = el.ownerDocument.defaultView ?? ctx.win;
  const tag = el.tagName.toLowerCase();
  const events: string[] = [];

  if (tag === "select") {
    return setSelectValue(ctx, el as HTMLSelectElement, rawValue);
  }

  if (tag === "input") {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      const want = rawValue === true || rawValue === "true" || rawValue === "on" || rawValue === 1;
      if (type === "radio" ? !input.checked && want !== false : input.checked !== want) {
        input.focus?.();
        input.click();
        events.push("click");
      }
      return { events, value: String(input.checked) };
    }
    if (input.readOnly) {
      throw new KernelError("INPUT_FAILED", "input is read-only");
    }
    input.focus?.();
    events.push("focus");
    const text = String(rawValue ?? "");
    setNativeValue(win, input, text);
    fireInputAndChange(win, input, text, events);
    return { events, value: input.value };
  }

  if (tag === "textarea") {
    const area = el as HTMLTextAreaElement;
    if (area.readOnly) throw new KernelError("INPUT_FAILED", "textarea is read-only");
    area.focus?.();
    events.push("focus");
    const text = String(rawValue ?? "");
    setNativeValue(win, area, text);
    fireInputAndChange(win, area, text, events);
    return { events, value: area.value };
  }

  if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).focus?.();
    el.textContent = String(rawValue ?? "");
    fireInputAndChange(win, el, String(rawValue ?? ""), events);
    return { events, value: el.textContent ?? "" };
  }

  throw new KernelError("INPUT_FAILED", `element <${tag}> is not editable`);
}

function setSelectValue(ctx: KernelContext, select: HTMLSelectElement, rawValue: unknown): DispatchReport {
  const win = select.ownerDocument.defaultView ?? ctx.win;
  const wanted = (Array.isArray(rawValue) ? rawValue : [rawValue]).map((v) => String(v));
  const options = Array.from(select.options);
  const matched: HTMLOptionElement[] = [];

  for (const want of wanted) {
    const byValue = options.find((o) => o.value === want);
    const byLabel = options.find((o) => (o.label || o.textContent || "").trim().toLowerCase() === want.trim().toLowerCase());
    const hit = byValue ?? byLabel;
    if (!hit) {
      throw new KernelError("INPUT_FAILED", `no option matches "${want}"`, {
        options: options.map((o) => ({ value: o.value, label: (o.label || o.textContent || "").trim() }))
      });
    }
    matched.push(hit);
  }

  if (!select.multiple && matched.length > 1) {
    throw new KernelError("INPUT_FAILED", "multiple values for a single-select");
  }
  for (const option of options) option.selected = false;
  for (const option of matched) option.selected = true;

  const events: string[] = [];
  select.focus?.();
  fireInputAndChange(win, select, matched[0]?.value ?? null, events);
  return { events, value: select.value };
}

export function clearValue(ctx: KernelContext, el: Element): DispatchReport {
  if ((el as HTMLElement).isContentEditable) {
    el.textContent = "";
    const win = el.ownerDocument.defaultView ?? ctx.win;
    const events: string[] = [];
    fireInputAndChange(win, el, null, events);
    return { events, value: "" };
  }
  return setValue(ctx, el, "");
}

/** Per-character typing with key events, appended to the current value. */
export function typeText(ctx: KernelContext, el: Element, text: string): DispatchReport {
  if (isDisabled(el)) throw new KernelError("TARGET_DISABLED", "cannot type into a disabled element");
  const win = el.ownerDocument.defaultView ?? ctx.win;
  const input = el as HTMLInputElement;
  const events: string[] = [];
  input.focus?.();
  events.push("focus");
  const InputEventCtor = (win as unknown as { InputEvent?: typeof InputEvent }).InputEvent;

  for (const ch of text) {
    el.dispatchEvent(new win.KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true, composed: true }));
    setNativeValue(win, el, (input.value ?? "") + ch);
    if (InputEventCtor) {
      el.dispatchEvent(new InputEventCtor("input", { bubbles: true, composed: true, data: ch, inputType: "insertText" }));
    } else {
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new win.KeyboardEvent("keyup", { key: ch, bubbles: true, composed: true }));
  }
  events.push(`typed ${text.length} characters`);
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
  events.push("change");
  return { events, value: input.value };
}

const MODIFIERS = new Set(["control", "ctrl", "shift", "alt", "meta", "cmd"]);

export function dispatchKeySequence(ctx: KernelContext, target: Element | null, sequence: string | string[]): DispatchReport {
  const el = target ?? ctx.doc.activeElement ?? ctx.doc.body;
  const win = el.ownerDocument?.defaultView ?? ctx.win;
  const events: string[] = [];
  const keys = Array.isArray(sequence) ? sequence : [sequence];

  for (const combo of keys) {
    const parts = combo.split("+").map((p) => p.trim());
    const key = parts[parts.length - 1] ?? combo;
    const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()).filter((m) => MODIFIERS.has(m)));
    const init: KeyboardEventInit = {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: mods.has("control") || mods.has("ctrl"),
      shiftKey: mods.has("shift"),
      altKey: mods.has("alt"),
      metaKey: mods.has("meta") || mods.has("cmd")
    };
    el.dispatchEvent(new win.KeyboardEvent("keydown", init));
    el.dispatchEvent(new win.KeyboardEvent("keyup", init));
    events.push(`key ${combo}`);
  }
  return { events };
}

export function focusElement(ctx: KernelContext, el: Element): DispatchReport {
  (el as HTMLElement).focus?.();
  const active = ctx.doc.activeElement === el;
  return { events: active ? ["focus"] : ["focus attempted"] };
}
