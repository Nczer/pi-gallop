/**
 * intervention.ts — loop detection and enforcement.
 *
 * Detects the model's pathological patterns and intervenes on a shared
 * escalation policy (nudge → nudge_plus → block):
 *  - failure loop: the same bash command failing repeatedly with the same
 *    error (fingerprint = normalized command + last error line, windowed to
 *    the last N turns)
 *  - repetitive call: the same tool with the same arguments called in a row
 *    (any tool; a successful call breaks streaks for OTHER fingerprints)
 *  - reasoning-action mismatch: the model's thinking acknowledged an error,
 *    yet the next tool call repeats the exact call that just failed
 *
 * Enforcement happens in tool_call (the block reasons teach the model a
 * different approach); detection in tool_execution_start/end (args are only
 * available at start). After CIRCUIT_BREAKER_BLOCKS total enforced blocks the
 * circuit breaker pauses the agent with a user dialog: Continue (fresh slate,
 * full session-state reset) or Stop (all tools blocked until /compact or
 * /new). While tripped, no auto-intervention runs at all.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Normalization and fingerprinting ──

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

  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return "empty-output";

  const lastLine = lines[lines.length - 1];
  return lastLine.length > 120 ? lastLine.slice(0, 120).toLowerCase() : lastLine.toLowerCase();
}

/**
 * Prune failure history to keep only entries within the window.
 */
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
 * read: path (+ offset/limit when given); bash: normalized command;
 * edit: path + per-edit oldText region tags; others: stable JSON of args.
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

// ── Shared escalation engine ──

export type EscalationLevel = "nudge" | "nudge_plus" | "block";

export interface EscalationEntry {
  level: EscalationLevel;
  nudgeCount: number;
}

const ESCALATION_LEVELS: EscalationLevel[] = ["nudge", "nudge_plus", "block"];

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

// ── Thresholds ──

const FAILURE_LOOP_THRESHOLD = 3;     // N identical failures before nudging
const FAILURE_LOOP_NUDGE_PLUS = 5;    // N failures before escalated nudge
const FAILURE_LOOP_BLOCK = 5;         // N failures before hard block (immediate escalation reaches it from 4)
const FAILURE_WINDOW_TURNS = 5;       // Only consider failures within last N turns
const REPETITIVE_CALL_THRESHOLD = 3;  // N consecutive identical calls before nudging
const REPETITIVE_CALL_NUDGE_PLUS = 5; // N consecutive calls before escalated nudge
const REPETITIVE_CALL_BLOCK = 5;      // N consecutive calls before hard block (immediate escalation reaches it from 4)
const CIRCUIT_BREAKER_BLOCKS = 3;     // Total blocks before shutdown

// ── State ──

/** In-flight tool calls keyed by toolCallId: { args, fingerprint }.
 *  tool_execution_end events carry no args, so we stash them here. */
const pendingToolCalls = new Map<string, { args: unknown; fingerprint: string }>();

/** History of recent bash failures for loop detection */
const failureHistory: {
  command: string;    // normalized command
  fingerprint: string; // error fingerprint
  turnIndex: number;
}[] = [];

/** Track consecutive identical tool calls */
let repetitiveCallState: {
  fingerprint: string;   // "toolName:normalizedArgs"
  count: number;
} | null = null;

let currentTurnIndex = 0;

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

/** Last failed tool call for mismatch detection */
let lastFailedToolCall: {
  toolName: string;
  fingerprint: string;
  error: string;
} | null = null;

/** Whether LLM's thinking acknowledged an error */
let llmAcknowledgedError = false;

// ── Reasoning-action mismatch keywords ──

/** Keywords that suggest the LLM acknowledged an error or strategy change */
const ERROR_ACK_KEYWORDS = [
  "wrong", "error", "failed", "fail", "issue", "problem",
  "retry", "retried", "repeat", "same", "again",
  "cd ", "change", "different", "alternative", "instead",
  "directory", "path", "not found", "does not exist",
  "should have", "need to", "must", "fix", "correct",
];

