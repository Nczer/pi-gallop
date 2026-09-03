import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import gallopExtension from "../index";
import {
  computeSelfCompactFileLists,
  appendSelfCompactFileOps,
  contextTokensFromUsage,
  readPiCompactionSettings,
  nudgeThreshold,
  checkpointFormat,
  tooSmallCompactError,
  computeCustomFirstKeptEntryId,
  COMPACT_DONE_MARKER,
  rewriteCompactContext,
} from "../self-compact";

// ── computeSelfCompactFileLists ──

describe("computeSelfCompactFileLists", () => {
  it("separates read-only from modified files and sorts both", () => {
    const fileOps = {
      read: new Set(["a.ts", "b.ts"]),
      written: new Set(["c.ts"]),
      edited: new Set(["a.ts"]),
    };
    // a.ts was edited → modified (not read-only); b.ts read-only; c.ts written → modified
    expect(computeSelfCompactFileLists(fileOps)).toEqual({
      readFiles: ["b.ts"],
      modifiedFiles: ["a.ts", "c.ts"],
    });
  });

  it("returns empty lists when there are no file ops", () => {
    const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
    expect(computeSelfCompactFileLists(fileOps)).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it("treats a written-but-not-read file as modified only", () => {
    const fileOps = { read: new Set<string>(), written: new Set(["x.ts"]), edited: new Set<string>() };
    expect(computeSelfCompactFileLists(fileOps)).toEqual({ readFiles: [], modifiedFiles: ["x.ts"] });
  });
});

// ── appendSelfCompactFileOps ──

describe("appendSelfCompactFileOps", () => {
  it("appends both sections in pi's format", () => {
    const fileOps = { read: new Set(["b.ts"]), written: new Set(["c.ts"]), edited: new Set(["a.ts"]) };
    expect(appendSelfCompactFileOps("SUMMARY", fileOps)).toBe(
      "SUMMARY\n\n<read-files>\nb.ts\n</read-files>\n\n<modified-files>\na.ts\nc.ts\n</modified-files>",
    );
  });

  it("returns the summary unchanged when there are no file ops", () => {
    const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
    expect(appendSelfCompactFileOps("SUMMARY", fileOps)).toBe("SUMMARY");
  });

  it("omits an empty section", () => {
    const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set(["a.ts"]) };
    expect(appendSelfCompactFileOps("SUMMARY", fileOps)).toBe(
      "SUMMARY\n\n<modified-files>\na.ts\n</modified-files>",
    );
  });
});

// ── tooSmallCompactError (minimum-context guard) ──

describe("tooSmallCompactError", () => {
  it("fails at or below the keep window", () => {
    expect(tooSmallCompactError(10_000, 20_000, false)).toMatch(/below the compaction minimum/);
    expect(tooSmallCompactError(20_000, 20_000, false)).toMatch(/below the compaction minimum/);
  });

  it("tells a nuke that pi refuses to compact a too-small session at all", () => {
    const err = tooSmallCompactError(10_000, 20_000, true);
    expect(err).toMatch(/refuses to compact this session at all/);
    expect(err).toMatch(/start a new session/);
  });

  it("proceeds above the keep window", () => {
    expect(tooSmallCompactError(20_001, 20_000, false)).toBeNull();
    expect(tooSmallCompactError(50_000, 20_000, true)).toBeNull(); // nuke on a large session
    expect(tooSmallCompactError(150_000, 20_000, false)).toBeNull();
  });

  it("proceeds when usage is unmeasurable (post-compaction null)", () => {
    expect(tooSmallCompactError(null, 20_000, false)).toBeNull();
    expect(tooSmallCompactError(undefined, 20_000, true)).toBeNull();
  });

  it("tracks a custom keep window", () => {
    expect(tooSmallCompactError(30_000, 40_000, false)).toMatch(/40k/);
    expect(tooSmallCompactError(50_000, 40_000, false)).toBeNull();
  });
});

// Session-shaped fixtures for computeCustomFirstKeptEntryId — pi's findCutPoint
// runs on the same entry shape (verified against pi's real walker).
const fixtureUser = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text, timestamp: 0 } });
const fixtureAssistant = (id: string, text: string) => ({
  type: "message",
  id,
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
});
const BIG_TEXT = "x".repeat(20_000); // ~5k tokens by pi's chars/4 heuristic

// ── computeCustomFirstKeptEntryId (nuke cut) ──

