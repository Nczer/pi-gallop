/**
 * ext-settings.ts — single owner of this extension's namespace in
 * ~/.pi/agent/settings-ext.json — the one shared settings file for all
 * extensions (pi owns settings.json; extensions never write into it).
 *
 * Semantics:
 *  • The extension's namespace object is merged per key over the passed
 *    defaults; nested plain objects merge recursively (a partial object in
 *    the file never clobbers the other defaults).
 *  • Defaults are materialized: keys missing from the file are written back
 *    on first read, so every option is visible and editable in the file.
 *  • Corrupt file (bad JSON or non-object top level) → copied to <file>.bak
 *    and defaults apply — user settings are preserved, never silently
 *    discarded.
 *  • patchExtSettings merges a patch into the own namespace; other
 *    extensions' namespaces are preserved.
 *
 * `filePath` is a test seam (defaults to the production path).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings-ext.json");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Per-key merge: file values win; nested plain objects merge recursively.
 *  Keys the file has but the defaults don't are preserved (never drop user
 *  data on materialization). */
function merge(defaults: Record<string, unknown>, file: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...file };
  for (const [k, d] of Object.entries(defaults)) {
    const f = file[k];
    out[k] = isPlainObject(d) && isPlainObject(f) ? merge(d, f) : f === undefined ? d : f;
  }
  return out;
}

function backupCorrupt(filePath: string): void {
  try {
    fs.copyFileSync(filePath, filePath + ".bak");
  } catch {
    /* best effort — defaults still apply */
  }
}

function readWhole(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    backupCorrupt(filePath);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    /* fall through to backup */
  }
  backupCorrupt(filePath);
  return {};
}

function writeWhole(filePath: string, file: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n");
  } catch {
    /* write failure: the in-memory values still apply */
  }
}

/**
 * Read this extension's namespace merged over its defaults (per key,
 * recursively), and materialize missing keys back into the file so every
 * option is visible there.
 */
export function loadExtSettings<T extends object>(
  namespace: string,
  defaults: T,
  filePath: string = SETTINGS_PATH,
): T {
  const file = readWhole(filePath);
  const raw = file[namespace];
  const mine = merge(defaults as Record<string, unknown>, isPlainObject(raw) ? raw : {}) as T;
  if (JSON.stringify(file[namespace]) !== JSON.stringify(mine)) {
    writeWhole(filePath, { ...file, [namespace]: mine });
  }
  return mine;
}

/** Merge a patch into this extension's namespace (other namespaces preserved). */
export function patchExtSettings(
  namespace: string,
  patch: Record<string, unknown>,
  filePath: string = SETTINGS_PATH,
): void {
  const file = readWhole(filePath);
  const raw = file[namespace];
  const mine: Record<string, unknown> = { ...(isPlainObject(raw) ? raw : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete mine[k];
    else mine[k] = v;
  }
  writeWhole(filePath, { ...file, [namespace]: mine });
}
