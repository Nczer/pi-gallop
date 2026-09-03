/**
 * self-compact.ts — model-initiated compaction, the "gallop" loop.
 *
 * The live model writes the checkpoint summary itself as compact_request's
 * `summary` argument — a normal session turn, so that LLM call rides the
 * session's cached prompt prefix (no cold prefill). The summary is stashed
 * and returned by session_before_compact as a custom CompactionResult, so
 * pi skips its one-shot summarizer (a cold prefill of the flattened
 * conversation).
 *
 * The compact itself is DEFERRED to agent_settled, not fired inside the
 * tool's execute. ctx.compact() first awaits the agent to become idle, which
 * happens only AFTER pi's post-run loop — where the automatic threshold
 * compaction runs. Firing from execute when the run's final usage crossed the
 * threshold would therefore always double-compact: the automatic compact
 * completes first (consuming the stashed summary), then the manual one
 * throws "Already compacted" and the TUI shows an error. Deferring to
 * agent_settled (which fires after the post-run loop) makes the outcome
 * deterministic: automatic compaction already ran → session_compact cleared
 * the pending state → no trigger; nothing ran → the deferred trigger
 * compacts now, with the stashed summary if the model called the tool, pi's
 * native one-shot otherwise.
 *
 * A user message typed while the compact is pending would otherwise be
 * queued by pi and its post-run loop would process it BEFORE the deferred
 * compact (agent_settled waits for queued continuations) — running it on the
 * stale, un-compacted context and delaying the compact until that run ends.
 * The input handler (onInput) swallows interactive messages while
 * pendingCompact is set; session_compact re-delivers them after the
 * compaction (and session_compact_failed delivers them immediately when the
 * compact fails).
 *
 * The summary text would stay in the kept tail as the tool call's arguments
 * — duplicated on every request — and the exchange (call + "Compacting."
 * result) would read as an unfulfilled compact request. The `context`
 * handler (onContext) replaces it with a short completion marker once a
 * compaction summary is in context (session file untouched; per-path rules
 * below). When no usable summary is stashed (native /compact, auto
 * threshold, overflow recovery, or a too-short summary),
 * session_before_compact returns undefined and pi uses its native one-shot
 * — compaction always works.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  CompactionEntry,
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { findCutPoint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { compactRequestRenderers, contextStatusRenderers } from "./render";
import { halted as interventionHalted } from "./intervention";

// ── Pi's compaction settings ──

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

// ── Thresholds and formats ──

/** Buffer above pi's automatic threshold for the self-compact nudge — the
 *  model gets one more message of warning before the native backstop fires. */
const NUDGE_BUFFER = 2_048;
/** Nudge threshold when pi's automatic compaction is disabled — no backstop
 *  exists, so a fixed 16k (pi's default reserve). */
const NUDGE_DISABLED_AT = 16_000;
/** Context size (tokens used) beyond which context_status suggests a
 *  compaction even with ample headroom — models (especially local ones)
 *  perform best under ~100k. Suggestion only: the model decides whether the
 *  next task still needs the current window. */
export const SOFT_NUDGE_TOKENS = 100_000;

/** Below this length a stashed summary is rejected (pi's one-shot runs instead). */
const MIN_SUMMARY_LENGTH = 200;

/** The in-context completion marker that replaces a compact_request exchange
 *  once the compaction has run (see the `context` handler). A fixed string —
 *  the rewrite must be deterministic or the request prefix loses cache
 *  stability. "summary" (not "checkpoint"): on the native-fallback path the
 *  top summary is pi's one-shot, not the model's checkpoint. Revocable by
 *  design — a later task that fills the context again may compact again. */
export const COMPACT_DONE_MARKER =
  "[Gallop] Compaction complete — the summary at the top of context is your current state. Do not call compact_request again unless context pressure returns.";

/** Checkpoint summary format — the exact format the model must use, carried
 *  by the compact_request tool description (system prompt). The kept-tail
 *  line is parameterized: pi's compaction.keepRecentTokens (default 20k) is
 *  user-configurable, and the guidance must match what pi will actually keep
 *  verbatim. */
