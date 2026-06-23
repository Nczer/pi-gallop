/**
 * Gallop Extension
 *
 * Keeps the agent moving:
 * - Detects stalled generation (stopped mid-thinking or mid-tool-call) and sends resume
 * - Detects repetitive command failure loops and nudges the agent to change strategy
 * - LLM can trigger compaction via `request_compact` tool with post-compaction resume
 * - Injects context usage before each turn
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── State ──

let cooldownUntil = 0;
let sawAssistantMessage = false;

let compactRequested = false;
let pendingTask: string | null = null;
let customCompactInstructions: string | null = null;
let lastReportedPct: number | null = null;

// ── Failure-loop detection state ──

/** Commands in-flight, keyed by toolCallId */
const pendingCommands = new Map<string, string>();

/** History of recent bash failures for loop detection */
const failureHistory: {
  command: string;    // normalized command
  fingerprint: string; // error fingerprint
  turnIndex: number;
  timestamp: number;
}[] = [];

/** Track which command+error combos we've already nudged about */
const nudgedKeys = new Set<string>();

// ── Repetitive-call detection state ──

/** Track consecutive identical tool calls */
let repetitiveCallState: {
  fingerprint: string;   // "toolName:normalizedArgs"
  count: number;
} | null = null;

/** Repetitive-call patterns we've already nudged about */
const repetitiveNudgedKeys = new Set<string>();

// Thresholds
const FAILURE_LOOP_THRESHOLD = 3;     // N identical failures before nudging
const FAILURE_WINDOW_TURNS = 5;       // Only consider failures within last N turns
const REPETITIVE_CALL_THRESHOLD = 3;  // N consecutive identical calls before nudging
const NUDGE_COOLDOWN_MS = 30_000;     // Cooldown between nudges for same pattern

let currentTurnIndex = 0;
let nudgeCooldownUntil = 0;

// ── Helpers ──

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function lastItemIsThinking(message: { content?: unknown[] }): boolean {
  if (!message.content || !Array.isArray(message.content) || message.content.length === 0) return false;
  const last = message.content[message.content.length - 1];
  return typeof last === "object" && last !== null && (last as any).type === "thinking";
}

function lastItemIsToolUse(message: { content?: unknown[] }): boolean {
  if (!message.content || !Array.isArray(message.content) || message.content.length === 0) return false;
  const last = message.content[message.content.length - 1];
  return typeof last === "object" && last !== null && (last as any).type === "tool_use";
}

function triggerCompaction(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  instructions?: string,
  task?: string | null,
): void {
  compactRequested = false;

  ctx.compact({
    customInstructions: instructions,
    onComplete: () => {
      lastReportedPct = null;
      if (task) {
        pi.appendEntry("auto-compact-pending-task", { task });
        setTimeout(() => {
          pi.sendUserMessage(`[Gallop] Resume: ${task}`, { deliverAs: "steer" });
        }, 200);
      }
    },
  });
}

// ── Failure-loop detection helpers ──

/**
 * Normalize a command string for comparison.
 * Collapses whitespace, trims, and lowercases for fuzzy matching.
 */
