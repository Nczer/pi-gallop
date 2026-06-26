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
const FAILURE_LOOP_BLOCK = 7;         // N failures before hard block
const FAILURE_WINDOW_TURNS = 5;       // Only consider failures within last N turns
const REPETITIVE_CALL_THRESHOLD = 3;  // N consecutive identical calls before nudging
const REPETITIVE_CALL_NUDGE_PLUS = 5; // N consecutive calls before escalated nudge
const REPETITIVE_CALL_BLOCK = 7;      // N consecutive calls before hard block
const NUDGE_COOLDOWN_MS = 30_000;     // Cooldown between nudges for same pattern
const STALL_WARN = 4;                 // Stalls before strong warning
const STALL_STOP = 5;                 // Stalls before stopping and notifying user
const CIRCUIT_BREAKER_BLOCKS = 5;     // Total blocks before shutdown

const ESCALATION_LEVELS: EscalationLevel[] = ["nudge", "nudge_plus", "block"];

let currentTurnIndex = 0;
let failureLoopCooldownUntil = 0;
let repetitiveCallCooldownUntil = 0;

// ── Escalation state ──

type EscalationLevel = "nudge" | "nudge_plus" | "block";

interface EscalationEntry {
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

// ── Binary detection ──

/**
 * Detect binary content in bash output.
 * Checks for null bytes and high ratio of non-printable characters.
 */
export function isBinaryContent(text: string): boolean {
  if (!text.length) return false;

  // Any null byte = binary
  if (text.includes("\0")) return true;

  // Count non-printable bytes (excluding normal whitespace \n \r \t)
  let nonPrintable = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Control chars 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, plus DEL (0x7F)
    // Allow: 0x09 (\t), 0x0A (\n), 0x0D (\r)
    if ((code >= 0x00 && code <= 0x08) ||
        code === 0x0B || code === 0x0C ||
        (code >= 0x0E && code <= 0x1F) ||
        code === 0x7F) {
      nonPrintable++;
    }
  }

  // >5% non-printable = binary
  return (nonPrintable / text.length) > 0.05;
}

// ── Helpers ──

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function lastItemIsThinking(message: { content?: unknown[] }): boolean {
  if (!message.content || !Array.isArray(message.content) || message.content.length === 0) return false;
  const last = message.content[message.content.length - 1];
  return typeof last === "object" && last !== null && (last as any).type === "thinking";
}

export function lastItemIsToolUse(message: { content?: unknown[] }): boolean {
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
    blockedPatterns.clear();
    failureEscalation.clear();
    repetitiveEscalation.clear();
    failureHistory.length = 0;
    totalBlocks = 0;
    stallCount = 0;
    circuitBreakerTripped = false;
    pi.sendUserMessage(
      `[Gallop] Circuit breaker: blocks cleared by user. Continuing.`,
      { deliverAs: "steer" },
    );
  } else {
    // No UI — just step back
    blockedPatterns.clear();
    failureEscalation.clear();
    repetitiveEscalation.clear();
    circuitBreakerTripped = false;
    pi.sendUserMessage(
      `[Gallop] Circuit breaker: ${totalBlocks} blocks enforced. Stepping back (no UI).`,
      { deliverAs: "steer" },
    );
  }

  // Let this tool call through
  return {};
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

// ── Repetitive-call detection helpers ──

