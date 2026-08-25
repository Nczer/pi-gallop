import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import gallopExtension from "../index";

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

/** A valid (>200 char) checkpoint summary. */
const LONG_SUMMARY = `## Goal
Test goal: keep messages typed during a pending self-compact from running on
the stale, un-compacted context before the deferred compact fires.

## Constraints & Preferences
- Swallowed messages must be re-delivered in order after the compaction.

## Progress
### Done
- [x] request_compact defers to agent_settled

### In Progress
- [ ] Input gate around the pending window

### Blocked
- (none)

## Key Decisions
- The post-run loop processes queued messages before agent_settled, so the
  compact must never wait behind them.

## Next Steps
1. Verify the gate swallows only interactive input
2. Verify re-delivery skips the generic proceed steer

## Critical Context
- session_compact fires while pi's compaction-in-progress flag is still set.`;

describe("pending-compact input gate", () => {
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
      sessionManager: { getBranch: vi.fn(() => []) },
    };
    // Reset shared module state (mirrors the self-compact suite): clear any
    // pending request, stash, or redelivery timer left by a prior test.
    void handlers.get("session_compact")(null, { hasUI: false });
    void handlers.get("message_start")({ message: { role: "user" } }, ctx);
  });

  afterEach(() => {
    // A scheduled redelivery timer must not leak into the next test.
    void handlers.get("session_compact")(null, { hasUI: false });
  });

  const settle = () => handlers.get("agent_settled")(null, ctx);
  const callTool = (params: any) =>
    tools.get("request_compact").execute("id1", params, new AbortController().signal, undefined, ctx);
  const input = (text: string, source = "interactive") =>
    handlers.get("input")({ type: "input", text, images: undefined, source, streamingBehavior: "steer" }, ctx);
  const flushTimers = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms));

  it("swallows interactive input while a compact is pending and re-delivers it after", async () => {
    await callTool({ summary: LONG_SUMMARY });
    expect(input("hello after compact")).toEqual({ action: "handled" });
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    // Consume the pending request, let the (mock) compact "complete".
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    pi.sendUserMessage.mockClear();
    await handlers.get("session_compact")(null, ctx);
    const opts = ctx.compact.mock.calls[0][0];
    opts.onComplete(); // real pi: fires right after compact() resolves
    await flushTimers();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("hello after compact");
    expect(pi.sendUserMessage.mock.calls[0][1]).toEqual({ deliverAs: "followUp", expandPromptTemplates: true });
  });

  it("passes input through when no compact is pending", () => {
    expect(input("hello")).toBeUndefined();
  });

  it("does not swallow non-interactive sources", async () => {
    await callTool({ summary: LONG_SUMMARY });
    expect(input("hello", "extension")).toBeUndefined();
    expect(input("hello", "rpc")).toBeUndefined();
    // Consume the pending request so no state leaks.
    await settle();
  });

  it("re-delivers stashed messages in order and skips the proceed steer", async () => {
    await callTool({ summary: LONG_SUMMARY, continue: true });
    expect(input("first")).toEqual({ action: "handled" });
    expect(input("second", "interactive")).toEqual({ action: "handled" });
    await settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    pi.sendUserMessage.mockClear();
    await handlers.get("session_compact")(null, ctx);
    const opts = ctx.compact.mock.calls[0][0];
    opts.onComplete(); // while the redelivery is pending — must be suppressed
    await flushTimers();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("first");
    expect(pi.sendUserMessage.mock.calls[1][0]).toBe("second");
  });

  it("re-delivers stashed messages when pi's automatic compaction ran first", async () => {
    await callTool({ summary: LONG_SUMMARY, continue: true });
    expect(input("queued")).toEqual({ action: "handled" });

    // Auto path: pi's threshold compaction consumes the stashed summary.
    const auto = await handlers.get("session_before_compact")(
      { preparation: { firstKeptEntryId: "e1", tokensBefore: 50000, fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: new AbortController().signal },
      ctx,
    );
    expect(auto?.compaction?.summary).toContain("Goal");

    pi.sendUserMessage.mockClear();
    await handlers.get("session_compact")(null, ctx);
    await flushTimers();
    // The stashed message is the continuation — no proceed steer either.
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("queued");
  });

  it("delivers stashed messages immediately when the compact fails", async () => {
    await callTool({ summary: LONG_SUMMARY });
    expect(input("queued")).toEqual({ action: "handled" });
    await handlers.get("session_compact_failed")({}, ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("queued");
  });

  it("keeps the proceed steer when nothing was stashed (manual path)", async () => {
    await callTool({ summary: LONG_SUMMARY, continue: true });
    await settle();
    pi.sendUserMessage.mockClear();
    await handlers.get("session_compact")(null, ctx);
    const opts = ctx.compact.mock.calls[0][0];
    opts.onComplete();
    await flushTimers();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("[Gallop] Compact done — proceed as commanded.");
  });

  it("keeps the proceed steer when nothing was stashed (auto path)", async () => {
    await callTool({ summary: LONG_SUMMARY, continue: true });
    await handlers.get("session_before_compact")(
      { preparation: { firstKeptEntryId: "e1", tokensBefore: 50000, fileOps: { read: new Set(), written: new Set(), edited: new Set() } }, signal: new AbortController().signal },
      ctx,
    );
    pi.sendUserMessage.mockClear();
    await handlers.get("session_compact")(null, ctx);
    await flushTimers();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toBe("[Gallop] Compact done — proceed as commanded.");
  });

  it("discards the stash on a session reset", async () => {
    await callTool({ summary: LONG_SUMMARY });
    expect(input("old-session message")).toEqual({ action: "handled" });
    await handlers.get("session_start")(null, ctx); // resetAllState
    pi.sendUserMessage.mockClear();
    await handlers.get("session_compact")(null, ctx);
    await flushTimers();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
