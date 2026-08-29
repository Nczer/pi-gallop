# Gallop

Keeps the agent moving. Prevents stalls and manages context lifecycle.

## Features

### Read Guard (binary file blocking)

Intercepts `read` tool calls targeting known binary file types (`.pdf`, `.docx`, `.xlsx`, `.pptx`, archives, databases, compiled binaries, media, CAD files, etc.) and blocks them before execution. The read tool has no binary detection — it would dump raw bytes as garbled UTF-8 text into context. The block message includes a remediation hint pointing at the right tool or skill (e.g. the pdf skill for `.pdf`).

- Image formats the read tool handles natively (jpg/png/gif/webp/bmp) are **not** blocked
- Unsupported image formats (tiff, heic, ...) are deliberately **not** blocked either — pi may add native support without notice, and the safety net below catches them until then
- ASCII-capable CAD formats (`.stl`, `.obj`, `.step`, `.iges`, `.dxf`) are **not** blocked — they are often plain text the read tool handles fine; binary variants (e.g. binary STL) are caught by the safety net. Always-binary `.dwg` and `.3mf` remain blocked
- Safety net: `read` tool **results** are also sniffed for binary content (null bytes, >5% non-printable, >5% U+FFFD replacement characters) and replaced with a suppression summary — catches misnamed or extension-less binaries and unsupported image formats
- Toggle with `/gallop-read-guard [on|off]` (persisted, default on; stored in `~/.pi/agent/gallop.json` — pi's own `settings.json` is left untouched)

### Binary Output Filter

Intercepts bash tool results before they enter context. Detects binary output (null bytes, >5% non-printable characters, >5% U+FFFD replacement characters from undecodable bytes) and replaces it with a summary message. Prevents context corruption from accidental `head`, `cat`, or other commands on binary files.

The summary includes:
- Byte count and detection reason
- Hex head preview (first 64 bytes)
- **First 3 and last 5 readable lines** (control chars stripped) so you can verify the command ran correctly
- Total line count when output exceeds 8 readable lines
- Toggle with `/gallop-binary [on|off]` (persisted, default on, in the same `~/.pi/agent/gallop.json`)

### Stall Detection

Monitors assistant messages for unexpected stops. When the LLM halts mid-thought or mid-tool-call (not a clean `tool_use` handoff), sends a resume prompt.

- Triggers on: `message_end` where last content is `thinking` or `tool_use`
- Skips: `aborted`, `error`, and normal `tool_use` stops (a normal tool handoff **resets** the stall streak)
- Resume messages throttled to one per 10s to avoid spam, but **every** stall counts toward escalation — a fast stuck loop escalates instead of resuming forever
- Sends `[Gallop] Resume: <reason> (stopReason: <value>)` as steer message

#### Stall Escalation

Consecutive stalls escalate to prevent infinite resume loops:

| Stalls | Action |
|--------|--------|
| 1–3 | Normal resume message |
| 4+ | Stronger resume with stall count warning |
| 5+ | **Stop** auto-resume; notify user to try `/new` or `/compact` |

Stall counter resets on any non-stall assistant message (a final text answer or a normal tool-use handoff).

### Failure-Loop Detection

Tracks bash commands that fail repeatedly with the same error. When a command fails ≥3 times within a 5-turn window with the same error fingerprint, injects a nudge with contextual hints.

- Normalizes commands (whitespace, case) for fuzzy matching
- Fingerprints errors by last meaningful line
- Provides hints for common patterns: ENOENT, permission denied, package managers, syntax errors
- Sends `[Gallop] Failure loop detected: <details>` as steer message

#### Failure-Loop Escalation

Repeated failures escalate from suggestion to hard block. If a nudge is ignored (same command fails again), it escalates immediately:

| Failures | Level | Action |
|----------|-------|--------|
| 3 | **Nudge** | Suggest changing strategy with contextual hints |
| 4 | **Nudge+** | Stronger warning that previous nudge was ignored |
| 5+ | **Block** | Hard-block further retries via `tool_call` interceptor; LLM must use a different command |

Successful command execution resets all failure-loop state.

### Repetitive-Call Detection

Tracks consecutive tool calls with identical arguments across **all tools**. When the same tool+args repeats ≥3 times in a row, injects a nudge to break the loop.

- `read` — fingerprints by file path + offset/limit; hints to analyze content already in context
- `bash` — fingerprints by normalized command; hints to use output or move on
- Other tools — fingerprints by sorted JSON of args
- Resets counter on any different call
- Skips bash errors (failure-loop handler already covers them)
- Sends `[Gallop] Repetitive action detected: <details>` as steer message

#### Repetitive-Call Escalation

If a nudge is ignored (same call repeats again), it escalates immediately:

| Calls | Level | Action |
|-------|-------|--------|
| 3 | **Nudge** | Suggest analyzing existing output or moving on |
| 4 | **Nudge+** | Stronger warning to stop repeating |
| 5+ | **Block** | Hard-block identical calls via `tool_call` interceptor |

A successful call with different arguments clears the escalation state, so a later legitimate re-use of the same call (e.g. `npm run build` after editing files) starts fresh instead of being hard-blocked from an earlier streak.

### Circuit Breaker

A global circuit breaker prevents total doom loops when multiple patterns are blocked:

- Tracks total blocks enforced across all detectors
- After **3 total blocks**, Gallop **pauses the agent** with a dialog:
  - **Continue** — clears all blocks, lets the agent try again
  - **Stop** — blocks all tool calls, halts the agent, returns to your prompt
- After Stop, you're in control: type a new message, or use `/new` / `/compact` / change model

### Reasoning-Action Mismatch

Detects when the LLM acknowledges an error in its thinking but then calls the same tool that just failed. Catches the gap between what the model says and what it does.

- After any tool call fails, records the fingerprint (tool + args + error)
- On the next `tool_call`, checks if the thinking block contains error keywords ("wrong", "failed", "retry", "different", "instead", etc.)
- If thinking acknowledges an error AND the tool call matches the last failed fingerprint → injects `[Gallop] Mismatch: ...` steer message
- One-shot: clears after firing or on any successful tool call
- Operates independently of failure-loop and repetitive-call escalation

### Self-Compaction (cache-friendly)

The LLM can request compaction via the `request_compact` tool and write the
checkpoint summary itself — the summarization happens inside the live session
(a normal turn), so that LLM call rides the session's cached prompt prefix with
no cold prefill. Gallop stashes the summary and returns it as a custom
`CompactionResult` in `session_before_compact` (with pi's file-list sections
appended), so pi skips its one-shot summarizer (which cold-prefills the
flattened conversation). If no usable summary is stashed (native `/compact`,
auto threshold, overflow recovery, or a summary under 200 chars) or the user
aborts, gallop returns `undefined` and pi's native one-shot runs — compaction
always works.

Tool arguments:

- `message` — brief user-visible message shown in the tool result (`Compacting (<message>).`)
- `summary` — the checkpoint summary in pi's format (Goal / Constraints & Preferences /
  Progress / Key Decisions / Next Steps / Critical Context); the model focuses on
  older work, since the recent tokens up to pi's `compaction.keepRecentTokens`
  (default ~20k, user-configurable) are kept verbatim — the tool description names
  the configured value. Stays in the kept tail as the tool call's arguments — one
  copy, the price of in-session summarization.
