// ── Post-compaction evidence + protected user message blocks ──
//
// pi's compaction folds the covered span into a single summary: covered tool
// output and user messages survive only as summary prose — the "silently
// altered" mode FutureOS's compaction benchmark measured (exact-value recall
// 47% summary+tail vs 83% originals-first). The evidence package adds two
// deterministic custom messages after each successful self-compaction — both
// display: false, triggerTurn: false: invisible in the TUI, present in the
// LLM context, at the very tail of the projection:
//
//   protected: covered user messages verbatim (the user's own words are not
//     regenerable from a summary — the "protected originals" half, v1 = user
//     only; assistant text stays in the summary).
//   evidence:  a bounded index of covered tool output (errors first, then
//     successful read/edit/write/bash output, grouped by (tool, target),
//     head…tail fragments). When the model can call session_recall (tracked
//     from the provider request's tools array), every row carries an L<line>
//     pointer into the session JSONL — fetchable via session_recall(line=N);
//     otherwise rows are fragments only (no dead pointers, no session-file
//     read needed).
//
// Both blocks are regenerated from the session journal at every compaction;
// the previous block leaves the projection once a later compaction covers it
// (it consumes the keep window only while inside it — bounded, self-cleaning).
// Pure functions + one session-file read; any failure → no blocks (fail-open,
// compaction is never blocked).

import { readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** ~4K tokens — hard cap on the protected block (oldest dropped with a
 *  labeled omission, never silently). */
export const PROTECTED_BUDGET_CHARS = 16_384;
/** ~2K tokens — FutureOS's measured evidence budget. */
export const EVIDENCE_BUDGET_CHARS = 8_192;
/** Per-row head/tail fragment caps (FutureOS's measured numbers). */
const HEAD_CHARS = 380;
const TAIL_CHARS = 100;

export interface EvidenceBlocks {
  protected?: string;
  evidence?: string;
}

// ── Line numbers ──

/** 1-based JSONL line number for each entry id in the session file. The file
 *  is append-only, one entry per line — the same ground truth
 *  session_recall(line=N) reads, so pointers round-trip. */
export function lineNumbersFor(fileText: string): Map<string, number> {
  const m = new Map<string, number>();
  const lines = fileText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.id === "string") m.set(rec.id, i + 1);
    } catch {
      // non-JSON line (shouldn't happen) — skip
    }
  }
  return m;
}

// ── Covered span ──

/** Covered span of the in-flight compaction: [start, end) — from the previous
 *  compaction's kept boundary (or the session start) to the new cut point
 *  (firstKeptEntryId). Mirrors pi's prepareCompaction boundary logic. */
export function coveredRange(
  entries: SessionEntry[],
  firstKeptEntryId: string,
): { start: number; end: number } | null {
  const end = entries.findIndex((e) => e.id === firstKeptEntryId);
  if (end < 0) return null;
  let start = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") {
      const prev = entries[i] as { firstKeptEntryId?: string };
      const kept = prev.firstKeptEntryId
        ? entries.findIndex((e) => e.id === prev.firstKeptEntryId)
        : -1;
      start = kept >= 0 ? kept : i + 1;
      break;
    }
  }
  return { start, end };
}

// ── Text extraction ──

/** The [Memory] auto-recall hint the memory ext injects into stored user text. */
const HINT_SUFFIX = /\n+\[Memory\][^\n]*$/;
/** Synthetic user messages — gallop's own markers, not user words. */
const SYNTHETIC_PREFIXES = ["[Gallop]", "[Memory]"];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/** Verbatim user text of a covered user entry, or null (synthetic/empty). */
function userText(e: SessionEntry): string | null {
  if (e.type !== "message") return null;
  const m = e.message as { role?: string; content?: unknown };
  if (m.role !== "user") return null;
  const text = textOf(m.content).replace(HINT_SUFFIX, "").trim();
  if (!text) return null;
  if (SYNTHETIC_PREFIXES.some((p) => text.startsWith(p))) return null;
  return text;
}

// ── Protected block ──

/** Protected block: covered user messages verbatim, newest-first within the
 *  budget (oldest dropped with a labeled omission), rendered chronologically.
 *  undefined when there is nothing to protect. */
