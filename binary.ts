/**
 * binary.ts — binary-content detection, output suppression, and the read guard.
 *
 * Two layers keep raw binary bytes out of the context:
 *  - read guard: blocks read-tool calls on paths with known binary
 *    extensions (pdf, docx, zip, …) before execution, with a remediation
 *    hint. The read tool has no binary detection — it would dump raw bytes
 *    as garbled UTF-8 text into context.
 *  - output suppression: sniffs bash and read tool_result text for binary
 *    content and replaces it with a short summary — the safety net for
 *    misnamed or extension-less files (and unsupported image formats like
 *    tiff/heic, which the extension list deliberately does not name).
 *
 * Both layers are user-togglable (/gallop-binary, /gallop-read-guard),
 * persisted in the "gallop" namespace of settings-ext.json; session_start
 * reloads the toggles. Image formats handled natively by the read tool
 * (jpg/png/gif/webp/bmp) are never blocked — those attach correctly.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadExtSettings, patchExtSettings } from "./ext-settings";

/** Gallop's toggles live in the shared settings-ext.json ("gallop"
 *  namespace, defaults materialized on first load). */
export const GALLOP_DEFAULTS = { binarySuppression: true, readGuard: true };

let binarySuppressionEnabled = true;
let readGuardEnabled = true;

// ── Binary content detection ──

/** Result from binary content detection */
export interface BinaryDetectionResult {
  binary: boolean;
  reason: string;       // e.g. "contains null bytes" or "6.2% non-printable characters"
  nonPrintablePct: number;
}

/**
 * Detect binary content in bash/read output.
 * Checks for null bytes, high ratio of non-printable characters, and high
 * ratio of U+FFFD replacement characters (undecodable bytes — e.g. the read
 * tool decodes via buffer.toString("utf-8"), which mangles null-free binaries
 * into U+FFFD walls with no control characters left to flag).
 * Returns a result with detection reason for use in suppression messages.
 */
export function detectBinaryContent(text: string): BinaryDetectionResult {
  if (!text.length) return { binary: false, reason: "", nonPrintablePct: 0 };

  // Any null byte = binary (always, no percentage threshold)
  if (text.includes("\0")) {
    return { binary: true, reason: "contains null bytes", nonPrintablePct: 0 };
  }

  // Count non-printable chars (excluding normal whitespace \n \r \t) and
  // U+FFFD replacement chars (undecodable bytes)
  let nonPrintable = 0;
  let replacementChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Control chars 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, plus DEL (0x7F)
    // Allow: 0x09 (\t), 0x0A (\n), 0x0D (\r)
    if (code === 0xFFFD) {
      replacementChars++;
    } else if ((code >= 0x00 && code <= 0x08) ||
        code === 0x0B || code === 0x0C ||
        (code >= 0x0E && code <= 0x1F) ||
        code === 0x7F) {
      nonPrintable++;
    }
  }

  const pct = nonPrintable / text.length;
  if (pct > 0.05) {
    return { binary: true, reason: `${(pct * 100).toFixed(1)}% non-printable characters`, nonPrintablePct: pct };
  }

  const replacementPct = replacementChars / text.length;
  if (replacementPct > 0.05) {
    return { binary: true, reason: `${(replacementPct * 100).toFixed(1)}% replacement characters (invalid UTF-8)`, nonPrintablePct: 0 };
  }

  return { binary: false, reason: "", nonPrintablePct: pct };
}

// ── Read guard: binary file blocking ──

/** Result from matching a read path against known binary extensions */
export interface BinaryReadMatch {
  ext: string;
  hint: string;
}

/**
 * Binary extension groups → hint for the block message.
 * Image formats handled natively by the read tool (jpg/png/gif/webp/bmp) are
 * deliberately excluded — those attach correctly. Unsupported image formats
 * (tiff, heic, ...) are also excluded: pi may add native support without notice,
 * and the tool_result content sniff catches them safely in the meantime.
 */
