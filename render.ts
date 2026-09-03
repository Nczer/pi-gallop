/**
 * render.ts — TUI renderers for the gallop tools (TUI + /export HTML).
 *
 * Without renderCall/renderResult, pi's /export HTML falls into its default
 * case — JSON.stringify(args), i.e. the full checkpoint summary dumped in
 * every export (native tools like read/bash ship one-line renderers instead).
 * These renderers keep the native look: a one-line title plus the short
 * result line. The checkpoint itself is deliberately NOT rendered here — the
 * [compaction] entry right below the call already carries it (Ctrl+O in the
 * TUI, click in the export), and showing it in the tool view would print the
 * same text twice under the same expand toggle.
 *
 * Theme is the public pi-coding-agent export (pi-tui does not export it);
 * renderer parameters are contextually typed by registerTool, so they track
 * pi's ToolDefinition signature instead of a hand-kept structural copy.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Shape of the tool result the renderers read (pi's content-block array). */
export interface ToolResultShape {
  content?: Array<{ type: string; text?: string }>;
}

export function formatToolCallLine(theme: Theme, name: string): string {
  return theme.fg("toolTitle", theme.bold(name));
}

export function formatCompactResultText(
  theme: Theme,
  result: ToolResultShape | undefined,
  options: { isPartial?: boolean },
): string {
  if (options.isPartial) return theme.fg("warning", "Compacting…");
  const text = (result?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
  return text ? theme.fg("toolOutput", text) : "";
}

/** context_status: the result IS the payload — collapsed shows the usage line
 *  only, expanded the full text (usage / thresholds / advice). No args are
 *  ever shown (the tool has none). */
export function formatStatusResultText(
  theme: Theme,
  result: ToolResultShape | undefined,
  options: { isPartial?: boolean; expanded?: boolean },
): string {
  if (options.isPartial) return theme.fg("warning", "Measuring…");
  const text = (result?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
  if (!text) return "";
  return theme.fg("toolOutput", options.expanded ? text : text.split("\n")[0]!);
}

/** Renderers for one tool (shapes match pi's ToolDefinition render hooks). */
export interface ToolRenderers {
  renderCall: (args: unknown, theme: Theme) => Text;
  renderResult: (
    result: ToolResultShape | undefined,
    options: { isPartial?: boolean; expanded?: boolean },
    theme: Theme,
  ) => Text;
}

/** compact_request: one-line title + short result line (the checkpoint
 *  lives in the [compaction] entry, never in the tool view). */
export const compactRequestRenderers: ToolRenderers = {
  renderCall(_args, theme) {
    return new Text(formatToolCallLine(theme, "compact_request"), 0, 0);
  },
  renderResult(result, options, theme) {
    return new Text(formatCompactResultText(theme, result, options), 0, 0);
  },
};

/** context_status: one-line title; collapsed = usage line, expanded = full. */
export const contextStatusRenderers: ToolRenderers = {
  renderCall(_args, theme) {
    return new Text(formatToolCallLine(theme, "context_status"), 0, 0);
  },
  renderResult(result, options, theme) {
    return new Text(formatStatusResultText(theme, result, options), 0, 0);
  },
};