- `continue` (boolean) — if `true`, a fixed generic steer
  (`[Gallop] Compact done — proceed as commanded.`) is injected after compaction;
  the checkpoint's Next Steps section tells the agent what to do next. Omitted/`false`
  = the agent stops and you take the next step. No custom resume text is ever written
  or re-sent.

Minimum context: the call **fails when the whole context fits in pi's keep
window** (`compaction.keepRecentTokens`, default 20k) — there is nothing older
than the verbatim tail to summarize, and pi would fail the compact. The guard
checks pi's own `getContextUsage()` (the same last-usage-anchored estimate the
automatic threshold check uses) against the live settings before stashing
anything: a below-minimum call fails as the tool call itself (the thrown error
becomes the tool result the model sees, with the reason and a retry-once-larger
hint), and no deferred compact is armed. Unmeasurable usage (`tokens: null` in
the window right after a compaction) proceeds and lets pi decide.

The tool description also suggests compacting at task boundaries: when a planned
task finished and another is queued, the checkpoint becomes the handoff for the
next task (which starts on a fresh context) instead of the next task inheriting
the previous one's tool-call history.

The compact itself is **deferred to pi's `agent_settled` event** (emitted after
the post-run loop). `ctx.compact()` first awaits the agent to go idle, which
only happens *after* pi's automatic threshold compaction ran — so firing it
inside the tool's `execute` at the moment a run's final usage crossed that
threshold would always double-compact: the automatic compact consumes the
stashed checkpoint first, then the manual one throws "Already compacted" and
the TUI shows an error. Deferring makes the race a no-op — if the automatic
compact (or a user `/compact`) ran first, `session_compact` clears the pending
state and the deferred trigger skips (a second check that the branch does not
already end in a compaction entry); in that race case the `continue` steer is
sent from `session_compact` instead of the manual `onComplete`.

