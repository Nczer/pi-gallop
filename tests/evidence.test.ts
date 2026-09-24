import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  lineNumbersFor,
  coveredRange,
  buildProtected,
  buildEvidence,
  buildEvidenceBlocks,
  PROTECTED_BUDGET_CHARS,
} from "../evidence";

// ── Fixtures (mirror self-compact.test.ts shapes) ──

const user = (id: string, text: string): SessionEntry =>
  ({ type: "message", id, message: { role: "user", content: text, timestamp: 0 } }) as SessionEntry;

const asstCall = (id: string, callId: string, name: string, args: Record<string, unknown>): SessionEntry =>
  ({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: args }],
      stopReason: "stop",
      timestamp: 0,
    },
  }) as SessionEntry;

const result = (id: string, callId: string, tool: string, text: string, isError = false): SessionEntry =>
  ({
    type: "message",
    id,
    message: { role: "toolResult", toolCallId: callId, toolName: tool, content: [{ type: "text", text }], isError, timestamp: 0 },
  }) as SessionEntry;

const compactionEntry = (id: string, firstKeptEntryId: string): SessionEntry =>
  ({ type: "compaction", id, summary: "old summary", firstKeptEntryId, tokensBefore: 1, timestamp: 0 }) as SessionEntry;

// ── lineNumbersFor ──

describe("lineNumbersFor", () => {
  it("maps entry ids to 1-based line numbers", () => {
    const file = '{"type":"session_header","id":"h"}\n{"type":"message","id":"a"}\n{"type":"message","id":"b"}';
    const m = lineNumbersFor(file);
    expect(m.get("h")).toBe(1);
    expect(m.get("a")).toBe(2);
    expect(m.get("b")).toBe(3);
  });

  it("skips non-JSON lines", () => {
    const m = lineNumbersFor('not json\n{"id":"x"}');
    expect(m.get("x")).toBe(2);
    expect(m.size).toBe(1);
  });
});

// ── coveredRange ──

describe("coveredRange", () => {
  it("covers from session start when there is no previous compaction", () => {
    const entries = [user("u1", "a"), user("u2", "b"), user("u3", "c")];
    expect(coveredRange(entries, "u3")).toEqual({ start: 0, end: 2 });
  });

  it("covers from the previous compaction's kept boundary", () => {
    const entries = [user("u0", "a"), user("u1", "b"), compactionEntry("c1", "u1"), user("u2", "c"), user("u3", "d")];
    expect(coveredRange(entries, "u3")).toEqual({ start: 1, end: 4 });
  });

  it("falls back to compaction entry + 1 when the kept id is missing", () => {
    const entries = [user("u0", "a"), compactionEntry("c1", "gone"), user("u1", "b")];
    expect(coveredRange(entries, "u1")).toEqual({ start: 2, end: 2 });
  });

  it("returns null when the cut id is absent", () => {
    const entries = [user("u1", "a")];
    expect(coveredRange(entries, "nope")).toBeNull();
  });
});

// ── buildProtected ──

describe("buildProtected", () => {
  it("carries user messages verbatim, chronologically", () => {
    const entries = [user("u1", "make it red"), user("u2", "no, dark red")];
    const out = buildProtected(entries, 0, 2);
    expect(out).toBeDefined();
    expect(out).toContain("make it red");
    expect(out).toContain("no, dark red");
    expect(out?.indexOf("make it red")).toBeLessThan(out?.indexOf("no, dark red"));
    expect(out).toContain("verbatim");
  });

  it("filters synthetic markers and strips the [Memory] hint suffix", () => {
    const entries = [
      user("u1", "[Gallop] Compact done — proceed as commanded."),
      user("u2", "[Memory] deep entry hint text"),
      user("u3", "real ask\n\n[Memory] foo:bar (deep)"),
    ];
    const out = buildProtected(entries, 0, 3);
    expect(out).toContain("real ask");
    expect(out).not.toContain("Compact done");
    expect(out).not.toContain("deep entry hint");
    expect(out).not.toContain("[Memory]");
  });

  it("skips empty user messages", () => {
    const entries = [user("u1", "   "), user("u2", "hello")];
    const out = buildProtected(entries, 0, 2);
    expect(out).toContain("hello");
  });

  it("returns undefined when there are no user messages", () => {
    expect(buildProtected([result("r1", "c1", "read", "x")], 0, 1)).toBeUndefined();
  });

  it("caps the budget, keeps newest, labels the omission", () => {
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push(user(`u${i}`, `message ${i} ` + "z".repeat(3000)));
    }
    const out = buildProtected(entries, 0, entries.length);
    expect(out).toBeDefined();
    expect(out).toContain("older user message(s) omitted (block cap)");
    // newest survives, oldest dropped
    expect(out).toContain("message 7");
    expect(out).not.toContain("message 0 ");
    // budget respected (header + footer overhead allowed)
    expect(out!.length).toBeLessThan(PROTECTED_BUDGET_CHARS + 500);
  });

  it("carries a single oversized message truncated", () => {
    const big = "b".repeat(PROTECTED_BUDGET_CHARS * 2);
    const out = buildProtected([user("u1", big)], 0, 1);
    expect(out).toContain("…[truncated]");
    expect(out!.length).toBeLessThan(PROTECTED_BUDGET_CHARS + 500);
  });
});