/**
 * Normalize tool arguments into a stable fingerprint string.
 * For read: just the path. For bash: the command. For others: JSON of args.
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

  // Default: stable JSON of arg keys/values (sorted keys)
  try {
    return JSON.stringify(a, Object.keys(a).sort(), 0);
  } catch {
    return JSON.stringify(a);
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
  if (circuitBreakerTripped) return;
  if (count < REPETITIVE_CALL_THRESHOLD) {
    // Below threshold — reset escalation for this pattern
    repetitiveEscalation.delete(fingerprint);
    return;
  }

  // Get or create escalation entry
  let entry = repetitiveEscalation.get(fingerprint);
  if (!entry) {
    entry = { level: "nudge", nudgeCount: 0 };
    repetitiveEscalation.set(fingerprint, entry);
  }

  // Determine current escalation level
  let currentLevel: EscalationLevel;
  if (count >= REPETITIVE_CALL_BLOCK) {
    currentLevel = "block";
  } else if (count >= REPETITIVE_CALL_NUDGE_PLUS) {
    currentLevel = "nudge_plus";
  } else {
    currentLevel = "nudge";
  }

  // Escalate if needed
  const currentIndex = ESCALATION_LEVELS.indexOf(entry.level);
  const targetIndex = ESCALATION_LEVELS.indexOf(currentLevel);
  if (targetIndex <= currentIndex) return; // Already at or past target level

  const escalated = targetIndex > currentIndex;
  entry.level = currentLevel;
  entry.nudgeCount++;

  // Cooldown check — skip when escalating to a new level or at block
  if (!escalated && currentLevel !== "block" && Date.now() < repetitiveCallCooldownUntil) return;

  // Parse tool name and arg summary
  const colonIndex = fingerprint.indexOf(":");
  const toolName = colonIndex > -1 ? fingerprint.slice(0, colonIndex) : fingerprint;
  const argSummary = colonIndex > -1 ? fingerprint.slice(colonIndex + 1) : "";
  const displayArg = argSummary.length > 80 ? argSummary.slice(0, 77) + "..." : argSummary;

  let hint = "";
  if (toolName === "read") {
    hint = " The file content is already in context — analyze it or move on.";
  } else if (toolName === "bash") {
    hint = " The command already succeeded — using its output or moving on would be more productive.";
  } else {
    hint = " Consider whether the result is already available in context.";
  }

  let msg: string;
  if (currentLevel === "block") {
    msg = `[Gallop] BLOCKED: You've called ${toolName} ${count} times in a row with the same arguments (${displayArg}). This pattern is now blocked. You MUST use a different tool or different arguments.${hint}`;
  } else if (currentLevel === "nudge_plus") {
    msg = `[Gallop] WARNING: You've called ${toolName} ${count} times in a row with the same arguments (${displayArg}). This has been flagged before. Stop repeating and try a different approach.${hint}`;
  } else {
    msg = `[Gallop] Repetitive action detected: You've called ${toolName} ${count} times in a row with the same arguments (${displayArg}).${hint}`;
  }

  // Set cooldown for non-block levels
  if (currentLevel !== "block") {
    repetitiveCallCooldownUntil = Date.now() + NUDGE_COOLDOWN_MS;
  }

  pi.sendUserMessage(msg, { deliverAs: "steer" });

  if (ctx.hasUI) {
    ctx.ui.notify(`Gallop: ${currentLevel} — repetitive call (${count}x ${toolName})`, currentLevel === "block" ? "error" : "warning");
  }
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
  if (circuitBreakerTripped) return;
  // Count matching failures in the window
  const matches = failureHistory.filter(
    entry => entry.command === normalized && entry.fingerprint === fingerprint,
  );
  const matchCount = matches.length;

  if (matchCount < FAILURE_LOOP_THRESHOLD) {
    // Below threshold — reset escalation
    const nudgeKey = `${normalized}:${fingerprint}`;
    failureEscalation.delete(nudgeKey);
    return;
  }

  // Get or create escalation entry
  const nudgeKey = `${normalized}:${fingerprint}`;
  let entry = failureEscalation.get(nudgeKey);
  if (!entry) {
    entry = { level: "nudge", nudgeCount: 0 };
    failureEscalation.set(nudgeKey, entry);
  }

  // Determine current escalation level
  let currentLevel: EscalationLevel;
  if (matchCount >= FAILURE_LOOP_BLOCK) {
    currentLevel = "block";
  } else if (matchCount >= FAILURE_LOOP_NUDGE_PLUS) {
    currentLevel = "nudge_plus";
  } else {
    currentLevel = "nudge";
  }

  // Escalate if needed
  const currentIndex = ESCALATION_LEVELS.indexOf(entry.level);
  const targetIndex = ESCALATION_LEVELS.indexOf(currentLevel);
  if (targetIndex <= currentIndex) return; // Already at or past target level

  const escalated = targetIndex > currentIndex;
  entry.level = currentLevel;
  entry.nudgeCount++;

  // Cooldown check — skip when escalating to a new level or at block
  if (!escalated && currentLevel !== "block" && Date.now() < failureLoopCooldownUntil) return;

  // Build display snippets
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

  let msg: string;
  if (currentLevel === "block") {
    msg = `[Gallop] BLOCKED: This command has failed ${matchCount} times with the same error ("${errorSnippet}"). Further retries are blocked. You MUST try a fundamentally different approach. Command: \`${shortCommand}\`${hint}`;
    blockedPatterns.set(normalized, errorSnippet);
  } else if (currentLevel === "nudge_plus") {
    msg = `[Gallop] WARNING: This command has failed ${matchCount} times with the same error ("${errorSnippet}"). A previous nudge was ignored. Stop retrying and change strategy. Command: \`${shortCommand}\`${hint}`;
  } else {
    msg = `[Gallop] Failure loop detected: You've retried this command ${matchCount} times with the same error — "${errorSnippet}". Command: \`${shortCommand}\`${hint}`;
  }

  // Set cooldown for non-block levels
  if (currentLevel !== "block") {
    failureLoopCooldownUntil = Date.now() + NUDGE_COOLDOWN_MS;
  }

  pi.sendUserMessage(msg, { deliverAs: "steer" });

  if (ctx.hasUI) {
    ctx.ui.notify(`Gallop: ${currentLevel} — failure loop (${matchCount} failures)`, currentLevel === "block" ? "error" : "warning");
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
    failureEscalation.clear();
    currentTurnIndex = 0;
    failureLoopCooldownUntil = 0;
    repetitiveCallCooldownUntil = 0;

    // Reset repetitive-call detection
    repetitiveCallState = null;
    repetitiveEscalation.clear();

    // Reset escalation state
    blockedPatterns.clear();
    totalBlocks = 0;
    circuitBreakerTripped = false;
    circuitBreakerHalted = false;
    stallCount = 0;
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
    // Circuit breaker tripped — no more stall intervention
    if (circuitBreakerTripped) return;
    sawAssistantMessage = false;

    if (lastItemIsThinking(event.message) || lastItemIsToolUse(event.message)) {
      const stopReason = (event.message as any).stopReason;
      if (stopReason === "aborted" || stopReason === "error") return;

      // Normal tool call flow: LLM stops with stopReason="tool_use" to let the tool run.
      if (lastItemIsToolUse(event.message) && stopReason === "tool_use") return;

      if (Date.now() < cooldownUntil) return;
      cooldownUntil = Date.now() + 10_000;

      stallCount++;
      const reason = lastItemIsThinking(event.message)
        ? "stopped mid-thought"
        : "stopped after tool call";

      // Escalate based on consecutive stall count
      if (stallCount >= STALL_STOP) {
        // Stop sending resumes — context is likely corrupted
        const msg = `[Gallop] Agent has stalled ${stallCount} times consecutively. Stopping auto-resume to prevent infinite loop. Please try /new, /compact, or change the prompt.`;
        pi.sendUserMessage(msg, { deliverAs: "steer" });

        if (ctx.hasUI) {
          ctx.ui.notify(`Gallop: stall loop stopped (${stallCount} stalls)`, "error");
        }
        return;
      }

      if (stallCount >= STALL_WARN) {
        const msg = `[Gallop] Resume: ${reason} (stopReason: ${stopReason}). This is stall #${stallCount} — if generation keeps stopping, consider compacting or restarting.`;
        pi.sendUserMessage(msg, { deliverAs: "steer" });

        if (ctx.hasUI) {
          ctx.ui.notify(`Gallop: repeated stall #${stallCount} (${reason})`, "warning");
        }
        return;
      }

      const msg = `[Gallop] Resume: ${reason} (stopReason: ${stopReason})`;
      pi.sendUserMessage(msg, { deliverAs: "steer" });

      if (ctx.hasUI) {
        ctx.ui.notify(`Gallop: ${reason} (stopReason: ${stopReason})`, "info");
      }
    } else {
      // Non-stall message — reset stall counter
      stallCount = 0;
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
      const args = (event as any).input as Record<string, unknown> | undefined;
      const argFingerprint = normalizeToolArgs(event.toolName, args);
      const callFingerprint = `${event.toolName}:${argFingerprint}`;

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
    if (event.toolName !== "bash") return;

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

    if (isBinaryContent(fullText)) {
      const bytes = new TextEncoder().encode(fullText).length;
      const command = (event.input as any)?.command;
      const shortCommand = typeof command === "string"
        ? command.split("\n")[0].trim().length > 80
          ? command.split("\n")[0].trim().slice(0, 77) + "..."
          : command.split("\n")[0].trim()
        : "<unknown>";

      // Detect reason for binary flag
      let reason = "";
      if (fullText.includes("\0")) {
        reason = "contains null bytes";
      } else {
        let nonPrintable = 0;
        for (let i = 0; i < fullText.length; i++) {
          const code = fullText.charCodeAt(i);
          if ((code >= 0x00 && code <= 0x08) ||
              code === 0x0B || code === 0x0C ||
              (code >= 0x0E && code <= 0x1F) ||
              code === 0x7F) {
            nonPrintable++;
          }
        }
        const pct = ((nonPrintable / fullText.length) * 100).toFixed(1);
        reason = `${pct}% non-printable characters`;
      }

      // Hex dump of first 64 bytes for debugging (safe ASCII only)
      const rawBytes = new TextEncoder().encode(fullText);
      const headBytes = rawBytes.slice(0, 64);
      const hexHead = Array.from(headBytes)
        .map(b => b.toString(16).padStart(2, "0"))
        .join(" ");

      return {
        content: [{
          type: "text",
          text: `[Gallop] Binary output suppressed — ${bytes.toLocaleString()} bytes (${reason})\nCommand: \`${shortCommand}\`\nHead (hex): ${hexHead}\nBinary content is hidden to protect context. The output was not sent to the model.`,
        }],
      };
    }
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
          // Successful execution — reset failure history and escalation to avoid stale detections
          failureHistory.length = 0;
          failureEscalation.clear();
          blockedPatterns.clear();
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
          });

          // Prune old entries outside the window
          pruneFailureHistory(failureHistory, currentTurnIndex, FAILURE_WINDOW_TURNS);

          // Check for failure loop
          checkFailureLoop(normalized, fingerprint, ctx, pi);
        }
      }
    }

    // ── Repetitive-call detection ──
    // Skip when bash just failed — failure-loop handler already covered it
    if (!(event.toolName === "bash" && event.isError) &&
        repetitiveCallState && repetitiveCallState.count >= REPETITIVE_CALL_THRESHOLD) {
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
    failureEscalation.clear();
    failureLoopCooldownUntil = 0;
    repetitiveCallCooldownUntil = 0;

    // Reset repetitive-call detection after compaction
    repetitiveCallState = null;
    repetitiveEscalation.clear();

    // Reset escalation state after compaction
    blockedPatterns.clear();
    totalBlocks = 0;
    circuitBreakerTripped = false;
    circuitBreakerHalted = false;
    stallCount = 0;
  });
}