const BINARY_READ_EXTENSION_GROUPS: [string[], string][] = [
  [[".pdf"], "Use the pdf skill (pdftotext, pdfinfo, etc.) to extract text"],
  [[".docx", ".doc"], "Use the docx skill"],
  [[".xlsx", ".xlsm", ".xls"], "Use the xlsx skill"],
  [[".pptx", ".ppt"], "Use the pptx skill"],
  [[".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war"], "Archive file — list/extract via bash (unzip -l, tar -tf, etc.)"],
  [[".sqlite", ".sqlite3", ".db"], "Database file — query via bash (sqlite3)"],
  [[".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".wasm", ".pyc", ".class"], "Compiled binary — inspect via bash (file, strings, objdump)"],
  [[".parquet", ".npy", ".npz", ".onnx", ".gguf", ".safetensors", ".ckpt", ".pt", ".pkl"], "Data/model file — inspect via bash with an appropriate CLI"],
  [[".mp3", ".wav", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm"], "Media file — inspect via bash (ffprobe, etc.)"],
  [[".ttf", ".otf", ".woff", ".woff2", ".eot"], "Font file — inspect via bash (fc-scan, etc.)"],
  [[".blend", ".sketch", ".fig"], "Design file — use an appropriate CLI via bash"],
  // Only .dwg and .3mf are blocked: they are always binary. ASCII-capable CAD
  // formats (.stl/.obj/.step/.iges/.dxf) are excluded — the read tool handles
  // their text variants fine, and the tool_result content sniff catches the
  // binary variants (e.g. binary STL, which always contains null bytes).
  [[".dwg", ".3mf"], "CAD file — use an appropriate CLI via bash"],
  [[".epub", ".mobi"], "E-book file — extract via bash (ebook-convert, pandoc)"],
];

/** Flat lookup: lowercase extension → hint */
const BINARY_READ_EXTENSIONS: Record<string, string> = Object.fromEntries(
  BINARY_READ_EXTENSION_GROUPS.flatMap(([exts, hint]) => exts.map((ext) => [ext, hint])),
);

/**
 * Match a read-tool path against known binary extensions.
 * Returns the matched extension and a remediation hint, or null for text files.
 * Case-insensitive; dotfiles without a real extension never match.
 */
export function matchBinaryReadPath(filePath: string): BinaryReadMatch | null {
  if (!filePath) return null;
  const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  // dotIndex <= 0: no extension, or dotfile like ".gitignore"
  if (dotIndex <= 0) return null;
  const ext = fileName.slice(dotIndex).toLowerCase();
  const hint = BINARY_READ_EXTENSIONS[ext];
  return hint ? { ext, hint } : null;
}

/** Read path from a read-tool input (accepts `path` or `file_path`). */
function readPathFromInput(input: unknown): string | undefined {
  const i = input as { path?: unknown; file_path?: unknown } | undefined;
  return typeof i?.path === "string"
    ? i.path
    : typeof i?.file_path === "string"
      ? i.file_path
      : undefined;
}

/** Read guard: block a read of a known binary path (with a remediation
 *  hint). Returns the block, or undefined when the call passes. */
export function guardRead(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
): { block: true; reason: string } | undefined {
  if (event.toolName !== "read" || !readGuardEnabled) return undefined;
  const readPath = readPathFromInput(event.input);
  if (!readPath) return undefined;
  const match = matchBinaryReadPath(readPath);
  if (!match) return undefined;
  if (ctx.hasUI) {
    ctx.ui.notify(`Gallop: blocked read of ${match.ext} file`, "warning");
  }
  return {
    block: true,
    reason: `[Gallop] Blocked read of binary file "${readPath}" (${match.ext}) — the read tool cannot handle binary files and would dump raw bytes as garbled text into context. ${match.hint}. (The user can disable this guard with /gallop-read-guard off.)`,
  };
}

/** Output suppression: replace binary bash/read output with a short summary.
 *  Returns the replacement content, or undefined when the result passes
 *  through (not bash/read, disabled, no text, or not binary). */
export function filterToolResult(
  event: { toolName: string; content: unknown; input: unknown },
): { content: { type: "text"; text: string }[] } | undefined {
  // bash: suppress binary command output. read: safety net for binary content
  // that slipped past the extension guard (misnamed or extension-less files,
  // unsupported image formats like tiff/heic). Image reads are safe — they
  // carry only a short printable text note.
  const isBash = event.toolName === "bash";
  const isRead = event.toolName === "read";
  if (!isBash && !isRead) return undefined;
  if (isBash && !binarySuppressionEnabled) return undefined;
  if (isRead && !readGuardEnabled) return undefined;

  const content = event.content;
  if (!Array.isArray(content)) return undefined;

  let fullText = "";
  for (const item of content) {
    if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
      fullText += item.text;
    }
  }

  if (!fullText.length) return undefined;

  const detection = detectBinaryContent(fullText);
  if (!detection.binary) return undefined;

  const summary = buildBinarySuppressionSummary(
    fullText,
    detection,
    isRead
      ? { kind: "read", path: readPathFromInput(event.input) ?? "<unknown>" }
      : { kind: "bash", command: (event.input as any)?.command },
  );

  return {
    content: [{
      type: "text",
      text: summary,
    }],
  };
}

/** The suppression summary the model sees instead of the raw bytes — a pure
 *  function of (fullText, detection, source): byte count + detection reason,
 *  the source line, a hex dump of the first 64 bytes, and the readable lines
 *  extracted from the mangled text (head + tail). */
export function buildBinarySuppressionSummary(
  fullText: string,
  detection: BinaryDetectionResult,
  source: { kind: "read"; path: string } | { kind: "bash"; command: string | undefined },
): string {
  const rawBytes = new TextEncoder().encode(fullText);
  const bytes = rawBytes.length;
  let sourceLine: string;
  if (source.kind === "read") {
    sourceLine = `Path: \`${source.path}\``;
  } else {
    const firstLine = typeof source.command === "string" ? source.command.split("\n")[0].trim() : "";
    const shortCommand = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : (firstLine || "<unknown>");
    sourceLine = `Command: \`${shortCommand}\``;
  }

  // Hex dump of first 64 bytes for debugging (safe ASCII only)
  const headBytes = rawBytes.slice(0, 64);
  const hexHead = Array.from(headBytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join(" ");

  // Strip control chars (except newlines/tabs) and U+FFFD replacement
  // chars to extract readable lines
  const cleaned = fullText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, "");
  const lines = cleaned.split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => l.replace(/\s+\d+%\s*/g, " ").replace(/\s+/g, " ").trim())
    .map(l => l.slice(0, 120));
  const headLines = lines.slice(0, 3);
  const tailLines = lines.length > 3 ? lines.slice(-5) : [];

  let summary = `[Gallop] Binary output suppressed — ${bytes.toLocaleString()} bytes (${detection.reason})\n${sourceLine}\nHead (hex): ${hexHead}`;
  if (headLines.length) summary += `\n> ${headLines.join("\n> ")}`;
  if (tailLines.length && lines.length > 3) {
    summary += `\n...\n> ${tailLines.join("\n> ")}`;
  }
  if (lines.length > 8) summary += `\n... (${lines.length} lines total)`;
  summary += "\nBinary content is hidden to protect context. The output was not sent to the model.";
  return summary;
}

// ── Toggles ──

/** session_start: reload the toggles from settings-ext.json. */
export function setToggles(settings: { binarySuppression?: boolean; readGuard?: boolean }): void {
  binarySuppressionEnabled = settings.binarySuppression !== false;
  readGuardEnabled = settings.readGuard !== false;
}

/** Register /gallop-binary and /gallop-read-guard. */
export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("gallop-binary", {
    description: "Toggle binary output suppression on/off. Pass 'on', 'off', or nothing to toggle.",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "enable") {
        binarySuppressionEnabled = true;
      } else if (arg === "off" || arg === "disable") {
        binarySuppressionEnabled = false;
      } else {
        binarySuppressionEnabled = !binarySuppressionEnabled;
      }
      patchExtSettings("gallop", { binarySuppression: binarySuppressionEnabled });
      const status = binarySuppressionEnabled ? "enabled" : "disabled";

      if (ctx.hasUI) {
        ctx.ui.notify(`Gallop: binary suppression ${status}`, binarySuppressionEnabled ? "info" : "warning");
      }
    },
  });

  pi.registerCommand("gallop-read-guard", {
    description: "Toggle read-guard (blocking reads of binary files like PDFs) on/off. Pass 'on', 'off', or nothing to toggle.",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "enable") {
        readGuardEnabled = true;
      } else if (arg === "off" || arg === "disable") {
        readGuardEnabled = false;
      } else {
        readGuardEnabled = !readGuardEnabled;
      }
      patchExtSettings("gallop", { readGuard: readGuardEnabled });
      const status = readGuardEnabled ? "enabled" : "disabled";

      if (ctx.hasUI) {
        ctx.ui.notify(`Gallop: read guard ${status}`, readGuardEnabled ? "info" : "warning");
      }
    },
  });
}