export function checkpointFormat(keepRecentTokens: number = PI_COMPACTION_DEFAULTS.keepRecentTokens): string {
  return `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user or found]
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

/** Remaining-token threshold at which gallop nudges the model to self-compact:
 *  just above pi's automatic threshold (reserveTokens + NUDGE_BUFFER) when
 *  auto-compact is on, or a fixed 16k when it is off (nothing else would
 *  fire). */
export function nudgeThreshold(settings: PiCompactionSettings = PI_COMPACTION_DEFAULTS): number {
  return settings.enabled ? settings.reserveTokens + NUDGE_BUFFER : NUDGE_DISABLED_AT;
}

/** Format a token count for the LLM: 950 → "950", 1200 → "1.2k", 200000 → "200k". */
export function formatTokenCount(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

/** The context_status advice line: one deterministic tier — the model gets a
 *  recommendation, not raw math to interpret. Tiers: > 2× threshold → headroom
 *  OK; (threshold, 2×] → pressure building; ≤ threshold → near the backstop.
 *  A large context (> SOFT_NUDGE_TOKENS used) with otherwise-OK headroom gets
 *  a suggestion-only compact hint instead of "headroom OK". */
export function contextStatusAdvice(remaining: number, tokens: number, settings: PiCompactionSettings): string {
  const threshold = nudgeThreshold(settings);
  if (remaining <= threshold) {
    return settings.enabled
      ? "Advice: near the backstop — call compact_request now if at a pause point."
      : "Advice: near the limit and auto-compact is off — call compact_request now if at a pause point.";
  }
  if (remaining <= 2 * threshold) {
    return "Advice: pressure building — if a large batch of reads or images is ahead, call compact_request at this boundary first.";
  }
  if (tokens > SOFT_NUDGE_TOKENS) {
    return `Advice: large context (~${formatTokenCount(tokens)} used) — models (especially local) work best under ~100k; if the next task does not depend on the current context window, call compact_request at this boundary.`;
  }
  return "Advice: headroom OK.";
}

/** Build the context_status tool result. Pure function of (usage, settings)
 *  so the tiers and formatting are unit-testable. usage is pi's own
 *  getContextUsage() — the same last-usage-anchored estimate pi's automatic
 *  threshold check uses, so the numbers match the backstop. tokens === null
 *  only in the window right after a compaction, before the next assistant
 *  response carries usage. */
export function buildContextStatusText(
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
  settings: PiCompactionSettings,
): string {
  if (!usage || usage.contextWindow <= 0) {
    return "No context usage data available (no model or context window).";
  }
  if (usage.tokens === null) {
    return "Context was just compacted — exact usage is unknown until the next response. Context is fresh; safe to proceed.";
  }
  const remaining = Math.max(0, usage.contextWindow - usage.tokens);
  const pct = usage.percent !== null ? usage.percent.toFixed(1) : "?";
  const lines = [
    `${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} tokens (${pct}%) — ${formatTokenCount(remaining)} remaining`,
  ];
  if (settings.enabled) {
    lines.push(
      `Thresholds: gallop nudge ~${formatTokenCount(nudgeThreshold(settings))} remaining · pi auto-compact ~${formatTokenCount(settings.reserveTokens)} remaining`,
    );
  } else {
    lines.push(
      `Thresholds: gallop nudge ~${formatTokenCount(nudgeThreshold(settings))} remaining · pi auto-compact OFF (no backstop)`,
    );
  }
  lines.push(contextStatusAdvice(remaining, usage.tokens, settings));
  return lines.join("\n");
}

/** Minimum-context guard for compact_request. pi's compact keeps the most recent
 *  configuredKeep (compaction.keepRecentTokens, default 20k) verbatim and summarizes
 *  everything older; when the whole context fits in that window pi's prepareCompaction
 *  bails out (returns undefined) and the compact fails — including a nuke, which pi
 *  evaluates with the CONFIGURED window, before any extension hook runs. Returns the
 *  error message to fail the tool call with, or null when the call may proceed.
 *  tokens === null (the window right after a compaction, before the next assistant
 *  response carries usage) is unmeasurable → proceed and let pi decide. */
export function tooSmallCompactError(
  tokens: number | null | undefined,
  configuredKeep: number,
  nuke: boolean,
): string | null {
  if (tokens === null || tokens === undefined || tokens > configuredKeep) return null;
  if (nuke) {
    return `Context (~${formatTokenCount(tokens)} tokens) is at or below pi's configured keep window (${formatTokenCount(configuredKeep)}), so pi refuses to compact this session at all — even nuke: true is rejected before compaction ("session too small"). If the context is broken: persist the state to memory (or a handoff file) and tell the user to start a new session.`;
  }
  return `Context is below the compaction minimum (${formatTokenCount(tokens)} tokens ≤ ${formatTokenCount(configuredKeep)} keep window). Pi keeps the most recent ${formatTokenCount(configuredKeep)} tokens verbatim, so there is no older context to summarize — the compact would fail. Continue working; call compact_request again once context exceeds ${formatTokenCount(configuredKeep)} tokens.`;
}

