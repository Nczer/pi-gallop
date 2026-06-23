import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	formatTokens,
	normalizeCommand,
	extractErrorFingerprint,
	normalizeToolArgs,
	lastItemIsThinking,
	lastItemIsToolUse,
	pruneFailureHistory,
} from "../index";

// ── formatTokens ──

describe("formatTokens", () => {
	it("returns raw number under 1000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(512)).toBe("512");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats thousands as X.Xk", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(42300)).toBe("42.3k");
		expect(formatTokens(999999)).toBe("1000.0k");
	});

	it("formats millions as X.XM", () => {
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatTokens(128_000_000)).toBe("128.0M");
		expect(formatTokens(200_000_100)).toBe("200.0M");
	});
});

// ── normalizeCommand ──

describe("normalizeCommand", () => {
	it("collapses multiple spaces", () => {
		expect(normalizeCommand("ls    -la")).toBe("ls -la");
	});

	it("trims leading and trailing whitespace", () => {
		expect(normalizeCommand("  ls -la  ")).toBe("ls -la");
	});

	it("lowercases the command", () => {
		expect(normalizeCommand("LS -LA")).toBe("ls -la");
	});

	it("handles multiline commands", () => {
		expect(normalizeCommand("npm install\n&& npm run build")).toBe("npm install && npm run build");
	});

	it("strips empty lines from multiline input", () => {
		expect(normalizeCommand("ls\n\n\n-la")).toBe("ls -la");
	});

	it("normalizes \\r\\n line endings", () => {
		expect(normalizeCommand("ls\r\n-la")).toBe("ls -la");
	});

	it("normalizes \\r line endings", () => {
		expect(normalizeCommand("ls\r-la")).toBe("ls -la");
	});

	it("collapses tab to space", () => {
		expect(normalizeCommand("ls\t-la")).toBe("ls -la");
	});

	it("handles empty string", () => {
		expect(normalizeCommand("")).toBe("");
	});

	it("handles whitespace-only string", () => {
		expect(normalizeCommand("   \n  \t  ")).toBe("");
	});
});

// ── extractErrorFingerprint ──

describe("extractErrorFingerprint", () => {
	it("extracts last line from text content array", () => {
		const result = {
			content: [
				{ type: "text", text: "some output" },
				{ type: "text", text: "error: permission denied" },
			],
		};
		expect(extractErrorFingerprint(result)).toBe("error: permission denied");
	});

	it("ignores non-text content blocks", () => {
		const result = {
			content: [
				{ type: "image", source: { type: "base64", data: "abc" } },
				{ type: "text", text: "bash: command not found" },
			],
		};
		expect(extractErrorFingerprint(result)).toBe("bash: command not found");
	});

	it("falls back to output string", () => {
		const result = { output: "fatal: not a git repository" };
		expect(extractErrorFingerprint(result)).toBe("fatal: not a git repository");
	});

	it("falls back to plain string result", () => {
		expect(extractErrorFingerprint("connection refused")).toBe("connection refused");
	});

	it("returns 'unknown' for null/undefined", () => {
		expect(extractErrorFingerprint(null)).toBe("unknown");
		expect(extractErrorFingerprint(undefined)).toBe("unknown");
	});

	it("returns 'empty-output' for empty text", () => {
		const result = { content: [{ type: "text", text: "" }] };
		expect(extractErrorFingerprint(result)).toBe("empty-output");
	});

	it("returns 'empty-output' for whitespace-only text", () => {
		const result = { content: [{ type: "text", text: "   \n  \n  " }] };
		expect(extractErrorFingerprint(result)).toBe("empty-output");
	});

	it("lowercases the fingerprint", () => {
		const result = { content: [{ type: "text", text: "ERROR: Permission Denied" }] };
		expect(extractErrorFingerprint(result)).toBe("error: permission denied");
	});

	it("truncates long lines to 120 characters", () => {
		const longLine = "a".repeat(200);
		const result = { content: [{ type: "text", text: longLine }] };
		const fp = extractErrorFingerprint(result);
		expect(fp.length).toBe(120);
		expect(fp).toBe("a".repeat(120));
	});

	it("strips empty lines from multiline output before taking last line", () => {
		const result = { content: [{ type: "text", text: "line1\n\n\n  \nline2\nerror: actual error" }] };
		expect(extractErrorFingerprint(result)).toBe("error: actual error");
	});

	it("returns 'empty-output' for result with no extractable content", () => {
		expect(extractErrorFingerprint({})).toBe("empty-output");
	});
});

// ── normalizeToolArgs ──