describe("computeCustomFirstKeptEntryId", () => {
  const entries = [fixtureUser("u1", "hello there"), fixtureAssistant("a1", BIG_TEXT), fixtureUser("u2", "second " + BIG_TEXT), fixtureAssistant("a2", "final")];

  it("keeps only the last turn's tail for a nuke (keep 0)", () => {
    expect(computeCustomFirstKeptEntryId(entries, 0)).toBe("a2");
  });

  it("cuts at a valid point for an intermediate keep", () => {
    expect(computeCustomFirstKeptEntryId(entries, 5_000)).toBe("u2");
  });

  it("keeps everything (first entry) when the budget exceeds the context", () => {
    expect(computeCustomFirstKeptEntryId(entries, 50_000)).toBe("u1");
  });

  it("returns null for empty entries", () => {
    expect(computeCustomFirstKeptEntryId([], 0)).toBeNull();
  });

  it("starts after the previous compaction's kept boundary", () => {
    // A compaction whose kept boundary is u2 — the already-summarized older
    // entries must never be re-kept, even with a huge budget.
    const withPrev = [...entries, { type: "compaction", id: "cmp", parentId: "a2", timestamp: 0, summary: "old state", firstKeptEntryId: "u2", tokensBefore: 10_000 }, fixtureUser("u3", "new work " + BIG_TEXT), fixtureAssistant("a3", "end")];
    expect(computeCustomFirstKeptEntryId(withPrev, 0)).toBe("a3");
    expect(computeCustomFirstKeptEntryId(withPrev, 5_000)).toBe("u3");
    expect(computeCustomFirstKeptEntryId(withPrev, 50_000)).toBe("u2");
  });
});

// ── Integration: compact_request tool + session_before_compact wiring ──