Once the checkpoint has become the compaction summary, a `context` handler
replaces the `request_compact` exchange in every LLM request — the exchange
would otherwise duplicate the ~1k-token summary in the kept tail *and* read
as an unfulfilled request (the resumed model re-requested compaction, with
the triggering pressure nudge still standing in the tail). When the summary
text is verifiably carried by a `compactionSummary` message in context, the
assistant message carrying the call is rewritten to a fixed completion marker
(“Compaction complete — the summary at the top of context is your current
state. Do not call request_compact again unless context pressure returns.”)
and the paired toolResult is dropped. A call whose text is NOT carried
(native-fallback compact) keeps its call as a true record and only gets its
in-progress “Compacting (…)” result text marked done. Pre-compact tree views
and aborted compacts (no `compactionSummary` in context) are left intact, so
a re-request after an aborted compact is still the correct recovery. The
session file and TUI transcript always retain the full summary; the rewrite
is deterministic, so the prefix stays cache-stable.

`message_end` triggers nothing (pi emits it *before* pending tools execute) —
every compact request resolves deterministically at `agent_settled`. A
re-entrancy guard skips re-triggered `ctx.compact()` calls while a compact is
in flight (pi would throw "Already compacted"), re-armed at each new user
turn.

`/qcompact` (v2.0.0–v2.0.2) is gone: the context-pressure nudge below asks the
model to compact itself as the context fills, and pi's native `/compact`
remains for an immediate user-initiated compact (cold one-shot — the trade for
not needing a live-model checkpoint turn).

### Context-pressure nudge

As the context nears its limit, gallop steers the live model to self-compact:
one advisory steer per compaction cycle (state resets on `session_compact`),
placed just above pi's automatic threshold — `reserveTokens + 2k` (default ~18k
remaining) when auto-compact is on, or a fixed 16k when it is off (then no
backstop exists, and an overflow would abort the run). The threshold reads pi's
compaction settings from the global + project `settings.json` (merged per key,
project wins — same read-only reader shape as the context extension, falling
back to pi's defaults), so it tracks a custom `reserveTokens` and stays
proportionate on small context windows (e.g. 64k). After the nudge, silence —
pi's automatic compaction (which also drives overflow recovery, so it stays
enabled as the backstop) decides. No nudge while a compact is pending or in
flight — including an en-route one whose `request_compact` call sits in the
very message being judged (pi emits `message_end` before that call executes, so
the state flags are not set yet — the message content is the signal) — when a
message ends in aborted/error, or when the circuit breaker has halted the
agent.

Compaction resets all escalation state (blocks, nudges, stall count).

### Context status (active usage query)

The model has no passive view of context usage — the nudge above only fires
near the limit. `context_status` is a parameterless tool that reports, on
demand: current usage vs the model window (percent), remaining tokens, the
two backstop thresholds (gallop nudge, pi auto-compact — or the missing
backstop when auto-compact is off), and one deterministic advice line
(headroom OK / pressure building / near the backstop). It reads pi's own
`getContextUsage()` — the same last-usage-anchored estimate pi's automatic
threshold check uses — so the numbers match the backstop. In the window right
after a compaction (before the next assistant response carries usage) pi
reports `null`; the tool then says the context is fresh and safe to proceed.

The tool description scopes the call frequency — task boundaries and large
batches of reads or images (~1.6k tokens each), not after every tool call — so
the on-demand query stays on-demand (each result stays in the kept context).
Per-category visualization for humans remains the separate `/context`
extension.

