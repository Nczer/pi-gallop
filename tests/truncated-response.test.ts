import { describe, expect, it, vi, beforeEach } from "vitest";
import gallopExtension from "../index";

// ── A response that hit the output token limit (stopReason "length") ──
// Field case (session 01a14841, 2026-10-17): a message truncated mid-thought on
// "length" got gallop's resume steer, and the resumed generation — same
// exhausted output budget — produced a 32-token fragment and truncated again.
// pi owns this shape: it fails every tool call in the truncated message itself
// ("...was not executed: the response hit the output token limit... Re-issue the
// tool call with complete arguments.") and emits tool_execution_start/end for
// those synthetic errors. Gallop must neither resume it nor feed the synthetic
// failures and the possibly-truncated arguments into its detection ladders.

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

/** pi's own wording for the synthetic failure of an unexecuted tool call. */
const TRUNCATION_ERROR = 'Tool call "bash" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.';

function assistantMessage(content: unknown[], stopReason: string) {
  return {
    role: "assistant",
    content,
    stopReason,
    // Far from any nudge threshold: the context-pressure steer stays out of the way.
    usage: { input: 50_000, output: 4000, totalTokens: 54_000 },
  };
}

const CMD = "npm run build 2>&1 | tail -40";

describe("length-truncated responses", () => {
  let pi: any, handlers: Map<string, any>, ctx: any;

  beforeEach(() => {
    ({ pi, handlers } = makeMockPi());
    gallopExtension(pi);
    ctx = {
      compact: vi.fn(),
      hasUI: false,
      cwd: "/tmp/gallop-test",
      model: { contextWindow: 200_000 },
      getContextUsage: vi.fn(() => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 })),
      sessionManager: { getBranch: vi.fn(() => []) },
    };
    void handlers.get("session_compact")(null, { hasUI: false });
    void handlers.get("message_start")({ message: { role: "user" } }, ctx);
  });

  /** One truncated round trip: assistant message_end → pi's synthetic failure. */
  async function truncatedBashCall(id: string) {
    const message = assistantMessage(
      [{ type: "thinking", thinking: "build the project and check the output" },
       { type: "toolCall", name: "bash", arguments: { command: CMD } }],
      "length",
    );
    await handlers.get("message_start")({ message }, ctx);
    await handlers.get("message_end")({ message }, ctx);
    await handlers.get("tool_execution_start")({
      toolCallId: id, toolName: "bash", args: { command: CMD },
    });
    await handlers.get("tool_execution_end")({
      toolCallId: id, toolName: "bash", isError: true,
      result: { content: [{ type: "text", text: TRUNCATION_ERROR }] },
    }, ctx);
  }

  const steers = () =>
    pi.sendUserMessage.mock.calls.map(([t]: any[]) => t as string).filter((t) => t.startsWith("[Gallop]"));

  it("sends no resume steer for a mid-thought truncation", async () => {
    const message = assistantMessage([{ type: "thinking", thinking: "now I will write the checkpoint and c" }], "length");
    await handlers.get("message_start")({ message }, ctx);
    await handlers.get("message_end")({ message }, ctx);
    expect(steers()).toEqual([]);
  });

  it("keeps repeated truncations off the failure-loop and repetitive ladders", async () => {
    // Same command, same synthetic error, three rounds: enough for both the
    // failure-loop nudge (≥3) and the repetitive-call nudge (≥3 in a row).
    for (let i = 0; i < 4; i++) await truncatedBashCall(`id${i}`);
    expect(steers()).toEqual([]);
    // Nothing was recorded, so nothing can be enforced on the re-issue either.
    const verdict = await handlers.get("tool_call")(
      { toolCallId: "id9", toolName: "bash", input: { command: CMD } }, ctx,
    );
    expect(verdict).toBeUndefined();
  });

  it("still detects a real failure after a truncated round", async () => {
    await truncatedBashCall("id0");
    // A genuine failure of the same command (the run continued, output budget
    // recovered) climbs the ladder as usual.
    const message = assistantMessage(
      [{ type: "toolCall", name: "bash", arguments: { command: CMD } }],
      "toolUse",
    );
    for (let i = 0; i < 3; i++) {
      await handlers.get("message_start")({ message }, ctx);
      await handlers.get("message_end")({ message }, ctx);
      await handlers.get("tool_execution_start")({
        toolCallId: `real${i}`, toolName: "bash", args: { command: CMD },
      });
      await handlers.get("tool_execution_end")({
        toolCallId: `real${i}`, toolName: "bash", isError: true,
        result: { content: [{ type: "text", text: "error: missing script \"build\"" }] },
      }, ctx);
    }
    expect(steers().some((s) => s.startsWith("[Gallop] Failure loop detected"))).toBe(true);
  });
});
