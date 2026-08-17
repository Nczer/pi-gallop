import { describe, expect, it, vi, beforeEach } from "vitest";
import gallopExtension, {
  computeSelfCompactFileLists,
  appendSelfCompactFileOps,
} from "../index";

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

// ── Integration: request_compact tool + session_before_compact / qcompact wiring ──

function makeMockPi() {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    on: vi.fn((name: string, handler: any) => { handlers.set(name, handler); }),
    registerTool: vi.fn((tool: any) => { tools.set(tool.name, tool); }),
    registerCommand: vi.fn((name: string, cmd: any) => { commands.set(name, cmd); }),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  return { pi, handlers, tools, commands };
}

/** A valid (>200 char) checkpoint summary in the exact format. */
const LONG_SUMMARY = `## Goal
Test goal: refactor the compaction machinery of the gallop extension.

## Constraints & Preferences
- Keep the extension silent in the main session except for status indicators.

## Progress
### Done
- [x] Removed the old fork summarizer
- [x] Rewrote the request_compact tool

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
  let commands: Map<string, any>;
  let ctx: any;

  beforeEach(() => {
    ({ pi, handlers, tools, commands } = makeMockPi());
    gallopExtension(pi);
    ctx = {
      compact: vi.fn(),
      hasUI: false,
      cwd: "/tmp/gallop-test",
      sessionManager: { getSessionFile: () => "/tmp/gallop-test/session.jsonl" },
    };
    // Reset shared module state (no disk I/O) so each test is independent.
    // compactionInFlight is deliberately NOT in resetAllState (it stays active through
    // the re-trigger window) — clear it via the real new-turn boundary.
    void handlers.get("session_compact")(null, { hasUI: false });
    void handlers.get("message_start")({ message: { role: "user" } }, ctx);
  });

  const prep = (fileOps: any) => ({
    firstKeptEntryId: "entry-123",
    tokensBefore: 50000,
    fileOps,
  });

  const emptyOps = () => ({ read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() });

  /** Call the request_compact tool and return its result. */
  const callTool = (params: any) =>
    tools.get("request_compact").execute("id1", params, new AbortController().signal, undefined, ctx);

  const flushTimers = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms));

  // ── request_compact tool ──

  it("stashes the summary, triggers compact, and returns the short message with terminate", async () => {
    const result = await callTool({ message: "context bloat", summary: LONG_SUMMARY });

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(result.terminate).toBe(true);
    const text = result.content[0].text;
    expect(text).toBe("Compacting (context bloat).");
    // The summary must NOT be echoed in the tool result — the tool call's own
    // arguments (kept in the tail) already carry it.
    expect(text).not.toContain("## Goal");
  });

  it("defaults the message to 'model-initiated' when omitted", async () => {
    const result = await callTool({ summary: LONG_SUMMARY });
    expect(result.content[0].text).toBe("Compacting (model-initiated).");
  });

  it("injects the generic proceed message after compaction when continue is true", async () => {
    await callTool({ message: "bloat", summary: LONG_SUMMARY, continue: true });
    const opts = ctx.compact.mock.calls[0][0];
    pi.sendUserMessage.mockClear();
    opts.onComplete();
    await flushTimers();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("[Gallop] Compact done — proceed as commanded.");
    expect(pi.sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer" });
  });

  it("does not inject anything after compaction when continue is false or omitted", async () => {
    await callTool({ message: "bloat", summary: LONG_SUMMARY });
    const opts = ctx.compact.mock.calls[0][0];
    pi.sendUserMessage.mockClear();
    opts.onComplete();
    await flushTimers();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    // And with continue: false explicitly (re-arm the guard — no user turn in between).
    await handlers.get("message_start")({ message: { role: "user" } }, ctx);
    ctx.compact.mockClear();
    await callTool({ message: "bloat", summary: LONG_SUMMARY, continue: false });
    const opts2 = ctx.compact.mock.calls[0][0];
    pi.sendUserMessage.mockClear();
    opts2.onComplete();
    await flushTimers();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("declares summary as a required parameter and exposes message/continue", () => {
    const tool = tools.get("request_compact");
    expect(tool.parameters.required).toEqual(["summary"]);
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["continue", "message", "summary"]);
    expect(tool.parameters.properties.continue.type).toBe("boolean");
    // The tool description carries the checkpoint format the model must follow.
    for (const section of ["## Goal", "## Progress", "## Next Steps", "## Critical Context"]) {
      expect(tool.description).toContain(section);
    }
  });

  // ── session_before_compact ──

  it("returns a custom compaction built from the stashed summary, with file ops appended", async () => {
    await callTool({ message: "bloat", summary: LONG_SUMMARY });

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
  });

  it("returns undefined (pi's native one-shot) when no summary is stashed — native /compact path", async () => {
    const result = await handlers.get("session_before_compact")(
      { preparation: prep(emptyOps()), signal: new AbortController().signal },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined (native one-shot fallback) for a too-short stashed summary", async () => {
    await callTool({ message: "bloat", summary: "too short" });
    const result = await handlers.get("session_before_compact")(
      { preparation: prep(emptyOps()), signal: new AbortController().signal },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("discards the stashed summary on abort so a later compact doesn't reuse it", async () => {
    await callTool({ message: "bloat", summary: LONG_SUMMARY });

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
  });

  it("registers its abort handler on the signal and removes it again on the way out", async () => {
    await callTool({ message: "bloat", summary: LONG_SUMMARY });

    const added: string[] = [];
    const removed: string[] = [];
    const signal = {
      addEventListener: (type: string, _fn: () => void) => { added.push(type); },
      removeEventListener: (type: string, _fn: () => void) => { removed.push(type); },
    };
    await handlers.get("session_before_compact")({ preparation: prep(emptyOps()), signal }, ctx);
    expect(added).toEqual(["abort"]);
    expect(removed).toEqual(["abort"]);
  });

  // ── re-entrancy ──

  it("ignores a re-triggered request_compact while a compact is in flight", async () => {
    await callTool({ message: "bloat", summary: LONG_SUMMARY });
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    // Simulate the tool re-executing after ctx.compact()'s internal abort.
    await callTool({ message: "bloat", summary: LONG_SUMMARY });
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    // A new user turn re-arms the guard — the next request is honored.
    await handlers.get("message_start")({ message: { role: "user" } }, ctx);
    await callTool({ message: "bloat", summary: LONG_SUMMARY });
    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  // ── /qcompact ──

  it("steers the live model to write the checkpoint and call request_compact", async () => {
    await commands.get("qcompact").handler("the parser", ctx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [text, opts] = pi.sendUserMessage.mock.calls[0];
    expect(opts).toEqual({ deliverAs: "steer" });
    expect(text).toContain("/qcompact");
    expect(text).toContain("request_compact");
    expect(text).toContain("## Goal");
    expect(text).toContain("## Next Steps");
    expect(text).toContain("Extra focus for the summary: the parser.");
    // No compact yet — the model's turn produces the summary first.
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("omits the focus sentence when no argument is given", async () => {
    await commands.get("qcompact").handler("", ctx);
    const [text] = pi.sendUserMessage.mock.calls[0];
    expect(text).not.toContain("Extra focus");
  });

  it("falls back to a native compact when the model does not comply by message_end", async () => {
    await commands.get("qcompact").handler(null, ctx);
    expect(ctx.compact).not.toHaveBeenCalled();

    // The run ends with an assistant message that did NOT call request_compact.
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "hmm" }] } }, ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    // No stashed summary → native one-shot.
    const result = await handlers.get("session_before_compact")(
      { preparation: prep(emptyOps()), signal: new AbortController().signal },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("does not double-compact when the model complies (tool call after steering)", async () => {
    await commands.get("qcompact").handler(null, ctx);
    await callTool({ message: "qcompact", summary: LONG_SUMMARY, continue: true });
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    // The run ends (aborted by the tool's compact) — the fallback must be a no-op.
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")({ message: { role: "assistant", content: [] } }, ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("does not fire the native fallback when message_end carries a pending request_compact tool call", async () => {
    await commands.get("qcompact").handler(null, ctx);

    // pi emits message_end BEFORE the pending tool call executes; the tool runs
    // next and must trigger the proper in-session compact itself.
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll write the checkpoint now." },
          { type: "toolCall", id: "c1", name: "request_compact", arguments: { message: "qcompact", summary: LONG_SUMMARY, continue: true } },
        ],
      },
    }, ctx);

    // The fallback must NOT have started an un-stashed native compact...
    expect(ctx.compact).not.toHaveBeenCalled();

    // ...the pending tool call executes right after and triggers the in-session
    // compact with the stashed summary.
    await callTool({ message: "qcompact", summary: LONG_SUMMARY, continue: true });
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const result = await handlers.get("session_before_compact")({
      preparation: prep(emptyOps()),
      signal: new AbortController().signal,
    }, ctx);
    expect(result?.compaction?.summary).toContain(LONG_SUMMARY);
  });

  it("still falls back to a native compact when the pending tool call is not request_compact", async () => {
    await commands.get("qcompact").handler(null, ctx);

    // The model keeps working with other tools instead of calling request_compact.
    await handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    await handlers.get("message_end")({
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
      },
    }, ctx);

    // Non-compliant: the pending call is not request_compact → compact anyway.
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("refuses /qcompact while a compact is running", async () => {
    const uiCtx = { ...ctx, hasUI: true, ui: { notify: vi.fn() } };
    await callTool({ message: "bloat", summary: LONG_SUMMARY });

    await commands.get("qcompact").handler(null, uiCtx);
    expect(ctx.compact).toHaveBeenCalledTimes(1); // refused, no new compact
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Gallop: compact already in progress", "info");
  });

  // ── session_compact ──

  it("clears compaction state on session_compact so /qcompact works again", async () => {
    await callTool({ message: "bloat", summary: LONG_SUMMARY });
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    await handlers.get("session_compact")(null, { hasUI: false });
    await handlers.get("message_start")({ message: { role: "user" } }, ctx);

    await callTool({ message: "bloat", summary: LONG_SUMMARY });
    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });
});

// ── context handler: pruning the request_compact summary arg from LLM context ──

describe("context handler (summary-arg pruning)", () => {
  let pi: any;
  let handlers: Map<string, any>;
  let ctx: any;

  beforeEach(() => {
    ({ pi, handlers } = makeMockPi());
    gallopExtension(pi);
    ctx = { hasUI: false };
  });

  const compactionSummaryMsg = (summary: string) => ({
    role: "compactionSummary",
    summary,
    tokensBefore: 1000,
    timestamp: Date.now(),
  });

  const requestCompactCall = (summary: string) => ({
    role: "assistant",
    content: [
      { type: "text", text: "compacting" },
      { type: "toolCall", id: "tc1", name: "request_compact", arguments: { message: "bloat", summary } },
    ],
  });

  const otherToolCall = () => ({
    role: "assistant",
    content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } }],
  });

  it("returns undefined (no rewrite) when no compaction summary is in context", async () => {
    // Pre-compact tree view / aborted compact: the arg is the only copy.
    const result = await handlers.get("context")({ messages: [requestCompactCall(LONG_SUMMARY)] }, ctx);
    expect(result).toBeUndefined();
  });

  it("prunes the summary arg when it is carried verbatim by the compaction summary", async () => {
    // Gallop appends file sections after the summary text — the compaction
    // summary starts with the exact arg text.
    const compactionSummary = appendSelfCompactFileOps(LONG_SUMMARY, {
      read: new Set<string>(),
      written: new Set(["a.ts"]),
      edited: new Set<string>(),
    });
    const result = await handlers.get("context")({
      messages: [compactionSummaryMsg(compactionSummary), requestCompactCall(LONG_SUMMARY), otherToolCall()],
    }, ctx);

    expect(result).toBeDefined();
    const [compMsg, compactCall, other] = result.messages;
    expect(compMsg.role).toBe("compactionSummary");
    expect(compactCall.content[1].arguments.summary).toBe("[moved into the compaction summary]");
    expect(compactCall.content[1].arguments.message).toBe("bloat"); // other args untouched
    expect(compactCall.content[0]).toEqual({ type: "text", text: "compacting" });
    expect(other).toEqual(otherToolCall()); // unrelated tool calls untouched
  });

  it("does not prune a summary that the compaction summary does not carry", async () => {
    // e.g. an EARLIER compaction's tool call still in the kept tail, or a newer
    // aborted call: its text is not in the (latest) compaction summary.
    const result = await handlers.get("context")({
      messages: [
        compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() })),
        requestCompactCall("A completely different checkpoint that was never compacted.".padEnd(250, "x")),
      ],
    }, ctx);
    expect(result).toBeUndefined();
  });

  it("does not prune too-short summaries (below MIN_SUMMARY_LENGTH)", async () => {
    const short = "too short";
    const result = await handlers.get("context")({
      messages: [compactionSummaryMsg(short), requestCompactCall(short)],
    }, ctx);
    expect(result).toBeUndefined();
  });

  it("prunes only the matching call when multiple request_compact calls are present", async () => {
    const otherCheckpoint = "Another checkpoint summary, long enough to matter. ".repeat(5); // >200 chars
    const result = await handlers.get("context")({
      messages: [
        compactionSummaryMsg(appendSelfCompactFileOps(LONG_SUMMARY, { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() })),
        requestCompactCall(otherCheckpoint), // not the compacted one → intact
        requestCompactCall(LONG_SUMMARY), // the compacted one → pruned
      ],
    }, ctx);

    expect(result).toBeDefined();
    expect(result.messages[1].content[1].arguments.summary).toBe(otherCheckpoint);
    expect(result.messages[2].content[1].arguments.summary).toBe("[moved into the compaction summary]");
  });

  it("handles messages without array content and non-matching roles", async () => {
    const result = await handlers.get("context")({
      messages: [
        compactionSummaryMsg(LONG_SUMMARY),
        { role: "user", content: "plain string content, not an array" },
        { role: "toolResult", content: [{ type: "text", text: "Compacting (bloat)." }] },
        requestCompactCall(LONG_SUMMARY),
      ],
    }, ctx);
    expect(result).toBeDefined();
    expect(result.messages[3].content[1].arguments.summary).toBe("[moved into the compaction summary]");
  });
});
