# Improvements

Backlog of improvement items for gallop, each recorded with the evidence that
motivated it. When an item is implemented it moves to CHANGELOG.md and is
removed from here.

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

## Pi-core candidate: keepRecentTokens should adapt to the window

`compaction.keepRecentTokens` (the verbatim tail pi keeps after compaction,
default 20k) is user-configurable in settings.json, so gallop no longer
needs a knob for it — the checkpoint guidance now names the configured
value (Unreleased changelog). What remains is the *default* being a fixed
number: on a 200k window 20k is ~10% of the window (fine — roughly the
last 5–10 tool cycles, or one large file read); on a 64k window it is ~31%
of the window, leaving little headroom after the summary. A proportional
default (e.g. `max(8k, 10% of window)`) would adapt without configuration.
Candidate for a pi-core issue, not a gallop change. The LLM has no concept
of the tail size — the model only sees what the tail happens to contain, so
this is a harness compression parameter, not something the model tunes.

## Post-compaction: the protected/evidence blocks read as open work

**Observation (2026-10-23, 7 sessions / 18 compactions).** After a compaction the
context ends, in order: the compaction summary → `gallop-protected` ("Pre-compaction
user messages, verbatim") → `gallop-evidence` (the `L<n>` result index) →
`[Gallop] Compact done — proceed as commanded.` The blocks sit *after* the summary,
so the freshest thing in context is the previous branch's user text — and its last
entry is a message that was already answered.

Measured, not felt:

- The post-compaction thinking referenced that pre-compaction user block in **4 of
  18** compactions; both cases where the model resumed work on an already-reported
  task were among the 4 (session `01a1575d` L313→L314: "the user's last message in
  the pre-compaction block was …" → re-measured sheet ranges it had already
  measured; L425→L426 → invented a LibreOffice→PDF colour-rect verification pass,
  ended `stopReason: error`).
- The evidence index's fetch instruction was **never taken**: `session_recall`
  appeared in **0 of 18** post-compaction runs (its budget here was ~17 rows plus
  "17 older result(s) omitted"), so it costs context and shows error rows
  (`KeyError`, `SyntaxError`, "Omitted results are unknown, not absent-as-success")
  without being used.
- Re-runs, if any, are not literal: **5 of 445** post-compaction tool calls were
  byte-identical to a pre-compaction call — the resumed work is *new* verification,
  which is what makes it look like rechecking.

**Partly implemented (2026-10-23).** The reframing landed: the protected header now
names the block as the user's earlier words, still in force as constraints but part
of the record of what was already said and done, and the continue steer points at the
checkpoint's `Next Steps` and calls anything re-injected above the record, not new
work. The evidence index stopped indexing errored results — the errors-led ordering is
gone, along with the `ERR` marker. The block position stays as designed (the user
judged the 2/18 rate too low to move it) and the 8k-char budget stays: self-compact
already shrinks the verbatim tail to 8k tokens (`KEEP_RECENT_TOKENS_DEFAULT`, against
pi's 20k default for native compacts), so the package is an addendum to a smaller tail
rather than a competing one. **Next, if the following batch of compactions again shows
0 `session_recall` drill-ins: delete the evidence block** and keep only the protected
one — the pointer affordance has then had two batches of evidence against it.

## Post-compaction: ask answers (consult) survived only as paraphrase

Measured 2026-10-24 over the 24 session files of the current project's session
dir (`$HOME/.pi/agent/sessions/<project-slug>/`)
(pi of the gallop 2026-10-23 build — evidence package in place, keep window 8k):

- 65 successful `consult` results vs 212 user messages: the ask channel is
  roughly a third as busy as typing, and in the compacting sessions **55 of 60**
  consult results sit inside a compaction's covered span.
- **17 of 65** results carry a `User's note:` — free-form text the model never
  authored, and it carries new direction, not confirmation: "do remember retry
  nudge, etc. should clear if its addressed", "btw i plan to change gallop
  compaction message and protected block a bit…".
- Cheap to carry: median 86 chars, p90 224, max 419.
- Fidelity loss is not hypothetical: in session `01a16795` (17 consults, 6
  compaction summaries) **0 of 17** answers appear with their literal text in
  any summary. That measures paraphrase, not decision loss — the decisions were
  implemented, so the checkpoint carried *something* — but the exact option
  label ("Report only (Recommended)") and every note were rewritten away.
- A recovery path exists and works: `session_recall(tool="consult")` returns 34
  hits for that session, each result rendered next to its ask call (`question=`),
  with `L<n>` pointers. Recovery is voluntary though — the model has to notice it
  lost the answer, which is the failure the protected block exists to prevent.

**Implemented (2026-10-24).** Ask answers joined the protected block, interleaved
with user messages in the same newest-first 16k budget, as
`Q: <question stem, capped 160 chars>` + `A: <answer verbatim>`; question stems are
read from the ask call's `question` argument, failed/cancelled asks are skipped, and
`ASK_TOOLS` is the only coupling to consult. **Next:** if a post-compaction run
re-asks a question that is in the block, the header's "do not re-ask an answered
question" is not doing the job and the ask rows need their own label rather than
riding the shared header.
