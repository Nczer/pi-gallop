/**
 * collapse.ts — repetitive-text output collapse for bash/read tool results.
 *
 * binary.ts catches the other half of the same failure: huge *text* output
 * dominated by repeated line shapes — grep/find over a build tree
 * (thousands of "file:line: MATCH" lines sharing the matched string),
 * repeated build/log lines, repeated error blocks. Pi's truncation (2000
 * lines / 50KB) still injects ~12k tokens of near-duplicates, and in the
 * field that has wrecked sessions outright (the model stops responding —
 * two incidents: 2026-06-25, 2026-09-04).
 *
 * Two detection stages, both conservative (a miss is free; a wrong collapse
 * destroys information):
 *
 *  A. exact-line frequency — the top EXACT_TOP_LINES literal lines cover
 *     ≥ GROUP_COVER of all lines. Identical content carries no per-line
 *     information, so collapsing is always safe (handles repeated error
 *     blocks, repeated log lines — including short lines).
 *
 *  B. shingle span — 16-char shingles (stride 8) are counted over an
 *     evenly-spaced 50-line sample; shingles covering ≥ CANDIDATE_COVER of
 *     the sample become candidates. The collapse fires only when TWO
 *     candidates occur at least MIN_SPAN apart inside one sample line —
 *     i.e. the lines share a LONG common region (≥ ~32 chars), so most of
 *     the line is boilerplate (the grep case: the matched string is the
 *     dominant content). This is what keeps templated output with a short
 *     shared label ("npm WARN deprecated <pkg>…") intact: the repeated
 *     region there is the label, and the per-line information (the package
 *     name) is what the user came for.
 *
 * When triggered, the result is collapsed to head/tail examples + a count.
 * Pi's truncation note (full-output temp path) is preserved when present so
 * the model can drill in via bash; without it, the note tells the model to
 * re-run with head/tail/grep.
 *
 * User-togglable (/gallop-collapse), persisted in the "gallop" namespace of
 * settings-ext.json like the binary toggles.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchExtSettings } from "./ext-settings";

let collapseEnabled = true;

/** Below this many lines the result cannot pollute the context. */
export const MIN_LINES = 80;
/** Below this many bytes (~7.5k tokens) the cost of leaving it is small
 *  enough that collapsing — which is lossy — is not justified. 30KB is the
 *  disaster band (pi's own truncation cap is 50KB): a grep dump over a build
 *  tree, a repeated error wall. Smaller templated output (ls -l, a few
 *  hundred npm WARNs) stays readable and passes through. */
export const MIN_BYTES = 30_720;
/** Evenly-spaced sample size for shingle counting (stage B). */
export const SAMPLE_SIZE = 50;
export const SHINGLE_LEN = 16;
export const SHINGLE_STRIDE = 8;
/** A shingle must appear in ≥ this fraction of sampled lines to be a candidate. */
export const CANDIDATE_COVER = 0.35;
/** Max shingle candidates considered (stage B). */
export const MAX_SHINGLE_CANDIDATES = 10;
/** Two candidates must co-occur at least this far apart in one line —
 *  the repeated region must span ≥ ~2·SHINGLE_LEN chars (stage B). */
export const MIN_SPAN = 16;
/** Stage A: how many literal lines count toward the coverage. */
export const EXACT_TOP_LINES = 8;
/** The dominant group must cover ≥ this fraction of ALL lines to collapse. */
export const GROUP_COVER = 0.5;
export const MAX_EXAMPLE_HEAD = 3;
export const MAX_EXAMPLE_TAIL = 2;
export const MAX_REST_EXAMPLES = 2;
/** Each example line is clipped to this many chars. */
export const MAX_LINE_LEN = 120;
/** Stage A pattern display is clipped tighter (it is a whole line). */
export const MAX_PATTERN_LEN = 60;
/** Safety: never emit a collapse that saves less than half the bytes. */
export const MIN_SHRINK = 0.5;

/** Pi's truncation footer, e.g. "[Showing lines 3709-4113 of 4113 (50.0KB limit). Full output: /tmp/pi-bash-xxx.log]". */
const FULL_OUTPUT_NOTE = /^\[.*Full output: \S+\.log\]$/;

export interface CollapseStats {
  totalLines: number;
  groupLines: number;
  restLines: number;
  outLines: number;
}

interface GroupHit {
  group: string[];
  rest: string[];
  pattern: string;
}

const clip = (l: string, max: number) => (l.length > max ? l.slice(0, max - 1) + "…" : l);

/** Stage A: top literal lines dominate the output. Lines that appear once
 *  are by definition not repetitive and never join the group (without this
 *  guard a few unique lines would inflate the top-N coverage to 100%). */
function exactLineCollapse(lines: string[]): GroupHit | null {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const top = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, EXACT_TOP_LINES);
  const covered = top.reduce((s, [, c]) => s + c, 0);
  if (covered / lines.length < GROUP_COVER) return null;
  const topSet = new Set(top.map(([l]) => l));
  const group: string[] = [];
  const rest: string[] = [];
  for (const l of lines) (topSet.has(l) ? group : rest).push(l);
  return { group, rest, pattern: clip(top[0][0].trim() || "(blank)", MAX_PATTERN_LEN) };
}

/** Stage B: a long common region across most lines (frequent shingle pair
 *  at least MIN_SPAN apart in one line). */