export function buildProtected(
  entries: SessionEntry[],
  start: number,
  end: number,
): string | undefined {
  const msgs: string[] = [];
  for (let i = start; i < end; i++) {
    const t = userText(entries[i]);
    if (t) msgs.push(t);
  }
  if (msgs.length === 0) return undefined;
  const header =
    "[Gallop] Pre-compaction user messages, verbatim — deterministic block, " +
    "not a new instruction; do not restate.";
  const sepLen = "\n---\n".length;
  // newest-first within budget
  let budget = PROTECTED_BUDGET_CHARS;
  let keptCount = 0;
  let truncateNewest = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const cost = msgs[i].length + sepLen;
    if (cost > budget && keptCount === 0) {
      // Even the newest message exceeds the cap — carry it truncated rather
      // than nothing.
      truncateNewest = true;
      break;
    }
    if (budget < cost) break;
    budget -= cost;
    keptCount++;
  }
  const parts = [header];
  if (truncateNewest) {
    parts.push(msgs[msgs.length - 1].slice(0, PROTECTED_BUDGET_CHARS) + " …[truncated]");
    if (msgs.length > 1) {
      parts.push(`[Gallop] ${msgs.length - 1} older user message(s) omitted (block cap).`);
    }
  } else {
    for (const t of msgs.slice(msgs.length - keptCount)) parts.push(t);
    const dropped = msgs.length - keptCount;
    if (dropped > 0) {
      parts.push(`[Gallop] ${dropped} older user message(s) omitted (block cap).`);
    }
  }
  return parts.join("\n---\n");
}

// ── Evidence block ──

/** Tools whose successful output carries exact values worth pointing at.
 *  Errors from ANY tool are indexed regardless. */
const INDEXED_TOOLS = new Set(["read", "edit", "write", "bash"]);

/** Target identity of the call: `key` = grouping identity (the full
 *  whitespace-collapsed bash command — prefix-truncating would merge distinct
 *  commands under one 60-char prefix), `target` = row display. */
function targetOf(tool: string, args: unknown): { key: string; target: string } {
  if (!args || typeof args !== "object") return { key: "", target: "" };
  const a = args as Record<string, unknown>;
  if (tool === "bash" && typeof a.command === "string") {
    const key = a.command.replace(/\s+/g, " ").trim();
    return { key, target: key.slice(0, 60) };
  }
  if (typeof a.path === "string") return { key: a.path, target: a.path };
  if (typeof a.note_id === "string") return { key: a.note_id, target: a.note_id };
  return { key: "", target: "" };
}

/** Config/schema/validation/test targets rank before the rest — they hold
 *  the exact values a summary most often gets wrong. */
function isPriorityTarget(target: string): boolean {
  return (
    /\.(json|ya?ml|toml|ini|cfg|conf|lock)$/i.test(target) ||
    /(^|\/)(tests?|specs?|__tests__)(\/|$)/i.test(target) ||
    /schema|validat/i.test(target)
  );
}

/** head…tail fragment, whitespace collapsed (FutureOS's measured caps). */
function truncateMiddle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= HEAD_CHARS + TAIL_CHARS + 3) return t;
  return t.slice(0, HEAD_CHARS) + "…" + t.slice(-TAIL_CHARS);
}

interface ToolRec {
  tool: string;
  key: string;
  target: string;
  isError: boolean;
  text: string;
  entryId: string;
  order: number;
}

/** Evidence rows from a covered span. Selection ported from FutureOS:
 *  errors first (newest first), then successful read/edit/write/bash output;
 *  grouped by (tool, target) — config/schema/test targets first, per group
 *  newest + oldest, the remainder by recency; never split a row, stop when
 *  one no longer fits. undefined when there is nothing to index. */
