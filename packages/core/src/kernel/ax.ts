import { normalizeText } from "../types/matchers.js";

/**
 * Accessibility primitives: role inference and accessible-name computation.
 * This is a pragmatic subset of the ARIA specs — enough to make semantic
 * queries work on real applications without test ids or readable source.
 */

const INPUT_ROLE_BY_TYPE: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  email: "textbox",
  tel: "textbox",
  text: "textbox",
  url: "textbox",
  password: "textbox",
  date: "textbox",
  "datetime-local": "textbox",
  time: "textbox",
  month: "textbox",
  week: "textbox"
};

const TAG_ROLES: Record<string, string> = {
  a: "link",
  area: "link",
  button: "button",
  summary: "button",
  textarea: "textbox",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  form: "form",
  table: "table",
  thead: "rowgroup",
  tbody: "rowgroup",
  tfoot: "rowgroup",
  tr: "row",
  td: "cell",
  th: "columnheader",
  ul: "list",
  ol: "list",
  li: "listitem",
  dialog: "dialog",
  option: "option",
  select: "combobox",
  img: "img",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  hr: "separator",
  progress: "progressbar",
  output: "status",
  menu: "list",
  fieldset: "group",
  legend: "legend",
  label: "label",
  search: "search"
};

export function getRole(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) {
    const first = explicit.trim().split(/\s+/)[0];
    if (first) return first.toLowerCase();
  }
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "hidden") return null;
    if (type === "file") return null;
    return INPUT_ROLE_BY_TYPE[type] ?? "textbox";
  }
  if (tag === "a" || tag === "area") {
    return el.hasAttribute("href") ? "link" : null;
  }
  if (tag === "select") {
    const select = el as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }
  if (tag === "section") {
    return hasLabel(el) ? "region" : null;
  }
  return TAG_ROLES[tag] ?? null;
}

function hasLabel(el: Element): boolean {
  return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
}

export function isAriaHidden(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    if (current.getAttribute("aria-hidden") === "true") return true;
    current = current.parentElement ?? hostOf(current);
  }
  return false;
}

/**
 * Structural shadow-root test: `instanceof ShadowRoot` depends on a global
 * `ShadowRoot` constructor that only exists inside a real DOM scope (e.g. not
 * in a plain Node.js process driving a `happy-dom` window by reference), so
 * this checks node type and shape instead. Returns the shadow host element
 * when `root` is a shadow root, `null` otherwise (including for a plain,
 * non-shadow `DocumentFragment`, which shares the same `nodeType`).
 */
export function shadowHostOf(root: Node | null | undefined): Element | null {
  if (!root || root.nodeType !== 11 /* Node.DOCUMENT_FRAGMENT_NODE */) return null;
  const host = (root as unknown as { host?: unknown }).host as Element | undefined;
  return host && host.nodeType === 1 /* Node.ELEMENT_NODE */ ? host : null;
}

/** Crosses open shadow boundaries upward. */
function hostOf(el: Element): Element | null {
  return shadowHostOf(el.getRootNode?.());
}

export function isDisabled(el: Element): boolean {
  if (el.getAttribute("aria-disabled") === "true") return true;
  const disableable = el as HTMLButtonElement;
  if (typeof disableable.disabled === "boolean" && disableable.disabled) return true;
  const fieldset = el.closest?.("fieldset[disabled]");
  if (fieldset && !el.closest("legend")) return true;
  return false;
}

const FOCUSABLE_TAGS = new Set(["input", "select", "textarea", "button", "a", "area", "summary", "iframe"]);

export function isFocusable(el: Element): boolean {
  if (isDisabled(el)) return false;
  if (el.hasAttribute("tabindex")) return Number(el.getAttribute("tabindex")) >= 0;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" || tag === "area") return el.hasAttribute("href");
  if ((el as HTMLElement).isContentEditable) return true;
  return FOCUSABLE_TAGS.has(tag);
}

export function isEditable(el: Element): boolean {
  if (isDisabled(el)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return !(el as HTMLTextAreaElement).readOnly;
  if (tag === "select") return true;
  if (tag === "input") {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (["button", "submit", "reset", "image", "hidden"].includes(type)) return false;
    return !input.readOnly;
  }
  return (el as HTMLElement).isContentEditable === true;
}

/** Visible text of an element: text nodes plus image alt, skipping hidden parts. */
export function visibleText(el: Element): string {
  const parts: string[] = [];
  collectText(el, parts, 0);
  return normalizeText(parts.join(" "));
}

const SKIP_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);