/** Recompute pi's cut point with a custom keep budget (the nuke path uses 0).
 *  prepareCompaction itself is not exported, only its pieces — so mirror its boundary
 *  logic (start after the previous compaction's kept boundary) and run the same
 *  findCutPoint walker pi uses. session_before_compact returns the id; pi uses a
 *  custom firstKeptEntryId verbatim. Null when the entries yield no cut (the caller
 *  keeps pi's own cut). */
export function computeCustomFirstKeptEntryId(entries: SessionEntry[], keepTokens: number): string | null {
  if (entries.length === 0) return null;
  let prev: CompactionEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "compaction") {
      prev = e;
      break;
    }
  }
  let boundaryStart = 0;
  if (prev) {
    const firstKeptEntryIndex = entries.findIndex((e) => e.id === prev.firstKeptEntryId);
    boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : entries.indexOf(prev) + 1;
  }
  const cut = findCutPoint(entries, boundaryStart, entries.length, keepTokens);
  return entries[cut.firstKeptEntryIndex]?.id ?? null;
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

// ── State ──

/** Checkpoint summary written by the live model (compact_request's `summary` arg,
 *  stashed in the tool's execute). session_before_compact returns it as a custom
 *  CompactionResult so pi skips its one-shot summarizer (a cold prefill of the
 *  flattened conversation). Null → pi's native one-shot. */
let selfSummary: string | null = null;
/** A compact was requested during the last run but has not run yet. Set when
 *  compact_request executes ({ continue, nuke } from the tool args). Consumed by the
 *  agent_settled handler, which triggers the compact. Deferring to agent_settled is what makes
 *  the trigger race-free: pi's automatic threshold compaction runs in the post-run
 *  loop, BEFORE the settled event. If it fired, it consumed the stashed summary
 *  via session_before_compact and session_compact cleared this flag — the manual
 *  compact that would otherwise hit pi's "Already compacted" error is never
 *  started. Cleared by session_compact (a compaction already did the work) and by
 *  session reset. */
let pendingCompact: { continue: boolean; nuke: boolean } | null = null;
/** Interactive messages received while a compact was pending. pi would queue
 *  them and its post-run loop would process them on the stale, un-compacted
 *  context BEFORE the deferred compact fires (agent_settled waits for queued
 *  continuations). The input handler stashes them; session_compact re-delivers
 *  them after the compaction. A new session discards them — they belong to the
 *  compacted context. */
type StashedInput = Pick<InputEvent, "text" | "images">;
let stashedInputs: StashedInput[] = [];
/** True between redelivery scheduling (session_compact) and delivery — the
 *  user's own messages are the continuation, so the manual path's continue
 *  steer must be suppressed. */
let stashedRedeliveryPending = false;
let stashedRedeliveryTimer: ReturnType<typeof setTimeout> | undefined;
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

// ── Message-shape helpers ──

/** True when the message contains a compact_request tool call. pi emits
 *  message_end BEFORE the message's tool calls execute, so this is how the
 *  nudge path sees an en-route compact — pendingCompact is only set later,
 *  in the tool's execute. */
