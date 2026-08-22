import { describe, expect, it, vi, beforeEach } from "vitest";
import gallopExtension from "../index";

// ── Regression tests for gallop's own blocks vs the detection ladders ──
// Blocked calls (read guard, failure-loop blocks, breaker halts) arrive at
// tool_execution_end as gallop-generated errors ("[Gallop] ..."). Those must
// be invisible to the repetitive-call and failure-loop ladders — otherwise
// the model's (mandated) retry of a blocked call climbs a second ladder and
// gets contradicting, escalating signals.

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

const NO_UI = { hasUI: false };

/** UI context whose breaker dialog returns `choice` (undefined = dismissed). */
const uiCtx = (choice: string | undefined) => ({
  hasUI: true,
  ui: {
    notify: vi.fn(),
    select: vi.fn(async () => choice),
  },
});

/**
 * Simulate one full tool-call round trip the way pi emits it:
 * tool_execution_start (raw args) → tool_call (validated input, may block) →
 * tool_execution_end (block reason as error result when blocked).
 */
async function runCall(
  handlers: Map<string, any>,
  ctx: any,
  call: { id: string; toolName: string; args: any; input?: any; isError?: boolean; resultText?: string },
) {
  await handlers.get("tool_execution_start")({
    toolCallId: call.id,
    toolName: call.toolName,
    args: call.args,
  });
  const verdict = await handlers.get("tool_call")(
    { toolCallId: call.id, toolName: call.toolName, input: call.input ?? call.args },
    ctx,
  );
  const blocked = !!(verdict && verdict.block);
  const resultText = call.resultText ?? (blocked ? verdict.reason : "ok");
  await handlers.get("tool_execution_end")({
    toolCallId: call.id,
    toolName: call.toolName,
    isError: call.isError ?? blocked,
    result: { content: [{ type: "text", text: resultText }] },
  }, ctx);
  // pi treats an undefined verdict as "pass through" — normalize it.
  return verdict ?? {};
}

const steers = (pi: any) =>
  pi.sendUserMessage.mock.calls.map(([t]) => t as string).filter((t) => t.startsWith("[Gallop]"));

describe("gallop-blocked calls vs the repetitive ladder", () => {
  let pi: any;
  let handlers: Map<string, any>;
  let ctx: any;

  beforeEach(() => {
    ({ pi, handlers } = makeMockPi());
    gallopExtension(pi);
    ctx = NO_UI;
    // Reset shared module state (no disk I/O; read guard is on by default).
    void handlers.get("session_compact")(null, ctx);
  });

  it("repeated read-guard blocks never trip the repetitive-call ladder", async () => {
    for (let i = 1; i <= 5; i++) {
      const verdict = await runCall(handlers, ctx, {
        id: `r${i}`,
        toolName: "read",
        args: { path: "/tmp/spec.pdf" },
      });
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("Blocked read of binary file");
    }
    // The guard's block reason is the only signal — no ladder nudge, no
    // contradictory "The file content is already in context", no hard block.
    expect(steers(pi)).toEqual([]);
  });

  it("blocked calls neither start nor extend a streak; a real streak still trips the ladder", async () => {
    // Two blocked reads of a binary file…
    await runCall(handlers, ctx, { id: "b1", toolName: "read", args: { path: "/tmp/spec.pdf" } });
    await runCall(handlers, ctx, { id: "b2", toolName: "read", args: { path: "/tmp/spec.pdf" } });
    // …then three identical SUCCESSFUL reads → the 3rd trips the ladder.
    await runCall(handlers, ctx, { id: "c1", toolName: "read", args: { path: "/tmp/a.ts" } });
    await runCall(handlers, ctx, { id: "c2", toolName: "read", args: { path: "/tmp/a.ts" } });
    const third = await runCall(handlers, ctx, { id: "c3", toolName: "read", args: { path: "/tmp/a.ts" } });
    expect(third.block).toBeUndefined();

    const nudges = steers(pi).filter((t) => t.startsWith("[Gallop] Repetitive action detected"));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("a.ts");
  });
});

