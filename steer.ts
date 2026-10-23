/**
 * steer.ts — the one transport for every steer gallop puts in front of the model.
 *
 * A hidden custom message (`display: false`), never a user message: the
 * transcript stays the user's own words, and the steer shows up only where it
 * is honest to show it — in the footer line (status.ts) while it is live, in
 * the session file, and in /export, which labels display:false customs
 * "[<customType>] · Hidden in terminal" with the full text.
 *
 * Verified against pi's `sendCustomMessage` (`core/agent-session.js`):
 * - mid-run (`isStreaming`, which stays true through pi's post-run and
 *   compaction loop) `deliverAs:"steer"` queues it in the same steering queue
 *   `sendUserMessage` used, so pi's post-run loop still sees a queued message
 *   and continues the run;
 * - idle, `triggerTurn:true` starts a turn — preserving what `sendUserMessage`
 *   always did. Passing both options is what covers both cases;
 * - `convertToLlm` maps role `custom` to role `user` verbatim, so the model
 *   reads exactly the text it read before;
 * - the message is persisted as a CustomMessageEntry on `message_end`, so it
 *   survives resume.
 * Two consequences, accepted deliberately: the idle path bypasses `prompt()`,
 * so pi's model/API-key preflight and its pre-send compaction check do not
 * re-run for a steer; and customs never enter pi's steering-queue mirror, so
 * they are not listed in the "Steering: …" pending display and the dequeue key
 * drops them instead of returning them to the editor.
 *
 * `customType` is per steer family (gallop-nudge, gallop-retry,
 * gallop-repetitive, gallop-mismatch, gallop-stall, gallop-continue) so the
 * session file and /export say which steer a message was.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function sendHiddenSteer(pi: ExtensionAPI, customType: string, content: string): void {
  // No delivery signal exists: ExtensionAPI types this as Promise<void> and
  // pi's bridge swallows a rejection into its own extension-error event
  // (agent-session.ts), so a failed send is pi's record, not this call's.
  void pi.sendMessage(
    { customType, content, display: false },
    { triggerTurn: true, deliverAs: "steer" },
  );
}