export function messageContainsRequestCompact(message: { content?: unknown }): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (item) =>
      typeof item === "object" && item !== null &&
      (item as any).type === "toolCall" && (item as any).name === "compact_request",
  );
}

// ── Delivery ──

const CONTINUE_STEER_MESSAGE = "[Gallop] Compact done — proceed as commanded.";

/** Inject the generic proceed message a beat after compaction completes — the
 *  checkpoint's Next Steps section carries the actual "what next", so no custom
 *  resume text is ever written or re-sent. */
export function scheduleContinueSteer(pi: ExtensionAPI): void {
  setTimeout(() => {
    pi.sendUserMessage(CONTINUE_STEER_MESSAGE, { deliverAs: "steer" });
  }, 200);
}

function sendStashed(stashed: StashedInput[], pi: ExtensionAPI): void {
  for (const m of stashed) {
    const content = m.images && m.images.length > 0
      ? [{ type: "text" as const, text: m.text }, ...m.images]
      : m.text;
    // followUp: direct prompt when idle, queued when a run is already active.
    // expandPromptTemplates: interactive prompts expand by default — keep it.
    void pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: true });
  }
}

/** Re-deliver messages stashed while a compact was pending (input handler).
 *  Delayed: session_compact fires while pi's compaction-in-progress flag is
 *  still set, and prompt() refuses to submit during compaction — by the time
 *  the timer fires, compact() has finished and cleared the flag. */
