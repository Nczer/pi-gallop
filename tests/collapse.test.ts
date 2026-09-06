import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  collapseRepetitiveText,
  setToggles,
  MIN_LINES,
  MIN_BYTES,
} from "../collapse";
import { filterToolResult, setToggles as setBinaryToggles } from "../binary";

// ── helpers ──

function lines(...l: string[]): string {
  return l.join("\n");
}

function repeated(line: string, n: number): string {
  return lines(...Array.from({ length: n }, () => line));
}

let seed = 42;
function rnd(): string {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff).toString(36).slice(2, 10);
}

/** 9/4 incident shape: unique per-line (path + line number), but a long
 *  shared tail (the matched string). 400 lines ≈ 38KB (above MIN_BYTES). */
function grepDump(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = i % 7 === 0 ? "flt-eval-method.h" : "struct_timeval.h";
    out.push(`./llama.cpp/build/src/CMakeFiles/llama.dir/compiler_depend.${i % 3}.${i}:550${i}: /usr/include/bits/${f}`);
  }
  return lines(...out);
}

/** Random lines with no shared 16-char substring. n=900 ≈ 38KB. */
function randomLines(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`row${i} ${rnd()} ${rnd()} ${rnd()} ${rnd()}`);
  }
  return lines(...out);
}

beforeEach(() => {
  seed = 42;
  setToggles({ repetitionCollapse: true });
  setBinaryToggles({ binarySuppression: true, readGuard: true });
});

afterEach(() => {
  setToggles({ repetitionCollapse: true });
  setBinaryToggles({ binarySuppression: true, readGuard: true });
});

// ── gates: too small / disabled ──

describe("collapseRepetitiveText gates", () => {
  it("returns null below MIN_LINES", () => {
    expect(collapseRepetitiveText(repeated("same line here", MIN_LINES - 1))).toBeNull();
  });

  it("returns null below MIN_BYTES even with many identical lines", () => {
    // 800 lines × 38 chars ≈ 30KB, just under the gate
    const t = repeated("a line of moderate length here ok", 800);
    expect(new TextEncoder().encode(t).length).toBeLessThan(MIN_BYTES);
    expect(collapseRepetitiveText(t)).toBeNull();
  });

  it("returns null when disabled", () => {
    setToggles({ repetitionCollapse: false });
    expect(collapseRepetitiveText(repeated("same line here that is long enough to count", 1000))).toBeNull();
  });

  it("returns null on empty text", () => {
    expect(collapseRepetitiveText("")).toBeNull();
  });
});

// ── stage A: exact-line repetition ──

describe("collapseRepetitiveText stage A (exact lines)", () => {
  it("collapses a wall of identical lines", () => {
    const res = collapseRepetitiveText(repeated("ERROR: connection refused (port 8080)", 1000));
    expect(res).not.toBeNull();
    const t = res!.text;
    expect(t).toContain("1000 lines, 1000 repetitive");
    expect(t).toContain("ERROR: connection refused (port 8080)");
    expect(t).toContain("995 more lines share the pattern");
    // header + head 3 + ellipsis + tail 2 + hint = 8 lines total
    expect(t.split("\n").length).toBe(8);
  });

  it("collapses repeated error blocks with a few unique lines", () => {
    const body = repeated("segfault at 0x0 (rip 0x7f00) in thread main", 720);
    const t = body + "\nfirst unique line\nlast unique line";
    const res = collapseRepetitiveText(t);
    expect(res).not.toBeNull();
    expect(res!.text).toContain("722 lines, 720 repetitive");
    expect(res!.text).toContain("plus 2 other lines");
    expect(res!.stats.groupLines).toBe(720);
    expect(res!.stats.restLines).toBe(2);
  });

  it("keeps head and tail examples and reports the rest", () => {
    const t = lines("A head line", ...repeated("dup line for stage A that is long enough to count bytes", 600).split("\n"), "Z tail line");
    const res = collapseRepetitiveText(t);
    expect(res).not.toBeNull();
    const shown = res!.text;
    // header pattern + head 3 + tail 2 examples
    expect(shown.match(/dup line for stage A/g)!.length).toBe(6);
    expect(shown).toContain("plus 2 other lines");
  });

  it("does not collapse when top repeated lines cover < 50%", () => {
    // 400 copies of one line + 401 unique lines = 400/801 < 50%
    const uniq = Array.from({ length: 401 }, (_, i) => `unique row number ${i} ${i * 7} ${i * 13}`)
      .map((l, i) => l + " x".repeat(i % 5)).join("\n");
    const t = repeated("one repeated line that is long enough to count", 400) + "\n" + uniq;
    expect(collapseRepetitiveText(t)).toBeNull();
  });
});

// ── stage B: long shared region (grep dump) ──

