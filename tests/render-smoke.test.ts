import { describe, expect, it, vi } from "vitest";
import gallopExtension from "../index.ts";

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

  it("collapsed result is the usage line only; expanded shows the full text", () => {
    const tool = captureTools().get("context_status");
    const collapsed: any = tool.renderResult(
      { content: [{ type: "text", text: STATUS }] },
      { expanded: false, isPartial: false },
      fakeTheme,
      {},
    );
    const lines = collapsed.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("142.3k / 200k");
    expect(lines[0]).not.toContain("Thresholds");
    expect(lines[0]).not.toContain("Advice");

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