export function scheduleStashedRedelivery(stashed: StashedInput[], pi: ExtensionAPI): void {
  stashedRedeliveryPending = true;
  stashedRedeliveryTimer = setTimeout(() => {
    stashedRedeliveryTimer = undefined;
    stashedRedeliveryPending = false;
    sendStashed(stashed, pi);
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
      // A stashed-redelivery is in flight (session_compact) — the user's own
      // messages are the continuation, so no generic proceed steer.
      if (continueAfter && !stashedRedeliveryPending) {
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

// ── Event surface ──

/** message_start (user role): a new user turn — the "already compacted"
 *  re-trigger window is over, so allow future compaction. */
export function noteUserTurn(): void {
  compactionInFlight = false;
}

/** message_end (assistant): the context-pressure nudge — one advisory steer
 *  per compaction cycle, just above pi's automatic threshold (or at a fixed
 *  16k when auto-compact is disabled — then no backstop exists). A compliant
 *  model compacts cache-warm before the native backstop takes over; after the
 *  nudge, silence — the backstop (or overflow) decides. Like the old per-turn
 *  context-usage injection (removed in v1.3 as ambient noise), this rides the
 *  session's cached prompt prefix — but it fires at most once per compaction
 *  cycle. compact_request triggers nothing here: pi emits message_end BEFORE
 *  this message's tool calls execute, and pi's automatic threshold
 *  compaction (when the run crossed it) runs in the post-run loop — both are
 *  resolved deterministically at agent_settled, where the deferred trigger
 *  compacts with the stashed summary, or skips entirely when a compaction
 *  already ran. */
export function onMessageEnd(
  message: {
    stopReason?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
    content?: unknown;
  },
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  if (interventionHalted()) return;              // agent halted — a steer would restart a run where every tool is blocked
  if (pendingCompact) return;                     // a compact request is already pending
  if (compactionRunning) return;                 // compact in flight — usage about to drop
  // pi emits message_end BEFORE this message's tool calls execute — a message
  // containing compact_request has a compact en route the two state guards
  // above cannot see yet (execute runs after this event). Skip, or the nudge
  // steer lands around the compaction boundary: "call compact_request now"
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
      `[Gallop] Context is nearly full (~${k}k tokens remaining; pi's automatic compaction triggers at ~${m}k). If the current work is at a sensible pause point, write a checkpoint summary and call compact_request now so the summary stays cache-warm.`,
      { deliverAs: "steer" },
    );
  } else {
    pi.sendUserMessage(
      `[Gallop] Context is nearly full (~${k}k tokens remaining) and pi's automatic compaction is disabled. If the current work is at a sensible pause point, write a checkpoint summary and call compact_request now — a context overflow would otherwise abort the run.`,
      { deliverAs: "steer" },
    );
  }
}

// ── Deferred compact trigger ──
// agent_settled fires only after the post-run loop has completed — i.e. AFTER
// pi's automatic threshold compaction had its chance to run (it consumes the
// stashed summary via session_before_compact and clears pendingCompact via
// session_compact). Triggering the requested compact HERE, instead of inside
// the tool's execute, is what makes the race a no-op: a compaction that
// already ran leaves nothing pending, so the manual compact that would
// otherwise throw "Already compacted" is never started.
export function onSettled(ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (!pendingCompact) return;
  const continueAfter = pendingCompact.continue;
  pendingCompact = null;
  // Second line of defense (session_compact normally already cleared the
  // pending state): if the branch already ends in a compaction entry — e.g.
  // a user /compact in the same window — there is nothing to compact.
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  if (branch[branch.length - 1]?.type === "compaction") return;
  triggerCompaction(ctx, pi, undefined, continueAfter);
}

// ── Pending-compact input gate ──
// While a model-requested compact is pending (compact_request executed, the
// deferred compact not yet fired), a typed message would be queued and pi's
// post-run loop would process it on the stale context before the compact —
// delaying the compact until that run ends. Swallow interactive messages
// instead; session_compact (or session_compact_failed) re-delivers them on
// the fresh context. Once a compact is actually running, the TUI routes
// typed messages through its own compaction queue and they never reach here.
export function onInput(
  event: { source?: string; text?: string; images?: InputEvent["images"] },
  ctx: ExtensionContext,
): { action: "handled" } | undefined {
  if (!pendingCompact || event.source !== "interactive") return undefined;
  stashedInputs.push({ text: event.text ?? "", images: event.images });
  if (ctx.hasUI) {
    ctx.ui.notify("Gallop: message saved — it will run after the pending compaction", "info");
  }
  return { action: "handled" };
}

// ── Compaction: in-session checkpoint (cache-friendly) ──
// When the live model called compact_request, its checkpoint summary is stashed
// in selfSummary — return it (with the file-ops sections appended) as a custom
// CompactionResult so pi skips its one-shot summarizer (a cold prefill of the
// flattened conversation). Otherwise (native /compact, auto threshold, overflow
// recovery, or a rejected/missing summary) return undefined and pi uses its
// native one-shot — compaction always works.
export function onBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
): { compaction: CompactionResult } | undefined {
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
    if (!summary || summary.length < MIN_SUMMARY_LENGTH) return undefined;
    // Nuke (compact_request's `nuke`): pi computed preparation with its configured
    // keep window — recompute the cut point with budget 0 (the same findCutPoint
    // walker pi's prepareCompaction uses), keeping only the last turn's tail, and
    // return the custom firstKeptEntryId; pi uses it verbatim. Applies to any
    // trigger that consumes the stashed summary (the deferred manual path, or the
    // automatic threshold compact that won the race). Falls back to pi's cut when
    // no usable custom cut exists.
    let firstKeptEntryId = event.preparation.firstKeptEntryId;
    if (pendingCompact?.nuke === true) {
      const custom = computeCustomFirstKeptEntryId(event.branchEntries, 0);
      if (custom) firstKeptEntryId = custom;
    }
    return {
      compaction: {
        summary: appendSelfCompactFileOps(summary, event.preparation.fileOps),
        firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: computeSelfCompactFileLists(event.preparation.fileOps),
      },
    };
  } finally {
    event.signal.removeEventListener("abort", onAbort);
  }
}

