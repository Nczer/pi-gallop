import { describe, expect, it } from "vitest";
import { matchBinaryReadPath } from "../binary";

// ── matchBinaryReadPath ──

describe("matchBinaryReadPath", () => {
  it("matches .pdf with pdf skill hint", () => {
    const match = matchBinaryReadPath("/home/user/report.pdf");
    expect(match).not.toBeNull();
    expect(match!.ext).toBe(".pdf");
    expect(match!.hint).toContain("pdf skill");
  });

  it("matches office formats with their skill hints", () => {
    expect(matchBinaryReadPath("docs/slides.pptx")!.hint).toContain("pptx skill");
    expect(matchBinaryReadPath("data/sheet.xlsx")!.hint).toContain("xlsx skill");
    expect(matchBinaryReadPath("letter.docx")!.hint).toContain("docx skill");
  });

  it("is case-insensitive", () => {
    expect(matchBinaryReadPath("REPORT.PDF")).not.toBeNull();
    expect(matchBinaryReadPath("Archive.ZIP")).not.toBeNull();
  });

  it("handles windows-style paths", () => {
    const match = matchBinaryReadPath("C:\\Users\\me\\report.pdf");
    expect(match).not.toBeNull();
    expect(match!.ext).toBe(".pdf");
  });

  it("matches archives, databases, and compiled binaries", () => {
    expect(matchBinaryReadPath("backup.tar.gz")).not.toBeNull();
    expect(matchBinaryReadPath("app.sqlite")).not.toBeNull();
    expect(matchBinaryReadPath("module.wasm")).not.toBeNull();
    expect(matchBinaryReadPath("lib.dll")).not.toBeNull();
  });

  it("blocks always-binary CAD formats", () => {
    expect(matchBinaryReadPath("drawing.dwg")).not.toBeNull();
    expect(matchBinaryReadPath("model.3mf")).not.toBeNull();
  });

  it("passes ASCII-capable CAD formats — Layer 2 content sniff handles binary variants", () => {
    // STL/OBJ/STEP/IGES/DXF are frequently plain text that the read tool
    // handles fine; binary variants (e.g. binary STL) are caught at
    // tool_result by the null-byte sniff.
    expect(matchBinaryReadPath("model.stl")).toBeNull();
    expect(matchBinaryReadPath("mesh.obj")).toBeNull();
    expect(matchBinaryReadPath("assembly.step")).toBeNull();
    expect(matchBinaryReadPath("part.stp")).toBeNull();
    expect(matchBinaryReadPath("surf.iges")).toBeNull();
    expect(matchBinaryReadPath("dwg.dxf")).toBeNull();
  });

  it("does NOT match image formats the read tool handles natively", () => {
    expect(matchBinaryReadPath("photo.jpg")).toBeNull();
    expect(matchBinaryReadPath("photo.jpeg")).toBeNull();
    expect(matchBinaryReadPath("screenshot.png")).toBeNull();
    expect(matchBinaryReadPath("anim.gif")).toBeNull();
    expect(matchBinaryReadPath("img.webp")).toBeNull();
    expect(matchBinaryReadPath("icon.bmp")).toBeNull();
  });

  it("does NOT match unsupported image formats — Layer 2 content sniff handles those", () => {
    // Deliberately not blocked at tool_call: pi may add native read support
    // for these without notice, and the tool_result sniff catches them until then.
    expect(matchBinaryReadPath("scan.tiff")).toBeNull();
    expect(matchBinaryReadPath("photo.heic")).toBeNull();
  });

  it("passes text files", () => {
    expect(matchBinaryReadPath("src/index.ts")).toBeNull();
    expect(matchBinaryReadPath("README.md")).toBeNull();
    expect(matchBinaryReadPath("data.csv")).toBeNull();
    expect(matchBinaryReadPath("notes.txt")).toBeNull();
    expect(matchBinaryReadPath("config.json")).toBeNull();
  });

  it("passes extension-less files and dotfiles", () => {
    expect(matchBinaryReadPath("Makefile")).toBeNull();
    expect(matchBinaryReadPath("/usr/bin/script")).toBeNull();
    expect(matchBinaryReadPath(".gitignore")).toBeNull();
    expect(matchBinaryReadPath(".env")).toBeNull();
  });

  it("handles empty and weird input", () => {
    expect(matchBinaryReadPath("")).toBeNull();
    expect(matchBinaryReadPath("dir/")).toBeNull();
    expect(matchBinaryReadPath("file.")).toBeNull();
  });
});