function shingleCollapse(lines: string[]): GroupHit | null {
  const sample: string[] = [];
  for (let i = 0; i < SAMPLE_SIZE && i < lines.length; i++) {
    sample.push(lines[Math.floor((i * lines.length) / SAMPLE_SIZE)]);
  }

  // Shingle census over the sample (per-line dedupe: a shingle repeated
  // inside one line counts once).
  const counts = new Map<string, number>();
  for (const line of sample) {
    if (line.length < SHINGLE_LEN) continue;
    const seen = new Set<string>();
    for (let i = 0; i + SHINGLE_LEN <= line.length; i += SHINGLE_STRIDE) {
      const s = line.slice(i, i + SHINGLE_LEN);
      if (!seen.has(s)) {
        seen.add(s);
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
  }

  const candidates = [...counts.entries()]
    .filter(([, c]) => c / sample.length >= CANDIDATE_COVER)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SHINGLE_CANDIDATES)
    .map(([s]) => s);
  if (candidates.length < 2) return null;

  // A pair with a distant co-occurrence in one sample line ⇒ a long common
  // region. First/last-occurrence extremes bound all pairwise distances.
  let pair: [string, string] | null = null;
  outer: for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      for (const line of sample) {
        const a = line.indexOf(candidates[i]);
        if (a < 0) continue;
        const b = line.indexOf(candidates[j]);
        if (b < 0) continue;
        const aL = line.lastIndexOf(candidates[i]);
        const bL = line.lastIndexOf(candidates[j]);
        const maxDist = Math.max(Math.abs(a - b), Math.abs(a - bL), Math.abs(aL - b), Math.abs(aL - bL));
        if (maxDist >= MIN_SPAN) {
          pair = [candidates[i], candidates[j]];
          break outer;
        }
      }
    }
  }
  if (!pair) return null;

  const [pa, pb] = pair;
  const group: string[] = [];
  const rest: string[] = [];
  for (const l of lines) (l.includes(pa) || l.includes(pb) ? group : rest).push(l);
  if (group.length / lines.length < GROUP_COVER) return null;
  return { group, rest, pattern: pa.replace(/["\\\n]/g, "") };
}

/** Collapse repetitive text output. Returns null when the text passes
 *  through unchanged (disabled, too small, not repetitive, or no shrink). */
export function collapseRepetitiveText(text: string): { text: string; stats: CollapseStats } | null {
  if (!collapseEnabled) return null;

  // Pi's truncation note (full-output temp path) must survive the collapse —
  // extract it from the tail before line accounting.
  let note = "";
  let body = text;
  const lastNl = text.lastIndexOf("\n");
  const lastLine = (lastNl >= 0 ? text.slice(lastNl + 1) : text).trim();
  if (FULL_OUTPUT_NOTE.test(lastLine)) {
    note = lastLine;
    body = lastNl >= 0 ? text.slice(0, lastNl + 1) : "";
  }

  const lines = body.split("\n");
  if (lines.length < MIN_LINES) return null;
  if (new TextEncoder().encode(body).length < MIN_BYTES) return null;

  const hit = exactLineCollapse(lines) ?? shingleCollapse(lines);
  if (!hit) return null;
  const { group, rest, pattern } = hit;

  const groupHead = group.slice(0, MAX_EXAMPLE_HEAD);
  const groupTail = group.length > MAX_EXAMPLE_HEAD + MAX_EXAMPLE_TAIL ? group.slice(-MAX_EXAMPLE_TAIL) : [];
  const restHead = rest.slice(0, MAX_REST_EXAMPLES);

  const out: string[] = [];
  out.push(`[Gallop] Collapsed repetitive output: ${lines.length} lines, ${group.length} repetitive (pattern: "${pattern}")`);
  out.push(...groupHead.map((l) => clip(l, MAX_LINE_LEN)));
  if (group.length > groupHead.length + groupTail.length) {
    out.push(`  … ${group.length - groupHead.length - groupTail.length} more lines share the pattern`);
  }
  out.push(...groupTail.map((l) => clip(l, MAX_LINE_LEN)));
  if (rest.length) {
    out.push(`  plus ${rest.length} other lines:`);
    out.push(...restHead.map((l) => "  " + clip(l, MAX_LINE_LEN)));
  }
  if (note) {
    out.push(note);
  } else {
    out.push("  (no full-output file — re-run with head/tail/grep to inspect specifics)");
  }

  const collapsed = out.join("\n");
  // Safety net: if the "collapsed" form is not at least half the size, the
  // distortion is not worth it.
  if (collapsed.length >= text.length * MIN_SHRINK) return null;

  return {
    text: collapsed,
    stats: { totalLines: lines.length, groupLines: group.length, restLines: rest.length, outLines: out.length },
  };
}

/** session_start: reload the toggle from settings-ext.json. */
export function setToggles(settings: { repetitionCollapse?: boolean }): void {
  collapseEnabled = settings.repetitionCollapse !== false;
}

/** Register /gallop-collapse. */
export function registerCommand(pi: ExtensionAPI): void {
  pi.registerCommand("gallop-collapse", {
    description: "Toggle repetitive-output collapse on/off. Pass 'on', 'off', or nothing to toggle.",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "enable") {
        collapseEnabled = true;
      } else if (arg === "off" || arg === "disable") {
        collapseEnabled = false;
      } else {
        collapseEnabled = !collapseEnabled;
      }
      patchExtSettings("gallop", { repetitionCollapse: collapseEnabled });
      const status = collapseEnabled ? "enabled" : "disabled";
      if (ctx.hasUI) {
        ctx.ui.notify(`Gallop: repetitive-output collapse ${status}`, collapseEnabled ? "info" : "warning");
      }
    },
  });
}