function makeMockPi() {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const pi = {
    on: vi.fn((name: string, handler: any) => { handlers.set(name, handler); }),
    registerTool: vi.fn((tool: any) => { tools.set(tool.name, tool); }),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  return { pi, handlers, tools };
}

/** A valid (>200 char) checkpoint summary in the exact format. */
const LONG_SUMMARY = `## Goal
Test goal: refactor the compaction machinery of the gallop extension.

## Constraints & Preferences
- Keep the extension silent in the main session except for status indicators.

## Progress
### Done
- [x] Removed the old fork summarizer
- [x] Rewrote the compact_request tool

### In Progress
- [ ] Rewriting the test suite

### Blocked
- (none)

## Key Decisions
- **In-session summary**: the model writes the checkpoint itself so the LLM call is cache-warm.

## Next Steps
1. Finish the test suite and run it
2. Update the README and CHANGELOG

## Critical Context
- MIN_SUMMARY_LENGTH is 200; shorter summaries fall back to pi's native one-shot.`;

describe("self-compact wiring (in-session summary)", () => {
  let pi: any;
  let handlers: Map<string, any>;
  let tools: Map<string, any>;
  let ctx: any;

  beforeEach(() => {
    ({ pi, handlers, tools } = makeMockPi());
    gallopExtension(pi);
    ctx = {
      compact: vi.fn(),
      hasUI: false,
      cwd: "/tmp/gallop-test",
      // Comfortably above the default 20k keep window so the minimum-context
      // guard stays out of the way (tests that exercise it override this).
      getContextUsage: vi.fn(() => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 })),
      sessionManager: {
        getSessionFile: () => "/tmp/gallop-test/session.jsonl",
        // Branch does not end in a compaction entry (nothing compacted yet).
        // Override in tests that simulate a completed compaction.
        getBranch: vi.fn(() => []),
      },
    };
    // Reset shared module state (no disk I/O) so each test is independent.
    // compactionInFlight is deliberately NOT in resetAllState (it stays active through
    // the re-trigger window) — clear it via the real new-turn boundary.
    void handlers.get("session_compact")(null, { hasUI: false });
    void handlers.get("message_start")({ message: { role: "user" } }, ctx);
  });

  /** Run settles — the deferred compact trigger point (after pi's post-run loop). */
  const settle = () => handlers.get("agent_settled")(null, ctx);

  const prep = (fileOps: any) => ({
    firstKeptEntryId: "entry-123",
    tokensBefore: 50000,
    fileOps,
  });

  const emptyOps = () => ({ read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() });

  /** Call the compact_request tool and return its result. */
  const callTool = (params: any) =>
    tools.get("compact_request").execute("id1", params, new AbortController().signal, undefined, ctx);

  const flushTimers = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * Simulate the compact completing (test hygiene): consumes any residual
   * pending request at the real session boundary, so the NEXT test's
   * beforeEach doesn't inherit its continue steer on a fresh mock.
   */
  const compactDone = () => handlers.get("session_compact")(null, { hasUI: false });

  // ── compact_request tool ──

  it("stashes the summary, defers the compact to agent_settled, and returns the short message with terminate", async () => {
    const result = await callTool({ summary: LONG_SUMMARY });

    // No compact during execute — the run ends (terminate) and pi's post-run
    // loop (automatic threshold compaction) gets its chance first.
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(result.terminate).toBe(true);
    const text = result.content[0].text;
    expect(text).toBe("Compacting.");
    // The summary must NOT be echoed in the tool result — the tool call's own
    // arguments (kept in the tail) already carry it.
    expect(text).not.toContain("## Goal");

    // Run settles without a compaction having run → deferred trigger fires.
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("injects the generic proceed message after compaction when continue is true", async () => {
    await callTool({ summary: LONG_SUMMARY, continue: true });
    await settle();
    const opts = ctx.compact.mock.calls[0][0];
    pi.sendUserMessage.mockClear();
    opts.onComplete();
    await flushTimers();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("[Gallop] Compact done — proceed as commanded.");
    expect(pi.sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer" });
  });

  it("injects the proceed message when continue is omitted (default true)", async () => {
    await callTool({ summary: LONG_SUMMARY });
    await settle();
    const opts = ctx.compact.mock.calls[0][0];
    pi.sendUserMessage.mockClear();
    opts.onComplete();
    await flushTimers();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("[Gallop] Compact done — proceed as commanded.");
  });

  it("does not inject anything after compaction when continue is false", async () => {
    // Re-arm the guard (a user turn ends the previous cycle).
    await handlers.get("message_start")({ message: { role: "user" } }, ctx);
    ctx.compact.mockClear();
    await callTool({ summary: LONG_SUMMARY, continue: false });
    await settle();
    const opts = ctx.compact.mock.calls[0][0];
    pi.sendUserMessage.mockClear();
    opts.onComplete();
    await flushTimers();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("fails the call when the context is at or below the keep window — nothing stashed, no deferred compact", async () => {
    ctx.getContextUsage.mockReturnValue({ tokens: 15_000, contextWindow: 200_000, percent: 7.5 });
    await expect(callTool({ summary: LONG_SUMMARY })).rejects.toThrow(/below the compaction minimum/);

    // The guard threw before stashing — the settle point must not fire a compact.
    await settle();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("proceeds when usage is unmeasurable (tokens: null right after a compact)", async () => {
    ctx.getContextUsage.mockReturnValue({ tokens: null, contextWindow: 200_000, percent: null });
    const result = await callTool({ summary: LONG_SUMMARY });
    expect(result.terminate).toBe(true);
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("declares summary as the only required parameter and exposes summary/continue/nuke", () => {
    const tool = tools.get("compact_request");
    expect(tool.parameters.required).toEqual(["summary"]);
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["continue", "nuke", "summary"]);
    expect(tool.parameters.properties.continue.type).toBe("boolean");
    expect(tool.parameters.properties.nuke.type).toBe("boolean");
    // The tool description carries the checkpoint format the model must follow
    // and the nuke bullet (trigger + full-state obligation).
    expect(tool.description).toContain("nuke: true");
    for (const section of ["## Goal", "## Progress", "## Next Steps", "## Critical Context"]) {
      expect(tool.description).toContain(section);
    }
  });

  // ── session_before_compact ──

  it("returns a custom compaction built from the stashed summary, with file ops appended", async () => {
    await callTool({ summary: LONG_SUMMARY });

    const result = await handlers.get("session_before_compact")(
      {
        preparation: prep({ read: new Set(["a.ts", "b.ts"]), written: new Set(["c.ts"]), edited: new Set(["a.ts"]) }),
        signal: new AbortController().signal,
      },
      ctx,
    );

    expect(result).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("entry-123");
    expect(result.compaction.tokensBefore).toBe(50000);
    expect(result.compaction.summary).toContain("## Goal");
    expect(result.compaction.summary).toContain("## Next Steps");
    expect(result.compaction.summary).toContain("<read-files>\nb.ts\n</read-files>");
    expect(result.compaction.summary).toContain("<modified-files>\na.ts\nc.ts\n</modified-files>");
    expect(result.compaction.details).toEqual({ readFiles: ["b.ts"], modifiedFiles: ["a.ts", "c.ts"] });
    compactDone();
  });

  it("nuke: true replaces pi's cut with the budget-0 cut (last turn's tail)", async () => {
    await callTool({ summary: LONG_SUMMARY, nuke: true });

    const result = await handlers.get("session_before_compact")(
      {
        preparation: prep(emptyOps()),
        branchEntries: [fixtureUser("u1", "hello there"), fixtureAssistant("a1", BIG_TEXT), fixtureUser("u2", "second " + BIG_TEXT), fixtureAssistant("a2", "final")],
        signal: new AbortController().signal,
      },
      ctx,
    );

    // pi's own cut (entry-123, the configured ~20k window) is replaced by the
    // budget-0 cut point.
    expect(result?.compaction?.firstKeptEntryId).toBe("a2");
    compactDone();
  });

  it("keeps pi's own cut when nuke is not set", async () => {
    await callTool({ summary: LONG_SUMMARY });

    const result = await handlers.get("session_before_compact")(
      {
        preparation: prep(emptyOps()),
        branchEntries: [fixtureUser("u1", "hello there"), fixtureAssistant("a1", BIG_TEXT)],
        signal: new AbortController().signal,
      },
      ctx,
    );

    expect(result?.compaction?.firstKeptEntryId).toBe("entry-123");
    compactDone();
  });

  it("nuke on a too-small session fails with the escape-hatch message — nothing stashed", async () => {
    ctx.getContextUsage.mockReturnValue({ tokens: 15_000, contextWindow: 200_000, percent: 7.5 });
    await expect(callTool({ summary: LONG_SUMMARY, nuke: true })).rejects.toThrow(/refuses to compact this session at all/);

    // The guard threw before stashing — the settle point must not fire a compact.
    await settle();
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("returns undefined (pi's native one-shot) when no summary is stashed — native /compact path", async () => {
    const result = await handlers.get("session_before_compact")(
      { preparation: prep(emptyOps()), signal: new AbortController().signal },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined (native one-shot fallback) for a too-short stashed summary", async () => {
    await callTool({ summary: "too short" });
    const result = await handlers.get("session_before_compact")(
      { preparation: prep(emptyOps()), signal: new AbortController().signal },
      ctx,
    );
    expect(result).toBeUndefined();
    compactDone();
  });

  it("discards the stashed summary on abort so a later compact doesn't reuse it", async () => {
    await callTool({ summary: LONG_SUMMARY });

    // Simulate pi aborting the compact after the hook has run (Esc during compaction):
    // the hook consumed the stash; a second compact must fall back to the one-shot.
    const first = await handlers.get("session_before_compact")(
      { preparation: prep(emptyOps()), signal: new AbortController().signal },
      ctx,
    );
    expect(first).toBeDefined();

    const second = await handlers.get("session_before_compact")(
      { preparation: prep(emptyOps()), signal: new AbortController().signal },
      ctx,
    );
    expect(second).toBeUndefined();
    compactDone();
  });

  it("registers its abort handler on the signal and removes it again on the way out", async () => {
    await callTool({ summary: LONG_SUMMARY });

    const added: string[] = [];
    const removed: string[] = [];
    const signal = {
      addEventListener: (type: string, _fn: () => void) => { added.push(type); },
      removeEventListener: (type: string, _fn: () => void) => { removed.push(type); },
    };
    await handlers.get("session_before_compact")({ preparation: prep(emptyOps()), signal }, ctx);
    expect(added).toEqual(["abort"]);
    expect(removed).toEqual(["abort"]);
    compactDone();
  });

  // ── re-entrancy ──

  it("blocks a redundant trigger while a compact is in flight; a new user turn re-arms", async () => {
    await callTool({ summary: LONG_SUMMARY });
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    // Another request before any user turn: the guard blocks the redundant
    // trigger (and its continue message).
    await callTool({ summary: LONG_SUMMARY });
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    // A new user turn re-arms the guard — the next request is honored.
    await handlers.get("message_start")({ message: { role: "user" } }, ctx);
    await callTool({ summary: LONG_SUMMARY });
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  // ── message_end behavior ──

  it("message_end with a pending compact_request triggers nothing; the tool stashes and settle compacts", async () => {
    // pi emits message_end BEFORE the pending tool call executes: nothing may
    // trigger here (an un-stashed compact would race the tool's stashed one).
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll write the checkpoint now." },
          { type: "toolCall", id: "c1", name: "compact_request", arguments: { summary: LONG_SUMMARY, continue: true } },
        ],
      },
    }, ctx);
    expect(ctx.compact).not.toHaveBeenCalled();

    // The pending tool call executes right after and stashes the summary.
    await callTool({ summary: LONG_SUMMARY, continue: true });
    expect(ctx.compact).not.toHaveBeenCalled();

    // Settle → deferred trigger compacts with the stashed summary.
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const result = await handlers.get("session_before_compact")({
      preparation: prep(emptyOps()),
      signal: new AbortController().signal,
    }, ctx);
    expect(result?.compaction?.summary).toContain(LONG_SUMMARY);
  });

  // ── session_compact ──

  it("clears compaction state on session_compact so a new request works again", async () => {
    await callTool({ summary: LONG_SUMMARY });
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    await handlers.get("session_compact")(null, { hasUI: false });
    await handlers.get("message_start")({ message: { role: "user" } }, ctx);

    await callTool({ summary: LONG_SUMMARY });
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  // ── the threshold race (compact_request vs pi's automatic compaction) ──

  it("does not double-compact when pi's automatic compaction ran first (the 16k race)", async () => {
    // LLM calls compact_request right as the run's final usage crosses pi's
    // automatic threshold. The automatic compact runs in pi's post-run loop,
    // BEFORE agent_settled — it consumes the stashed summary (cache-warm, no
    // cold prefill) and session_compact clears the pending state.
    await callTool({ summary: LONG_SUMMARY, continue: true });
    expect(ctx.compact).not.toHaveBeenCalled();

    const auto = await handlers.get("session_before_compact")(
      { preparation: prep(emptyOps()), signal: new AbortController().signal },
      ctx,
    );
    expect(auto?.compaction?.summary).toContain(LONG_SUMMARY);

    pi.sendUserMessage.mockClear();
    await handlers.get("session_compact")(null, ctx);

    // Settle: deferred trigger is a no-op — no second compact, no
    // "Already compacted" error. The continue message comes from the
    // session_compact handler (the manual onComplete never ran).
    await settle();
    expect(ctx.compact).not.toHaveBeenCalled();
    await flushTimers();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("[Gallop] Compact done — proceed as commanded.");
  });

  it("skips the deferred trigger when the branch already ends in a compaction entry", async () => {
    await callTool({ summary: LONG_SUMMARY });
    // A compaction completed in the same window but its session_compact event
    // did not reach our state (defensive path): the branch check catches it.
    ctx.sessionManager.getBranch.mockReturnValue([{ type: "compaction", summary: "x" }]);
    await settle();
    expect(ctx.compact).not.toHaveBeenCalled();
  });
});

// ── contextTokensFromUsage ──

describe("contextTokensFromUsage", () => {
  it("prefers totalTokens, else sums the parts; undefined → 0", () => {
    expect(
      contextTokensFromUsage({ totalTokens: 100, input: 10, output: 2, cacheRead: 3, cacheWrite: 4 }),
    ).toBe(100);
    expect(contextTokensFromUsage({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(19);
    expect(contextTokensFromUsage(undefined)).toBe(0);
  });
});

// ── context-pressure nudge ──

describe("context-pressure nudge", () => {
  const WINDOW = 200_000;
  let pi: any;
  let handlers: Map<string, any>;
  let tools: Map<string, any>;
  let ctx: any;
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    ({ pi, handlers, tools } = makeMockPi());
    gallopExtension(pi);
    // Isolate pi's settings read (gallop merges global + project settings.json,
    // the global path coming from $HOME).
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gallop-nudge-home-"));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gallop-nudge-cwd-"));
    vi.stubEnv("HOME", tmpHome);
    ctx = {
      compact: vi.fn(),
      hasUI: false,
      cwd: tmpCwd,
      model: { contextWindow: WINDOW },
      // Comfortably above the default 20k keep window — the minimum-context
      // guard stays out of the way.
      getContextUsage: vi.fn(() => ({ tokens: 50_000, contextWindow: WINDOW, percent: 25 })),
      sessionManager: { getSessionFile: () => "/tmp/gallop-test/session.jsonl", getBranch: vi.fn(() => []) },
    };
    void handlers.get("session_compact")(null, { hasUI: false });
    void handlers.get("message_start")({ message: { role: "user" } }, ctx);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  const writeSettings = (settings: unknown, scope: "global" | "project" = "project") => {
    const dir = scope === "global" ? path.join(tmpHome, ".pi", "agent") : path.join(tmpCwd, ".pi");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  };

  /** Global path that does not exist — unit tests scope to it explicitly. */
  const missingGlobal = () => path.join(tmpHome, "missing-settings.json");

  /** assistant message whose usage leaves `remaining` tokens of the window. */
  const usageMsg = (remaining: number) => ({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      stopReason: "stop",
      usage: {
        input: WINDOW - remaining,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: WINDOW - remaining,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });

  const endTurn = async (remaining: number) => {
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")(usageMsg(remaining), ctx);
  };

  const nudgeSteers = () =>
    pi.sendUserMessage.mock.calls
      .map(([t]) => t)
      .filter((t) => t.startsWith("[Gallop] Context"));

  const resetState = async () => {
    void handlers.get("session_compact")(null, { hasUI: false });
    await handlers.get("message_start")({ message: { role: "user" } }, ctx);
  };

  // ── threshold math (unit) ──

  it("defaults (no settings files): enabled, 16k reserve, 20k kept tail → nudges at 18,432 remaining", () => {
    expect(readPiCompactionSettings(tmpCwd, missingGlobal())).toEqual({ reserveTokens: 16_384, enabled: true, keepRecentTokens: 20_000 });
    expect(nudgeThreshold(readPiCompactionSettings(tmpCwd, missingGlobal()))).toBe(18_432);
  });

  it("follows a custom keepRecentTokens (project wins over global; falls back to 20k)", () => {
    expect(readPiCompactionSettings(tmpCwd, missingGlobal()).keepRecentTokens).toBe(20_000);
    writeSettings({ compaction: { keepRecentTokens: 40_000 } }, "global");
    expect(readPiCompactionSettings(tmpCwd).keepRecentTokens).toBe(40_000);
    writeSettings({ compaction: { keepRecentTokens: 8_000 } }, "project");
    expect(readPiCompactionSettings(tmpCwd).keepRecentTokens).toBe(8_000);
  });

  it("checkpointFormat names the kept tail it will actually keep", () => {
    expect(checkpointFormat()).toContain("~20k tokens are kept verbatim");
    expect(checkpointFormat(40_000)).toContain("~40k tokens are kept verbatim");
    expect(checkpointFormat(8_000)).toContain("~8k tokens are kept verbatim");
  });

  it("follows a custom reserveTokens (auto-compact on → reserve + 2k)", () => {
    writeSettings({ compaction: { reserveTokens: 30_000 } });
    expect(nudgeThreshold(readPiCompactionSettings(tmpCwd, missingGlobal()))).toBe(32_048);
  });

  it("merges per key with the project file winning; disabled → fixed 16k", () => {
    writeSettings({ compaction: { reserveTokens: 30_000 } }, "global");
    writeSettings({ compaction: { enabled: false } }, "project");
    // Default global path = the stubbed $HOME (writeSettings' global scope).
    const s = readPiCompactionSettings(tmpCwd);
    expect(s).toEqual({ reserveTokens: 30_000, enabled: false, keepRecentTokens: 20_000 });
    expect(nudgeThreshold(s)).toBe(16_000);
  });

  it("treats missing or malformed settings files as pi's defaults", () => {
    writeSettings("{ broken json");
    expect(nudgeThreshold(readPiCompactionSettings(tmpCwd, missingGlobal()))).toBe(18_432);
  });

  // ── nudge message path ──

  it("nudges once just above the automatic threshold and does not repeat", async () => {
    // Default settings: nudge at 18,432 remaining.
    await endTurn(19_000);
    expect(nudgeSteers()).toHaveLength(0);

    await endTurn(18_000);
    expect(nudgeSteers()).toHaveLength(1);
    expect(nudgeSteers()[0]).toContain("~18k tokens remaining");
    expect(nudgeSteers()[0]).toContain("automatic compaction triggers at ~16k");

    // Deeper still — silence, the backstop is just below.
    await endTurn(15_000);
    expect(nudgeSteers()).toHaveLength(1);
  });

  it("nudges at 16k when auto-compact is disabled", async () => {
    writeSettings({ compaction: { enabled: false } });
    await endTurn(17_000);
    expect(nudgeSteers()).toHaveLength(0);

    await endTurn(15_000);
    expect(nudgeSteers()).toHaveLength(1);
    expect(nudgeSteers()[0]).toContain("~15k tokens remaining");
    expect(nudgeSteers()[0]).toContain("automatic compaction is disabled");
  });

  it("resets after a compaction (fresh cycle)", async () => {
    await endTurn(18_000);
    await resetState();
    await endTurn(15_000);
    expect(nudgeSteers()).toHaveLength(2);
  });

  it("does not nudge while a compact is pending or on aborted/error messages", async () => {
    // 15k is below every threshold — only the skip conditions are under test.
    // pending compact
    await resetState();
    await tools.get("compact_request").execute("id1", { summary: LONG_SUMMARY }, new AbortController().signal, undefined, ctx);
    await endTurn(15_000);
    expect(nudgeSteers()).toHaveLength(0);

    // aborted / error messages never count
    await resetState();
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")({ message: { ...usageMsg(15_000).message, stopReason: "aborted" } }, ctx);
    await handlers.get("message_end")({ message: { ...usageMsg(14_000).message, stopReason: "error" } }, ctx);
    expect(nudgeSteers()).toHaveLength(0);
  });

  it("does not nudge without a model or usage", async () => {
    const noModel = { ...ctx, model: undefined };
    await handlers.get("message_start")({ message: { role: "assistant" } }, noModel);
    await handlers.get("message_end")(usageMsg(15_000), noModel);
    expect(nudgeSteers()).toHaveLength(0);
  });

  it("does not nudge when the ending message itself calls compact_request (message_end precedes tool execution)", async () => {
    // Real pi order: message_end fires BEFORE the message's tool calls execute,
    // so pendingCompact is still null — only the message's content reveals the
    // en-route compact. Regression: the nudge steer landed around the
    // compaction boundary, telling the model to call a tool it just called.
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")({
      message: {
        ...usageMsg(8_000).message,
        content: [
          { type: "text", text: "context is hot — checkpointing" },
          { type: "toolCall", id: "c1", name: "compact_request", arguments: { summary: LONG_SUMMARY } },
        ],
        stopReason: "toolUse",
      },
    }, ctx);
    expect(nudgeSteers()).toHaveLength(0);

    // The tool then executes; a same-cycle endTurn is held by the pending guard.
    await tools.get("compact_request").execute("id1", { summary: LONG_SUMMARY }, new AbortController().signal, undefined, ctx);
    await endTurn(7_000);
    expect(nudgeSteers()).toHaveLength(0);
  });

  it("the compact_request skip is message-scoped: a fresh cycle still nudges", async () => {
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")({
      message: {
        ...usageMsg(8_000).message,
        content: [{ type: "toolCall", id: "c1", name: "compact_request", arguments: { summary: LONG_SUMMARY } }],
        stopReason: "toolUse",
      },
    }, ctx);
    expect(nudgeSteers()).toHaveLength(0);

    await resetState();
    await endTurn(15_000);
    expect(nudgeSteers()).toHaveLength(1);
  });
});


// ── rewriteCompactContext: the compact_request exchange → completion marker ──

describe("rewriteCompactContext (compact_request exchange → completion marker)", () => {
  const emptyFileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };

  const compactionSummaryMsg = (summary: string) => ({
    role: "compactionSummary",
    summary,
    tokensBefore: 1000,
    timestamp: Date.now(),
  });

  const requestCompactCall = (summary: string, id = "tc1") => ({
    role: "assistant",
    content: [
      { type: "text", text: "compacting" },
      { type: "toolCall", id, name: "compact_request", arguments: { summary } },
    ],
  });

  const compactToolResult = (toolCallId = "tc1") => ({
    role: "toolResult",
    toolCallId,
    toolName: "compact_request",
    content: [{ type: "text", text: "Compacting." }],
  });

  const otherToolCall = () => ({
    role: "assistant",
    content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } }],
  });

  it("returns undefined (no rewrite) when no compaction summary is in context", async () => {
    // Pre-compact tree view / aborted compact: the exchange is the only record.
    const result = rewriteCompactContext([requestCompactCall(LONG_SUMMARY), compactToolResult()]);
    expect(result).toBeUndefined();
  });

  it("replaces the whole exchange with the marker when carried verbatim by the compaction summary", async () => {
    // Gallop appends file sections after the summary text — the compaction
    // summary starts with the exact arg text. The call message becomes the
    // marker; the toolResult is dropped; the rest is untouched.
    const compactionSummary = appendSelfCompactFileOps(LONG_SUMMARY, {
      read: new Set<string>(),
      written: new Set(["a.ts"]),
      edited: new Set<string>(),
    });
    const result = rewriteCompactContext([compactionSummaryMsg(compactionSummary), requestCompactCall(LONG_SUMMARY), compactToolResult(), otherToolCall()]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("compactionSummary");
    expect(result[1]).toEqual({ role: "assistant", content: [{ type: "text", text: COMPACT_DONE_MARKER }] });
    expect(result[2]).toEqual(otherToolCall());
    expect(result.some((m: any) => m?.toolName === "compact_request")).toBe(false);
  });

  it("keeps the triggering nudge in the tail while the exchange becomes the marker (field repro)", async () => {
    // The double-compact repro: the pressure nudge survives the compaction in
    // the kept tail; the exchange that fulfilled it must NOT vanish silently.
    // With the marker in place the nudge reads as fulfilled, so the resumed
    // model does not re-request.
    const nudge = {
      role: "user",
      content: [{
        type: "text",
        text: "[Gallop] Context is nearly full (~11k tokens remaining) and pi's automatic compaction is disabled. If the current work is at a sensible pause point, write a checkpoint summary and call compact_request now.",
      }],
    };
    const result = rewriteCompactContext([
        compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, emptyFileOps)),
        nudge,
        requestCompactCall(LONG_SUMMARY),
        compactToolResult(),
        { role: "user", content: [{ type: "text", text: "reloaded" }] },
      ]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(4);
    expect(result[1]).toEqual(nudge); // the instruction stays — visibly fulfilled below
    expect(result[2]).toEqual({ role: "assistant", content: [{ type: "text", text: COMPACT_DONE_MARKER }] });
    expect(result[3].content).toEqual([{ type: "text", text: "reloaded" }]);
    expect(result.some((m: any) => m?.toolName === "compact_request")).toBe(false);
  });

  it("keeps a call the compaction summary does not carry, marking its result done", async () => {
    // The call's text is not in any compaction summary (native-fallback
    // compact): the call stays as a true record, but the in-progress
    // "Compacting." result is rewritten to the marker.
    const result = rewriteCompactContext([
        compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, emptyFileOps)),
        requestCompactCall("A completely different checkpoint that was never compacted.".padEnd(250, "x")),
        compactToolResult(),
      ]);
    expect(result).toBeDefined();
    expect(result).toHaveLength(3);
    expect(result[1].content[1].arguments.summary).toMatch("completely different checkpoint");
    expect(result[2]).toEqual({
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "compact_request",
      content: [{ type: "text", text: COMPACT_DONE_MARKER }],
    });
  });

  it("rewrites the in-progress result on the native-fallback path, keeping the short-arg call", async () => {
    // Below MIN_SUMMARY_LENGTH the stashed summary was NOT used — pi's native
    // one-shot ran. The arg is the model's real short text (a record), but the
    // result must stop reading as in-progress.
    const short = "too short";
    const result = rewriteCompactContext([compactionSummaryMsg("A native one-shot summary that does not carry the short arg at all."), requestCompactCall(short), compactToolResult()]);
    expect(result).toBeDefined();
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual(requestCompactCall(short));
    expect(result[2].content).toEqual([{ type: "text", text: COMPACT_DONE_MARKER }]);
  });

  it("handles multiple compact_request calls: carried → marker, uncarried → marked result", async () => {
    const otherCheckpoint = "Another checkpoint summary, long enough to matter. ".repeat(5); // >200 chars
    const result = rewriteCompactContext([
        compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, emptyFileOps)),
        requestCompactCall(otherCheckpoint, "tc2"), // not carried → call kept, result marked
        compactToolResult("tc2"),
        requestCompactCall(LONG_SUMMARY, "tc1"), // carried → replaced by the marker
        compactToolResult("tc1"),
      ]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(4);
    expect(result[1].content[1].arguments.summary).toBe(otherCheckpoint);
    expect(result[2].content).toEqual([{ type: "text", text: COMPACT_DONE_MARKER }]); // tc2 result marked
    expect(result[3]).toEqual({ role: "assistant", content: [{ type: "text", text: COMPACT_DONE_MARKER }] }); // tc1 → marker
    expect(result.some((m: any) => m?.toolName === "compact_request" && m?.toolCallId === "tc1")).toBe(false); // tc1 result dropped
  });

  it("markers the newest compacted exchange when an older compaction entry sits in the kept tail", async () => {
    // Task-boundary compaction: the previous compaction entry falls inside
    // the newest compaction's kept tail, so context holds TWO compaction
    // summary messages. The just-compacted exchange must still be replaced —
    // the older summary does not carry its text (the .find()-first bug).
    const oldCheckpoint = "Old checkpoint from a previous task, long enough to matter. ".repeat(4);
    const result = rewriteCompactContext([
        compactionSummaryMsg(oldCheckpoint),
        compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, emptyFileOps)),
        requestCompactCall(LONG_SUMMARY),
        compactToolResult(),
      ]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ role: "assistant", content: [{ type: "text", text: COMPACT_DONE_MARKER }] });
  });

  it("markers a call from an earlier compaction when its entry is still in the kept tail", async () => {
    // The older compaction entry's summary is still carried by context, so
    // the earlier call's text is verifiably present — replace it too.
    const oldCheckpoint = "Old checkpoint from a previous task, long enough to matter. ".repeat(4);
    const result = rewriteCompactContext([
        compactionSummaryMsg(oldCheckpoint),
        compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, emptyFileOps)),
        requestCompactCall(oldCheckpoint),
        compactToolResult(),
      ]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ role: "assistant", content: [{ type: "text", text: COMPACT_DONE_MARKER }] });
  });

  it("drops an orphaned compact_request toolResult whose call was summarized out of the window", async () => {
    // The cut point split the compact turn: the call landed in the summarized
    // prefix, only its result survives in the kept tail. Without its toolCall
    // the result would be an API error — drop it.
    const result = rewriteCompactContext([compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, emptyFileOps)), compactToolResult("tc1")]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("compactionSummary");
  });

  it("keeps sibling tool calls in a batched message, dropping the compact block and appending the marker", async () => {
    const result = rewriteCompactContext([
        compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, emptyFileOps)),
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } },
            { type: "toolCall", id: "tc1", name: "compact_request", arguments: { summary: LONG_SUMMARY } },
          ],
        },
        { role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "ok" }] },
        compactToolResult("tc1"),
      ]);

    expect(result).toBeDefined();
    expect(result).toHaveLength(3);
    expect(result[1].content).toEqual([
      { type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } },
      { type: "text", text: COMPACT_DONE_MARKER },
    ]);
    expect(result[2]).toEqual({ role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "ok" }] });
  });

  it("handles messages without array content and non-matching roles", async () => {
    const result = rewriteCompactContext([
        compactionSummaryMsg(LONG_SUMMARY),
        { role: "user", content: "plain string content, not an array" },
        { role: "toolResult", toolCallId: "tc9", toolName: "bash", content: [{ type: "text", text: "ok" }] },
        requestCompactCall(LONG_SUMMARY),
        compactToolResult(),
      ]);
    expect(result).toBeDefined();
    expect(result).toHaveLength(4); // compactionSummary, user, bash result, marker
    expect(result[2]).toEqual({ role: "toolResult", toolCallId: "tc9", toolName: "bash", content: [{ type: "text", text: "ok" }] });
    expect(result[3]).toEqual({ role: "assistant", content: [{ type: "text", text: COMPACT_DONE_MARKER }] });
  });

  it("never emits the marker without a compaction summary in context", async () => {
    // Aborted compact / pre-compact tree view: the exchange is the only
    // record, "Compacting." is still true, and a re-request is the correct
    // recovery — so the handler must not rewrite anything.
    const result = rewriteCompactContext([requestCompactCall("too short"), compactToolResult()]);
    expect(result).toBeUndefined();
  });
});
