# Improvements

Backlog of improvement items for gallop, each recorded with the evidence that
motivated it. When an item is implemented it moves to CHANGELOG.md and is
removed from here.

## Self-compact: compact at task boundaries

**Observed (2026-08, three-task session that compacted between each task).**
For a multi-task session with an explicit task list, compacting at every task
boundary beat waiting for context pressure:

- Post-compact context is the checkpoint summary + the most recent ~20k
  tokens verbatim. The next task starts with a fresh, plan-carrying context
  and without the previous task's tool-call history (the actual bloat).
- The KV cache is rebuilt by compaction anyway, so a boundary compact costs
  nothing relative to running hot until the pressure nudge fires near the
  limit.
- The checkpoint summary *is* the handoff: with complete Progress / Key
  Decisions / Next Steps sections, the next task's work is self-contained.

**Change.** The `request_compact` description's "Call when" list (index.ts)
is reactive — bloat symptoms (edit tool failing on text matching, large
diffs accumulated), a long session, the context-pressure notice. Add a
proactive trigger, e.g.:

> a planned task finished and another is queued (e.g. the next item in
> project memory) — write the checkpoint now with `continue: true` so the
> next task starts on a fresh context.

No change to the post-compact continue steer: it is deliberately generic
(`[Gallop] Compact done — proceed as commanded.`) and the checkpoint's Next
Steps section carries the specifics.

## Self-compact: the checkpoint-elision incident

**Incident (2026-08, same session).** After a compaction, the model saw the
`request_compact` call's `summary` argument rewritten to `[omitted — …]`
(the context handler's pruning working as designed) and misread it as a lost
summary — then re-derived the session state by re-exploring the repos,
which is expensive and avoidable.

**Mitigations already in place.**

- `d5bd97b` — the elision marker now says where the text lives:
  `[omitted — full summary text is in the compaction summary at the top of
  context]`.
- The memory extension (separate repo, `fdf0aa7`) — a one-shot
  post-compaction pointer in the system prompt to project memory (the
  session task list) and deep memory (`memory_search`). Persistent state
  lives in the memory stores, so the agent checks there instead of
  re-deriving. This only helps if the session used the memory stores —
  which is what the memory extension's own project-memory nudge steers
  toward.

**Remaining (open question, no code yet).** Gallop is standalone and does
not know about the memory extension — the two are independent by design.
In a gallop-only session there is no post-compact pointer to persistent
state; the compaction summary at the top of context is the only handoff and
its quality is entirely the model's. Options if it matters in practice:

1. Extend the generic continue steer with a line pointing at the
   compaction summary as the handoff. Cheap, but it starts to erode the
   "no custom resume text is ever written or re-sent" invariant.
2. Document the pairing in the README (gallop owns the compaction
   lifecycle; the memory extension owns state persistence) and leave the
   code alone.

Recommendation: 2, until the incident recurs in a gallop-only session.