function normalizeCommand(command: string): string {
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
function extractErrorFingerprint(result: any): string {
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
 * Prune failure history to keep only entries within the window.
 */
function pruneFailureHistory(): void {
  const cutoff = currentTurnIndex - FAILURE_WINDOW_TURNS;
  while (failureHistory.length > 0 && failureHistory[0].turnIndex < cutoff) {
    failureHistory.shift();
  }
}

// ── Repetitive-call detection helpers ──

/**
 * Normalize tool arguments into a stable fingerprint string.
 * For read: just the path. For bash: the command. For others: JSON of args.
 */
function normalizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "{}";

  const a = args as Record<string, unknown>;

  // read: fingerprint by path
  if (toolName === "read") {
    return (typeof a.path === "string" ? a.path : String(a.path ?? "")).replace(/\\/g, "/");
  }

  // bash: fingerprint by normalized command
  if (toolName === "bash") {
    return normalizeCommand(typeof a.command === "string" ? a.command : String(a.command ?? ""));
  }

  // Default: stable JSON of arg keys/values (sorted keys)
  try {
    return JSON.stringify(a, Object.keys(a).sort(), 0);
  } catch {
    return JSON.stringify(a);
  }
}

/**
 * Check for repetitive consecutive tool calls.
 * Injects a steer nudge when threshold is hit.
 */
function checkRepetitiveCall(
  fingerprint: string,
  count: number,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  if (count < REPETITIVE_CALL_THRESHOLD) return;

  // Avoid repeating the same nudge
  if (repetitiveNudgedKeys.has(fingerprint)) return;

  // Check cooldown
  if (Date.now() < nudgeCooldownUntil) return;

  // Parse tool name and arg summary from fingerprint
  const colonIndex = fingerprint.indexOf(":");
  const toolName = colonIndex > -1 ? fingerprint.slice(0, colonIndex) : fingerprint;
  const argSummary = colonIndex > -1 ? fingerprint.slice(colonIndex + 1) : "";

  // Truncate long arg summaries for display
  const displayArg = argSummary.length > 80 ? argSummary.slice(0, 77) + "..." : argSummary;

  let hint = "";
  if (toolName === "read") {
    hint = " The file content is already in context — analyze it or move on.";
  } else if (toolName === "bash") {
    hint = " The command already succeeded — using its output or moving on would be more productive.";
  } else {
    hint = " Consider whether the result is already available in context.";
  }

  const msg = `[Gallop] Repetitive action detected: You've called ${toolName} ${count} times in a row with the same arguments (${displayArg}).${hint}`;

  // Mark as nudged and set cooldown
  repetitiveNudgedKeys.add(fingerprint);
  nudgeCooldownUntil = Date.now() + NUDGE_COOLDOWN_MS;

  // Inject steer message
  pi.sendUserMessage(msg, { deliverAs: "steer" });

  if (ctx.hasUI) {
    ctx.ui.notify(`Gallop: repetitive call detected (${count}x ${toolName})`, "warning");
  }
}

/**
 * Check if the current failure pattern indicates a loop.
 * If so, inject a steer message to nudge the agent.
 */
function checkFailureLoop(
  normalized: string,
  fingerprint: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  // Count matching failures in the window
  const matches = failureHistory.filter(
    entry => entry.command === normalized && entry.fingerprint === fingerprint,
  );

  if (matches.length < FAILURE_LOOP_THRESHOLD) return;

  // Build a nudge key to avoid repeating the same nudge
  const nudgeKey = `${normalized}:${fingerprint}`;
  if (nudgedKeys.has(nudgeKey)) return;

  // Check cooldown
  if (Date.now() < nudgeCooldownUntil) return;

  // Extract the original command (first match's raw form for display)
  const matchCount = matches.length;

  // Build helpful nudge message
  const shortCommand = normalized.length > 80 ? normalized.slice(0, 77) + "..." : normalized;
  const errorSnippet = fingerprint.length > 60 ? fingerprint.slice(0, 57) + "..." : fingerprint;

  let hint = "";
  // Generate contextual hints based on error patterns
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

  const msg = `[Gallop] Failure loop detected: You've retried this command ${matchCount} times with the same error — "${errorSnippet}". Command: \`${shortCommand}\`${hint}`;

  // Mark as nudged and set cooldown
  nudgedKeys.add(nudgeKey);
  nudgeCooldownUntil = Date.now() + NUDGE_COOLDOWN_MS;

  // Inject steer message
  pi.sendUserMessage(msg, { deliverAs: "steer" });

  if (ctx.hasUI) {
    ctx.ui.notify(`Gallop: failure loop detected (${matchCount} retries)`, "warning");
  }
}

// ── Main extension ──

export default function gallopExtension(pi: ExtensionAPI) {
  // ── Tool: LLM can request compaction ──

  pi.registerTool({
    name: "request_compact",
    label: "Request Compact",
    description: `Compact context to reduce token usage. Discards bloat while preserving active tasks. 
    - 'pending': A direct instruction (e.g., 'Immediately finish the refactor of X') that will be injected as a high-priority user message immediately after compaction to ensure seamless resumption.
    - 'customInstructions': Specific directions for the compactor (e.g., 'Keep the last 3 error logs but discard previous ones').`,
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason for compaction (e.g., 'context bloat', 'completed large task')",
        },
        pending: {
          type: "string",
          description: "Task to resume after compaction. Write as a direct command.",
        },
        customInstructions: {
          type: "string",
          description: "Custom instructions for the compaction summary process.",
        },
      },
      required: [],
    },
    async execute(_id: string, params: { reason?: string; pending?: string; customInstructions?: string }, _signal, _onUpdate) {
      compactRequested = true;
      pendingTask = params?.pending || null;
      customCompactInstructions = params?.customInstructions || null;
      const reason = params?.reason || "model-initiated";

      if (pendingTask) {
        pi.appendEntry("auto-compact-intent", { task: pendingTask });
      }

      return {
        details: {},
        content: [{
          type: "text",
          text: `Compacting (${reason}).`,
        }],
      };
    },
  });

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, _ctx) => {
    cooldownUntil = 0;
    sawAssistantMessage = false;
    compactRequested = false;
    pendingTask = null;
    customCompactInstructions = null;
    lastReportedPct = null;

    // Reset failure-loop detection
    pendingCommands.clear();
    failureHistory.length = 0;
    nudgedKeys.clear();
    currentTurnIndex = 0;
    nudgeCooldownUntil = 0;

    // Reset repetitive-call detection
    repetitiveCallState = null;
    repetitiveNudgedKeys.clear();
  });

  // ── Before agent start: inject context usage ──

  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    try {
      const usage = ctx.getContextUsage();
      if (!usage?.percent) return;

      if (lastReportedPct !== null && Math.abs(usage.percent - lastReportedPct) < 5) return;
      lastReportedPct = usage.percent;

      const maxTokens = ctx.model?.contextWindow ?? ctx.model?.maxTokens;
      const pct = Math.round(usage.percent);
      const tokens = usage.tokens ?? 0;
      const injection = typeof maxTokens === "number" && maxTokens > 0
        ? `Context: ${formatTokens(tokens)} / ${formatTokens(maxTokens)} (${pct}%)`
        : `Context: ${formatTokens(tokens)}`;
      return {
        message: {
          customType: "context-usage",
          content: injection,
          display: false,
        },
      };
    } catch {
      // getContextUsage may not be available
    }
  });

  // ── Stall detection ──

  pi.on("message_start", async (event, _ctx) => {
    if (event.message.role === "assistant") {
      sawAssistantMessage = true;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !sawAssistantMessage) return;
    sawAssistantMessage = false;

    if (lastItemIsThinking(event.message) || lastItemIsToolUse(event.message)) {
      const stopReason = (event.message as any).stopReason;
      if (stopReason === "aborted" || stopReason === "error") return;

      // Normal tool call flow: LLM stops with stopReason="tool_use" to let the tool run.
      if (lastItemIsToolUse(event.message) && stopReason === "tool_use") return;

      if (Date.now() < cooldownUntil) return;
      cooldownUntil = Date.now() + 10_000;

      const reason = lastItemIsThinking(event.message)
        ? "stopped mid-thought"
        : "stopped after tool call";

      const msg = `[Gallop] Resume: ${reason} (stopReason: ${stopReason})`;
      pi.sendUserMessage(msg, { deliverAs: "steer" });

      if (ctx.hasUI) {
        ctx.ui.notify(`Gallop: ${reason} (stopReason: ${stopReason})`, "info");
      }
    }
  });

  // ── Turn tracking ──

  pi.on("turn_start", async (event: { turnIndex: number }) => {
    currentTurnIndex = event.turnIndex;
  });

  // ── Failure-loop detection ──

  pi.on("tool_execution_start", async (event) => {
    // Track bash commands for failure-loop detection
    if (event.toolName === "bash") {
      const command = (event.args as any)?.command;
      if (typeof command === "string") {
        pendingCommands.set(event.toolCallId, command);
      }
    }

    // Track ALL tools for repetitive-call detection
    const args = event.args as Record<string, unknown> | undefined;
    const argFingerprint = normalizeToolArgs(event.toolName, args);
    const callFingerprint = `${event.toolName}:${argFingerprint}`;

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
    // ── Bash failure-loop detection (existing) ──

    if (event.toolName === "bash") {
      const rawCommand = pendingCommands.get(event.toolCallId);
      pendingCommands.delete(event.toolCallId);

      if (rawCommand) {
        if (!event.isError) {
          // Successful execution — reset failure history to avoid stale detections
          failureHistory.length = 0;
          nudgedKeys.clear();
        } else {
          // Normalize the command for comparison
          const normalized = normalizeCommand(rawCommand);

          // Extract error fingerprint from result content
          const fingerprint = extractErrorFingerprint(event.result);

          // Record the failure
          failureHistory.push({
            command: normalized,
            fingerprint,
            turnIndex: currentTurnIndex,
            timestamp: Date.now(),
          });

          // Prune old entries outside the window
          pruneFailureHistory();

          // Check for failure loop
          checkFailureLoop(normalized, fingerprint, ctx, pi);
        }
      }
    }

    // ── Repetitive-call detection (new) ──

    if (repetitiveCallState && repetitiveCallState.count >= REPETITIVE_CALL_THRESHOLD) {
      checkRepetitiveCall(repetitiveCallState.fingerprint, repetitiveCallState.count, pi, ctx);
    }
  });

  // ── Turn end: check for model-requested compaction ──

  pi.on("turn_end", async (_event: unknown, ctx: ExtensionContext) => {
    if (compactRequested) {
      const defaultInstructions = "The agent requested compaction. Preserve active work and key decisions. " +
        "Aggressively remove completed tasks, old error traces, and accumulated bloat.";

      const baseInstructions = customCompactInstructions || defaultInstructions;
      const instructions = (pendingTask ? `CRITICAL: After compaction, the agent must execute this pending task: "${pendingTask}".\n\n` : "") +
        baseInstructions;

      triggerCompaction(ctx, pi, instructions, pendingTask);
    }
  });

  // ── Compaction UI ──

  pi.on("session_before_compact", async (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("compact", `${ctx.ui.theme.fg("dim", "· ")}${ctx.ui.theme.fg("warning", "⟳ Compacting...")}`);
    }
  });

  pi.on("session_compact", async (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("compact", undefined);
    }
    // Reset failure-loop detection after compaction to avoid stale state
    failureHistory.length = 0;
    nudgedKeys.clear();
    nudgeCooldownUntil = 0;

    // Reset repetitive-call detection after compaction
    repetitiveCallState = null;
    repetitiveNudgedKeys.clear();
  });
}