/** Check if thinking content contains error/strategy keywords */
function thinkingAcknowledgesError(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_ACK_KEYWORDS.some(keyword => lower.includes(keyword));
}

// ── Circuit breaker ──

const HALT_REASON = "[Gallop] Agent halted by user (circuit breaker). Use /compact or /new to unblock tools.";

/** Block reason for every tool call while the breaker has halted the agent. */
export function haltReason(): string {
  return HALT_REASON;
}

/** Full session-state reset (all subsystems), injected by the composition
 *  root — the breaker's "Continue" is a session-level fresh slate, not just
 *  an intervention reset. */
let fullReset: (() => void) | undefined;
export function setFullReset(fn: () => void): void {
  fullReset = fn;
}

export function tripped(): boolean {
  return circuitBreakerTripped;
}

export function halted(): boolean {
  return circuitBreakerHalted;
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
      fullReset?.();
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
    stepBackAfterBlocks(pi, " (no UI)");
  }

  return {};
}

// ── Detectors ──

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

// ── Event surface ──

/** turn_start: count turns. Monotonic counter, NOT pi's turnIndex: pi resets
 *  it to 0 on every agent_start (including agent.continue() runs), which
 *  would leave failureHistory entries from the previous run un-prunable and
 *  counted into the new run's window. Counting turns ourselves keeps the
 *  failure window "last N turns" across runs. reset() zeroes it together
 *  with failureHistory on session start / compaction. */
export function onTurnStart(): void {
  currentTurnIndex += 1;
}

export interface ToolExecStartEvent {
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
}

/** tool_execution_start: stash args + fingerprint (tool_execution_end events
 *  carry no args), and track consecutive identical calls for repetitive-call
 *  detection. */
export function onToolExecutionStart(event: ToolExecStartEvent): void {
  // Stash args + fingerprint for this call. Used for bash failure-loop command
  // extraction, repetitive-call block matching, and mismatch arg fingerprinting.
  const args = event.args;
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
}

export interface ToolExecEndEvent {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  result: unknown;
}

/** tool_execution_end: failure-loop detection (bash), last-failed-call
 *  tracking (mismatch), and repetitive-call streak accounting. */
export function onToolExecutionEnd(event: ToolExecEndEvent, ctx: ExtensionContext, pi: ExtensionAPI): void {
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
        const normalized = normalizeCommand(rawCommand);

        const fingerprint = extractErrorFingerprint(event.result);

        // Skip Gallop-generated failures: blocked calls still emit
        // tool_execution_end with the block reason as the error result, and
        // recording those would pollute the loop history with block text.
        if (!fingerprint.startsWith("[gallop]")) {
          failureHistory.push({
            command: normalized,
            fingerprint,
            turnIndex: currentTurnIndex,
          });

          pruneFailureHistory(failureHistory, currentTurnIndex, FAILURE_WINDOW_TURNS);

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
}

/** tool_call guard: enforce failure-loop blocks (bash) and repetitive-call
 *  blocks (all tools), tripping the circuit breaker on repeated blocks.
 *  Returns the block, or undefined when the call passes. */
export async function guardToolCall(
  event: { toolName: string; toolCallId: string; input: unknown },
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<{ block?: boolean; reason?: string } | undefined> {
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
      ?? `${event.toolName}:${normalizeToolArgs(event.toolName, event.input)}`;

    const repEntry = repetitiveEscalation.get(callFingerprint);
    if (repEntry && repEntry.level === "block") {
      totalBlocks++;

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

  return undefined;
}

/** message_end (assistant): reasoning-action mismatch detection. Runs before
 *  stall handling in the caller so it still fires on normal tool-call
 *  handoffs. Assistant tool-call content blocks use type "toolCall" with
 *  { name, arguments }. */
export function onMessageEnd(
  message: { content?: unknown },
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  if (lastFailedToolCall) {
    const content = Array.isArray(message.content) ? message.content : [];
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
}

/** Reset all intervention state. Called by the composition root on session
 *  start, compaction, and circuit-breaker continue. */
export function reset(): void {
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

  lastFailedToolCall = null;
  llmAcknowledgedError = false;
}
