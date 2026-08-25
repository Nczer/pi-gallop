import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import gallopExtension, {
  formatTokenCount,
  contextStatusAdvice,
  buildContextStatusText,
} from "../index";

const DEFAULTS = { reserveTokens: 16_384, enabled: true, keepRecentTokens: 20_000 };
const WINDOW = 200_000;

// ── formatTokenCount ──

describe("formatTokenCount", () => {
  it("keeps small counts raw", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(950)).toBe("950");
  });

  it("uses k for thousands and M for millions, trims .0", () => {
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(1_200)).toBe("1.2k");
    expect(formatTokenCount(16_384)).toBe("16.4k");
    expect(formatTokenCount(18_432)).toBe("18.4k");
    expect(formatTokenCount(142_300)).toBe("142.3k");
    expect(formatTokenCount(200_000)).toBe("200k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_234_567)).toBe("1.2M");
  });
});

// ── contextStatusAdvice tiers ──

describe("contextStatusAdvice", () => {
  it("headroom OK above 2× the nudge threshold (and under the soft size tier)", () => {
    // default threshold 18_432; 2× = 36_864; soft tier at 100k used
    expect(contextStatusAdvice(50_000, 40_000, DEFAULTS)).toBe("Advice: headroom OK.");
    expect(contextStatusAdvice(36_865, 90_000, DEFAULTS)).toBe("Advice: headroom OK.");
  });

  it("pressure building between the threshold and 2× it", () => {
    // remaining tier wins over the size tier, even for a large context
    expect(contextStatusAdvice(30_000, 150_000, DEFAULTS)).toContain("pressure building");
    expect(contextStatusAdvice(18_433, 150_000, DEFAULTS)).toContain("pressure building");
  });

  it("near the backstop at or below the threshold (auto-compact on)", () => {
    expect(contextStatusAdvice(18_432, 180_000, DEFAULTS)).toBe(
      "Advice: near the backstop — call request_compact now if at a pause point.",
    );
    expect(contextStatusAdvice(0, 200_000, DEFAULTS)).toContain("near the backstop");
  });

  it("names the missing backstop when auto-compact is off", () => {
    // disabled → fixed 16k threshold
    expect(contextStatusAdvice(15_000, 180_000, { ...DEFAULTS, enabled: false })).toBe(
      "Advice: near the limit and auto-compact is off — call request_compact now if at a pause point.",
    );
    // disabled → 2× fixed 16k = 32k still counts as pressure building
    expect(contextStatusAdvice(17_000, 180_000, { ...DEFAULTS, enabled: false })).toContain("pressure building");
    expect(contextStatusAdvice(33_000, 90_000, { ...DEFAULTS, enabled: false })).toBe("Advice: headroom OK.");
  });

  it("suggests compacting a large context with otherwise-OK headroom", () => {
    expect(contextStatusAdvice(100_000, 100_001, DEFAULTS)).toContain("large context");
    expect(contextStatusAdvice(100_000, 142_300, DEFAULTS)).toContain("~142.3k used");
    // exactly at the soft tier is not large
    expect(contextStatusAdvice(100_000, 100_000, DEFAULTS)).toBe("Advice: headroom OK.");
  });

  it("tracks a custom reserveTokens", () => {
    const s = { ...DEFAULTS, reserveTokens: 8_000 };
    // threshold 10_048; 2× = 20_096
    expect(contextStatusAdvice(10_048, 190_000, s)).toContain("near the backstop");
    expect(contextStatusAdvice(15_000, 190_000, s)).toContain("pressure building");
    expect(contextStatusAdvice(20_097, 90_000, s)).toBe("Advice: headroom OK.");
  });
});

// ── buildContextStatusText ──

