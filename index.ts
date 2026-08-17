/**
 * Gallop Extension
 *
 * Keeps the agent moving:
 * - Detects stalled generation (stopped mid-thinking or mid-tool-call) and sends resume
 * - Detects repetitive command failure loops and nudges the agent to change strategy
 * - LLM can trigger compaction via `request_compact` with an in-session checkpoint summary
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

// ── Persisted settings ──

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "gallop.json");
const LEGACY_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const BINARY_SUPPRESSION_KEY = "gallopBinarySuppressionEnabled";
const READ_GUARD_KEY = "gallopReadGuardEnabled";

/** Gallop's own settings file (~/.pi/agent/gallop.json). pi owns settings.json
 *  and writes it under a proper-lockfile lock; writing to it from an extension
 *  races pi's saves and can clobber keys or corrupt the file. */
function readJsonFile(filePath: string): Record<string, any> | null {
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

function loadSettings(): Record<string, any> {
  return readJsonFile(SETTINGS_PATH) ?? {};
}

function saveSettings(settings: Record<string, any>): void {
  mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

/** Load a toggle: gallop.json first, then migrate from legacy settings.json keys. */
function loadToggleSetting(key: string, defaultValue: boolean): boolean {
  const own = loadSettings();
  if (own[key] !== undefined) return own[key] !== false;
  // Legacy: toggles used to live in pi's settings.json — migrate if present.
  const legacy = readJsonFile(LEGACY_SETTINGS_PATH);
  if (legacy && legacy[key] !== undefined) return legacy[key] !== false;
  return defaultValue;
}

function saveToggleSetting(key: string, enabled: boolean): void {
  const settings = loadSettings();
  settings[key] = enabled;
  saveSettings(settings);
}

// ── State ──

let cooldownUntil = 0;
let sawAssistantMessage = false;

/** Checkpoint summary written by the live model (request_compact's `summary` arg,
 *  stashed in the tool's execute). session_before_compact returns it as a custom
 *  CompactionResult so pi skips its one-shot summarizer (a cold prefill of the
 *  flattened conversation). Null → pi's native one-shot. */
let selfSummary: string | null = null;
/** True while a /qcompact steering message is in flight (the live model has been
 *  asked to write the checkpoint and call request_compact but hasn't yet). Cleared
 *  on message_end (with a native compact fallback if the model did not comply),
 *  on compaction abort, and on session reset. */
let qcompactSteering = false;
/** Re-entrancy guard for ctx.compact(). ctx.compact() internally aborts the run
 *  executing request_compact, which can re-trigger a compaction (tool re-execution)
 *  while the last session entry is still the compaction entry — at which point pi
 *  throws "Already compacted". Set when a compact actually starts; cleared only at
 *  a true new-turn boundary (a new user message, a /qcompact command, or a new
 *  session) — NOT on session_compact or compact complete/error. */
let compactionInFlight = false;
/** True while a ctx.compact() call is actually executing (from trigger to
 *  session_compact / onError). Lets /qcompact tell "compact running" apart from
 *  the post-compaction re-trigger window. */
let compactionRunning = false;
let binarySuppressionEnabled = true;
let readGuardEnabled = true;

// ── Failure-loop detection state ──

/** In-flight tool calls keyed by toolCallId: { args, fingerprint }.
 *  tool_execution_end events carry no args, so we stash them here. */
const pendingToolCalls = new Map<string, { args: unknown; fingerprint: string }>();

/** History of recent bash failures for loop detection */
const failureHistory: {
  command: string;    // normalized command
  fingerprint: string; // error fingerprint
  turnIndex: number;
}[] = [];

// ── Repetitive-call detection state ──

/** Track consecutive identical tool calls */
let repetitiveCallState: {
  fingerprint: string;   // "toolName:normalizedArgs"
  count: number;
} | null = null;

// Thresholds
const FAILURE_LOOP_THRESHOLD = 3;     // N identical failures before nudging
const FAILURE_LOOP_NUDGE_PLUS = 5;    // N failures before escalated nudge
const FAILURE_LOOP_BLOCK = 5;         // N failures before hard block (immediate escalation reaches it from 4)
const FAILURE_WINDOW_TURNS = 5;       // Only consider failures within last N turns
const REPETITIVE_CALL_THRESHOLD = 3;  // N consecutive identical calls before nudging
const REPETITIVE_CALL_NUDGE_PLUS = 5; // N consecutive calls before escalated nudge
const REPETITIVE_CALL_BLOCK = 5;      // N consecutive calls before hard block (immediate escalation reaches it from 4)
const STALL_WARN = 4;                 // Stalls before strong warning
const STALL_STOP = 5;                 // Stalls before stopping and notifying user
const CIRCUIT_BREAKER_BLOCKS = 3;     // Total blocks before shutdown

const ESCALATION_LEVELS: EscalationLevel[] = ["nudge", "nudge_plus", "block"];

let currentTurnIndex = 0;

// ── Escalation state ──

export type EscalationLevel = "nudge" | "nudge_plus" | "block";

export interface EscalationEntry {
  level: EscalationLevel;
  nudgeCount: number;
}

/** Failure-loop escalation: key -> { level, nudgeCount } */
const failureEscalation = new Map<string, EscalationEntry>();

/** Repetitive-call escalation: fingerprint -> { level, nudgeCount } */
const repetitiveEscalation = new Map<string, EscalationEntry>();

/** Patterns currently blocked (key -> reason snippet for error messages) */
const blockedPatterns = new Map<string, string>();

/** Total blocks enforced (for circuit breaker) */
let totalBlocks = 0;

/** Circuit breaker has tripped — no more auto-intervention */
let circuitBreakerTripped = false;

/** User chose "Stop" on circuit breaker — block all tool calls */
let circuitBreakerHalted = false;

/** Consecutive stall count */
let stallCount = 0;

/** Whether the "stopping auto-resume" notice was already sent (send once) */
let stallStopNotified = false;

// ── Reasoning-action mismatch detection ──

/** Last failed tool call for mismatch detection */
let lastFailedToolCall: {
  toolName: string;
  fingerprint: string;
  error: string;
} | null = null;

/** Whether LLM's thinking acknowledged an error */
let llmAcknowledgedError = false;

/** Keywords that suggest the LLM acknowledged an error or strategy change */
const ERROR_ACK_KEYWORDS = [
  "wrong", "error", "failed", "fail", "issue", "problem",
  "retry", "retried", "repeat", "same", "again",
  "cd ", "change", "different", "alternative", "instead",
  "directory", "path", "not found", "does not exist",
  "should have", "need to", "must", "fix", "correct",
];

// ── Binary detection ──

/** Result from binary content detection */
interface BinaryDetectionResult {
  binary: boolean;
  reason: string;       // e.g. "contains null bytes" or "6.2% non-printable characters"
  nonPrintablePct: number;
}

/**
 * Detect binary content in bash/read output.
 * Checks for null bytes, high ratio of non-printable characters, and high
 * ratio of U+FFFD replacement characters (undecodable bytes — e.g. the read
 * tool decodes via buffer.toString("utf-8"), which mangles null-free binaries
 * into U+FFFD walls with no control characters left to flag).
 * Returns a result with detection reason for use in suppression messages.
 */
export function detectBinaryContent(text: string): BinaryDetectionResult {
  if (!text.length) return { binary: false, reason: "", nonPrintablePct: 0 };

  // Any null byte = binary (always, no percentage threshold)
  if (text.includes("\0")) {
    return { binary: true, reason: "contains null bytes", nonPrintablePct: 0 };
  }

  // Count non-printable chars (excluding normal whitespace \n \r \t) and
  // U+FFFD replacement chars (undecodable bytes)
  let nonPrintable = 0;
  let replacementChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Control chars 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, plus DEL (0x7F)
    // Allow: 0x09 (\t), 0x0A (\n), 0x0D (\r)
    if (code === 0xFFFD) {
      replacementChars++;
    } else if ((code >= 0x00 && code <= 0x08) ||
        code === 0x0B || code === 0x0C ||
        (code >= 0x0E && code <= 0x1F) ||
        code === 0x7F) {
      nonPrintable++;
    }
  }

  const pct = nonPrintable / text.length;
  if (pct > 0.05) {
    return { binary: true, reason: `${(pct * 100).toFixed(1)}% non-printable characters`, nonPrintablePct: pct };
  }

  const replacementPct = replacementChars / text.length;
  if (replacementPct > 0.05) {
    return { binary: true, reason: `${(replacementPct * 100).toFixed(1)}% replacement characters (invalid UTF-8)`, nonPrintablePct: 0 };
  }

  return { binary: false, reason: "", nonPrintablePct: pct };
}

/** @deprecated Use detectBinaryContent() for result with reason */
export function isBinaryContent(text: string): boolean {
  return detectBinaryContent(text).binary;
}

// ── Read guard: binary file blocking ──

/** Result from matching a read path against known binary extensions */
export interface BinaryReadMatch {
  ext: string;
  hint: string;
}

/**
 * Binary extension groups → hint for the block message.
 * Image formats handled natively by the read tool (jpg/png/gif/webp/bmp) are
 * deliberately excluded — those attach correctly. Unsupported image formats
 * (tiff, heic, ...) are also excluded: pi may add native support without notice,
 * and the tool_result content sniff catches them safely in the meantime.
 */
const BINARY_READ_EXTENSION_GROUPS: [string[], string][] = [
  [[".pdf"], "Use the pdf skill (pdftotext, pdfinfo, etc.) to extract text"],
  [[".docx", ".doc"], "Use the docx skill"],
  [[".xlsx", ".xlsm", ".xls"], "Use the xlsx skill"],
  [[".pptx", ".ppt"], "Use the pptx skill"],
  [[".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war"], "Archive file — list/extract via bash (unzip -l, tar -tf, etc.)"],
  [[".sqlite", ".sqlite3", ".db"], "Database file — query via bash (sqlite3)"],
  [[".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".wasm", ".pyc", ".class"], "Compiled binary — inspect via bash (file, strings, objdump)"],
  [[".parquet", ".npy", ".npz", ".onnx", ".gguf", ".safetensors", ".ckpt", ".pt", ".pkl"], "Data/model file — inspect via bash with an appropriate CLI"],
  [[".mp3", ".wav", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm"], "Media file — inspect via bash (ffprobe, etc.)"],
  [[".ttf", ".otf", ".woff", ".woff2", ".eot"], "Font file — inspect via bash (fc-scan, etc.)"],
  [[".blend", ".sketch", ".fig"], "Design file — use an appropriate CLI via bash"],
  // Only .dwg and .3mf are blocked: they are always binary. ASCII-capable CAD
  // formats (.stl/.obj/.step/.iges/.dxf) are excluded — the read tool handles
  // their text variants fine, and the tool_result content sniff catches the
  // binary variants (e.g. binary STL, which always contains null bytes).
  [[".dwg", ".3mf"], "CAD file — use an appropriate CLI via bash"],
  [[".epub", ".mobi"], "E-book file — extract via bash (ebook-convert, pandoc)"],
];

/** Flat lookup: lowercase extension → hint */
const BINARY_READ_EXTENSIONS: Record<string, string> = Object.fromEntries(
  BINARY_READ_EXTENSION_GROUPS.flatMap(([exts, hint]) => exts.map((ext) => [ext, hint])),
);

/**
 * Match a read-tool path against known binary extensions.
 * Returns the matched extension and a remediation hint, or null for text files.
 * Case-insensitive; dotfiles without a real extension never match.
 */
export function matchBinaryReadPath(filePath: string): BinaryReadMatch | null {
  if (!filePath) return null;
  const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  // dotIndex <= 0: no extension, or dotfile like ".gitignore"
  if (dotIndex <= 0) return null;
  const ext = fileName.slice(dotIndex).toLowerCase();
  const hint = BINARY_READ_EXTENSIONS[ext];
  return hint ? { ext, hint } : null;
}

// ── Helpers ──

export function lastItemIsThinking(message: { content?: unknown[] }): boolean {
  if (!message.content || !Array.isArray(message.content) || message.content.length === 0) return false;
  const last = message.content[message.content.length - 1];
  return typeof last === "object" && last !== null && (last as any).type === "thinking";
}

export function lastItemIsToolUse(message: { content?: unknown[] }): boolean {
  if (!message.content || !Array.isArray(message.content) || message.content.length === 0) return false;
  const last = message.content[message.content.length - 1];
  // Assistant tool-call content blocks use type "toolCall" (not "tool_use").
  return typeof last === "object" && last !== null && (last as any).type === "toolCall";
}

function triggerCompaction(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  instructions?: string,
  continueAfter: boolean = false,
): void {
  // Re-entrancy guard: ctx.compact() aborts the current run, which can re-trigger
  // this function (tool re-execution) while the last session entry is still the
  // compaction entry — pi would then throw "Already compacted". The first compact
  // is already doing the work, so skip the redundant second trigger.
  if (compactionInFlight) {
    return;
  }
  compactionInFlight = true;
  compactionRunning = true;
  ctx.compact({
    customInstructions: instructions,
    onComplete: () => {
      // `continue`: inject a GENERIC proceed message — the checkpoint's Next Steps
      // section carries the actual "what next", so no custom resume text is ever
      // written or re-sent.
      if (continueAfter) {
        setTimeout(() => {
          pi.sendUserMessage("[Gallop] Compact done — proceed as commanded.", { deliverAs: "steer" });
        }, 200);
      }
    },
    onError: () => {
      // Compaction failed or was cancelled — mark it as no longer running so
      // /qcompact can re-arm the guard on a later attempt.
      compactionRunning = false;
    },
  });
}

// ── Self-compact (in-session checkpoint summary) ──
//
// The live model writes the checkpoint summary itself as request_compact's
// `summary` argument — a normal session turn, so that LLM call rides the
// session's cached prompt prefix (no cold prefill). The summary is stashed and
// returned by session_before_compact as a custom CompactionResult, so pi skips
// its one-shot summarizer (a cold prefill of the flattened conversation). The
// summary text would stay in the kept tail as the tool call's arguments —
// duplicated on every request — but the `context` handler below prunes that
// argument from LLM context once the text is safely carried by the compaction
// summary itself (session file untouched). On abort, or when no usable
// summary is stashed (native /compact, auto threshold, overflow recovery, or a
// too-short summary), the handler returns undefined and pi uses its native
// one-shot — compaction always works.

/** Below this length a stashed summary is rejected (pi's one-shot runs instead). */
const MIN_SUMMARY_LENGTH = 200;

/** The exact checkpoint format the model must use. Shared by the tool
 *  description and the /qcompact steering message so both stay in sync. */
const CHECKPOINT_FORMAT = `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Focus on OLDER work — the most recent ~20k tokens are kept verbatim, so do not restate
what is already recent. If a previous checkpoint summary is present in the conversation,
fold its still-relevant content into this one.`;

/** Shape of pi's FileOperations (read/written/edited path sets). Structurally
 *  compatible with the package's FileOperations type. */
export interface SelfCompactFileOps {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/** Compute read-only and modified file lists from file ops.
 *  readFiles = read-only (not written/edited), modifiedFiles = edited ∪ written,
 *  both sorted. Mirrors pi's computeFileLists (not exported from the package). */
export function computeSelfCompactFileLists(fileOps: SelfCompactFileOps): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

/** Append pi-style <read-files>/<modified-files> sections to a summary.
 *  Mirrors pi's formatFileOperations (not exported from the package). */
export function appendSelfCompactFileOps(summary: string, fileOps: SelfCompactFileOps): string {
  const { readFiles, modifiedFiles } = computeSelfCompactFileLists(fileOps);
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return summary;
  return `${summary}\n\n${sections.join("\n\n")}`;
}

// ── Failure-loop detection helpers ──

/**
 * Normalize a command string for comparison.
 * Collapses whitespace, trims, and lowercases for fuzzy matching.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.replace(/\s+/g, " "))
    .join(" ")
    .toLowerCase();
}

/**
 * Extract an error fingerprint from tool result content.
 * Uses the last meaningful error line (trimmed, lowercased) as a fingerprint.
 */
export function extractErrorFingerprint(result: any): string {
  if (!result) return "unknown";

  // Try to get text content from result
  let text = "";
  if (Array.isArray(result.content)) {
    text = result.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c?.text ?? "")
      .join("\n");
  } else if (typeof result.output === "string") {
    text = result.output;
  } else if (typeof result === "string") {
    text = result;
  }

  if (!text.trim()) return "empty-output";

  // Extract last meaningful line as fingerprint
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return "empty-output";

  // Take the last line (typically the error message) and truncate to 120 chars
  const lastLine = lines[lines.length - 1];
  return lastLine.length > 120 ? lastLine.slice(0, 120).toLowerCase() : lastLine.toLowerCase();
}

/**
 * Handle circuit breaker: pause agent with a UI dialog, let user decide.
 */
async function handleCircuitBreaker(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<{ block?: boolean; reason?: string }> {
  circuitBreakerTripped = true;

  if (ctx.hasUI) {
    ctx.ui.notify(`Gallop: circuit breaker — ${totalBlocks} blocks enforced. Pausing.`, "error");

    const choice = await ctx.ui.select(
      `⚠️ Gallop Circuit Breaker\n\n${totalBlocks} tool calls were blocked due to persistent failure/repetition loops.`,
      ["Continue", "Stop"],
    );

    if (choice === "Stop") {
      // Block all further tool calls — agent will halt and return to prompt
      circuitBreakerHalted = true;
      pi.sendUserMessage(
        `[Gallop] Circuit breaker: agent halted by user. You can type a new message, or use /compact / /new.`,
        { deliverAs: "steer" },
      );
      return { block: true, reason: `[Gallop] Circuit breaker: agent halted by user. Type a message or use /compact / /new.` };
    }

    // "Continue" — full reset, fresh Gallop state
    resetAllState();
    pi.sendUserMessage(
      `[Gallop] Circuit breaker: blocks cleared by user. Continuing.`,
      { deliverAs: "steer" },
    );
  } else {
    // No UI — just step back. Reset totalBlocks too, otherwise the next block
    // immediately re-trips the breaker and spams the steer message every call.
    const enforced = totalBlocks;
    blockedPatterns.clear();
    failureEscalation.clear();
    repetitiveEscalation.clear();
    totalBlocks = 0;
    circuitBreakerTripped = false;
    pi.sendUserMessage(
      `[Gallop] Circuit breaker: ${enforced} blocks enforced. Stepping back (no UI).`,
      { deliverAs: "steer" },
    );
  }

  // Let this tool call through
  return {};
}

/**
 * Reset all Gallop state. Called on session start, compaction, and circuit breaker continue.
 */
function resetAllState(): void {
  cooldownUntil = 0;
  sawAssistantMessage = false;
  selfSummary = null;
  qcompactSteering = false;

  pendingToolCalls.clear();
  failureHistory.length = 0;
  failureEscalation.clear();
  currentTurnIndex = 0;
  repetitiveCallState = null;
  repetitiveEscalation.clear();

  blockedPatterns.clear();
  totalBlocks = 0;
  circuitBreakerTripped = false;
  circuitBreakerHalted = false;
  stallCount = 0;
  stallStopNotified = false;

  lastFailedToolCall = null;
  llmAcknowledgedError = false;
}

/**
 * Prune failure history to keep only entries within the window.
 */
/** Check if thinking content contains error/strategy keywords */
function thinkingAcknowledgesError(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_ACK_KEYWORDS.some(keyword => lower.includes(keyword));
}

export function pruneFailureHistory(
  failureHistory: { turnIndex: number }[],
  currentTurnIndex: number,
  windowTurns: number,
): void {
  const cutoff = currentTurnIndex - windowTurns;
  while (failureHistory.length > 0 && failureHistory[0].turnIndex < cutoff) {
    failureHistory.shift();
  }
}

// ── Repetitive-call detection helpers ──

/**
 * Stable JSON stringify: sorts object keys recursively at every depth.
 * (An array replacer in JSON.stringify would drop nested keys, collapsing
 * distinct nested args into identical fingerprints.)
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Normalize tool arguments into a stable fingerprint string.
 * For read: just the path. For bash: the command. For others: stable JSON of args.
 */
export function normalizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "{}";

  const a = args as Record<string, unknown>;

  // read: fingerprint by path + offset/limit
  if (toolName === "read") {
    const path = (typeof a.path === "string" ? a.path : String(a.path ?? "")).replace(/\\/g, "/");
    const offset = a.offset;
    const limit = a.limit;
    if (offset !== undefined || limit !== undefined) {
      return `${path}:o=${offset ?? ""}:l=${limit ?? ""}`;
    }
    return path;
  }

  // bash: fingerprint by normalized command
  if (toolName === "bash") {
    return normalizeCommand(typeof a.command === "string" ? a.command : String(a.command ?? ""));
  }

  // edit: fingerprint by path + short oldText prefix per edit (different regions = different fingerprints)
  if (toolName === "edit") {
    const path = (typeof a.path === "string" ? a.path : String(a.path ?? "")).replace(/\\/g, "/");
    const edits = Array.isArray(a.edits) ? a.edits : [];
    const regionTags = edits.map((e: any) => {
      const old = typeof e?.oldText === "string" ? e.oldText.trim().slice(0, 40) : "";
      return old.replace(/[^a-zA-Z0-9_$/]/g, "");
    }).join("|");
    return `${path}:${regionTags}`;
  }

  // Default: stable JSON of arg keys/values (keys sorted recursively)
  try {
    return stableStringify(a);
  } catch {
    return "{}";
  }
}

/**
 * Shared escalation engine.
 * Manages level transitions (nudge → nudge_plus → block) and message delivery.
 * Repeated failures at the same level escalate immediately (previous warning ignored).
 * Callers provide a message builder for their context.
 */
export function escalate(
  fingerprint: string,
  count: number,
  threshold: number,
  nudgePlusThreshold: number,
  blockThreshold: number,
  escalationMap: Map<string, EscalationEntry>,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  buildMessage: (level: EscalationLevel) => string,
  uiLabel: string,
): void {
  if (circuitBreakerTripped) return;
  if (count < threshold) {
    escalationMap.delete(fingerprint);
    return;
  }

  let entry = escalationMap.get(fingerprint);
  if (!entry) {
    entry = { level: "nudge", nudgeCount: 0 };
    escalationMap.set(fingerprint, entry);
  }

  let targetLevel: EscalationLevel;
  if (count >= blockThreshold) {
    targetLevel = "block";
  } else if (count >= nudgePlusThreshold) {
    targetLevel = "nudge_plus";
  } else {
    targetLevel = "nudge";
  }

  const currentIndex = ESCALATION_LEVELS.indexOf(entry.level);
  let targetIndex = ESCALATION_LEVELS.indexOf(targetLevel);

  // Already at target level and nudged before → escalate immediately (previous warning ignored)
  if (targetIndex <= currentIndex && entry.nudgeCount > 0) {
    const nextIndex = Math.min(currentIndex + 1, ESCALATION_LEVELS.length - 1);
    if (nextIndex > currentIndex) {
      targetLevel = ESCALATION_LEVELS[nextIndex];
      targetIndex = nextIndex;
    } else {
      return; // Already at max level, nothing left to do
    }
  } else if (targetIndex <= currentIndex) {
    // New entry, hasn't nudged yet — fall through to send initial nudge
  }

  entry.level = targetLevel;
  entry.nudgeCount++;

  const msg = buildMessage(targetLevel);
  if (msg) {
    pi.sendUserMessage(msg, { deliverAs: "steer" });
  }

  if (ctx.hasUI) {
    ctx.ui.notify(`Gallop: ${targetLevel} — ${uiLabel}`, targetLevel === "block" ? "error" : "warning");
  }
}

/**
 * Check for repetitive consecutive tool calls.
 * Escalates: nudge → nudge+ (stronger) → block (enforced in tool_call).
 */
function checkRepetitiveCall(
  fingerprint: string,
  count: number,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  const colonIndex = fingerprint.indexOf(":");
  const toolName = colonIndex > -1 ? fingerprint.slice(0, colonIndex) : fingerprint;
  const argSummary = colonIndex > -1 ? fingerprint.slice(colonIndex + 1) : "";
  const displayArg = argSummary.length > 80 ? argSummary.slice(0, 77) + "..." : argSummary;

  let hint = "";
  if (toolName === "read") {
    hint = " The file content is already in context — analyze it or move on.";
  } else if (toolName === "bash") {
    hint = " The command already succeeded — using its output or moving on would be more productive.";
  } else if (toolName === "edit") {
    hint = " Check if you meant to make multiple distinct edits in one call instead.";
  } else {
    hint = " Consider whether the result is already available in context.";
  }

  escalate(
    fingerprint, count,
    REPETITIVE_CALL_THRESHOLD, REPETITIVE_CALL_NUDGE_PLUS, REPETITIVE_CALL_BLOCK,
    repetitiveEscalation,
    ctx, pi,
    (level) => {
      if (level === "block") {
        return `[Gallop] BLOCKED: You've called ${toolName} ${count} times in a row with the same arguments (${displayArg}). This pattern is now blocked. You MUST use a different tool or different arguments.${hint}`;
      }
      if (level === "nudge_plus") {
        return `[Gallop] WARNING: You've called ${toolName} ${count} times in a row with the same arguments (${displayArg}). This has been flagged before. Stop repeating and try a different approach.${hint}`;
      }
      return `[Gallop] Repetitive action detected: You've called ${toolName} ${count} times in a row with the same arguments (${displayArg}).${hint}`;
    },
    `repetitive call (${count}x ${toolName})`,
  );
}

/**
 * Check if the current failure pattern indicates a loop.
 * Escalates: nudge → nudge+ (stronger warning) → block (enforced in tool_call).
 */
function checkFailureLoop(
  normalized: string,
  fingerprint: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const matches = failureHistory.filter(
    entry => entry.command === normalized && entry.fingerprint === fingerprint,
  );
  const matchCount = matches.length;

  const nudgeKey = `${normalized}:${fingerprint}`;
  const shortCommand = normalized.length > 80 ? normalized.slice(0, 77) + "..." : normalized;
  const errorSnippet = fingerprint.length > 60 ? fingerprint.slice(0, 57) + "..." : fingerprint;

  let hint = "";
  if (fingerprint.includes("enoent") || fingerprint.includes("command not found") || fingerprint.includes("not found")) {
    hint = " The command or a dependency may not exist in the current working directory. Consider checking the working directory or using absolute paths.";
  } else if (fingerprint.includes("permission") || fingerprint.includes("eacces")) {
    hint = " Check file permissions or whether you need sudo.";
  } else if (fingerprint.includes("npm") || fingerprint.includes("yarn") || fingerprint.includes("pnpm")) {
    hint = " Check if the package manager is installed and if you're in the correct project directory.";
  } else if (fingerprint.includes("syntax") || fingerprint.includes("parse")) {
    hint = " Review the command syntax or quoted arguments.";
  } else {
    hint = " Consider checking the working directory, command syntax, or prerequisites.";
  }

  escalate(
    nudgeKey, matchCount,
    FAILURE_LOOP_THRESHOLD, FAILURE_LOOP_NUDGE_PLUS, FAILURE_LOOP_BLOCK,
    failureEscalation,
    ctx, pi,
    (level) => {
      if (level === "block") {
        blockedPatterns.set(normalized, errorSnippet);
        return `[Gallop] BLOCKED: This command has failed ${matchCount} times with the same error ("${errorSnippet}"). Further retries are blocked. You MUST try a fundamentally different approach. Command: \`${shortCommand}\`${hint}`;
      }
      if (level === "nudge_plus") {
        return `[Gallop] WARNING: This command has failed ${matchCount} times with the same error ("${errorSnippet}"). A previous nudge was ignored. Stop retrying and change strategy. Command: \`${shortCommand}\`${hint}`;
      }
      return `[Gallop] Failure loop detected: You've retried this command ${matchCount} times with the same error — "${errorSnippet}". Command: \`${shortCommand}\`${hint}`;
    },
    `failure loop (${matchCount} failures)`,
  );
}

// ── Main extension ──

export default function gallopExtension(pi: ExtensionAPI) {
  // ── Tool: LLM can request compaction ──

  pi.registerTool({
    name: "request_compact",
    label: "Request Compact",
    description: `Compact context to reduce token usage. Discards bloat while preserving active tasks.
- Call when: edit tool fails 2+ times (context bloat broke text matching), large diffs accumulated, or session is long.
- Write the checkpoint summary yourself in the 'summary' argument, in this exact format:

${CHECKPOINT_FORMAT}
- 'message': brief user-visible message shown while compacting.
- 'continue': pass true to keep working right after compaction — a generic proceed message is injected. The checkpoint's Next Steps section tells you what to do next. Omit or pass false when the task is done or the user takes the next step.`,
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Brief user-visible message about this compaction (e.g., 'context bloat', 'large task finished')",
        },
        summary: {
          type: "string",
          description: "Checkpoint summary of the conversation so far, in the exact format given in the tool description",
        },
        continue: {
          type: "boolean",
          description: "Whether the agent should continue working right after compaction",
        },
      },
      required: ["summary"],
    },
    async execute(_id: string, params: { message?: string; summary?: string; continue?: boolean }, _signal, _onUpdate, ctx) {
      const message = params?.message || "model-initiated";

      // Stash the model's checkpoint for session_before_compact. A too-short summary
      // falls back to pi's native one-shot there, so compaction always works.
      const summary = (params?.summary || "").trim();
      selfSummary = summary.length >= MIN_SUMMARY_LENGTH ? summary : null;
      qcompactSteering = false;

      // Trigger compaction immediately inside the tool execute, so the LLM never
      // processes a tool result and generates extra tokens before compaction.
      triggerCompaction(ctx, pi, undefined, params?.continue === true);

      // Do NOT echo the summary in the tool result: the tool call's own arguments
      // (kept in the post-compaction tail) already carry it. The user-visible
      // message is the short 'message' argument only.
      return {
        details: {},
        content: [{
          type: "text",
          text: `Compacting (${message}).`,
        }],
        terminate: true,
      };
    },
  });

  // ── Gallop-binary command ──

  pi.registerCommand("gallop-binary", {
    description: "Toggle binary output suppression on/off. Pass 'on', 'off', or nothing to toggle.",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "enable") {
        binarySuppressionEnabled = true;
      } else if (arg === "off" || arg === "disable") {
        binarySuppressionEnabled = false;
      } else {
        binarySuppressionEnabled = !binarySuppressionEnabled;
      }
      saveToggleSetting(BINARY_SUPPRESSION_KEY, binarySuppressionEnabled);
      const status = binarySuppressionEnabled ? "enabled" : "disabled";

      if (ctx.hasUI) {
        ctx.ui.notify(`Gallop: binary suppression ${status}`, binarySuppressionEnabled ? "info" : "warning");
      }
    },
  });

  // ── Session lifecycle ──

  // ── Gallop-read-guard command ──

  pi.registerCommand("gallop-read-guard", {
    description: "Toggle read-guard (blocking reads of binary files like PDFs) on/off. Pass 'on', 'off', or nothing to toggle.",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "enable") {
        readGuardEnabled = true;
      } else if (arg === "off" || arg === "disable") {
        readGuardEnabled = false;
      } else {
        readGuardEnabled = !readGuardEnabled;
      }
      saveToggleSetting(READ_GUARD_KEY, readGuardEnabled);
      const status = readGuardEnabled ? "enabled" : "disabled";

      if (ctx.hasUI) {
        ctx.ui.notify(`Gallop: read guard ${status}`, readGuardEnabled ? "info" : "warning");
      }
    },
  });

  // ── /qcompact: user-initiated compact ──
  // Steers the live model to write the checkpoint and call request_compact —
  // the model's turn is a normal session request, so the summary is generated
  // cache-warm. If the model does not call the tool by message_end, the
  // message_end handler falls back to ctx.compact() (pi's native one-shot), so
  // /qcompact always compacts.
  pi.registerCommand("qcompact", {
    description: "Compact now: asks the live model to write a cache-warm checkpoint summary and call request_compact (native one-shot fallback if it does not comply). Optional argument = extra focus for the summary.",
    handler: async (args, ctx) => {
      const focus = (args ?? "").trim();
      if (compactionRunning) {
        if (ctx.hasUI) {
          ctx.ui.notify("Gallop: compact already in progress", "info");
        }
        return;
      }
      // /qcompact is an explicit new user compaction request — a new-turn boundary,
      // so re-arm the re-entrancy guard.
      compactionInFlight = false;
      qcompactSteering = true;
      const focusPart = focus ? ` Extra focus for the summary: ${focus}.` : "";
      pi.sendUserMessage(
        `[Gallop] /qcompact: context compaction is requested. Write the checkpoint summary now and call request_compact with message="qcompact", continue=true, and summary=<your checkpoint>. ${CHECKPOINT_FORMAT}.${focusPart}`,
        { deliverAs: "steer" },
      );
      if (ctx.hasUI) {
        ctx.ui.notify("Gallop: /qcompact — asking the model to write the checkpoint", "info");
      }
    },
  });

  pi.on("session_start", async (_event, _ctx) => {
    resetAllState();
    binarySuppressionEnabled = loadToggleSetting(BINARY_SUPPRESSION_KEY, true);
    readGuardEnabled = loadToggleSetting(READ_GUARD_KEY, true);
  });

  // ── Stall detection ──

  pi.on("message_start", async (event, _ctx) => {
    if (event.message.role === "assistant") {
      sawAssistantMessage = true;
    } else if (event.message.role === "user") {
      // A new user turn: a user message now follows any prior compaction, so the
      // "already compacted" re-trigger window is over — allow future compaction.
      compactionInFlight = false;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !sawAssistantMessage) return;

    // /qcompact fallback: the steering message told the live model to write the
    // checkpoint and call request_compact. If this run ended without the call
    // (non-compliant model), compact anyway with pi's native one-shot, so
    // /qcompact always compacts. (If the model did call the tool, compaction is
    // already in flight — triggerCompaction's guard makes this a no-op.)
    //
    // EXCEPTION: pi emits message_end BEFORE pending tool calls execute (the
    // agent-loop emits it at the end of streamAssistantResponse, then runs the
    // tools). If request_compact is among the pending calls, it executes a
    // moment later and triggers the proper in-session compact itself. Firing
    // the native fallback now would start an un-stashed compact first: pi's
    // compact() aborts the run, killing the pending tool call, and the tool's
    // own trigger would be blocked by the re-entrancy guard. Keep the steering
    // armed and re-check at the next message_end.
    if (qcompactSteering) {
      const pendingRequestCompact = Array.isArray(event.message.content) &&
        event.message.content.some(
          (b: any) => b?.type === "toolCall" && b?.name === "request_compact",
        );
      if (!pendingRequestCompact) {
        qcompactSteering = false;
        triggerCompaction(ctx, pi, undefined, true);
      }
      return;
    }

    // Circuit breaker tripped — no more stall intervention
    if (circuitBreakerTripped) return;
    sawAssistantMessage = false;

    // ── Reasoning-action mismatch detection ──
    // Runs before stall handling so it still fires on normal tool-call handoffs
    // (which return early from the stall block below). Assistant tool-call content
    // blocks use type "toolCall" with { name, arguments }.
    if (lastFailedToolCall) {
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      const thinkingContent = content.find(
        (item: any) => item.type === "thinking",
      ) as { text?: string } | undefined;
      llmAcknowledgedError = thinkingContent
        ? thinkingAcknowledgesError(thinkingContent.text ?? "")
        : false;

      if (llmAcknowledgedError) {
        const toolCalls = content.filter(
          (item: any) => item.type === "toolCall",
        ) as { name?: string; arguments?: Record<string, unknown> }[];

        for (const tc of toolCalls) {
          const argFingerprint = normalizeToolArgs(tc.name ?? "", tc.arguments);
          const callFingerprint = `${tc.name}:${argFingerprint}`;

          if (callFingerprint === lastFailedToolCall.fingerprint) {
            const errorSnippet = lastFailedToolCall.error.length > 60
              ? lastFailedToolCall.error.slice(0, 57) + "..."
              : lastFailedToolCall.error;

            const msg = `[Gallop] Mismatch: You acknowledged an error in your thinking but are about to call ${lastFailedToolCall.toolName} with the same arguments that just failed (error: "${errorSnippet}"). Change the tool call to match your reasoning.`;
            pi.sendUserMessage(msg, { deliverAs: "steer" });

            if (ctx.hasUI) {
              ctx.ui.notify("Gallop: reasoning-action mismatch", "warning");
            }

            // Clear tracking so we don't flag repeatedly
            lastFailedToolCall = null;
            llmAcknowledgedError = false;
            break;
          }
        }
      }
    }

    // ── Stall detection ──
    if (lastItemIsThinking(event.message) || lastItemIsToolUse(event.message)) {
      const stopReason = (event.message as any).stopReason;
      if (stopReason === "aborted" || stopReason === "error") return;

      // Normal tool call flow: LLM stops with stopReason "toolUse" to let the tool run.
      if (lastItemIsToolUse(event.message) && stopReason === "toolUse") {
        // Healthy handoff — resets the consecutive-stall streak.
        stallCount = 0;
        stallStopNotified = false;
        return;
      }

      stallCount++;
      const reason = lastItemIsThinking(event.message)
        ? "stopped mid-thought"
        : "stopped after tool call";

      // Count every stall so fast stuck loops still escalate, but throttle
      // resume messages to one per 10s so a stuck loop doesn't spam.
      const messageAllowed = Date.now() >= cooldownUntil;
      if (messageAllowed) {
        cooldownUntil = Date.now() + 10_000;
      }

      // Escalate based on consecutive stall count
      if (stallCount >= STALL_STOP) {
        // Stop sending resumes — context is likely corrupted.
        // Notify once; further stalls stay silent so the notice itself doesn't loop.
        if (!stallStopNotified) {
          stallStopNotified = true;
          const msg = `[Gallop] Agent has stalled ${stallCount} times consecutively. Stopping auto-resume to prevent infinite loop. Please try /new, /compact, or change the prompt.`;
          pi.sendUserMessage(msg, { deliverAs: "steer" });

          if (ctx.hasUI) {
            ctx.ui.notify(`Gallop: stall loop stopped (${stallCount} stalls)`, "error");
          }
        }
        return;
      }

      if (stallCount >= STALL_WARN) {
        if (messageAllowed) {
          const msg = `[Gallop] Resume: ${reason} (stopReason: ${stopReason}). This is stall #${stallCount} — if generation keeps stopping, consider compacting or restarting.`;
          pi.sendUserMessage(msg, { deliverAs: "steer" });

          if (ctx.hasUI) {
            ctx.ui.notify(`Gallop: repeated stall #${stallCount} (${reason})`, "warning");
          }
        }
        return;
      }

      if (messageAllowed) {
        const msg = `[Gallop] Resume: ${reason} (stopReason: ${stopReason})`;
        pi.sendUserMessage(msg, { deliverAs: "steer" });

        if (ctx.hasUI) {
          ctx.ui.notify(`Gallop: ${reason} (stopReason: ${stopReason})`, "info");
        }
      }
    } else {
      // Non-stall message — reset stall counter
      stallCount = 0;
      stallStopNotified = false;
    }
  });

  // ── Turn tracking ──

  pi.on("turn_start", async (event: { turnIndex: number }) => {
    currentTurnIndex = event.turnIndex;
  });

  // ── Tool call interceptor: enforce blocks ──

  pi.on("tool_call", async (event, ctx) => {
    // User halted via circuit breaker — block everything
    if (circuitBreakerHalted) {
      return { block: true, reason: `[Gallop] Agent halted by user (circuit breaker). Type a message or use /compact / /new.` };
    }
    // Circuit breaker tripped — no more auto-intervention
    if (circuitBreakerTripped) return;

    // Read guard: block reads of known binary file types (pdf, docx, zip, ...).
    // The read tool has no binary detection — it would dump raw bytes as garbled
    // UTF-8 text into context. Images (jpg/png/gif/webp/bmp) are excluded since
    // the read tool handles them natively.
    if (event.toolName === "read" && readGuardEnabled) {
      const readInput = event.input as { path?: unknown; file_path?: unknown } | undefined;
      const readPath = typeof readInput?.path === "string"
        ? readInput.path
        : typeof readInput?.file_path === "string"
          ? readInput.file_path
          : undefined;
      if (readPath) {
        const match = matchBinaryReadPath(readPath);
        if (match) {
          if (ctx.hasUI) {
            ctx.ui.notify(`Gallop: blocked read of ${match.ext} file`, "warning");
          }
          return {
            block: true,
            reason: `[Gallop] Blocked read of binary file "${readPath}" (${match.ext}) — the read tool cannot handle binary files and would dump raw bytes as garbled text into context. ${match.hint}. (The user can disable this guard with /gallop-read-guard off.)`,
          };
        }
      }
    }

    // Check failure-loop blocks (bash commands)
    if (blockedPatterns.size > 0 && event.toolName === "bash") {
      const command = (event.input as any)?.command;
      if (typeof command === "string") {
        const normalized = normalizeCommand(command);
        const reason = blockedPatterns.get(normalized);
        if (reason) {
          totalBlocks++;

          // Circuit breaker: too many blocks total — pause and let user decide
          if (totalBlocks >= CIRCUIT_BREAKER_BLOCKS) {
            return handleCircuitBreaker(ctx, pi);
          }

          if (ctx.hasUI) {
            ctx.ui.notify(`Gallop: blocked command ("${reason.slice(0, 50)}")`, "error");
          }
          return { block: true, reason: `[Gallop] Blocked: This command has been retried too many times with error "${reason}". Try a fundamentally different approach.` };
        }
      }
    }

    // Check repetitive-call blocks (all tools)
    if (repetitiveEscalation.size > 0) {
      // Prefer the fingerprint captured at tool_execution_start (raw args) so the
      // lookup key matches the one used when the block was recorded. Fall back to
      // recomputing from the (possibly coerced) validated input.
      const callFingerprint = pendingToolCalls.get(event.toolCallId)?.fingerprint
        ?? `${event.toolName}:${normalizeToolArgs(event.toolName, (event as any).input)}`;

      const repEntry = repetitiveEscalation.get(callFingerprint);
      if (repEntry && repEntry.level === "block") {
        totalBlocks++;

        // Circuit breaker
        if (totalBlocks >= CIRCUIT_BREAKER_BLOCKS) {
          return handleCircuitBreaker(ctx, pi);
        }

        const colonIndex = callFingerprint.indexOf(":");
        const toolName = colonIndex > -1 ? callFingerprint.slice(0, colonIndex) : event.toolName;
        const displayArg = (colonIndex > -1 ? callFingerprint.slice(colonIndex + 1) : "").length > 60
          ? (colonIndex > -1 ? callFingerprint.slice(colonIndex + 1) : "").slice(0, 57) + "..."
          : (colonIndex > -1 ? callFingerprint.slice(colonIndex + 1) : "");

        if (ctx.hasUI) {
          ctx.ui.notify(`Gallop: blocked repetitive call (${toolName})`, "error");
        }
        return { block: true, reason: `[Gallop] Blocked: You've called ${toolName} too many times with the same arguments (${displayArg}). Use a different tool or arguments.` };
      }
    }
  });

  // ── Binary output filter ──

  pi.on("tool_result", async (event) => {
    // bash: suppress binary command output. read: safety net for binary content
    // that slipped past the extension guard (misnamed or extension-less files,
    // unsupported image formats like tiff/heic). Image reads are safe — they
    // carry only a short printable text note.
    const isBash = event.toolName === "bash";
    const isRead = event.toolName === "read";
    if (!isBash && !isRead) return;
    if (isBash && !binarySuppressionEnabled) return;
    if (isRead && !readGuardEnabled) return;

    const content = event.content;
    if (!Array.isArray(content)) return;

    // Collect all text from content
    let fullText = "";
    for (const item of content) {
      if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
        fullText += item.text;
      }
    }

    if (!fullText.length) return;

    const detection = detectBinaryContent(fullText);
    if (detection.binary) {
      const rawBytes = new TextEncoder().encode(fullText);
      const bytes = rawBytes.length;
      let sourceLine: string;
      if (isRead) {
        const readInput = event.input as { path?: unknown; file_path?: unknown } | undefined;
        const readPath = typeof readInput?.path === "string"
          ? readInput.path
          : typeof readInput?.file_path === "string"
            ? readInput.file_path
            : "<unknown>";
        sourceLine = `Path: \`${readPath}\``;
      } else {
        const command = (event.input as any)?.command;
        const shortCommand = typeof command === "string"
          ? command.split("\n")[0].trim().length > 80
            ? command.split("\n")[0].trim().slice(0, 77) + "..."
            : command.split("\n")[0].trim()
          : "<unknown>";
        sourceLine = `Command: \`${shortCommand}\``;
      }

      // Hex dump of first 64 bytes for debugging (safe ASCII only)
      const headBytes = rawBytes.slice(0, 64);
      const hexHead = Array.from(headBytes)
        .map(b => b.toString(16).padStart(2, "0"))
        .join(" ");

      // Strip control chars (except newlines/tabs) and U+FFFD replacement
      // chars to extract readable lines
      const cleaned = fullText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, "");
      const lines = cleaned.split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map(l => l.replace(/\s+\d+%\s*/g, " ").replace(/\s+/g, " ").trim())
        .map(l => l.slice(0, 120));
      const headLines = lines.slice(0, 3);
      const tailLines = lines.length > 3 ? lines.slice(-5) : [];

      let summary = `[Gallop] Binary output suppressed — ${bytes.toLocaleString()} bytes (${detection.reason})\n${sourceLine}\nHead (hex): ${hexHead}`;
      if (headLines.length) summary += `\n> ${headLines.join("\n> ")}`;
      if (tailLines.length && lines.length > 3) {
        summary += `\n...\n> ${tailLines.join("\n> ")}`;
      }
      if (lines.length > 8) summary += `\n... (${lines.length} lines total)`;
      summary += "\nBinary content is hidden to protect context. The output was not sent to the model.";

      return {
        content: [{
          type: "text",
          text: summary,
        }],
      };
    }
  });

  // ── Failure-loop detection ──

  pi.on("tool_execution_start", async (event) => {
    // Stash args + fingerprint for this call. tool_execution_end events carry no
    // args field, so we look them up here. Used for bash failure-loop command
    // extraction, repetitive-call block matching, and mismatch arg fingerprinting.
    const args = event.args as Record<string, unknown> | undefined;
    const argFingerprint = normalizeToolArgs(event.toolName, args);
    const callFingerprint = `${event.toolName}:${argFingerprint}`;
    pendingToolCalls.set(event.toolCallId, { args, fingerprint: callFingerprint });

    // Safety cap: if tool_execution_end never fires for a call (e.g. blocked),
    // entries would leak — drop the oldest when the map grows unbounded.
    if (pendingToolCalls.size > 200) {
      const oldest = pendingToolCalls.keys().next().value;
      if (oldest !== undefined) pendingToolCalls.delete(oldest);
    }

    // Track ALL tools for repetitive-call detection
    if (repetitiveCallState && repetitiveCallState.fingerprint === callFingerprint) {
      repetitiveCallState.count += 1;
    } else {
      repetitiveCallState = {
        fingerprint: callFingerprint,
        count: 1,
      };
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Args are not present on tool_execution_end events; retrieve what
    // tool_execution_start stashed for this call.
    const pending = pendingToolCalls.get(event.toolCallId);

    // ── Bash failure-loop detection ──
    if (event.toolName === "bash") {
      const rawCommand = (pending?.args as any)?.command;
      if (typeof rawCommand === "string") {
        if (!event.isError) {
          // Successful execution — reset failure history and escalation to avoid stale detections
          failureHistory.length = 0;
          failureEscalation.clear();
          blockedPatterns.clear();
        } else {
          // Normalize the command for comparison
          const normalized = normalizeCommand(rawCommand);

          // Extract error fingerprint from result content
          const fingerprint = extractErrorFingerprint(event.result);

          // Skip Gallop-generated failures: blocked calls still emit
          // tool_execution_end with the block reason as the error result, and
          // recording those would pollute the loop history with block text.
          if (!fingerprint.startsWith("[gallop]")) {
            // Record the failure
            failureHistory.push({
              command: normalized,
              fingerprint,
              turnIndex: currentTurnIndex,
            });

            // Prune old entries outside the window
            pruneFailureHistory(failureHistory, currentTurnIndex, FAILURE_WINDOW_TURNS);

            // Check for failure loop
            checkFailureLoop(normalized, fingerprint, ctx, pi);
          }
        }
      }
    }

    // ── Track last failed tool call for mismatch detection ──
    if (event.isError) {
      const argFingerprint = normalizeToolArgs(event.toolName, pending?.args);
      const error = extractErrorFingerprint(event.result);
      // Skip Gallop-generated failures (blocks, circuit breaker) — the block
      // interceptor already handles those; mismatch detection would only add noise.
      lastFailedToolCall = error.startsWith("[gallop]")
        ? null
        : {
            toolName: event.toolName,
            fingerprint: `${event.toolName}:${argFingerprint}`,
            error,
          };
    } else {
      // Success clears mismatch tracking
      lastFailedToolCall = null;
    }

    // ── Repetitive-call detection ──
    // Skip when bash just failed — failure-loop handler already covered it.
    // Reset the consecutive counter on bash failure so a later success with the
    // same command isn't flagged as a repetitive success.
    if (event.toolName === "bash" && event.isError) {
      repetitiveCallState = null;
    } else {
      if (!event.isError) {
        // A successful call breaks the streak for OTHER fingerprints — clear
        // their escalation so a later legitimate re-use isn't hard-blocked from
        // an earlier streak. Keep the current fingerprint's entry so its own
        // ladder (nudge → nudge+ → block) continues uninterrupted.
        const current = repetitiveCallState?.fingerprint;
        for (const key of repetitiveEscalation.keys()) {
          if (key !== current) repetitiveEscalation.delete(key);
        }
      }
      if (repetitiveCallState && repetitiveCallState.count >= REPETITIVE_CALL_THRESHOLD) {
        checkRepetitiveCall(repetitiveCallState.fingerprint, repetitiveCallState.count, pi, ctx);
      }
    }

    pendingToolCalls.delete(event.toolCallId);
  });

  // ── Compaction: in-session checkpoint (cache-friendly) ──
  // When the live model called request_compact, its checkpoint summary is stashed
  // in selfSummary — return it (with the file-ops sections appended) as a custom
  // CompactionResult so pi skips its one-shot summarizer (a cold prefill of the
  // flattened conversation). Otherwise (native /compact, auto threshold, overflow
  // recovery, or a rejected/missing summary) return undefined and pi uses its
  // native one-shot — compaction always works.
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("compact", `${ctx.ui.theme.fg("dim", "· ")}${ctx.ui.theme.fg("warning", "⟳ Compacting...")}`);
    }
    // If compaction is cancelled, discard the stashed checkpoint — otherwise a
    // later, unrelated compaction would reuse a stale summary. Registered
    // unconditionally (not gated on hasUI) so a headless abort can't leave it.
    const onAbort = (): void => {
      selfSummary = null;
      qcompactSteering = false;
      if (ctx.hasUI) {
        ctx.ui.setStatus("compact", undefined);
      }
    };
    event.signal.addEventListener("abort", onAbort);
    try {
      const summary = selfSummary;
      selfSummary = null;
      if (!summary || summary.length < MIN_SUMMARY_LENGTH) return;
      return {
        compaction: {
          summary: appendSelfCompactFileOps(summary, event.preparation.fileOps),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: computeSelfCompactFileLists(event.preparation.fileOps),
        },
      };
    } finally {
      event.signal.removeEventListener("abort", onAbort);
    }
  });

  // ── context: prune the request_compact summary arg from LLM context ──
  // After a self-compact, the checkpoint text appears twice in every request:
  // as the compaction summary (pi renders compaction entries as messages with
  // role "compactionSummary") and as the `summary` argument of the
  // request_compact tool call in the kept tail (~1k duplicated tokens per
  // request). Prune the argument here — but only when that exact text is
  // verifiably carried by a compaction summary in context (gallop appends the
  // file sections after the summary text, so a byte-identical prefix match is
  // exact). Pre-compact tree views (no compactionSummary message), tool calls
  // from earlier compactions, and newer aborted calls all fail the check →
  // their arguments stay intact. The session file is never touched (the TUI
  // transcript still shows the full summary) and the rewrite is deterministic,
  // so the prefix stays cache-stable.
  pi.on("context", (event) => {
    const messagesIn = event.messages as any[];
    const lastCompaction = messagesIn.find(
      (m) => m?.role === "compactionSummary" && typeof m?.summary === "string",
    ) as { summary: string } | undefined;
    if (!lastCompaction) return;
    let changed = false;
    const messages = messagesIn.map((msg) => {
      if (!Array.isArray(msg?.content)) return msg;
      let msgChanged = false;
      const content = msg.content.map((block: any) => {
        if (block?.type !== "toolCall" || block.name !== "request_compact") return block;
        const summary = block.arguments?.summary;
        if (
          typeof summary === "string" &&
          summary.length >= MIN_SUMMARY_LENGTH &&
          lastCompaction.summary.startsWith(summary)
        ) {
          msgChanged = true;
          return {
            ...block,
            arguments: { ...block.arguments, summary: "[moved into the compaction summary]" },
          };
        }
        return block;
      });
      if (msgChanged) changed = true;
      return msgChanged ? { ...msg, content } : msg;
    });
    return changed ? { messages } : undefined;
  });

  pi.on("session_compact", async (_event: unknown, ctx: ExtensionContext) => {
    compactionRunning = false;
    if (ctx.hasUI) {
      ctx.ui.setStatus("compact", undefined);
    }
    // Reset all Gallop state after compaction to avoid stale state
    resetAllState();
  });
}
