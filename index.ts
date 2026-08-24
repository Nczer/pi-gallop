/**
 * Gallop Extension
 *
 * Keeps the agent moving:
 * - Detects stalled generation (stopped mid-thinking or mid-tool-call) and sends resume
 * - Detects repetitive command failure loops and nudges the agent to change strategy
 * - LLM can trigger compaction via `request_compact` with an in-session checkpoint summary
 * - Nudges the LLM to self-compact as the context nears its limit — pi's automatic
 *   compaction stays enabled as the backstop for non-compliant or overflowing runs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

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
/** A compact was requested during the last run but has not run yet. Set when
 *  request_compact executes ({ continue } from the tool arg). Consumed by the
 *  agent_settled handler, which triggers the compact. Deferring to agent_settled is what makes
 *  the trigger race-free: pi's automatic threshold compaction runs in the post-run
 *  loop, BEFORE the settled event. If it fired, it consumed the stashed summary
 *  via session_before_compact and session_compact cleared this flag — the manual
 *  compact that would otherwise hit pi's "Already compacted" error is never
 *  started. Cleared by session_compact (a compaction already did the work) and by
 *  session reset. */
let pendingCompact: { continue: boolean } | null = null;
/** Re-entrancy guard for ctx.compact(). Set when a compact actually starts;
 *  cleared only at a true new-turn boundary (a new user message or a new
 *  session) — NOT on session_compact or compact complete/error.
 *  Belt-and-braces: the deferred trigger already makes double-compaction a no-op,
 *  this stops a redundant second ctx.compact() (and its continue message) in the
 *  window before the next user turn. */
let compactionInFlight = false;
/** True while a ctx.compact() call is actually executing (from trigger to
 *  session_compact / onError). Distinguishes "compact running" from the
 *  post-compaction re-trigger window. */
let compactionRunning = false;
/** Context-pressure nudge state, one nudge per compaction cycle. "idle" →
 *  advisory nudge just above pi's automatic threshold (reserveTokens +
 *  NUDGE_BUFFER, or a fixed 16k when auto-compact is disabled); "nudged" →
 *  silence — pi's automatic compaction is the backstop (or nothing, if it is
 *  disabled). Reset on every compaction and session reset. */
let contextNudgeState: "idle" | "nudged" = "idle";
/** Buffer above pi's automatic threshold for the self-compact nudge — the
 *  model gets one more message of warning before the native backstop fires. */
const NUDGE_BUFFER = 2_048;
/** Nudge threshold when pi's automatic compaction is disabled — no backstop
 *  exists, so a fixed 16k (pi's default reserve). */
const NUDGE_DISABLED_AT = 16_000;
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

/** True when the message contains a request_compact tool call. pi emits
 *  message_end BEFORE the message's tool calls execute, so this is how the
 *  nudge path sees an en-route compact — pendingCompact is only set later,
 *  in the tool's execute. */
export function messageContainsRequestCompact(message: { content?: unknown[] }): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (item) =>
      typeof item === "object" && item !== null &&
      (item as any).type === "toolCall" && (item as any).name === "request_compact",
  );
}

const CONTINUE_STEER_MESSAGE = "[Gallop] Compact done — proceed as commanded.";

/** Inject the generic proceed message a beat after compaction completes — the
 *  checkpoint's Next Steps section carries the actual "what next", so no custom
 *  resume text is ever written or re-sent. */
function scheduleContinueSteer(pi: ExtensionAPI): void {
  setTimeout(() => {
    pi.sendUserMessage(CONTINUE_STEER_MESSAGE, { deliverAs: "steer" });
  }, 200);
}

