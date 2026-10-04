/**
 * ext-settings.test.ts — patchExtSettings persistence invariant: a patch that
 * resolves to what the file already says must not rewrite settings-ext.json.
 * `filePath` is the test seam, so the real file is never touched.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchExtSettings } from "../ext-settings";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gallop-ext-settings-"));
  file = join(dir, "settings-ext.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("patchExtSettings", () => {
  it("writes the patch and preserves other namespaces", () => {
    writeFileSync(file, JSON.stringify({ halter: { enabled: true } }));
    patchExtSettings("gallop", { readGuard: true }, file);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.gallop).toEqual({ readGuard: true });
    expect(raw.halter).toEqual({ enabled: true });
  });

  it("leaves the file untouched when the patch changes nothing", async () => {
    writeFileSync(file, JSON.stringify({ gallop: { readGuard: true }, halter: { enabled: true } }));
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    patchExtSettings("gallop", { readGuard: true }, file);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("leaves the file untouched when an undefined-valued patch matches an absent namespace", async () => {
    writeFileSync(file, JSON.stringify({ halter: { enabled: true } }));
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    patchExtSettings("gallop", { readGuard: undefined }, file);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(JSON.parse(readFileSync(file, "utf8")).gallop).toBeUndefined();
  });
});
