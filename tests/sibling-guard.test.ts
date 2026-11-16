import { describe, expect, it, vi } from "vitest";
import gallopExtension from "../index";

// ── The compact_request sibling guard ──
// pi honours a terminating tool result only when EVERY finalized result in the
// batch terminates, so a tool call sharing compact_request's message cancels its
// terminate: the run keeps going and the compaction — fired at agent_settled —
// waits behind it (measured: 8 min / 20 further tool calls; IMPROVEMENTS.md).
// Gallop blocks those siblings, and blocks them WITH terminate, so the batch
// still ends the run and the compact lands at settle.

function makeMockPi() {
  const handlers = new Map<string, any>();
  const pi = {
    on: vi.fn((name: string, handler: any) => { handlers.set(name, handler); }),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  return { pi, handlers };
}

const NO_UI = { hasUI: false };

/** A fresh extension over the module state gallop keeps per session — the
 *  session_start reset is what separates one test from the next. */
function setup() {
  const { pi, handlers } = makeMockPi();
  gallopExtension(pi as any);
  handlers.get("session_start")();
  return handlers;
}

/** One tool_call hook, as pi fires it (validated input, may block). */
function call(
  handlers: Map<string, any>,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return handlers.get("tool_call")(
    { toolCallId, toolName, input: { summary: "s".repeat(300), ...input }, ...extra },
    NO_UI,
  );
}

const assistantStart = (handlers: Map<string, any>) =>
  handlers.get("message_start")({ message: { role: "assistant" } });

describe("compact_request sibling guard", () => {
  it("blocks a call sharing its message with compact_request, and terminates it", async () => {
    const h = setup();
    expect(await call(h, "compact_request", "c1")).toBeUndefined();

    const verdict = await call(h, "edit", "c2", { path: "/tmp/a.ts" });
    expect(verdict).toMatchObject({ block: true, terminate: true });
    expect(verdict.reason).toContain("compact_request");
  });

  it("runs a call listed before the request, and never blocks the request itself", async () => {
    const h = setup();
    // pi prepares every call in the batch before executing any, so a call that
    // arrived first is already past the hook — documented partial coverage.
    expect(await call(h, "bash", "c1", { command: "echo hi" })).toBeUndefined();
    expect(await call(h, "compact_request", "c2")).toBeUndefined();
    // …while a call behind the request is caught.
    expect(await call(h, "bash", "c3", { command: "ls" })).toMatchObject({ block: true });
  });

  it("is scoped to one assistant message", async () => {
    const h = setup();
    await call(h, "compact_request", "c1");
    expect(await call(h, "edit", "c2", { path: "/tmp/a.ts" })).toMatchObject({ block: true });

    // The next assistant message is a fresh batch: nothing to protect there.
    assistantStart(h);
    expect(await call(h, "edit", "c3", { path: "/tmp/a.ts" })).toBeUndefined();
  });

  it("leaves nested calls alone — their parent's batch cannot terminate anyway", async () => {
    const h = setup();
    await call(h, "compact_request", "c1");
    expect(
      await call(h, "bash", "c2/1", { command: "ls" }, { parentToolCallId: "c2" }),
    ).toBeUndefined();
  });

  it("is cleared with the rest of the cycle state on session start", async () => {
    const h = setup();
    await call(h, "compact_request", "c1");
    h.get("session_start")();
    expect(await call(h, "edit", "c2", { path: "/tmp/a.ts" })).toBeUndefined();
  });
});
