import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createEscalationLadder,
  type EscalationLevel,
  type EscalationUi,
} from "../intervention";
import { reconcile } from "../status";

// ── Escalation ladder (shared escalation engine) ──

describe("escalation ladder", () => {
  const buildMsg = (level: EscalationLevel) => `[test] ${level}`;
  // live() flips with this flag so the footer-part lifecycle is testable.
  let ladderLive = true;
  const ui: EscalationUi = {
    customType: "gallop-test",
    uiLabel: "test escalation",
    statusLabel: (level) => `[${level}]`,
    live: () => ladderLive,
  };
  const ctxNoUI = { hasUI: false } as any;
  const ctxWithUI = {
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_kind: string, text: string) => text },
    },
  } as any;
  const pi = { sendMessage: vi.fn() } as any;
  const statusText = () => ctxWithUI.ui.setStatus.mock.calls.at(-1)?.[1] as string | undefined;

  const newLadder = () =>
    createEscalationLadder({ nudge: 3, nudgePlus: 5, block: 5 }, () => false);

  beforeEach(() => {
    pi.sendMessage.mockClear();
    ctxWithUI.ui.notify.mockClear();
    ctxWithUI.ui.setStatus.mockClear();
    ladderLive = true;
  });

  const bumps = () => pi.sendMessage.mock.calls.map(([m]: any[]) => m.content as string);

  it("creates a nudge entry and sends a hidden nudge steer on first threshold hit", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui);

    expect(ladder.get("cmd")).toEqual({ level: "nudge", nudgeCount: 1 });
    // Hidden custom message, delivered as a steer while a run is active and as
    // a turn-triggering message when idle (steer.ts).
    expect(pi.sendMessage).toHaveBeenCalledWith(
      { customType: "gallop-test", content: "[test] nudge", display: false },
      { triggerTurn: true, deliverAs: "steer" },
    );
  });

  it("escalates immediately to nudge_plus when a previous nudge was ignored", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui); // nudge
    pi.sendMessage.mockClear();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui); // same count again

    expect(ladder.get("cmd")).toEqual({ level: "nudge_plus", nudgeCount: 2 });
    expect(bumps()).toEqual(["[test] nudge_plus"]);
  });

  it("blocks at the block threshold after nudges were ignored", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui); // nudge
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui); // nudge_plus
    pi.sendMessage.mockClear();
    ladder.bump("cmd", 5, buildMsg, ctxNoUI, pi, ui); // block

    expect(ladder.get("cmd")?.level).toBe("block");
    expect(bumps()).toEqual(["[test] block"]);
  });

  it("stays silent when already at the max level", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui); // nudge
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui); // nudge_plus
    ladder.bump("cmd", 5, buildMsg, ctxNoUI, pi, ui); // block
    pi.sendMessage.mockClear();
    ladder.bump("cmd", 5, buildMsg, ctxNoUI, pi, ui); // already at block

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(ladder.get("cmd")).toEqual({ level: "block", nudgeCount: 3 });
  });

  it("removes the entry when count drops below the threshold", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui);
    pi.sendMessage.mockClear();
    ladder.bump("cmd", 2, buildMsg, ctxNoUI, pi, ui);

    expect(ladder.get("cmd")).toBeUndefined();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("is silent while quiesced (circuit breaker tripped)", () => {
    let tripped = false;
    const ladder = createEscalationLadder({ nudge: 3, nudgePlus: 5, block: 5 }, () => tripped);
    tripped = true;
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, ui);

    expect(ladder.get("cmd")).toBeUndefined();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  // ── User-facing half: the footer part, not a toast ──

  it("puts the nudge on the footer line without a toast", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxWithUI, pi, ui);

    expect(ctxWithUI.ui.notify).not.toHaveBeenCalled();
    expect(statusText()).toContain("[nudge]");
  });

  it("toasts only at block level, and keeps the footer part for it", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxWithUI, pi, ui); // nudge
    ladder.bump("cmd", 3, buildMsg, ctxWithUI, pi, ui); // nudge_plus
    ctxWithUI.ui.setStatus.mockClear();
    ladder.bump("cmd", 5, buildMsg, ctxWithUI, pi, ui); // block

    expect(ctxWithUI.ui.notify).toHaveBeenCalledWith("Gallop: block — test escalation", "error");
    expect(statusText()).toContain("[block]");
  });

  it("clears the footer part once live() goes false (the nudge was addressed)", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxWithUI, pi, ui);
    expect(statusText()).toContain("[nudge]");

    ladderLive = false;            // e.g. the command succeeded: the ladder cleared
    reconcile(ctxWithUI);
    expect(statusText()).toBeUndefined();
  });
});