// ── context: replace the compact_request exchange with a completion marker ──
// After a self-compact, the checkpoint text appears twice in every request:
// as the compaction summary (pi renders compaction entries as messages with
// role "compactionSummary") and as the `summary` argument of the
// compact_request tool call in the kept tail (~1k duplicated tokens per
// request). The exchange is also a liability — dropping it outright (the
// previous behavior) left the nudge that triggered the compact ("…call
// compact_request now") standing in the tail as an unfulfilled instruction
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
//    text, but its "Compacting." result reads as in-progress — rewrite
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
// leave everything intact — on abort "Compacting." is true, and a
// re-request is the correct recovery. The triggering nudge is left untouched
// (a live post-compaction nudge is indistinguishable from a stale one in the
// rendered context); with the marker present it reads as fulfilled. The
// session file is never touched (the TUI transcript still shows the full
// summary) and the rewrite is deterministic, so the prefix stays cache-stable.
export function onContext(event: { messages: unknown }): { messages: any[] } | undefined {
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
  if (compactionSummaries.length === 0) return undefined;

  // Classify every compact_request call in context (also feeds orphan
  // detection):
  //  - carried: its summary text is verifiably in a compaction summary →
  //    replace the exchange with the marker (dedupe + completion closure)
  //  - fallback: not carried → keep the call, mark its result done
  const callIdsInContext = new Set<string>();
  // Carried calls get the exchange replaced; every OTHER compact_request call
  // in context is a native-fallback call (result gets marked done).
  const carriedCallIds = new Set<string>();
  for (const msg of messagesIn) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall" || block.name !== "compact_request") continue;
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
    // compact_request toolResult: orphan (call summarized out of the window)
    // → drop (an unpaired toolResult is an API error); paired with a carried
    // call → drop (the marker message carries the closure); paired with a
    // fallback call → rewrite the in-progress text to the marker.
    if (msg?.role === "toolResult" && msg?.toolName === "compact_request") {
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
}

/** session_compact: a compaction completed. Clears the running flag and the
 *  UI status, and captures the resume outcome (the pending request's
 *  continue, the stashed inputs) BEFORE the composition root resets all
 *  state and schedules the redelivery or the proceed steer. */
export function onCompacted(ctx: ExtensionContext): { continueAfter: boolean; stashed: StashedInput[] } {
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
  // Messages swallowed while this compact was pending (input gate): the
  // compact just ran, so re-deliver them on the fresh context. They are the
  // continuation — the generic proceed steer is skipped (the manual path's
  // onComplete is suppressed via stashedRedeliveryPending).
  const stashed = stashedInputs;
  pendingCompact = null;
  stashedInputs = [];
  return { continueAfter, stashed };
}

/** session_compact_failed: the compact did not run — deliver the swallowed
 *  messages anyway (they would have run on the un-compacted context, so
 *  dropping them would lose user input). Safe to submit now: pi clears its
 *  compaction-in-progress flag before emitting this event. */
export function onCompactFailed(pi: ExtensionAPI): void {
  const stashed = stashedInputs;
  stashedInputs = [];
  if (stashed.length > 0) sendStashed(stashed, pi);
}

// ── Reset ──

/** Reset the compaction-lifecycle state. Called by the composition root on
 *  session start and compaction. Deliberately does NOT touch
 *  compactionInFlight (cleared by a new user turn / noteUserTurn) or
 *  compactionRunning (cleared by session_compact / onError). */
export function reset(): void {
  selfSummary = null;
  pendingCompact = null;
  stashedInputs = [];
  stashedRedeliveryPending = false;
  if (stashedRedeliveryTimer) {
    clearTimeout(stashedRedeliveryTimer);
    stashedRedeliveryTimer = undefined;
  }
  contextNudgeState = "idle";
}

// ── Tool registration ──

/** Register compact_request and context_status. `cwd` is used for the
 *  registration-time keepRecentTokens read: the extension factory gets no
 *  session ctx, so a normal pi launch's session cwd is process.cwd() — a
 *  changed value takes effect on the next /reload, like the rest of the
 *  extension's load-time state. The nudge and both tools still read
 *  ctx.cwd live per use. */
export function registerTools(pi: ExtensionAPI, cwd: string): void {
  // The checkpoint guidance must name the tail pi actually keeps: the user
  // may customize compaction.keepRecentTokens (default 20k).
  const keepRecentTokens = readPiCompactionSettings(cwd).keepRecentTokens;

  pi.registerTool({
    name: "compact_request",
    label: "Request Compact",
    description: `Compact context to remove unrelated old context and increase performance while preserving active tasks.
- Call when: edit keeps failing (broken text matching), a major task finished and another is queued (compact at the boundary), the session is long, or context_status / a [Gallop] notice reports pressure.
- Write the checkpoint summary in 'summary', in this exact format:

${checkpointFormat(keepRecentTokens)}
- 'continue' defaults to true; pass false if there is nothing to follow up
- Context broken beyond repair (tool calls failing repeatedly): pass nuke: true — the checkpoint must then carry full state, not just older work`,
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Checkpoint summary of the conversation so far, in the exact format given in the tool description",
        },
        continue: {
          type: "boolean",
          description: "Continue working right after compaction or not (default: true — pass false to stop)",
        },
        nuke: {
          type: "boolean",
          description: `True = only compaction summary survives after compact, summarize everything you need (default: false)`,
        },
      },
      required: ["summary"],
    },
    async execute(_id: string, params: { summary?: string; continue?: boolean; nuke?: boolean }, _signal, _onUpdate, ctx: ExtensionContext) {
      // Minimum-context guard: when the whole context fits in pi's configured keep
      // window, pi's prepareCompaction bails before any hook runs — no compact can
      // happen at all (not even a nuke; pi evaluates the cut with the configured
      // window, never 0). Fail the tool call instead: the thrown error becomes the
      // tool result the model sees, and because the guard runs before anything is
      // stashed, no pending state exists and the deferred compact never fires. Usage
      // is pi's own last-usage-anchored estimate (same as the automatic threshold
      // check); the keep window is read live, like context_status.
      const settings = readPiCompactionSettings(ctx.cwd);
      const usage = ctx.getContextUsage();
      const tooSmall = tooSmallCompactError(usage?.tokens, settings.keepRecentTokens, params?.nuke === true);
      if (tooSmall) throw new Error(tooSmall);

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
      // Default continue: an omitted argument keeps working. The failure costs
      // are asymmetric — a mistaken continue costs one idle "nothing to do"
      // turn; a mistaken stop strands the in-flight task at the boundary.
      pendingCompact = { continue: params?.continue !== false, nuke: params?.nuke === true };

      // Do NOT echo the summary in the tool result: after compaction the
      // checkpoint lives in the compaction entry (top of context), and the
      // context handler below replaces the compact_request exchange with the
      // completion marker anyway. The fixed result text is all the user sees
      // before then.
      return {
        details: {},
        content: [{
          type: "text",
          text: "Compacting.",
        }],
        terminate: true,
      };
    },
    ...compactRequestRenderers,
  });

  // The model has no passive view of context usage — the pressure nudge above
  // only fires near the limit, one steer per cycle. This makes the view
  // on-demand, so the model can decide PROACTIVELY: compact at a task
  // boundary before the next task inherits the bloat, or before an image
  // batch that would overflow a small window. It reports pi's own
  // getContextUsage() (the last-usage-anchored estimate pi's automatic
  // threshold check uses) plus the two backstop thresholds it already reads,
  // and one advice line — a recommendation, not raw math. No parameters
  // (nothing to tune in v1); the description scopes the call frequency so the
  // on-demand query stays on-demand (per-call results stay in context — an
  // after-every-tool-call habit would re-create the v1.3 ambient noise).
  pi.registerTool({
    name: "context_status",
    label: "Context Status",
    description: `Report current context usage, remaining tokens, and compaction thresholds.
- Call when: at a task boundary or before a large batch of reads or images (~1.6k tokens each). If the advice is not "headroom OK", call compact_request first.`,
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_id: string, _params: {}, _signal, _onUpdate, ctx: ExtensionContext) {
      const usage = ctx.getContextUsage();
      const settings = readPiCompactionSettings(ctx.cwd);
      return {
        details: {},
        content: [{
          type: "text",
          text: buildContextStatusText(usage, settings),
        }],
      };
    },
    ...contextStatusRenderers,
  });
}