describe("normalizeToolArgs", () => {
	it("fingerprints read tool by path", () => {
		expect(normalizeToolArgs("read", { path: "/some/file.ts" })).toBe("/some/file.ts");
	});

	it("normalizes backslashes in read paths", () => {
		expect(normalizeToolArgs("read", { path: "C:\\Users\\test\\file.ts" })).toBe("C:/Users/test/file.ts");
	});

	it("fingerprints bash tool by normalized command", () => {
		expect(normalizeToolArgs("bash", { command: "  LS   -LA  " })).toBe("ls -la");
	});

	it("handles missing path for read tool", () => {
		expect(normalizeToolArgs("read", {})).toBe("");
	});

	it("includes offset and limit in read fingerprint", () => {
		expect(normalizeToolArgs("read", { path: "/some/file.ts", offset: 10, limit: 20 })).toBe("/some/file.ts:o=10:l=20");
	});

	it("differs when offset changes", () => {
		const fp1 = normalizeToolArgs("read", { path: "file.ts", offset: 10, limit: 20 });
		const fp2 = normalizeToolArgs("read", { path: "file.ts", offset: 30, limit: 20 });
		expect(fp1).not.toBe(fp2);
	});

	it("handles offset without limit", () => {
		expect(normalizeToolArgs("read", { path: "x", offset: 5 })).toBe("x:o=5:l=");
	});

	it("handles limit without offset", () => {
		expect(normalizeToolArgs("read", { path: "x", limit: 100 })).toBe("x:o=:l=100");
	});

	it("handles missing command for bash tool", () => {
		expect(normalizeToolArgs("bash", {})).toBe("");
	});

	it("produces stable sorted JSON for other tools", () => {
		const fp1 = normalizeToolArgs("edit", { path: "a.txt", content: "hi" });
		const fp2 = normalizeToolArgs("edit", { content: "hi", path: "a.txt" });
		expect(fp1).toBe(fp2);
	});

	it("returns '{}' for null args", () => {
		expect(normalizeToolArgs("read", null)).toBe("{}");
		expect(normalizeToolArgs("bash", undefined)).toBe("{}");
	});

	it("returns '{}' for non-object args", () => {
		expect(normalizeToolArgs("read", "string")).toBe("{}");
		expect(normalizeToolArgs("bash", 42)).toBe("{}");
	});
});

// ── lastItemIsThinking ──

describe("lastItemIsThinking", () => {
	it("returns true when last content item is thinking type", () => {
		const msg = { content: [{ type: "text", text: "hello" }, { type: "thinking", thinking: "..." }] };
		expect(lastItemIsThinking(msg)).toBe(true);
	});

	it("returns false when last item is not thinking", () => {
		const msg = { content: [{ type: "text", text: "hello" }] };
		expect(lastItemIsThinking(msg)).toBe(false);
	});

	it("returns false for empty content", () => {
		expect(lastItemIsThinking({ content: [] })).toBe(false);
	});

	it("returns false for string content", () => {
		expect(lastItemIsThinking({ content: "hello" })).toBe(false);
	});

	it("returns false for missing content", () => {
		expect(lastItemIsThinking({})).toBe(false);
	});
});

// ── lastItemIsToolUse ──

describe("lastItemIsToolUse", () => {
	it("returns true when last content item is tool_use type", () => {
		const msg = {
			content: [
				{ type: "text", text: "let me check" },
				{ type: "tool_use", name: "read", input: { path: "x" } },
			],
		};
		expect(lastItemIsToolUse(msg)).toBe(true);
	});

	it("returns false when last item is not tool_use", () => {
		const msg = { content: [{ type: "thinking", thinking: "..." }] };
		expect(lastItemIsToolUse(msg)).toBe(false);
	});

	it("returns false for empty content", () => {
		expect(lastItemIsToolUse({ content: [] })).toBe(false);
	});

	it("returns false for string content", () => {
		expect(lastItemIsToolUse({ content: "hello" })).toBe(false);
	});

	it("returns false for missing content", () => {
		expect(lastItemIsToolUse({})).toBe(false);
	});
});

// ── pruneFailureHistory ──

describe("pruneFailureHistory", () => {
	it("removes entries older than the window", () => {
		const history = [
			{ command: "ls", fingerprint: "err", turnIndex: 1, timestamp: 100 },
			{ command: "ls", fingerprint: "err", turnIndex: 5, timestamp: 200 },
			{ command: "ls", fingerprint: "err", turnIndex: 8, timestamp: 300 },
		];
		pruneFailureHistory(history, 10, 5);
		// cutoff = 10 - 5 = 5; entries with turnIndex < 5 are pruned
		expect(history).toHaveLength(2);
		expect(history[0].turnIndex).toBe(5);
		expect(history[1].turnIndex).toBe(8);
	});

	it("removes nothing when all entries are within the window", () => {
		const history = [
			{ command: "ls", fingerprint: "err", turnIndex: 6, timestamp: 100 },
			{ command: "ls", fingerprint: "err", turnIndex: 8, timestamp: 200 },
		];
		pruneFailureHistory(history, 10, 5);
		expect(history).toHaveLength(2);
	});

	it("handles empty history", () => {
		const history: { turnIndex: number }[] = [];
		pruneFailureHistory(history, 10, 5);
		expect(history).toHaveLength(0);
	});

	it("removes all entries when all are outside the window", () => {
		const history = [
			{ command: "ls", fingerprint: "err", turnIndex: 1, timestamp: 100 },
			{ command: "ls", fingerprint: "err", turnIndex: 2, timestamp: 200 },
		];
		pruneFailureHistory(history, 10, 5);
		expect(history).toHaveLength(0);
	});

	it("treats entry at exact cutoff as within window", () => {
		const history = [
			{ command: "ls", fingerprint: "err", turnIndex: 5, timestamp: 100 },
		];
		pruneFailureHistory(history, 10, 5);
		// cutoff = 10 - 5 = 5, and 5 < 5 is false, so it stays
		expect(history).toHaveLength(1);
	});
});