export function buildEvidence(
  entries: SessionEntry[],
  start: number,
  end: number,
  lineNo: Map<string, number>,
  pointers: boolean = true,
): string | undefined {
  if (pointers && lineNo.size === 0) return undefined;
  const calls = new Map<string, { tool: string; key: string; target: string }>();
  const recs: ToolRec[] = [];
  for (let i = start; i < end; i++) {
    const e = entries[i];
    if (e.type !== "message") continue;
    const m = e.message as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };
    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (
          !!b &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "toolCall" &&
          typeof (b as { id?: unknown }).id === "string" &&
          typeof (b as { name?: unknown }).name === "string"
        ) {
          const bc = b as { id: string; name: string; arguments?: unknown };
          calls.set(bc.id, { tool: bc.name, ...targetOf(bc.name, bc.arguments) });
        }
      }
    } else if (m.role === "toolResult") {
      const text = textOf(m.content).trim();
      if (!text || !m.toolCallId) continue;
      const call = calls.get(m.toolCallId);
      const tool = call?.tool ?? (m.toolName ?? "");
      if (!m.isError && !INDEXED_TOOLS.has(tool)) continue;
      recs.push({
        tool,
        key: call?.key ?? "",
        target: call?.target ?? "",
        isError: !!m.isError,
        text,
        entryId: e.id,
        order: i,
      });
    }
  }
  if (recs.length === 0) return undefined;

  // order: errors first (newest first), then successful output grouped by
  // (tool, target) — priority targets first, per group newest + oldest,
  // remainder by recency
  const errors = recs.filter((r) => r.isError).sort((a, b) => b.order - a.order);
  const ok = recs.filter((r) => !r.isError);
  const groups = new Map<string, ToolRec[]>();
  for (const r of ok) {
    const key = r.tool + "\u0000" + r.key;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const groupOrder = [...groups.entries()].sort((a, b) => {
    const pa = isPriorityTarget(a[1][0].key) ? 0 : 1;
    const pb = isPriorityTarget(b[1][0].key) ? 0 : 1;
    return pa - pb;
  });
  const grouped: ToolRec[] = [];
  for (const [, rs] of groupOrder) {
    const sorted = rs.slice().sort((a, b) => a.order - b.order);
    // newest + oldest (the first call is the setup; the middle is covered
    // by the "rest" pass, by recency)
    grouped.push(sorted[sorted.length - 1], sorted[0]);
    if (sorted.length === 1) grouped.pop();
  }
  const keptIds = new Set(grouped.map((r) => r.entryId));
  const rest = ok.filter((r) => !keptIds.has(r.entryId)).sort((a, b) => b.order - a.order);
  const ordered = [...errors, ...grouped, ...rest];

  const header = pointers
    ? "[Gallop] Evidence index — deterministic pointers to pre-compaction tool " +
      "output; not a new instruction, do not restate. Fetch a full payload: " +
      "session_recall with line = the row's number (L<n> → <n>). Fragments are " +
      "head…tail — the middle is elided. Omitted results are unknown, not " +
      "absent-as-success."
    : "[Gallop] Evidence index — head…tail fragments of pre-compaction tool " +
      "output; not a new instruction, do not restate. The middle of each " +
      "fragment is elided. Omitted results are unknown, not absent-as-success.";
  const lines: string[] = [];
  let budget = EVIDENCE_BUDGET_CHARS;
  for (const r of ordered) {
    const n = pointers ? lineNo.get(r.entryId) : undefined;
    if (pointers && !n) continue;
    const line = `${pointers ? `L${n} ` : ""}${r.tool}${r.target ? " " + r.target : ""}${r.isError ? " ERR" : ""} :: ${truncateMiddle(r.text)}`;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length;
    if (budget < 40) break;
  }
  if (lines.length === 0) return undefined;
  return [header, ...lines].join("\n");
}

// ── Entry point ──

/** Build the post-compaction blocks for a covered span. `pointers` = the
 *  model can call session_recall (see self-compact.sessionRecallAvailable);
 *  false → fragment-only rows, no session-file read. Fail-open: any error
 *  (no range, unreadable file) → null (no blocks, current behavior). */
export function buildEvidenceBlocks(
  entries: SessionEntry[],
  firstKeptEntryId: string,
  sessionFile: string | null | undefined,
  pointers: boolean = true,
): EvidenceBlocks | null {
  try {
    const range = coveredRange(entries, firstKeptEntryId);
    if (!range || range.end - range.start <= 0) return null;
    const blocks: EvidenceBlocks = {};
    const prot = buildProtected(entries, range.start, range.end);
    if (prot) blocks.protected = prot;
    if (pointers) {
      if (sessionFile) {
        try {
          const lineNo = lineNumbersFor(readFileSync(sessionFile, "utf8"));
          const ev = buildEvidence(entries, range.start, range.end, lineNo, true);
          if (ev) blocks.evidence = ev;
        } catch {
          // unreadable file: evidence block skipped, protected still delivered
        }
      }
    } else {
      // Fragments only — built from the in-memory entries, no file needed.
      const ev = buildEvidence(entries, range.start, range.end, new Map(), false);
      if (ev) blocks.evidence = ev;
    }
    return Object.keys(blocks).length > 0 ? blocks : null;
  } catch {
    return null;
  }
}