// ── buildEvidence ──

describe("buildEvidence", () => {
  const lineNo = (ids: string[]) => new Map(ids.map((id, i) => [id, i + 1]));

  it("returns undefined with an empty line map (no fetch pointers possible)", () => {
    const entries = [asstCall("a1", "c1", "read", { path: "/x.ts" }), result("r1", "c1", "read", "x")];
    expect(buildEvidence(entries, 0, 2, new Map())).toBeUndefined();
  });

  it("indexes errors first with the ERR marker, newest first", () => {
    const entries = [
      asstCall("a1", "c1", "bash", { command: "ls" }),
      result("r1", "c1", "bash", "ok output"),
      asstCall("a2", "c2", "bash", { command: "make" }),
      result("r2", "c2", "bash", "error: build failed", true),
      asstCall("a3", "c3", "bash", { command: "make again" }),
      result("r3", "c3", "bash", "error: still failing", true),
    ];
    const out = buildEvidence(entries, 0, 6, lineNo(entries.map((e) => e.id)));
    expect(out).toBeDefined();
    const r3 = out!.indexOf("L6");
    const r2 = out!.indexOf("L4");
    expect(r3).not.toBe(-1);
    expect(r2).not.toBe(-1);
    expect(r3).toBeLessThan(r2); // newest error first
    expect(out).toContain("ERR");
    expect(out!.indexOf("L4")).toBeLessThan(out!.indexOf("L2")); // error before success
  });

  it("groups by (tool, target): keeps newest + oldest per group", () => {
    const entries = [
      asstCall("a1", "c1", "read", { path: "/x.ts" }),
      result("r1", "c1", "read", "v1"),
      asstCall("a2", "c2", "read", { path: "/x.ts" }),
      result("r2", "c2", "read", "v2"),
      asstCall("a3", "c3", "read", { path: "/x.ts" }),
      result("r3", "c3", "read", "v3"),
    ];
    const out = buildEvidence(entries, 0, 6, lineNo(entries.map((e) => e.id)));
    expect(out).toBeDefined();
    expect(out).toContain("v3"); // newest
    expect(out).toContain("v1"); // oldest (setup)
    // the middle result is demoted below the group's newest + oldest
    expect(out!.indexOf("v3")).toBeLessThan(out!.indexOf("v2"));
    expect(out!.indexOf("v1")).toBeLessThan(out!.indexOf("v2"));
  });

  it("ranks config/schema/test targets before other targets", () => {
    const entries = [
      asstCall("a1", "c1", "read", { path: "/src/app.ts" }),
      result("r1", "c1", "read", "code"),
      asstCall("a2", "c2", "read", { path: "/settings.json" }),
      result("r2", "c2", "read", '{"port": 8081}'),
    ];
    const out = buildEvidence(entries, 0, 4, lineNo(entries.map((e) => e.id)));
    expect(out!.indexOf("settings.json")).toBeLessThan(out!.indexOf("app.ts"));
  });

  it("collapses newlines in bash commands (one row per result)", () => {
    const entries = [
      asstCall("a1", "c1", "bash", { command: "cd /x\ngrep -rn foo src/\necho done" }),
      result("r1", "c1", "bash", "found 3"),
    ];
    const out = buildEvidence(entries, 0, 2, lineNo(entries.map((e) => e.id)));
    const row = out!.split("\n").find((l) => l.startsWith("L2 "));
    expect(row).toBeDefined();
    expect(row).toMatch(/^L2 bash cd \/x grep -rn foo src\/ echo done :: found 3$/);
  });

  it("groups bash by full command, not the 60-char display prefix", () => {
    // two distinct commands sharing the same 60-char prefix stay separate
    const prefix = "cd /mnt/Ndr/Projects/pi/packages/coding-agent/src/core grep ";
    const entries = [
      asstCall("a1", "c1", "bash", { command: prefix + 'A -n "x"' }),
      result("r1", "c1", "bash", "outA"),
      asstCall("a2", "c2", "bash", { command: prefix + 'B -n "y"' }),
      result("r2", "c2", "bash", "outB"),
    ];
    const out = buildEvidence(entries, 0, 4, lineNo(entries.map((e) => e.id)));
    expect(out).toBeDefined();
    expect(out).toContain("outB");
    expect(out).toContain("outA"); // both kept — distinct groups, no demotion
  });

  it("excludes successful non-indexed tools", () => {
    const entries = [
      asstCall("a1", "c1", "web_search", { query: "x" }),
      result("r1", "c1", "web_search", "results"),
    ];
    expect(buildEvidence(entries, 0, 2, lineNo(entries.map((e) => e.id)))).toBeUndefined();
  });

  it("indexes errors from any tool", () => {
    const entries = [
      asstCall("a1", "c1", "mystery_tool", { q: 1 }),
      result("r1", "c1", "mystery_tool", "boom", true),
    ];
    const out = buildEvidence(entries, 0, 2, lineNo(entries.map((e) => e.id)));
    expect(out).toContain("mystery_tool ERR");
  });

  it("formats rows: L<n> tool target :: head…tail (whitespace collapsed)", () => {
    const big = "line1   line2\n\nline3 " + "y".repeat(500);
    const entries = [
      asstCall("a1", "c1", "read", { path: "/x.ts" }),
      result("r1", "c1", "read", big),
    ];
    const out = buildEvidence(entries, 0, 2, lineNo(entries.map((e) => e.id)));
    const row = out!.split("\n").find((l) => l.startsWith("L2 "));
    expect(row).toBeDefined();
    expect(row).toMatch(/^L2 read \/x\.ts :: /);
    expect(row).toContain("…"); // middle elided
    expect(row).not.toContain("  "); // whitespace collapsed
  });

  it("renders fragments without L pointers or fetch instruction when pointers is off", () => {
    const entries = [
      asstCall("a1", "c1", "bash", { command: "ls /x" }),
      result("r1", "c1", "bash", "file1\nfile2"),
    ];
    const out = buildEvidence(entries, 0, 2, new Map(), false);
    expect(out).toBeDefined();
    expect(out).not.toContain("session_recall");
    expect(out).not.toMatch(/\bL\d+/);
    const row = out!.split("\n").find((l) => l.includes("ls /x"));
    expect(row).toMatch(/^bash ls \/x :: file1 file2$/);
  });

  it("stops at the budget without splitting a row", () => {
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 40; i++) {
      entries.push(asstCall(`a${i}`, `c${i}`, "bash", { command: `cmd${i}` }));
      entries.push(result(`r${i}`, `c${i}`, "bash", "out " + i + " " + "z".repeat(400)));
    }
    const out = buildEvidence(entries, 0, entries.length, lineNo(entries.map((e) => e.id)));
    expect(out).toBeDefined();
    const rows = out!.split("\n").slice(1);
    expect(rows.length).toBeLessThan(40);
    expect(out!.length).toBeLessThan(12_000);
  });
});

