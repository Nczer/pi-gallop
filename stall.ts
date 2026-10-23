/**
 * stall.ts — stalled-generation detection.
 *
 * An assistant message that ends on a thinking block with a stop reason other
 * than "aborted"/"error" means generation stopped mid-thought: nothing is left
 * to execute, so pi's loop ends and the task strands. Gallop sends a resume
 * steer (throttled to one per 10s so a stuck loop doesn't spam); after
 * STALL_WARN consecutive stalls the steers become warnings, and at STALL_STOP
 * gallop stops auto-resuming (context is likely corrupted) and notifies the
 * user once — further stalls stay silent so the notice itself doesn't loop.
 * Any other message end resets the streak.
 *
 * A "length" stop is not a stall either, and gets no resume steer. The output
 * hit the token limit, so what is missing is output budget, not a nudge: with
 * tool calls in the message pi fails them itself and keeps the run going, and
 * with none, a resumed generation on the same exhausted budget just truncates
 * again (field: session 01a14841, 2026-10-17 — the message ended mid-thought on
 * "length", the resume steer bought a 32-token fragment, and the next message
 * truncated too). The context-pressure nudge is the steer that helps there.
 *
 * A message ending on a tool call is NOT a stall. pi executes the tool calls in
 * a message whatever the provider's finish_reason says — only "error" and
 * "aborted" end the run early, and the loop keeps going unless the tool batch
 * asked to terminate (pi-agent-core/dist/agent-loop.js:108,118-126) — and
 * providers do report finish_reason "stop" on tool-call messages (field:
 * llama.cpp + Qwen, 2026-10-14). The old `stopReason !== "toolUse"` test read
 * that as a stall, and the resume steer it injected restarted pi's post-run
 * loop, holding gallop's own deferred compact (agent_settled) off for 14 more
 * tool calls.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as status from "./status";
import { sendHiddenSteer } from "./steer";

/** customType of the resume steer (see steer.ts). */
export const STALL_TYPE = "gallop-stall";

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

/** One assistant message end (the caller has already filtered by role):
 *  counts stalls and sends the resume/warning/stop steers. */
export function onMessageEnd(message: StallMessage, ctx: ExtensionContext, pi: ExtensionAPI): void {
  if (!lastItemIsThinking(message)) {
    // Text answer, tool-call handoff (executed or not — pi runs them either
    // way), or empty content: not a stall, and it breaks a stall streak.
    stallCount = 0;
    stallStopNotified = false;
    // The resume nudge's footer part lives on `stallCount` — it just went false.
    status.reconcile(ctx);
    return;
  }

  const stopReason = message.stopReason;
  if (stopReason === "aborted" || stopReason === "error") return;   // user or pi ended the run — not a stall
  // Output hit the token limit — pi owns this case, and resuming does not fix
  // it (see the header). Neither counted nor streak-breaking: it says nothing
  // about whether the model keeps halting mid-thought.
  if (stopReason === "length") return;

  // A genuine mid-thought stall.
  stallCount++;
  const reason = "stopped mid-thought";

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
      sendHiddenSteer(pi, STALL_TYPE, msg);

      if (ctx.hasUI) {
        // The one stall case that asks something of the USER, so it keeps its
        // toast on top of the footer part.
        status.setNudge(
          ctx,
          `⛔ stalled ×${stallCount} — auto-resume off`,
          () => stallCount > 0,
          "error",
        );
        ctx.ui.notify(`Gallop: stall loop stopped (${stallCount} stalls)`, "error");
      }
    }
    return;
  }

  if (stallCount >= STALL_WARN) {
    if (messageAllowed) {
      const msg = `[Gallop] Resume: ${reason} (stopReason: ${stopReason}). This is stall #${stallCount} — if generation keeps stopping, consider compacting or restarting.`;
      sendHiddenSteer(pi, STALL_TYPE, msg);

      if (ctx.hasUI) {
        status.setNudge(ctx, `⚠ stall #${stallCount}: resumed`, () => stallCount > 0);
      }
    }
    return;
  }

  if (messageAllowed) {
    const msg = `[Gallop] Resume: ${reason} (stopReason: ${stopReason})`;
    sendHiddenSteer(pi, STALL_TYPE, msg);

    if (ctx.hasUI) {
      status.setNudge(ctx, `⚠ stall: resumed`, () => stallCount > 0);
    }
  }
}

export function reset(): void {
  stallCount = 0;
  stallStopNotified = false;
  cooldownUntil = 0;
}
