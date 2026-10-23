/**
 * status.ts — gallop's ONE line in pi's footer extension-status area.
 *
 * pi puts every extension status on a single shared line
 * (`components/footer.js` joins the statuses and truncates at terminal width),
 * and the user's footer extension orders that line with its own
 * `STATUS_PRIORITY`, in which the key `compact` has a reserved slot ahead of
 * the unknown-key tail. So gallop owns exactly one key and composes its own
 * parts, instead of several subsystems writing the same key and clobbering one
 * another:
 *
 *   · ⚠ ~12k left → compact_request · ⚠ failure loop ×3
 *     ^ state part (self-compact)     ^ nudge part (intervention / stall / continue)
 *
 * Lifecycle of the two parts:
 * - state part (compaction pressure, `⟳ Compacting...`) lives until the path
 *   that ends the compaction cycle clears it — compaction completed or aborted,
 *   or the session branch changed (`/tree`). Unchanged from before this file
 *   existed; it only moved here so one writer owns the key.
 * - nudge part: every delivery states what keeps it truthful (`live()` — a
 *   predicate over the state that produced it: the ladder entry, the stall
 *   streak, the owed continue). `reconcile` runs at the detection points that
 *   already mutate that state and drops the part as soon as it goes false, i.e.
 *   as soon as the model has addressed the nudge. No timers: a timer would
 *   clear a line while the model is still working on it.
 *
 * Headless (`!ctx.hasUI`) is a no-op for every render, but the state stays
 * tracked, so an extension reload mid-run cannot strand a part in the footer.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** pi's reserved slot for compaction-facing statuses. */
const STATUS_KEY = "compact";

// Parts hold plain text plus a register (a pi ThemeColor); theme.fg is applied
// in render(), where ctx.ui is guaranteed. That keeps the setters callable with
// a non-interactive ctx (headless pi, RPC, tests): the part is tracked, nothing
// is painted. The union is closed on purpose — the register is a contract, not a
// free color choice.
type Register = "dim" | "warning" | "error";
type Part = { text: string; live: () => boolean; severity: Register };

let statePart: Part | null = null;
let nudgePart: Part | null = null;

function render(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  const parts = [statePart, nudgePart]
    .filter((p): p is Part => !!p)
    .map((p) => theme.fg(p.severity, p.text));
  if (parts.length === 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  // The leading `· ` prefix is what every other status string carries; the
  // footer extension strips it, so the separator between our own parts is a
  // plain dim dot.
  ctx.ui.setStatus(STATUS_KEY, `${theme.fg("dim", "· ")}${parts.join(` ${theme.fg("dim", "·")} `)}`);
}

/** Set the state part (compaction pressure / in-flight compaction). Pressure is
 *  a caution, not an error, so it paints as warning. */
export function setState(ctx: ExtensionContext, text: string, severity: Register = "warning"): void {
  statePart = { text, live: () => true, severity };
  render(ctx);
}

/** Set the nudge part. `live` is the condition that keeps it on screen;
 *  `severity` picks the theme color: "error" for escalations the user should
 *  notice, "dim" for a note about something already done (the ✓ after a
 *  compaction) — the same register rule memory's footer parts use. */
export function setNudge(
  ctx: ExtensionContext,
  text: string,
  live: () => boolean,
  severity: Register = "warning",
): void {
  nudgePart = { text, live, severity };
  render(ctx);
}

/** Drop the nudge part now (explicit — e.g. the circuit breaker's "Continue"). */
export function clearNudge(ctx: ExtensionContext): void {
  if (!nudgePart) return;
  nudgePart = null;
  render(ctx);
}

/** Drop the nudge part if its own `live()` condition no longer holds. Call it
 *  wherever the subsystem state that produced the nudge has just changed. */
export function reconcile(ctx: ExtensionContext): void {
  if (!nudgePart || nudgePart.live()) return;
  nudgePart = null;
  render(ctx);
}

/** Take gallop's state part out of the footer line, leaving a live nudge part
 *  alone (it has its own lifecycle). */
export function setStateCleared(ctx: ExtensionContext): void {
  if (!statePart) return;
  statePart = null;
  render(ctx);
}

/** Clear both parts from the footer (session branch switch). */
export function clearAll(ctx: ExtensionContext): void {
  statePart = null;
  nudgePart = null;
  render(ctx);
}

/** State-only reset for the composition root's `resetAllState` (no render: the
 *  caller either has no UI context at that point — session start, compaction —
 *  or clears the footer itself via `clearAll`). */
export function reset(): void {
  statePart = null;
  nudgePart = null;
}
