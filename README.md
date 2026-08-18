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
  older work, since the recent ~20k tokens are kept verbatim. Stays in the kept tail
  as the tool call's arguments — one copy, the price of in-session summarization.
- `continue` (boolean) — if `true`, a fixed generic steer
  (`[Gallop] Compact done — proceed as commanded.`) is injected after compaction;
  the checkpoint's Next Steps section tells the agent what to do next. Omitted/`false`
  = the agent stops and you take the next step. No custom resume text is ever written
  or re-sent.

Once the checkpoint has become the compaction summary, a `context` handler
prunes the `request_compact` tool call's `summary` argument from every LLM
request (otherwise the ~1k-token text is duplicated in the kept tail on each
call) — but only when the exact text is verifiably carried by a
`compactionSummary` message in context, so pre-compact tree views, earlier
compactions' calls, and aborted calls keep their full argument. The session
file and TUI transcript always retain the full summary; the rewrite is
deterministic, so the prefix stays cache-stable.

`/qcompact [focus]` steers the live model to write the checkpoint and call
`request_compact` (same cache-warm path); if the model does not call the tool by
`message_end`, gallop falls back to `ctx.compact()` (pi's native one-shot), so
`/qcompact` always compacts. A `message_end` that carries a pending
`request_compact` call is not treated as non-compliance — pi emits
`message_end` *before* pending tools execute, and the tool triggers the
in-session compact itself a moment later (firing the native fallback first
would abort the pending call and lose the checkpoint). A re-entrancy guard skips re-triggered
`ctx.compact()` calls while a compact is in flight (pi would throw
"Already compacted"), re-armed at each new user turn.

Compaction resets all escalation state (blocks, nudges, stall count).