function triggerCompaction(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  instructions?: string,
  continueAfter: boolean = false,
): void {
  // Re-entrancy guard: skip a redundant second trigger while a compact from the
  // previous turn boundary is still settling. (The deferred agent_settled trigger
  // already prevents the automatic-threshold double-compact; this covers any
  // other re-trigger before the next user message.)
  if (compactionInFlight) {
    return;
  }
  compactionInFlight = true;
  compactionRunning = true;
  ctx.compact({
    customInstructions: instructions,
    onComplete: () => {
      if (continueAfter) {
        scheduleContinueSteer(pi);
      }
    },
    onError: () => {
      // Compaction failed or was cancelled — mark it as no longer running so a
      // later attempt isn't blocked.
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
// its one-shot summarizer (a cold prefill of the flattened conversation).
//
// The compact itself is DEFERRED to agent_settled, not fired inside the tool's
// execute. ctx.compact() first awaits the agent to become idle, which happens
// only AFTER pi's post-run loop — where the automatic threshold compaction
// runs. Firing from execute when the run's final usage crossed the threshold
// would therefore always double-compact: the automatic compact completes first
// (consuming the stashed summary), then the manual one throws "Already
// compacted" and the TUI shows an error. Deferring to agent_settled (which
// fires after the post-run loop) makes the outcome deterministic: automatic
// compaction already ran → session_compact cleared the pending state → no
// trigger; nothing ran → the deferred trigger compacts now, with the stashed
// summary if the model called the tool, pi's native one-shot otherwise.
//
// The summary text would stay in the kept tail as the tool call's arguments —
// duplicated on every request — and the exchange (call + "Compacting (…)" result)
// would read as an unfulfilled compact request. The `context` handler below
// replaces it with a short completion marker once a compaction summary is in
// context (session file untouched; per-path rules there). When no usable summary
// is stashed (native /compact, auto threshold, overflow recovery, or a too-short
// summary), session_before_compact returns undefined and pi uses its native
// one-shot — compaction always works.

/** Below this length a stashed summary is rejected (pi's one-shot runs instead). */
const MIN_SUMMARY_LENGTH = 200;

/** The in-context completion marker that replaces a request_compact exchange
 *  once the compaction has run (see the `context` handler). A fixed string —
 *  the rewrite must be deterministic or the request prefix loses cache
 *  stability. "summary" (not "checkpoint"): on the native-fallback path the
 *  top summary is pi's one-shot, not the model's checkpoint. Revocable by
 *  design — a later task that fills the context again may compact again. */
export const COMPACT_DONE_MARKER =
  "[Gallop] Compaction complete — the summary at the top of context is your current state. Do not call request_compact again unless context pressure returns.";

/** The exact checkpoint format the model must use. Carried by the
 *  request_compact tool description (system prompt). */
/** Checkpoint summary format. The kept-tail line is parameterized: pi's
 *  compaction.keepRecentTokens (default 20k) is user-configurable, and the
 *  guidance must match what pi will actually keep verbatim. */
export function checkpointFormat(keepRecentTokens: number = PI_COMPACTION_DEFAULTS.keepRecentTokens): string {
  return `## Goal
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
Focus on OLDER work — the most recent ~${Math.round(keepRecentTokens / 1000)}k tokens are kept verbatim, so do not restate
what is already recent. If a previous checkpoint summary is present in the conversation,
fold its still-relevant content into this one.`;
}

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

/** Count context tokens the way pi's threshold check does
 *  (calculateContextTokens, not exported from the package). */
export function contextTokensFromUsage(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
} | undefined): number {
  if (!usage) return 0;
  const sum = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return usage.totalTokens ?? sum;
}

/** Pi's compaction settings, as gallop needs them. The extension API does not
 *  expose settings, so read the settings.json files directly (read-only —
 *  gallop never writes pi's files): global `~/.pi/agent/settings.json` plus
 *  project `<cwd>/.pi/settings.json`, merged per key with the project winning
 *  (mirrors pi's FileSettingsStorage; same reader shape as the context
 *  extension). Missing/unparseable files fall back to pi's defaults. */
export interface PiCompactionSettings {
  reserveTokens: number;
  enabled: boolean;
  keepRecentTokens: number;
}

const PI_COMPACTION_DEFAULTS: PiCompactionSettings = { reserveTokens: 16_384, enabled: true, keepRecentTokens: 20_000 };

export function readPiCompactionSettings(
  cwd: string,
  globalPath: string = path.join(os.homedir(), ".pi", "agent", "settings.json"),
): PiCompactionSettings {
  const readCompaction = (file: string): { reserveTokens?: number; enabled?: boolean; keepRecentTokens?: number } | undefined => {
    try {
      const data: any = JSON.parse(readFileSync(file, "utf8"));
      return data?.compaction && typeof data.compaction === "object" ? data.compaction : undefined;
    } catch {
      return undefined;
    }
  };
  const global = readCompaction(globalPath) ?? {};
  const project = readCompaction(path.join(cwd, ".pi", "settings.json")) ?? {};
  return {
    reserveTokens: project.reserveTokens ?? global.reserveTokens ?? PI_COMPACTION_DEFAULTS.reserveTokens,
    enabled: project.enabled ?? global.enabled ?? PI_COMPACTION_DEFAULTS.enabled,
    keepRecentTokens: project.keepRecentTokens ?? global.keepRecentTokens ?? PI_COMPACTION_DEFAULTS.keepRecentTokens,
  };
}

/** Remaining-token threshold at which gallop nudges the model to self-compact:
 *  just above pi's automatic threshold (reserveTokens + NUDGE_BUFFER) when
 *  auto-compact is on, or a fixed 16k when it is off (nothing else would
 *  fire). */
export function nudgeThreshold(settings: PiCompactionSettings = PI_COMPACTION_DEFAULTS): number {
  return settings.enabled ? settings.reserveTokens + NUDGE_BUFFER : NUDGE_DISABLED_AT;
}

/**
 * Nudge the LLM to self-compact as the context nears its limit: one advisory
 * steer per compaction cycle, just above pi's automatic threshold (or at a
 * fixed 16k when auto-compact is disabled — then no backstop exists). A
 * compliant model compacts cache-warm before the native backstop takes over;
 * after the nudge, silence — the backstop (or overflow) decides. Like the old
 * per-turn context-usage injection (removed in v1.3 as ambient noise), this
 * rides the session's cached prompt prefix — but it fires at most once per
 * compaction cycle instead of every turn.
 */
function checkContextNudge(
  message: {
    stopReason?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
    content?: unknown[];
  },
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  if (circuitBreakerHalted) return;              // agent halted — a steer would restart a run where every tool is blocked
  if (pendingCompact) return;                     // a compact request is already pending
  if (compactionRunning) return;                 // compact in flight — usage about to drop
  // pi emits message_end BEFORE this message's tool calls execute — a message
  // containing request_compact has a compact en route the two state guards
  // above cannot see yet (execute runs after this event). Skip, or the nudge
  // steer lands around the compaction boundary: "call request_compact now"
  // right after the model just called it.
  if (messageContainsRequestCompact(message)) return;
  if (message.stopReason === "aborted" || message.stopReason === "error") return;
  const window = ctx.model?.contextWindow ?? 0;
  const tokens = contextTokensFromUsage(message.usage);
  if (window <= 0 || tokens <= 0) return;
  const remaining = window - tokens;

  const settings = readPiCompactionSettings(ctx.cwd);
  if (remaining > nudgeThreshold(settings)) return;
  if (contextNudgeState === "nudged") return;    // one nudge per compaction cycle
  contextNudgeState = "nudged";

  const k = Math.max(1, Math.round(remaining / 1000));
  if (settings.enabled) {
    const m = Math.max(1, Math.round(settings.reserveTokens / 1000));
    pi.sendUserMessage(
      `[Gallop] Context is nearly full (~${k}k tokens remaining; pi's automatic compaction triggers at ~${m}k). If the current work is at a sensible pause point, write a checkpoint summary and call request_compact now so the summary stays cache-warm.`,
      { deliverAs: "steer" },
    );
  } else {
    pi.sendUserMessage(
      `[Gallop] Context is nearly full (~${k}k tokens remaining) and pi's automatic compaction is disabled. If the current work is at a sensible pause point, write a checkpoint summary and call request_compact now — a context overflow would otherwise abort the run.`,
      { deliverAs: "steer" },
    );
  }
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
 * Clear block state after the breaker steps back. Resets totalBlocks too,
 * otherwise the next block immediately re-trips the breaker and spams the
 * steer message every call.
 */
function stepBackAfterBlocks(pi: ExtensionAPI, note: string): void {
  const enforced = totalBlocks;
  blockedPatterns.clear();
  failureEscalation.clear();
  repetitiveEscalation.clear();
  totalBlocks = 0;
  circuitBreakerTripped = false;
  pi.sendUserMessage(
    `[Gallop] Circuit breaker: ${enforced} blocks enforced. Stepping back${note}.`,
    { deliverAs: "steer" },
  );
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
      // Block all further tool calls — agent will halt and return to prompt.
      // A plain user message does NOT unblock (only /compact, /new, or a
      // breaker reset call resetAllState), so the wording must not promise
      // otherwise.
      circuitBreakerHalted = true;
      pi.sendUserMessage(
        `[Gallop] Circuit breaker: agent halted by user. Tools stay blocked until you use /compact or /new.`,
        { deliverAs: "steer" },
      );
      return { block: true, reason: `[Gallop] Circuit breaker: agent halted by user. Use /compact or /new to unblock tools.` };
    }

    if (choice === "Continue") {
      // "Continue" — full reset, fresh Gallop state
      resetAllState();
      pi.sendUserMessage(
        `[Gallop] Circuit breaker: blocks cleared by user. Continuing.`,
        { deliverAs: "steer" },
      );
    } else {
      // Dialog dismissed with no choice — step back rather than claiming the
      // user cleared the blocks.
      stepBackAfterBlocks(pi, " (dialog dismissed)");
    }
  } else {
    // No UI — just step back.
    stepBackAfterBlocks(pi, " (no UI)");
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
  pendingCompact = null;
  contextNudgeState = "idle";

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

// ── request_compact rendering (TUI + /export HTML) ──
// Without renderCall/renderResult, pi's /export HTML falls into its default
// case — JSON.stringify(args), i.e. the full checkpoint summary dumped in
// every export (native tools like read/bash ship one-line renderers instead).
// These renderers keep the native look: a one-line title plus the short
// result line. The checkpoint itself is deliberately NOT rendered here — the
// [compaction] entry right below the call already carries it (Ctrl+O in the
// TUI, click in the export), and showing it in the tool view would print the
// same text twice under the same expand toggle.
// Structural theme type: pi's Theme satisfies it; keeps the helpers free of
// a pi-internal Theme import.

interface CompactRenderTheme {
  fg: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

function formatCompactCallLine(theme: CompactRenderTheme): string {
  const bold = theme.bold ?? ((s: string) => s);
  return theme.fg("toolTitle", bold("request_compact"));
}

function formatCompactResultText(
  theme: CompactRenderTheme,
  result: { content?: Array<{ type: string; text?: string }> } | undefined,
  options: { isPartial?: boolean },
): string {
  if (options.isPartial) return theme.fg("warning", "Compacting…");
  const text = (result?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
  return text ? theme.fg("toolOutput", text) : "";
}

// ── Main extension ──

export default function gallopExtension(pi: ExtensionAPI) {
  // The checkpoint guidance must name the tail pi actually keeps: the user
  // may customize compaction.keepRecentTokens (default 20k). Read at
  // registration time — a changed setting takes effect on the next /reload,
  // like the rest of the extension's load-time state. The extension factory
  // gets no session ctx, so the project-scope lookup uses process.cwd() (the
  // session cwd for a normal pi launch); the nudge threshold below still
  // reads ctx.cwd live.
  const keepRecentTokens = readPiCompactionSettings(process.cwd()).keepRecentTokens;
  // ── Tool: LLM can request compaction ──

  pi.registerTool({
    name: "request_compact",
    label: "Request Compact",
    description: `Compact context to reduce token usage. Discards bloat while preserving active tasks.
- Call when: edit tool fails 2+ times (context bloat broke text matching), large diffs accumulated, a planned task finished and another is queued (compact at the boundary — the next task starts on a fresh context), the session is long, or a [Gallop] context-pressure notice asks you to.
- Write the checkpoint summary yourself in the 'summary' argument, in this exact format:

${checkpointFormat(keepRecentTokens)}
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
    async execute(_id: string, params: { message?: string; summary?: string; continue?: boolean }, _signal, _onUpdate, _ctx) {
      const message = params?.message || "model-initiated";

      // Stash the model's checkpoint for session_before_compact. A too-short summary
      // falls back to pi's native one-shot there, so compaction always works.
      const summary = (params?.summary || "").trim();
      selfSummary = summary.length >= MIN_SUMMARY_LENGTH ? summary : null;

      // Defer the actual compact to agent_settled (the run ends right after this
      // terminate result). If the run's final usage crossed pi's automatic
      // threshold, pi's post-run compaction consumes the stashed summary first
      // and session_compact clears pendingCompact — no double trigger, no
      // "Already compacted" error. Otherwise the settled handler triggers the
      // compact here with the stashed summary.
      pendingCompact = { continue: params?.continue === true };

      // Do NOT echo the summary in the tool result: after compaction the
      // checkpoint lives in the compaction entry (top of context), and the
      // context handler below replaces the request_compact exchange with the
      // completion marker anyway. The user-visible message is the short 'message' arg.
      return {
        details: {},
        content: [{
          type: "text",
          text: `Compacting (${message}).`,
        }],
        terminate: true,
      };
    },
    renderCall(
      _args: { message?: string; summary?: string },
      theme: CompactRenderTheme,
    ) {
      return new Text(formatCompactCallLine(theme), 0, 0);
    },
    renderResult(
      result: { content?: Array<{ type: string; text?: string }> },
      options: { isPartial?: boolean },
      theme: CompactRenderTheme,
    ) {
      return new Text(formatCompactResultText(theme, result, options), 0, 0);
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

    // Circuit breaker tripped — no more auto-intervention, including the
    // context nudge (a steer would restart a run gallop is backing off from).
    if (circuitBreakerTripped) return;

    // ── Context-pressure nudge ──
    checkContextNudge(event.message, ctx, pi);

    // request_compact: message_end triggers nothing. pi emits message_end
    // BEFORE pending tool calls execute, and pi's automatic threshold
    // compaction (when the run crossed it) runs in the post-run loop — both are
    // resolved deterministically at agent_settled, where the deferred trigger
    // compacts with the stashed summary, or skips entirely when a compaction
    // already ran.

    // Circuit breaker tripped — no more stall intervention
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

  // ── Deferred compact trigger ──
  // agent_settled fires only after the post-run loop has completed — i.e. AFTER
  // pi's automatic threshold compaction had its chance to run (it consumes the
  // stashed summary via session_before_compact and clears pendingCompact via
  // session_compact). Triggering the requested compact HERE, instead of inside
  // the tool's execute, is what makes the race a no-op: a compaction that
  // already ran leaves nothing pending, so the manual compact that would
  // otherwise throw "Already compacted" is never started.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingCompact) return;
    const continueAfter = pendingCompact.continue;
    pendingCompact = null;
    // Second line of defense (session_compact normally already cleared the
    // pending state): if the branch already ends in a compaction entry — e.g.
    // a user /compact in the same window — there is nothing to compact.
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    if (branch[branch.length - 1]?.type === "compaction") return;
    triggerCompaction(ctx, pi, undefined, continueAfter);
  });

  // ── Turn tracking ──

  // Monotonic counter, NOT pi's turnIndex: pi resets it to 0 on every
  // agent_start (including agent.continue() runs), which would leave
  // failureHistory entries from the previous run un-prunable and counted
  // into the new run's window. Counting turns ourselves keeps the failure
  // window "last N turns" across runs. resetAllState zeroes it together with
  // failureHistory on session start / compaction.
  pi.on("turn_start", async () => {
    currentTurnIndex += 1;
  });

  // ── Tool call interceptor: enforce blocks ──

  pi.on("tool_call", async (event, ctx) => {
    // User halted via circuit breaker — block everything
    if (circuitBreakerHalted) {
      return { block: true, reason: `[Gallop] Agent halted by user (circuit breaker). Use /compact or /new to unblock tools.` };
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
    const error = event.isError ? extractErrorFingerprint(event.result) : "";
    // Gallop-generated failures (blocks, circuit breaker) — the block
    // interceptor already handles those; mismatch and repetitive detection
    // would only add noise on top of gallop's own signal.
    const isGallopBlock = error.startsWith("[gallop]");
    if (event.isError) {
      const argFingerprint = normalizeToolArgs(event.toolName, pending?.args);
      lastFailedToolCall = isGallopBlock
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
    // Gallop-blocked calls (e.g. the read guard) are invisible to the ladder:
    // the block reason is the only signal for them (it already tells the model
    // what to do), so a blocked call neither starts a streak nor extends one —
    // undo the increment tool_execution_start made for it.
    if (isGallopBlock) {
      if (repetitiveCallState && pending && repetitiveCallState.fingerprint === pending.fingerprint) {
        repetitiveCallState.count -= 1;
        if (repetitiveCallState.count === 0) repetitiveCallState = null;
      }
    } else if (event.toolName === "bash" && event.isError) {
      // Bash failure: the failure-loop handler already covered it. Reset the
      // consecutive counter so a later success with the same command isn't
      // flagged as a repetitive success.
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
    // The stash is consumed eagerly below (nulled before the result is
    // returned), so a cancelled compaction can't leak the summary into a
    // later, unrelated compaction. The abort listener only clears the status
    // line — registered unconditionally so a headless abort can't leave it.
    const onAbort = (): void => {
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

  // ── context: replace the request_compact exchange with a completion marker ──
  // After a self-compact, the checkpoint text appears twice in every request:
  // as the compaction summary (pi renders compaction entries as messages with
  // role "compactionSummary") and as the `summary` argument of the
  // request_compact tool call in the kept tail (~1k duplicated tokens per
  // request). The exchange is also a liability — dropping it outright (the
  // previous behavior) left the nudge that triggered the compact ("…call
  // request_compact now") standing in the tail as an unfulfilled instruction
  // while its fulfillment was gone, and a `continue: false` compact delivers
  // no other completion signal. The resumed model then rationally re-requested
  // (field: two back-to-back double-compacts, the second preempting the user's
  // "proceed to phase 2"). So the exchange is REPLACED, not deleted:
  //
  //  - Carried verbatim (gallop appends the file sections after the summary
  //    text, so a byte-identical prefix match is exact): the assistant message
  //    carrying the call is rewritten to COMPACT_DONE_MARKER and the paired
  //    toolResult is dropped. The marker closes the loop in place — right
  //    after the work, before the user's next message — and points to the
  //    summary at the top of context.
  //  - Not carried (native-fallback: a too-short/absent summary, so pi's
  //    one-shot ran): the call stays as a true record of the model's short
  //    text, but its "Compacting (…)" result reads as in-progress — rewrite
  //    just the result text to the marker once any compaction summary is in
  //    context. (Edge: an ABORTED botched compact with an OLDER compaction in
  //    context is marked done too; a missed re-request then waits for the next
  //    pressure point — pi's overflow recovery still backstops.)
  //  - Batched with sibling tool calls: the message, siblings and their
  //    results stay; the compact block drops and the marker is appended as a
  //    text block so the completion remains visible.
  //  - Orphaned toolResult (the cut point split the compact turn): dropped,
  //    no marker — a toolResult without its toolCall is an API error, and the
  //    top summary already says compaction happened.
  //
  // Pre-compact tree views (no compactionSummary message) and aborted compacts
  // leave everything intact — on abort "Compacting (…)" is true, and a
  // re-request is the correct recovery. The triggering nudge is left untouched
  // (a live post-compaction nudge is indistinguishable from a stale one in the
  // rendered context); with the marker present it reads as fulfilled. The
  // session file is never touched (the TUI transcript still shows the full
  // summary) and the rewrite is deterministic, so the prefix stays cache-stable.
  pi.on("context", (event) => {
    const messagesIn = event.messages as any[];
    // Collect ALL compaction summaries in context: an earlier compaction entry
    // can sit inside the newest compaction's kept tail, so context may carry
    // several compactionSummary messages. A carried check matches ANY of them —
    // the call that was compacted most recently matches the newest, a call
    // from an earlier task still in the tail matches the older one.
    const compactionSummaries: string[] = [];
    for (const m of messagesIn) {
      if (m?.role === "compactionSummary" && typeof m?.summary === "string") {
        compactionSummaries.push((m as { summary: string }).summary);
      }
    }
    if (compactionSummaries.length === 0) return;

    // Classify every request_compact call in context (also feeds orphan
    // detection):
    //  - carried: its summary text is verifiably in a compaction summary →
    //    replace the exchange with the marker (dedupe + completion closure)
    //  - fallback: not carried → keep the call, mark its result done
    const callIdsInContext = new Set<string>();
    // Carried calls get the exchange replaced; every OTHER request_compact call
    // in context is a native-fallback call (result gets marked done).
    const carriedCallIds = new Set<string>();
    for (const msg of messagesIn) {
      if (!Array.isArray(msg?.content)) continue;
      for (const block of msg.content) {
        if (block?.type !== "toolCall" || block.name !== "request_compact") continue;
        if (typeof block.id !== "string") continue;
        callIdsInContext.add(block.id);
        const summary = block.arguments?.summary;
        if (
          typeof summary === "string" &&
          summary.length >= MIN_SUMMARY_LENGTH &&
          compactionSummaries.some((s) => s.startsWith(summary))
        ) {
          carriedCallIds.add(block.id);
        }
      }
    }

    let changed = false;
    const messages: any[] = [];
    for (const msg of messagesIn) {
      // request_compact toolResult: orphan (call summarized out of the window)
      // → drop (an unpaired toolResult is an API error); paired with a carried
      // call → drop (the marker message carries the closure); paired with a
      // fallback call → rewrite the in-progress text to the marker.
      if (msg?.role === "toolResult" && msg?.toolName === "request_compact") {
        const id = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
        if (!id || !callIdsInContext.has(id) || carriedCallIds.has(id)) {
          changed = true;
          continue;
        }
        messages.push({ ...msg, content: [{ type: "text", text: COMPACT_DONE_MARKER }] });
        changed = true;
        continue;
      }
      if (!Array.isArray(msg?.content)) {
        messages.push(msg);
        continue;
      }
      const blocks = msg.content as any[];
      const isCarried = (b: any) => b?.type === "toolCall" && typeof b?.id === "string" && carriedCallIds.has(b.id);
      if (!blocks.some(isCarried)) {
        messages.push(msg);
        continue;
      }
      if (blocks.some((b) => b?.type === "toolCall" && !isCarried(b))) {
        // Batched with other tool calls: keep the message and the siblings
        // (their results stay), drop only the compact call block, and append
        // the marker so the compact's completion stays visible.
        messages.push({ ...msg, content: [...blocks.filter((b) => !isCarried(b)), { type: "text", text: COMPACT_DONE_MARKER }] });
        changed = true;
        continue;
      }
      // Otherwise the message is the compact exchange itself (optionally with
      // explanatory text — the checkpoint carries it) → replace the whole
      // message with the completion marker.
      messages.push({ ...msg, content: [{ type: "text", text: COMPACT_DONE_MARKER }] });
      changed = true;
    }
    return changed ? { messages } : undefined;
  });

  pi.on("session_compact", async (_event: unknown, ctx: ExtensionContext) => {
    compactionRunning = false;
    if (ctx.hasUI) {
      ctx.ui.setStatus("compact", undefined);
    }
    // If this compaction satisfied a pending request — e.g. pi's automatic
    // threshold compaction consumed the stashed summary before the deferred
    // trigger could run — deliver the proceed message here; the deferred
    // trigger will be a no-op. (The manual path delivers its own via
    // onComplete; its pending state is already cleared by then.)
    const continueAfter = pendingCompact?.continue ?? false;
    // Reset all Gallop state after compaction to avoid stale state
    resetAllState();
    if (continueAfter) {
      scheduleContinueSteer(pi);
    }
  });
}
