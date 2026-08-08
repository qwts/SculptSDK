import type {
  ActionSummary,
  AlertSummary,
  DialogSummary,
  FormSummary,
  InteractiveElementSummary,
  PageSnapshot,
  SnapshotOptions,
  TableSummary
} from "../types/snapshot.js";
import type { KernelContext } from "./context.js";
import { currentRoute } from "./context.js";
import { getAccessibleName, getRole, isDisabled, visibleText } from "./ax.js";
import { collectElements, inferKind } from "./dom.js";
import { formName, summarizeFields } from "./forms.js";
import { isVisibleQuick } from "./layout.js";
import { detectFrameworks } from "./frameworks.js";
import { syntheticClick, dispatchKeySequence } from "./input.js";

/**
 * Snapshot system (§15): a compact, deterministic summary of actionable UI
 * state — never a raw DOM dump.
 */

const PRIMARY_ACTION_NAME = /save|submit|continue|next|confirm|ok\b|apply|send|search|sign in|log ?in|checkout|add|create|done/i;

function interactiveSummary(ctx: KernelContext, el: Element): InteractiveElementSummary {
  const role = getRole(el);
  const input = el as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  let value: string | undefined;
  if (["input", "select", "textarea"].includes(tag) && typeof input.value === "string") {
    const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : "";
    value = type === "password" ? (input.value ? "•••" : "") : input.value;
    if (type === "checkbox" || type === "radio") value = String(input.checked);
  }
  return {
    targetId: ctx.refs.acquire(el),
    kind: inferKind(el, role) ?? "button",
    role: role ?? undefined,
    name: getAccessibleName(el) || undefined,
    value,
    enabled: !isDisabled(el)
  };
}

export function dialogInfo(ctx: KernelContext, dialog: Element): DialogSummary {
  const buttons = collectElements(ctx, dialog)
    .filter((el) => getRole(el) === "button" && isVisibleQuick(ctx, el))
    .slice(0, 6)
    .map((el) => interactiveSummary(ctx, el));
  return {
    targetId: ctx.refs.acquire(dialog),
    role: getRole(dialog) ?? "dialog",
    title: getAccessibleName(dialog) || undefined,
    buttons
  };
}

const CLOSE_NAME = /^(close|cancel|dismiss|×|x|got it|ok)$/i;

export function closeDialog(ctx: KernelContext, dialog: Element): { method: string } {
  const native = dialog as HTMLDialogElement;
  if (dialog.tagName.toLowerCase() === "dialog" && typeof native.close === "function") {
    native.close();
    return { method: "native-close" };
  }
  for (const el of collectElements(ctx, dialog)) {
    if (getRole(el) === "button" && isVisibleQuick(ctx, el) && CLOSE_NAME.test(getAccessibleName(el))) {
      syntheticClick(ctx, el);
      return { method: "close-button" };
    }
  }
  dispatchKeySequence(ctx, dialog, "Escape");
  return { method: "escape-key" };
}

export interface ExtractedTable {
  name?: string;
  headers: string[];
  rows: string[][];
  records: Record<string, string>[];
}

export function extractTable(ctx: KernelContext, table: Element): ExtractedTable {
  const headers = Array.from(table.querySelectorAll("thead th, thead td")).map((cell) => visibleText(cell));
  if (headers.length === 0) {
    const firstRow = table.querySelector("tr");
    if (firstRow && firstRow.querySelectorAll("th").length > 0) {
      headers.push(...Array.from(firstRow.querySelectorAll("th")).map((cell) => visibleText(cell)));
    }
  }
  const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
  const rowSource = bodyRows.length > 0 ? bodyRows : Array.from(table.querySelectorAll("tr")).slice(headers.length > 0 ? 1 : 0);
  const rows = rowSource.map((row) => Array.from(row.querySelectorAll("td, th")).map((cell) => visibleText(cell)));
  const records =
    headers.length > 0
      ? rows.map((cells) => {
          const record: Record<string, string> = {};
          headers.forEach((header, i) => {
            if (header) record[header] = cells[i] ?? "";
          });
          return record;
        })
      : [];
  return { name: getAccessibleName(table) || undefined, headers, rows, records };
}

