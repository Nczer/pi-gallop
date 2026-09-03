/**
 * Gallop Extension — composition root.
 *
 * Keeps the agent moving:
 * - self-compact: the model writes a checkpoint and requests compaction
 *   (compact_request); gallop nudges it to compact as context fills, and
 *   context_status exposes usage on demand
 * - stall detection: stalled generation gets a resume steer
 * - intervention: failure loops, repetitive calls, and reasoning-action
 *   mismatches escalate nudge → nudge_plus → block, with a user-facing
 *   circuit breaker
 * - binary protection: the read guard blocks reads of binary files, binary
 *   tool output is suppressed
 *
 * Subsystems: self-compact.ts (compaction lifecycle + the two tools),
 * stall.ts, intervention.ts (detectors + escalation + breaker), binary.ts
 * (detection + suppression + read guard + toggles), render.ts (TUI
 * renderers). This file wires pi events to the subsystems and owns the
 * session lifecycle — state resets on session start and on compaction, and
 * the settings toggle reload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadExtSettings } from "./ext-settings";
import * as binary from "./binary";
import * as intervention from "./intervention";
import * as selfCompact from "./self-compact";
import * as stall from "./stall";

/** True while an assistant message is in flight (message_start →
 *  message_end); message_end processing is gated on it. */
let sawAssistantMessage = false;

/** Reset all gallop state. Called on session start and compaction (and via
 *  the breaker's "Continue", which the composition root injects into
 *  intervention as setFullReset). */
function resetAllState(): void {
  sawAssistantMessage = false;
  selfCompact.reset();
  intervention.reset();
  stall.reset();
}

export default function gallopExtension(pi: ExtensionAPI) {
  intervention.setFullReset(resetAllState);
  selfCompact.registerTools(pi, process.cwd());
  binary.registerCommands(pi);

  // ── Session lifecycle ──
  pi.on("session_start", () => {
    resetAllState();
    const gallopSettings = loadExtSettings("gallop", binary.GALLOP_DEFAULTS);
    binary.setToggles(gallopSettings);
  });

  // ── Message liveness + the new-user-turn compact re-arm ──
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      sawAssistantMessage = true;
    } else if (event.message.role === "user") {
      // A new user turn: a user message now follows any prior compaction, so the
      // "already compacted" re-trigger window is over — allow future compaction.
      selfCompact.noteUserTurn();
    }
  });

  // ── Message end: nudge, mismatch, stall ──
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !sawAssistantMessage) return;

    // Circuit breaker tripped — no more auto-intervention, including the
    // context nudge (a steer would restart a run gallop is backing off from).
    if (intervention.tripped()) return;

    selfCompact.onMessageEnd(event.message, ctx, pi);
    sawAssistantMessage = false;
    intervention.onMessageEnd(event.message, ctx, pi);
    stall.onMessageEnd(event.message, ctx, pi);
  });

  // ── Deferred compact trigger (after the post-run loop) ──
  pi.on("agent_settled", (_event, ctx) => {
    selfCompact.onSettled(ctx, pi);
  });

  // ── Pending-compact input gate ──
  pi.on("input", (event, ctx) => {
    return selfCompact.onInput(event, ctx);
  });

  // ── Turn tracking (failure-loop window) ──
  pi.on("turn_start", () => {
    intervention.onTurnStart();
  });

  // ── Tool call interceptor: halt, read guard, enforced blocks ──
  pi.on("tool_call", async (event, ctx) => {
    // User halted via circuit breaker — block everything
    if (intervention.halted()) {
      return { block: true, reason: intervention.haltReason() };
    }
    // Circuit breaker tripped — no more auto-intervention
    if (intervention.tripped()) return;
    return binary.guardRead(event, ctx) ?? (await intervention.guardToolCall(event, ctx, pi));
  });

  // ── Binary output filter ──
  pi.on("tool_result", (event) => {
    return binary.filterToolResult(event);
  });

  // ── Failure/repetitive detection (start stashes args; end detects) ──
  pi.on("tool_execution_start", (event) => {
    intervention.onToolExecutionStart(event);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    intervention.onToolExecutionEnd(event, ctx, pi);
  });

  // ── Compaction lifecycle ──
  pi.on("session_before_compact", (event, ctx) => {
    return selfCompact.onBeforeCompact(event, ctx);
  });

  pi.on("context", (event) => {
    return selfCompact.onContext(event);
  });

  pi.on("session_compact", (_event, ctx) => {
    const outcome = selfCompact.onCompacted(ctx);
    // Reset all gallop state after compaction to avoid stale state
    resetAllState();
    if (outcome.stashed.length > 0) {
      selfCompact.scheduleStashedRedelivery(outcome.stashed, pi);
    } else if (outcome.continueAfter) {
      selfCompact.scheduleContinueSteer(pi);
    }
  });

  pi.on("session_compact_failed", () => {
    selfCompact.onCompactFailed(pi);
  });
}
