/**
 * stall.ts — stalled-generation detection.
 *
 * An assistant message that ends on a thinking or toolCall block with a stop
 * reason other than "toolUse" means generation stopped mid-stream. Gallop
 * sends a resume steer (throttled to one per 10s so a stuck loop doesn't
 * spam); after STALL_WARN consecutive stalls the steers become warnings, and
 * at STALL_STOP gallop stops auto-resuming (context is likely corrupted) and
 * notifies the user once — further stalls stay silent so the notice itself
 * doesn't loop. A healthy tool-call handoff (stopReason "toolUse") resets
 * the streak, as does any other normal message end.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STALL_WARN = 4;                 // Stalls before strong warning
const STALL_STOP = 5;                 // Stalls before stopping and notifying user
const RESUME_COOLDOWN_MS = 10_000;    // Resume-steer throttle window

let stallCount = 0;
let stallStopNotified = false;
let cooldownUntil = 0;

export interface StallMessage {
  content?: unknown;
  stopReason?: string;
}

export function lastItemIsThinking(message: { content?: unknown }): boolean {
  const content = message.content;
  if (!content || !Array.isArray(content) || content.length === 0) return false;
  const last = content[content.length - 1];
  return typeof last === "object" && last !== null && (last as any).type === "thinking";
}

export function lastItemIsToolUse(message: { content?: unknown }): boolean {
  const content = message.content;
  if (!content || !Array.isArray(content) || content.length === 0) return false;
  const last = content[content.length - 1];
  // Assistant tool-call content blocks use type "toolCall" (not "tool_use").
  return typeof last === "object" && last !== null && (last as any).type === "toolCall";
}

/** One assistant message end (the caller has already filtered by role):
 *  counts stalls and sends the resume/warning/stop steers. */
export function onMessageEnd(message: StallMessage, ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (lastItemIsThinking(message) || lastItemIsToolUse(message)) {
    const stopReason = message.stopReason;
    if (stopReason === "aborted" || stopReason === "error") return;

    // Normal tool call flow: LLM stops with stopReason "toolUse" to let the tool run.
    if (lastItemIsToolUse(message) && stopReason === "toolUse") {
      // Healthy handoff — resets the consecutive-stall streak.
      stallCount = 0;
      stallStopNotified = false;
      return;
    }

    stallCount++;
    const reason = lastItemIsThinking(message)
      ? "stopped mid-thought"
      : "stopped after tool call";

    // Count every stall so fast stuck loops still escalate, but throttle
    // resume messages to one per 10s so a stuck loop doesn't spam.
    const messageAllowed = Date.now() >= cooldownUntil;
    if (messageAllowed) {
      cooldownUntil = Date.now() + RESUME_COOLDOWN_MS;
    }

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
    stallCount = 0;
    stallStopNotified = false;
  }
}

export function reset(): void {
  stallCount = 0;
  stallStopNotified = false;
  cooldownUntil = 0;
}