describe("buildContextStatusText", () => {
  it("reports usage, remaining, thresholds, and advice", () => {
    const text = buildContextStatusText(
      { tokens: 142_300, contextWindow: WINDOW, percent: 71.2 },
      DEFAULTS,
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("142.3k / 200k tokens (71.2%) — 57.7k remaining");
    expect(lines[1]).toBe("Thresholds: gallop nudge ~18.4k remaining · pi auto-compact ~16.4k remaining");
    expect(lines[2]).toBe(
      "Advice: large context (~142.3k used) — models (especially local) work best under ~100k; if the next task does not depend on the current context window, call request_compact at this boundary.",
    );
  });

  it("stays headroom OK below the soft size tier", () => {
    const text = buildContextStatusText(
      { tokens: 80_000, contextWindow: WINDOW, percent: 40 },
      DEFAULTS,
    );
    expect(text.split("\n")[2]).toBe("Advice: headroom OK.");
  });

  it("reports no data when pi has no usage or window", () => {
    expect(buildContextStatusText(undefined, DEFAULTS)).toBe(
      "No context usage data available (no model or context window).",
    );
    expect(buildContextStatusText({ tokens: 100, contextWindow: 0, percent: null }, DEFAULTS)).toBe(
      "No context usage data available (no model or context window).",
    );
  });

  it("reports the just-compacted window when tokens is null", () => {
    expect(
      buildContextStatusText({ tokens: null, contextWindow: WINDOW, percent: null }, DEFAULTS),
    ).toBe(
      "Context was just compacted — exact usage is unknown until the next response. Context is fresh; safe to proceed.",
    );
  });

  it("flags the missing backstop when auto-compact is off", () => {
    const text = buildContextStatusText(
      { tokens: 185_000, contextWindow: WINDOW, percent: 92.5 },
      { ...DEFAULTS, enabled: false },
    );
    expect(text.split("\n")[1]).toBe(
      "Thresholds: gallop nudge ~16k remaining · pi auto-compact OFF (no backstop)",
    );
    expect(text.split("\n")[2]).toContain("auto-compact is off");
  });

  it("clamps remaining at zero when the estimate overflows the window", () => {
    const text = buildContextStatusText(
      { tokens: 210_000, contextWindow: WINDOW, percent: 105 },
      DEFAULTS,
    );
    expect(text.split("\n")[0]).toContain("0 remaining");
    expect(text.split("\n")[2]).toContain("near the backstop");
  });
});

// ── Integration: context_status tool ──

describe("context_status tool (integration)", () => {
  let pi: any;
  let tools: Map<string, any>;
  let ctx: any;
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    const handlers = new Map<string, any>();
    tools = new Map<string, any>();
    pi = {
      on: vi.fn((name: string, handler: any) => handlers.set(name, handler)),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    gallopExtension(pi);
    // Isolate pi's settings read (gallop merges global + project settings.json,
    // the global path coming from $HOME).
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gallop-ctx-home-"));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gallop-ctx-cwd-"));
    vi.stubEnv("HOME", tmpHome);
    // Project settings pin all three compaction keys, so the thresholds in the
    // output are deterministic regardless of any real global settings.
    fs.mkdirSync(path.join(tmpCwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpCwd, ".pi", "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 16_384, enabled: true, keepRecentTokens: 20_000 } }),
    );
    ctx = {
      cwd: tmpCwd,
      model: { contextWindow: WINDOW },
      getContextUsage: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  const call = (usage: any) => {
    ctx.getContextUsage.mockReturnValue(usage);
    return tools.get("context_status").execute("id1", {}, new AbortController().signal, undefined, ctx);
  };

  it("is registered with no parameters", () => {
    const tool = tools.get("context_status");
    expect(tool).toBeDefined();
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("reports pi's usage + thresholds + advice, with no terminate", async () => {
    const result = await call({ tokens: 142_300, contextWindow: WINDOW, percent: 71.2 });
    expect(result.terminate).toBeUndefined();
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("142.3k / 200k tokens (71.2%) — 57.7k remaining");
    expect(lines[1]).toContain("gallop nudge ~18.4k");
    expect(lines[1]).toContain("pi auto-compact ~16.4k");
    expect(lines[2]).toContain("large context (~142.3k used)");
  });

  it("reports the just-compacted window when pi's usage is null", async () => {
    const result = await call({ tokens: null, contextWindow: WINDOW, percent: null });
    expect(result.content[0].text).toContain("just compacted");
  });

  it("reports no data when pi has no usage", async () => {
    const result = await call(undefined);
    expect(result.content[0].text).toBe("No context usage data available (no model or context window).");
  });

  it("reads the live pi settings (project scope wins)", async () => {
    // Custom reserveTokens in the project settings flows into both thresholds.
    fs.writeFileSync(
      path.join(tmpCwd, ".pi", "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 8_000, enabled: false } }),
    );
    const result = await call({ tokens: 185_000, contextWindow: WINDOW, percent: 92.5 });
    expect(result.content[0].text).toContain("pi auto-compact OFF (no backstop)");
    expect(result.content[0].text).toContain("auto-compact is off");
  });
});
