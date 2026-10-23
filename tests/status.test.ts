import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  setState, setNudge, clearNudge, setStateCleared, clearAll, reconcile, reset,
} from "../status";

// ── gallop's single footer status line (status.ts) ──

const mkCtx = () => {
  const ctx: any = {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      theme: { fg: (kind: string, text: string) => `${kind}:${text}` },
    },
  };
  return ctx;
};
const line = (ctx: any) => ctx.ui.setStatus.mock.calls.at(-1) as [string, string | undefined];

describe("footer status composition", () => {
  let ctx: any;
  beforeEach(() => { reset(); ctx = mkCtx(); });

  it("owns one key and joins the state and nudge parts", () => {
    setState(ctx, "⚠ ~12k left → compact_request");
    setNudge(ctx, "⚠ failure loop ×3", () => true);
    const [key, text] = line(ctx);
    expect(key).toBe("compact");
    expect(text).toContain("~12k left");
    expect(text).toContain("failure loop ×3");
    // Severity is data until render(): the nudge paints as warning, the state part too.
    expect(text).toContain("warning:⚠ ~12k left");
  });

  it("keeps the state part when only the nudge clears (and vice versa)", () => {
    setState(ctx, "⟳ Compacting...");
    setNudge(ctx, "⚠ stall: resumed", () => true);
    clearNudge(ctx);
    expect(line(ctx)[1]).toContain("Compacting");

    ctx.ui.setStatus.mockClear();
    setState(ctx, "⟳ Compacting...");
    setNudge(ctx, "⚠ stall: resumed", () => true);
    setStateCleared(ctx);
    expect(line(ctx)[1]).toContain("stall");
  });

  it("drops a nudge part in reconcile once its live() condition goes false", () => {
    let streak = 1;
    setNudge(ctx, "⚠ stall: resumed", () => streak > 0);
    ctx.ui.setStatus.mockClear();
    reconcile(ctx);                        // still live — nothing painted
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();

    streak = 0;                            // the model answered the nudge
    reconcile(ctx);
    expect(line(ctx)).toEqual(["compact", undefined]);
  });

  it("paints each part's register: caution, block, note", () => {
    setNudge(ctx, "⚠ repetitive bash ×5", () => true);
    expect(line(ctx)[1]).toContain("warning:⚠ repetitive");
    setNudge(ctx, "⛔ bash blocked (×10 same call)", () => true, "error");
    expect(line(ctx)[1]).toContain("error:⛔ bash blocked");
    // The ✓ reports something already done — a note, not a caution.
    setNudge(ctx, "✓ compacted → resuming", () => true, "dim");
    expect(line(ctx)[1]).toContain("dim:✓ compacted");
  });

  it("takes both parts out on clearAll (session branch switch)", () => {
    setState(ctx, "⚠ ~12k left");
    setNudge(ctx, "✓ compacted → resuming", () => true);
    clearAll(ctx);
    expect(line(ctx)).toEqual(["compact", undefined]);
  });

  it("is safe with a non-interactive ctx — state tracked, nothing painted", () => {
    const headless: any = { hasUI: false };
    setState(headless, "⟳ Compacting...");
    setNudge(headless, "⚠ mismatch", () => true);
    expect(() => reconcile(headless)).not.toThrow();
    // A later interactive render still sees both parts.
    setNudge(ctx, "⚠ mismatch", () => true);
    expect(line(ctx)[1]).toContain("Compacting");
    expect(line(ctx)[1]).toContain("mismatch");
  });
});