export function buildSnapshot(ctx: KernelContext, options: SnapshotOptions = {}): PageSnapshot {
  const { doc, win, state } = ctx;
  const maxInteractive = options.maxInteractiveElements ?? 40;
  const all = collectElements(ctx);

  const dialogs: DialogSummary[] = [];
  const forms: FormSummary[] = [];
  const interactive: InteractiveElementSummary[] = [];
  const tables: TableSummary[] = [];
  const alerts: AlertSummary[] = [];
  const buttonCandidates: { el: Element; score: number; reasons: string[] }[] = [];

  for (const el of all) {
    const role = getRole(el);
    const tag = el.tagName.toLowerCase();
    const visible = isVisibleQuick(ctx, el);

    if ((role === "dialog" || role === "alertdialog") && visible) {
      dialogs.push(dialogInfo(ctx, el));
      continue;
    }
    if (tag === "form" && el.isConnected) {
      forms.push({
        targetId: ctx.refs.acquire(el),
        name: formName(el),
        fields: summarizeFields(ctx, el)
      });
      continue;
    }
    if ((role === "table" || role === "grid") && visible && options.includeTables !== false) {
      const headers = Array.from(el.querySelectorAll("thead th, thead td, tr:first-child th")).map((cell) =>
        visibleText(cell)
      );
      tables.push({
        targetId: ctx.refs.acquire(el),
        name: getAccessibleName(el) || undefined,
        rowCount: el.querySelectorAll("tr").length,
        columnCount: headers.length || (el.querySelector("tr")?.querySelectorAll("td, th").length ?? 0),
        headers
      });
      continue;
    }
    if ((role === "alert" || role === "status") && visible) {
      const text = visibleText(el);
      if (text) alerts.push({ targetId: ctx.refs.acquire(el), role, text: text.slice(0, 200) });
      continue;
    }
    if (!visible) continue;

    if (role === "button" || role === "link" || ["input", "select", "textarea"].includes(tag)) {
      if (tag === "input" && (el.getAttribute("type") ?? "").toLowerCase() === "hidden") continue;
      if (interactive.length < maxInteractive) interactive.push(interactiveSummary(ctx, el));

      if (role === "button") {
        let score = 1;
        const reasons: string[] = [];
        const name = getAccessibleName(el);
        const type = (el.getAttribute("type") ?? "").toLowerCase();
        if (type === "submit") {
          score += 3;
          reasons.push("submit button");
        }
        if (PRIMARY_ACTION_NAME.test(name)) {
          score += 2;
          reasons.push("primary-action name");
        }
        if (el.closest("form")) {
          score += 1;
          reasons.push("inside form");
        }
        if (el.closest('dialog, [role="dialog"], [role="alertdialog"]')) {
          score += 2;
          reasons.push("inside dialog");
        }
        if (!isDisabled(el)) buttonCandidates.push({ el, score, reasons });
      }
    }
  }

  const primaryActions: ActionSummary[] = buttonCandidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ el, reasons }) => ({ ...interactiveSummary(ctx, el), reasons }));

  const active = doc.activeElement;
  const focused =
    active && active !== doc.body && active.tagName.toLowerCase() !== "html"
      ? {
          targetId: ctx.refs.acquire(active),
          role: getRole(active) ?? undefined,
          name: getAccessibleName(active) || undefined
        }
      : undefined;

  const now = Date.now();
  return {
    url: win.location.href,
    title: doc.title,
    route: currentRoute(win),
    focused,
    viewport: {
      width: win.innerWidth || doc.documentElement.clientWidth,
      height: win.innerHeight || doc.documentElement.clientHeight,
      scrollX: win.scrollX || 0,
      scrollY: win.scrollY || 0
    },
    dialogs,
    forms,
    primaryActions,
    interactiveElements: interactive,
    tables,
    alerts,
    network: {
      observed: state.networkObservation,
      inflight: state.inflightRequests,
      recentCompleted: state.completedRequests.slice(-10)
    },
    mutations: {
      totalSinceAttach: state.mutationCount,
      recentCount: state.mutationCount,
      lastMutationAgoMs: state.lastMutationAt === 0 ? null : now - state.lastMutationAt
    },
    frameworks: detectFrameworks(ctx),
    timestamp: now
  };
}
