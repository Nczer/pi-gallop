import { describe, expect, it, vi, beforeEach } from "vitest";
import gallopExtension from "../index";

// ── Reasoning-action mismatch ──
// The detector reads the thinking block to decide whether the model
// acknowledged the failure before re-issuing the exact call that failed. pi's
// ThinkingContent carries the text in `thinking`, not `text`
// (packages/ai/src/types.ts:403-405) — reading `text` made the check see an
// empty string forever, so no mismatch steer was ever issued (verified against
// the session transcripts: zero "[Gallop] Mismatch:" messages).

function makeMockPi() {
  const handlers = new Map<string, any>();
  const pi = {
    on: vi.fn((name: string, handler: any) => { handlers.set(name, handler); }),
    registerTool: vi.fn(), registerCommand: vi.fn(),
    sendUserMessage: vi.fn(), sendMessage: vi.fn(), appendEntry: vi.fn(),
  };
  return { pi, handlers };
}

const CMD = "cat /srv/secrets/token";

function assistantMessage(content: unknown[], stopReason = "toolUse") {
  return {
    role: "assistant",
    content,
    stopReason,
    // Far from any nudge threshold: the context-pressure steer stays out of the way.
    usage: { input: 50_000, output: 120, totalTokens: 50_120 },
  };
}

describe("reasoning-action mismatch", () => {
  let pi: any, handlers: Map<string, any>, ctx: any;

  beforeEach(async () => {
    ({ pi, handlers } = makeMockPi());
    gallopExtension(pi);
    ctx = {
      hasUI: false, cwd: "/tmp/gallop-test",
      model: { contextWindow: 200_000 },
      sessionManager: { getBranch: vi.fn(() => []) },
    };
    void handlers.get("session_compact")(null, ctx);
    // One real failure of the command (below the failure-loop threshold).
    const call = assistantMessage([{ type: "toolCall", name: "bash", arguments: { command: CMD } }]);
    await handlers.get("message_start")({ message: call }, ctx);
    await handlers.get("message_end")({ message: call }, ctx);
    await handlers.get("tool_execution_start")({ toolCallId: "f1", toolName: "bash", args: { command: CMD } });
    await handlers.get("tool_execution_end")({
      toolCallId: "f1", toolName: "bash", isError: true,
      result: { content: [{ type: "text", text: "cat: /srv/secrets/token: Permission denied" }] },
    }, ctx);
  });

  const steers = () =>
    pi.sendUserMessage.mock.calls.map(([t]: any[]) => t as string).filter((t) => t.startsWith("[Gallop] Mismatch:"));

  /** The model re-issues the exact failed call; only the thinking differs. */
  async function reIssue(thinking: string) {
    const message = assistantMessage([
      { type: "thinking", thinking, thinkingSignature: "sig" },
      { type: "toolCall", name: "bash", arguments: { command: CMD } },
    ]);
    await handlers.get("message_start")({ message }, ctx);
    await handlers.get("message_end")({ message }, ctx);
  }

  it("flags a re-issue the thinking acknowledged as a failure", async () => {
    await reIssue("That failed — the path is wrong, I need to check permissions first.");
    expect(steers()).toHaveLength(1);
    expect(steers()[0]).toContain("token");
  });

  it("stays silent when the thinking acknowledges nothing", async () => {
    await reIssue("Run the command to collect the rest of the output.");
    expect(steers()).toEqual([]);
  });
});