describe("collapseRepetitiveText stage B (shingle span)", () => {
  it("collapses a grep dump with unique lines but long shared regions", () => {
    const res = collapseRepetitiveText(grepDump(400));
    expect(res).not.toBeNull();
    const t = res!.text;
    expect(t).toContain("400 lines");
    expect(t).toContain("repetitive (pattern: ");
    // The 44-char shared prefix dominates the group (every line has it);
    // the shared tail would have grouped ~86% on its own.
    expect(res!.stats.groupLines).toBe(400);
    expect(t).toContain("more lines share the pattern");
    // pi note absent → re-run hint
    expect(t).toContain("no full-output file");
  });

  it("preserves pi's truncation note (full-output path) verbatim", () => {
    const note = "[Showing lines 3709-4113 of 4113 (50.0KB limit). Full output: /tmp/pi-bash-7e381cb2cb2f55e3.log]";
    const res = collapseRepetitiveText(grepDump(400) + "\n" + note);
    expect(res).not.toBeNull();
    const t = res!.text;
    expect(t.endsWith(note)).toBe(true);
    expect(t).not.toContain("no full-output file");
  });

  it("clips long example lines", () => {
    const longLine = "x".repeat(200);
    const res = collapseRepetitiveText(repeated(longLine, 200));
    expect(res).not.toBeNull();
    // Example lines are clipped; the header carries the (also clipped) pattern.
    for (const l of res!.text.split("\n").slice(1)) {
      expect(l.length).toBeLessThanOrEqual(120);
    }
  });

  it("does not collapse a short shared label with a long unique middle", () => {
    // "npm WARN deprecated " (20-char label, span < MIN_SPAN) + 60-char
    // unique middle: one repeated region only — no distant pair, and the
    // unique middle is the information.
    const t = lines(...Array.from({ length: 400 }, (_, i) => {
      let mid = "";
      for (let k = 0; k < 6; k++) mid += rnd() + "-";
      return `npm WARN deprecated pkg-${i}@1.0.0:${mid}`;
    }));
    expect(new TextEncoder().encode(t).length).toBeGreaterThan(MIN_BYTES);
    expect(collapseRepetitiveText(t)).toBeNull();
  });

  it("collapses templated lines where boilerplate dominates (unique middle is short)", () => {
    // The information (package name, ~15 chars) is small against the shared
    // prefix + long shared suffix: the count + examples + re-run hint is the
    // useful view, so collapsing is the right call.
    const t = lines(...Array.from({ length: 400 }, (_, i) =>
      `npm WARN deprecated pkg-${i}@${i}.1.${i % 9}: use the latest version of this package now`));
    expect(new TextEncoder().encode(t).length).toBeGreaterThan(MIN_BYTES);
    const res = collapseRepetitiveText(t);
    expect(res).not.toBeNull();
    expect(res!.stats.groupLines).toBe(400);
  });

  it("does not collapse genuinely varied output", () => {
    expect(collapseRepetitiveText(randomLines(900))).toBeNull();
  });

  it("does not collapse short-match grep output (the file:line IS the information)", () => {
    // grep -rn "TODO" → 23-char shared tail (span < MIN_SPAN), unique
    // file:line prefix. 800 lines ≈ 36KB (above the gate, so this really
    // tests the stage-B logic, not the byte gate).
    const t = lines(...Array.from({ length: 800 }, (_, i) => `src/module${i % 40}/file${i}.c:${i}: // TODO fix this later`));
    expect(new TextEncoder().encode(t).length).toBeGreaterThan(MIN_BYTES);
    expect(collapseRepetitiveText(t)).toBeNull();
  });
});

// ── filterToolResult integration ──

describe("filterToolResult integration", () => {
  const ev = (toolName: string, text: string, input?: unknown) => ({
    toolName,
    content: [{ type: "text", text }],
    input,
  });

  it("replaces repetitive bash output", () => {
    const r = filterToolResult(ev("bash", grepDump(400), { command: "grep -r struct_timeval ./build" }));
    expect(r).toBeDefined();
    expect(r!.content[0].text).toContain("[Gallop] Collapsed repetitive output");
  });

  it("replaces repetitive read output", () => {
    const r = filterToolResult(ev("read", repeated("log line: nothing to report here", 1200), { path: "/var/log/app.log" }));
    expect(r).toBeDefined();
    expect(r!.content[0].text).toContain("[Gallop] Collapsed repetitive output");
  });

  it("passes through non-repetitive output", () => {
    expect(filterToolResult(ev("bash", randomLines(900)))).toBeUndefined();
  });

  it("ignores tools other than bash/read", () => {
    expect(filterToolResult(ev("grep", repeated("same line here that is long enough to count", 1000)))).toBeUndefined();
  });

  it("lets the binary summary take precedence over collapse", () => {
    const binary = "header\n" + "\0".repeat(5000) + "\nfooter";
    const r = filterToolResult(ev("bash", binary));
    expect(r).toBeDefined();
    expect(r!.content[0].text).toContain("[Gallop] Binary output suppressed");
  });

  it("still collapses when binary suppression is off (independent toggles)", () => {
    setBinaryToggles({ binarySuppression: false, readGuard: true });
    const r = filterToolResult(ev("bash", grepDump(400), { command: "grep -r x ./build" }));
    expect(r).toBeDefined();
    expect(r!.content[0].text).toContain("[Gallop] Collapsed repetitive output");
  });

  it("skips collapse when its toggle is off", () => {
    setToggles({ repetitionCollapse: false });
    expect(filterToolResult(ev("bash", grepDump(400), { command: "grep -r x ./build" }))).toBeUndefined();
  });

  it("skips collapse for small repetitive results", () => {
    expect(filterToolResult(ev("bash", repeated("small", 30)))).toBeUndefined();
  });
});
