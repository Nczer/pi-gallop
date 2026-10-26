import { describe, expect, it, vi } from "vitest";
import gallopExtension from "../index.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";

/** pi's expand hint reads pi's own theme singleton (and throws before it is
 *  initialized), so it is initialized here the way the app does it. Its key TEXT
 *  resolves from a live keybinding registry, which a bare harness has none of:
 *  the assertions strip ANSI and pin the wording around the key. */
initTheme(undefined, false);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const fakeTheme = {
  fg: (name: string, text: string) => `<${name}>${text}</>`,
  bold: (text: string) => `*${text}*`,
};

function captureTools() {
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: vi.fn(),
    on: vi.fn(),
  };
  gallopExtension(pi);
  return tools;
}

describe("compact_request renderers", () => {
  const SUMMARY = "## Goal\nFix the thing.\n\n## Next Steps\n1. Done";
  const args = { summary: SUMMARY };

  it("call is a single title line — no args, no expand hint", () => {
    const tool = captureTools().get("compact_request");
    const comp: any = tool.renderCall(args, fakeTheme, {});
    const lines = comp.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("compact_request");
    expect(lines[0]).not.toContain("context bloat");
    expect(lines[0]).not.toContain("Ctrl+O");
    expect(lines[0]).not.toContain("## Goal");
  });

  it("collapsed result is the short line only", () => {
    const tool = captureTools().get("compact_request");
    const comp: any = tool.renderResult(
      { content: [{ type: "text", text: "Compacting." }] },
      { expanded: false, isPartial: false },
      fakeTheme,
      {},
    );
    const lines = comp.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Compacting.");
    expect(lines[0]).not.toContain("## Goal");
  });

  it("expanded result does NOT re-render the checkpoint (it lives in the [compaction] entry)", () => {
    const tool = captureTools().get("compact_request");
    const comp: any = tool.renderResult(
      { content: [{ type: "text", text: "Compacting." }] },
      { expanded: true, isPartial: false },
      fakeTheme,
      { expanded: true, args },
    );
    const out = comp.render(100).join("\n");
    expect(out).toContain("Compacting.");
    expect(out).not.toContain("## Goal");
    expect(out).not.toContain("Fix the thing.");
  });

  it("partial result shows the warning line", () => {
    const tool = captureTools().get("compact_request");
    const comp: any = tool.renderResult(
      { content: [] },
      { expanded: false, isPartial: true },
      fakeTheme,
      {},
    );
    expect(comp.render(100)[0]).toContain("Compacting…");
  });
});

describe("context_status renderers", () => {
  const STATUS =
    "142.3k / 200k tokens (71.2%) — 57.7k remaining\n"
    + "Thresholds: gallop nudge ~18.4k remaining · pi auto-compact ~16.4k remaining\n"
    + "Advice: headroom OK.";

  it("call is a single title line", () => {
    const tool = captureTools().get("context_status");
    const comp: any = tool.renderCall({}, fakeTheme, {});
    const lines = comp.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("context_status");
  });

  it("collapsed result is the usage line plus pi's mark; expanded shows the full text", () => {
    const tool = captureTools().get("context_status");
    const collapsed: any = tool.renderResult(
      { content: [{ type: "text", text: STATUS }] },
      { expanded: false, isPartial: false },
      fakeTheme,
      {},
    );
    const lines = collapsed.render(120);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain("142.3k / 200k");
    // The collapse is what needs saying: pi's mark, on the same line.
    // The collapse is what needs saying: pi's mark, riding the same line.
    // (`keyHint` styles through pi's singleton theme, so the fake-theme tags and
    //  pi's codes interleave — match the wording, not the markup.)
    expect(stripAnsi(lines[0])).toMatch(/\.\.\. \(2 more lines, .*to expand.*\)/);
    expect(stripAnsi(lines[0])).not.toContain("Thresholds");
    expect(stripAnsi(lines[0])).not.toContain("Advice");

    const expanded: any = tool.renderResult(
      { content: [{ type: "text", text: STATUS }] },
      { expanded: true, isPartial: false },
      fakeTheme,
      {},
    );
    const out = expanded.render(100).join("\n");
    expect(out).toContain("Thresholds");
    expect(out).toContain("Advice: headroom OK.");
  });

  it("partial result shows the warning line", () => {
    const tool = captureTools().get("context_status");
    const comp: any = tool.renderResult(
      { content: [] },
      { expanded: false, isPartial: true },
      fakeTheme,
      {},
    );
    expect(comp.render(100)[0]).toContain("Measuring…");
  });
});
