import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import gallopExtension from "../index";

/**
 * Stall detection — regression for the field failure of 2026-10-14 (session
 * 01a138f9). llama.cpp reported finish_reason "stop" on the assistant message
 * that carried compact_request; the old detector read any tool-call message not
 * ending on stopReason "toolUse" as a stall and sent a resume steer. That steer
 * refilled pi's steering queue, so the post-run loop kept running and gallop's
 * own deferred compaction (agent_settled) was delayed by 14 tool calls — the
 * stashed checkpoint was stale by the time it landed in context.
 */

function makeMockPi() {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const pi = {
    on: vi.fn((name: string, handler: any) => { handlers.set(name, handler); }),
    registerTool: vi.fn((tool: any) => { tools.set(tool.name, tool); }),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  return { pi, handlers, tools };
}

/** Short enough to keep the test readable, long enough to pass the
 *  compact_request minimum-summary guard. */
const SUMMARY = "## Goal\nProve a steer cannot hold off the deferred compact.\n\n" +
  "## State\n### Done\n- [x] stall detector no longer fires on tool-call messages\n\n" +
  "## Next Steps\n" + "1. Keep the steering queue empty between compact_request and agent_settled.\n".repeat(3);

function assistantMessage(content: unknown[], stopReason: string) {
  return {
    role: "assistant",
    content,
    stopReason,
    // Far from any nudge threshold: the context-pressure steer stays out of the way.
    usage: { input: 50_000, output: 100, totalTokens: 50_100 },
  };
}

describe("stall detection", () => {
  let pi: any, handlers: Map<string, any>, tools: Map<string, any>, ctx: any;

  beforeEach(() => {
    ({ pi, handlers, tools } = makeMockPi());
    gallopExtension(pi);
    ctx = {
      compact: vi.fn(),
      hasUI: false,
      cwd: "/tmp/gallop-test",
      model: { contextWindow: 200_000 },
      getContextUsage: vi.fn(() => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 })),
      sessionManager: { getBranch: vi.fn(() => []) },
    };
    // Clear any pending request / latch left by a prior test (session_compact
    // resets all gallop state through the composition root).
    void handlers.get("session_compact")(null, { hasUI: false });
    void handlers.get("message_start")({ message: { role: "user" } }, ctx);
  });

  afterEach(() => {
    void handlers.get("session_compact")(null, { hasUI: false });
    vi.useRealTimers();
  });

  const endMessage = (message: any) => {
    void handlers.get("message_start")({ message }, ctx);
    void handlers.get("message_end")({ message }, ctx);
  };
  const settle = () => handlers.get("agent_settled")(null, ctx);
  // Hidden steers (steer.ts): gallop sends display:false custom messages, so the
  // 2026-10-23 transport change moved them from sendUserMessage to sendMessage.
  const steers = () =>
    pi.sendMessage.mock.calls.map(([m]: any[]) => m?.content as string).filter((t) => typeof t === "string");

  it("does not treat a tool call the provider stopped as a stall", () => {
    // pi runs tool calls whatever finish_reason said; only terminate:true ends the run.
    endMessage(assistantMessage(
      [{ type: "thinking", thinking: "write the scripts" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }],
      "stop",
    ));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves the compact_request boundary steer-free and settles the compact", async () => {
    const message = assistantMessage(
      [{ type: "thinking", thinking: "checkpoint now" }, { type: "toolCall", name: "compact_request", arguments: { summary: SUMMARY } }],
      "stop",   // llama.cpp's finish_reason on this message in the field case
    );
    endMessage(message);                                   // message_end precedes the tool call
    await tools.get("compact_request").execute("id1", { summary: SUMMARY }, new AbortController().signal, undefined, ctx);
    expect(pi.sendMessage).not.toHaveBeenCalled();     // no resume steer, no nudge

    settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);          // not held off by a steer
  });

  it("resumes a message that stopped mid-thought", () => {
    endMessage(assistantMessage([{ type: "thinking", thinking: "now I will edit the file an" }], "stop"));
    expect(steers()).toEqual(["[Gallop] Resume: stopped mid-thought (stopReason: stop)"]);
  });

  it("sends nothing for an aborted or errored mid-thought stop", () => {
    endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "aborted"));
    endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "error"));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("sends nothing for a mid-thought stop cut off by the output token limit", () => {
    // pi owns "length": it fails the message's tool calls itself, and a
    // resumed generation on the same exhausted budget truncates again.
    endMessage(assistantMessage([{ type: "thinking", thinking: "now I will write the checkpoint a" }], "length"));
    endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "length"));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("neither counts a truncation nor breaks a stall streak", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T06:15:00Z"));
    for (let i = 0; i < 3; i++) {
      endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "stop"));
      vi.advanceTimersByTime(11_000);
    }
    endMessage(assistantMessage([{ type: "thinking", thinking: "cut off by the token lim" }], "length"));
    vi.advanceTimersByTime(11_000);
    endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "stop"));
    expect(steers()[3]).toContain("stall #4");   // truncation left the count at 3
    expect(steers()).toHaveLength(4);            // and sent nothing for itself
  });

  it("sends no stall steer while a compact is pending", async () => {
    await tools.get("compact_request").execute("id1", { summary: SUMMARY }, new AbortController().signal, undefined, ctx);
    pi.sendMessage.mockClear();
    endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "stop"));
    expect(pi.sendMessage).not.toHaveBeenCalled();
    settle();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("escalates consecutive mid-thought stalls and then stops auto-resuming", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T07:43:00Z"));
    for (let i = 0; i < 5; i++) {
      endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "stop"));
      vi.advanceTimersByTime(11_000);   // clear the resume throttle window
    }
    expect(steers()[0]).toContain("stopped mid-thought");
    expect(steers()[4]).toContain("Agent has stalled 5 times consecutively");
    endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "stop"));
    expect(steers()).toHaveLength(5);   // auto-resume stopped; the notice is not repeated
  });

  it("resets the stall streak on a normal tool-call handoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T07:43:00Z"));
    endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "stop"));
    vi.advanceTimersByTime(11_000);
    endMessage(assistantMessage([{ type: "toolCall", name: "read", arguments: { path: "x" } }], "toolUse"));
    vi.advanceTimersByTime(11_000);
    endMessage(assistantMessage([{ type: "thinking", thinking: "half a thought" }], "stop"));
    expect(steers()[1]).not.toContain("stall #");   // back to stall #1, not #2
  });
});
