import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  escalate,
  type EscalationEntry,
  type EscalationLevel,
} from "../intervention";

// ── escalate (shared escalation engine) ──

describe("escalate", () => {
  const buildMsg = (level: EscalationLevel) => `[test] ${level}`;
  const uiLabel = "test escalation";
  const ctxNoUI = { hasUI: false } as any;
  const ctxWithUI = { hasUI: true, ui: { notify: vi.fn() } } as any;
  const pi = { sendUserMessage: vi.fn() } as any;

  beforeEach(() => {
    pi.sendUserMessage.mockClear();
    ctxWithUI.ui.notify.mockClear();
  });

  it("creates a nudge entry and sends a nudge message on first threshold hit", () => {
    const map = new Map<string, EscalationEntry>();
    escalate("cmd", 3, 3, 5, 5, map, ctxNoUI, pi, buildMsg, uiLabel);

    expect(map.get("cmd")).toEqual({ level: "nudge", nudgeCount: 1 });
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[test] nudge", { deliverAs: "steer" });
  });

  it("escalates immediately to nudge_plus when a previous nudge was ignored", () => {
    const map = new Map<string, EscalationEntry>();
    escalate("cmd", 3, 3, 5, 5, map, ctxNoUI, pi, buildMsg, uiLabel); // nudge
    pi.sendUserMessage.mockClear();
    escalate("cmd", 3, 3, 5, 5, map, ctxNoUI, pi, buildMsg, uiLabel); // same count again

    expect(map.get("cmd")).toEqual({ level: "nudge_plus", nudgeCount: 2 });
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[test] nudge_plus", { deliverAs: "steer" });
  });

  it("blocks at the block threshold after nudges were ignored", () => {
    const map = new Map<string, EscalationEntry>();
    escalate("cmd", 3, 3, 5, 5, map, ctxNoUI, pi, buildMsg, uiLabel); // nudge
    escalate("cmd", 3, 3, 5, 5, map, ctxNoUI, pi, buildMsg, uiLabel); // nudge_plus
    pi.sendUserMessage.mockClear();
    escalate("cmd", 5, 3, 5, 5, map, ctxNoUI, pi, buildMsg, uiLabel); // block

    expect(map.get("cmd")?.level).toBe("block");
    expect(pi.sendUserMessage).toHaveBeenCalledWith("[test] block", { deliverAs: "steer" });
  });

  it("stays silent when already at the max level", () => {
    const map = new Map<string, EscalationEntry>([["cmd", { level: "block", nudgeCount: 3 }]]);
    escalate("cmd", 5, 3, 5, 5, map, ctxNoUI, pi, buildMsg, uiLabel);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(map.get("cmd")).toEqual({ level: "block", nudgeCount: 3 });
  });

  it("removes the entry when count drops below the threshold", () => {
    const map = new Map<string, EscalationEntry>([["cmd", { level: "nudge", nudgeCount: 1 }]]);
    escalate("cmd", 2, 3, 5, 5, map, ctxNoUI, pi, buildMsg, uiLabel);

    expect(map.has("cmd")).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("notifies through the UI when available", () => {
    const map = new Map<string, EscalationEntry>();
    escalate("cmd", 3, 3, 5, 5, map, ctxWithUI, pi, buildMsg, uiLabel);

    expect(ctxWithUI.ui.notify).toHaveBeenCalledWith("Gallop: nudge — test escalation", "warning");
  });

  it("uses error severity for block-level UI notifications", () => {
    const map = new Map<string, EscalationEntry>([["cmd", { level: "nudge_plus", nudgeCount: 2 }]]);
    escalate("cmd", 5, 3, 5, 5, map, ctxWithUI, pi, buildMsg, uiLabel);

    expect(ctxWithUI.ui.notify).toHaveBeenCalledWith("Gallop: block — test escalation", "error");
  });
});
