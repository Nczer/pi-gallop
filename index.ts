/**
 * Gallop Extension
 *
 * Keeps the agent moving:
 * - Detects stalled generation (stopped mid-thinking or mid-tool-call) and sends resume
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
      const injection = maxTokens && maxTokens > 0
        ? `Context: ${formatTokens(usage.tokens)} / ${formatTokens(maxTokens)} (${pct}%)`
        : `Context: ${formatTokens(usage.tokens)}`;
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
  });
}
