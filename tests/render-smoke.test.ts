import { describe, expect, it, vi } from "vitest";
import gallopExtension from "../index.ts";

const fakeTheme = {
  fg: (name: string, text: string) => `<${name}>${text}</>`,
  bold: (text: string) => `*${text}*`,
};

function captureTool() {
  const tool: any = {};
  const pi: any = {
    registerTool: (t: any) => Object.assign(tool, t),
    registerCommand: vi.fn(),
    on: vi.fn(),
  };
  gallopExtension(pi);
  return tool;
}

describe("request_compact renderers", () => {
  const SUMMARY = "## Goal\nFix the thing.\n\n## Next Steps\n1. Done";
  const args = { message: "context bloat", summary: SUMMARY };

  it("call is a single title line — no args, no expand hint", () => {
    const tool = captureTool();
    const comp: any = tool.renderCall(args, fakeTheme, {});
    const lines = comp.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("request_compact");
    expect(lines[0]).not.toContain("context bloat");
    expect(lines[0]).not.toContain("Ctrl+O");
    expect(lines[0]).not.toContain("## Goal");
  });

  it("collapsed result is the short line only", () => {
    const tool = captureTool();
    const comp: any = tool.renderResult(
      { content: [{ type: "text", text: "Compacting (context bloat)." }] },
      { expanded: false, isPartial: false },
      fakeTheme,
      {},
    );
    const lines = comp.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Compacting (context bloat).");
    expect(lines[0]).not.toContain("## Goal");
  });

  it("expanded result does NOT re-render the checkpoint (it lives in the [compaction] entry)", () => {
    const tool = captureTool();
    const comp: any = tool.renderResult(
      { content: [{ type: "text", text: "Compacting (context bloat)." }] },
      { expanded: true, isPartial: false },
      fakeTheme,
      { expanded: true, args },
    );
    const out = comp.render(100).join("\n");
    expect(out).toContain("Compacting (context bloat).");
    expect(out).not.toContain("## Goal");
    expect(out).not.toContain("Fix the thing.");
  });

  it("partial result shows the warning line", () => {
    const tool = captureTool();
    const comp: any = tool.renderResult(
      { content: [] },
      { expanded: false, isPartial: true },
      fakeTheme,
      {},
    );
    expect(comp.render(100)[0]).toContain("Compacting…");
  });
});