describe("circuit breaker dialog handling", () => {
  let pi: any;
  let handlers: Map<string, any>;

  beforeEach(() => {
    ({ pi, handlers } = makeMockPi());
    gallopExtension(pi);
    void handlers.get("session_compact")(null, NO_UI);
  });

  /** Five identical bash failures → the command is hard-blocked. */
  async function hardBlockCommand() {
    for (let i = 1; i <= 5; i++) {
      await runCall(handlers, NO_UI, {
        id: `fail${i}`,
        toolName: "bash",
        args: { command: "false" },
        isError: true,
        resultText: "Command failed with exit code 1",
      });
    }
  }

  it("dismissed dialog (no choice) steps back instead of claiming the blocks were cleared", async () => {
    await hardBlockCommand();
    // Two more calls hit the failure-loop block (totalBlocks 1, 2)…
    await runCall(handlers, NO_UI, { id: "bl1", toolName: "bash", args: { command: "false" } });
    await runCall(handlers, NO_UI, { id: "bl2", toolName: "bash", args: { command: "false" } });
    // …the third trips the breaker; the user dismisses the dialog without choosing.
    const verdict = await runCall(handlers, uiCtx(undefined), {
      id: "bl3",
      toolName: "bash",
      args: { command: "false" },
    });
    // The call passes through (not blocked) — stepping back, like the no-UI path.
    expect(verdict.block).toBeUndefined();

    const sent = steers(pi);
    expect(sent.some((t) => t.includes("Stepping back (dialog dismissed)"))).toBe(true);
    expect(sent.some((t) => t.includes("blocks cleared by user"))).toBe(false);

    // State fully reset: the same command runs unblocked again.
    const fresh = await runCall(handlers, NO_UI, {
      id: "fresh",
      toolName: "bash",
      args: { command: "false" },
      isError: true,
      resultText: "Command failed with exit code 1",
    });
    expect(fresh.block).toBeUndefined();
  });

  it("Stop halts the agent and the halt reason does not promise a plain message unblocks", async () => {
    await hardBlockCommand();
    await runCall(handlers, NO_UI, { id: "bl1", toolName: "bash", args: { command: "false" } });
    await runCall(handlers, NO_UI, { id: "bl2", toolName: "bash", args: { command: "false" } });
    const verdict = await runCall(handlers, uiCtx("Stop"), {
      id: "bl3",
      toolName: "bash",
      args: { command: "false" },
    });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toBe(
      "[Gallop] Circuit breaker: agent halted by user. Use /compact or /new to unblock tools.",
    );

    // Every further tool call is blocked with the same corrected wording.
    const next = await runCall(handlers, NO_UI, { id: "after", toolName: "read", args: { path: "/tmp/a.ts" } });
    expect(next.block).toBe(true);
    expect(next.reason).toBe(
      "[Gallop] Agent halted by user (circuit breaker). Use /compact or /new to unblock tools.",
    );
    expect(next.reason).not.toContain("Type a message");
  });
});

describe("failure window across runs", () => {
  let pi: any;
  let handlers: Map<string, any>;

  beforeEach(() => {
    ({ pi, handlers } = makeMockPi());
    gallopExtension(pi);
    void handlers.get("session_compact")(null, NO_UI);
  });

  // pi restarts its turnIndex at 0 on every agent_start (including
  // agent.continue() runs) — the payload here mimics that reset.
  const turnStart = () => handlers.get("turn_start")({ turnIndex: 0 }, NO_UI);
  const fail = (id: string) =>
    runCall(handlers, NO_UI, {
      id,
      toolName: "bash",
      args: { command: "false" },
      isError: true,
      resultText: "Command failed with exit code 1",
    });

  it("failures from a previous run do not count once the window slides past them", async () => {
    // Run 1 (gallop turns 1–2): two identical failures — below the threshold.
    await turnStart();
    await fail("f1");
    await turnStart();
    await fail("f2");
    // New run: five more turns (gallop turns 3–7), then the same failure on
    // turn 8. The old entries are outside the 5-turn window → matchCount 1,
    // no false nudge. (With pi's resetting turnIndex they would survive
    // pruning and trip a spurious "Failure loop detected" at count 3.)
    for (let i = 0; i < 5; i++) await turnStart();
    await turnStart();
    await fail("f3");
    expect(steers(pi).filter((t) => t.includes("Failure loop detected"))).toEqual([]);
  });

  it("failures within the window still trip the ladder", async () => {
    for (let i = 1; i <= 3; i++) {
      await turnStart();
      await fail(`g${i}`);
    }
    expect(steers(pi).filter((t) => t.includes("Failure loop detected"))).toHaveLength(1);
  });
});
