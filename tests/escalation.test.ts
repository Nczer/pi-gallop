import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createEscalationLadder,
  type EscalationLevel,
} from "../intervention";

// ── Escalation ladder (shared escalation engine) ──

describe("escalation ladder", () => {
  const buildMsg = (level: EscalationLevel) => `[test] ${level}`;
  const uiLabel = "test escalation";
  const ctxNoUI = { hasUI: false } as any;
  const ctxWithUI = { hasUI: true, ui: { notify: vi.fn() } } as any;
  const pi = { sendUserMessage: vi.fn() } as any;

  const newLadder = () =>
    createEscalationLadder({ nudge: 3, nudgePlus: 5, block: 5 }, () => false);

  beforeEach(() => {
    pi.sendUserMessage.mockClear();
    ctxWithUI.ui.notify.mockClear();
  });

  it("creates a nudge entry and sends a nudge message on first threshold hit", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel);

    expect(ladder.get("cmd")).toEqual({ level: "nudge", nudgeCount: 1 });
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[test] nudge", { deliverAs: "steer" });
  });

  it("escalates immediately to nudge_plus when a previous nudge was ignored", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel); // nudge
    pi.sendUserMessage.mockClear();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel); // same count again

    expect(ladder.get("cmd")).toEqual({ level: "nudge_plus", nudgeCount: 2 });
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[test] nudge_plus", { deliverAs: "steer" });
  });

  it("blocks at the block threshold after nudges were ignored", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel); // nudge
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel); // nudge_plus
    pi.sendUserMessage.mockClear();
    ladder.bump("cmd", 5, buildMsg, ctxNoUI, pi, uiLabel); // block

    expect(ladder.get("cmd")?.level).toBe("block");
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[test] block", { deliverAs: "steer" });
  });

  it("stays silent when already at the max level", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel); // nudge
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel); // nudge_plus
    ladder.bump("cmd", 5, buildMsg, ctxNoUI, pi, uiLabel); // block
    pi.sendUserMessage.mockClear();
    ladder.bump("cmd", 5, buildMsg, ctxNoUI, pi, uiLabel); // already at block

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ladder.get("cmd")).toEqual({ level: "block", nudgeCount: 3 });
  });

  it("removes the entry when count drops below the threshold", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel);
    pi.sendUserMessage.mockClear();
    ladder.bump("cmd", 2, buildMsg, ctxNoUI, pi, uiLabel);

    expect(ladder.get("cmd")).toBeUndefined();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("notifies through the UI when available", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxWithUI, pi, uiLabel);

    expect(ctxWithUI.ui.notify).toHaveBeenCalledWith("Gallop: nudge — test escalation", "warning");
  });

  it("uses error severity for block-level UI notifications", () => {
    const ladder = newLadder();
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel); // nudge
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel); // nudge_plus
    ladder.bump("cmd", 5, buildMsg, ctxWithUI, pi, uiLabel); // block

    expect(ctxWithUI.ui.notify).toHaveBeenCalledWith("Gallop: block — test escalation", "error");
  });

  it("is silent while quiesced (circuit breaker tripped)", () => {
    let tripped = false;
    const ladder = createEscalationLadder({ nudge: 3, nudgePlus: 5, block: 5 }, () => tripped);
    tripped = true;
    ladder.bump("cmd", 3, buildMsg, ctxNoUI, pi, uiLabel);

    expect(ladder.get("cmd")).toBeUndefined();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