// ── buildEvidenceBlocks (integration + fail-open) ──

describe("buildEvidenceBlocks", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gallop-evidence-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds both blocks from a session file", () => {
    const entries = [
      user("u1", "make the port 8081"),
      asstCall("a1", "c1", "read", { path: "/settings.json" }),
      result("r1", "c1", "read", '{"port": 8080}'),
    ];
    const jsonl = entries.map((e) => JSON.stringify(e)).join("\n");
    file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, jsonl);
    const blocks = buildEvidenceBlocks(entries, "u1", file);
    // cut at u1 → covered span empty → no blocks
    expect(blocks).toBeNull();
    const blocks2 = buildEvidenceBlocks([...entries, user("u2", "and keep it")], "u2", file);
    expect(blocks2?.protected).toContain("make the port 8081");
    expect(blocks2?.evidence).toContain("L3");
    expect(blocks2?.evidence).toContain("settings.json");
  });

  it("falls back to protected-only when the session file is missing", () => {
    const entries = [user("u1", "hello"), user("u2", "world")];
    const blocks = buildEvidenceBlocks(entries, "u2", "/nonexistent/path.jsonl");
    expect(blocks?.protected).toContain("hello");
    expect(blocks?.evidence).toBeUndefined();
  });

  it("delivers fragments without pointers or a session file when recall is unavailable", () => {
    const entries = [
      user("u1", "make the port 8081"),
      asstCall("a1", "c1", "read", { path: "/settings.json" }),
      result("r1", "c1", "read", '{"port": 8080}'),
      user("u2", "and keep it"),
    ];
    const blocks = buildEvidenceBlocks(entries, "u2", null, false);
    expect(blocks?.protected).toContain("make the port 8081");
    expect(blocks?.evidence).toBeDefined();
    expect(blocks?.evidence).toContain("settings.json");
    expect(blocks?.evidence).toContain('{"port": 8080}');
    expect(blocks?.evidence).not.toContain("session_recall");
    expect(blocks?.evidence).not.toMatch(/\bL\d+/);
  });

  it("is fail-open on bad input", () => {
    expect(buildEvidenceBlocks([], "x", null)).toBeNull();
    expect(buildEvidenceBlocks([user("u1", "a")], "absent", null)).toBeNull();
  });
});