function collectText(node: Element, parts: string[], depth: number): void {
  if (depth > 12) return;
  if (SKIP_TEXT_TAGS.has(node.tagName.toLowerCase())) return;
  if (node.getAttribute("aria-hidden") === "true") return;
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.textContent;
      if (text) parts.push(text);
    } else if (child.nodeType === 1) {
      const childEl = child as Element;
      if (childEl.tagName.toLowerCase() === "img") {
        const alt = childEl.getAttribute("alt");
        if (alt) parts.push(alt);
      } else {
        collectText(childEl, parts, depth + 1);
      }
    }
  }
}

const NAME_FROM_CONTENT_ROLES = new Set([
  "button",
  "link",
  "heading",
  "cell",
  "columnheader",
  "rowheader",
  "option",
  "menuitem",
  "tab",
  "listitem",
  "tooltip",
  "legend",
  "label"
]);

/**
 * Accessible name computation, simplified accname order:
 * aria-labelledby → aria-label → native label association → alt/value →
 * name-from-content → placeholder → title.
 */
export function getAccessibleName(el: Element): string {
  const doc = el.ownerDocument;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const texts = labelledBy
      .trim()
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((ref): ref is HTMLElement => ref !== null)
      .map((ref) => visibleText(ref))
      .filter((text) => text.length > 0);
    if (texts.length > 0) return normalizeText(texts.join(" "));
  }

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return normalizeText(ariaLabel);

  const tag = el.tagName.toLowerCase();

  if (tag === "input" || tag === "select" || tag === "textarea") {
    const labelText = nativeLabelText(el);
    if (labelText) return labelText;
    if (tag === "input") {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute("type") ?? "text").toLowerCase();
      if (["submit", "reset", "button"].includes(type) && input.value) return normalizeText(input.value);
      if (type === "image") {
        const alt = input.getAttribute("alt");
        if (alt) return normalizeText(alt);
      }
    }
  }

  if (tag === "img" || tag === "area") {
    const alt = el.getAttribute("alt");
    if (alt) return normalizeText(alt);
  }

  if (tag === "table") {
    const caption = el.querySelector(":scope > caption");
    if (caption) return visibleText(caption);
  }

  if (tag === "fieldset") {
    const legend = el.querySelector(":scope > legend");
    if (legend) return visibleText(legend);
  }

  if (tag === "dialog" || el.getAttribute("role") === "dialog" || el.getAttribute("role") === "alertdialog") {
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading) return visibleText(heading);
  }

  const role = getRole(el);
  if (role && NAME_FROM_CONTENT_ROLES.has(role)) {
    const text = visibleText(el);
    if (text) return text;
  }

  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) return normalizeText(placeholder);

  const title = el.getAttribute("title");
  if (title && title.trim()) return normalizeText(title);

  return "";
}

function nativeLabelText(el: Element): string | null {
  const doc = el.ownerDocument;
  const id = el.getAttribute("id");
  if (id) {
    // CSS.escape is unavailable in some embedded environments; query by scan.
    for (const label of Array.from(doc.querySelectorAll("label[for]"))) {
      if (label.getAttribute("for") === id) {
        const text = labelTextExcludingControls(label);
        if (text) return text;
      }
    }
  }
  const wrapping = el.closest?.("label");
  if (wrapping) {
    const text = labelTextExcludingControls(wrapping);
    if (text) return text;
  }
  return null;
}

function labelTextExcludingControls(label: Element): string {
  const clone = label.cloneNode(true) as Element;
  for (const control of Array.from(clone.querySelectorAll("input, select, textarea, button"))) {
    control.remove();
  }
  return visibleText(clone);
}

export function getDescription(el: Element): string {
  const describedBy = el.getAttribute("aria-describedby");
  if (describedBy) {
    const doc = el.ownerDocument;
    const texts = describedBy
      .trim()
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((ref): ref is HTMLElement => ref !== null)
      .map((ref) => visibleText(ref));
    return normalizeText(texts.join(" "));
  }
  return el.getAttribute("title") ?? "";
}
