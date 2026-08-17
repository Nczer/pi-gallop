# Changelog

## v2.0.0

### Changed
- **Self-compact: the model writes the checkpoint summary in-session** — `request_compact` now requires a `summary` argument written by the live model (pi's checkpoint format, focused on older work since the recent ~20k tokens are kept verbatim). Summarization happens inside the session as a normal turn, so that LLM call rides the session's cached prompt prefix (cache-warm) — no subprocess, no cold prefill of the flattened conversation. Gallop stashes the summary and returns it as a custom `CompactionResult` in `session_before_compact` (with pi's file-list sections appended), so pi skips its one-shot summarizer.
- **`reason`/`pending` replaced by `message`/`continue`** — `message` is a short user-visible string carried by the tool result (`Compacting (<message>).`); the summary is no longer echoed in the result. `continue` (boolean) replaces the free-text resume task: when `true`, one fixed generic steer is injected after compaction (`[Gallop] Compact done — proceed as commanded.`) — the checkpoint's Next Steps section carries the actual "what next", so no custom resume text is ever written or re-sent (the old `pending` text appeared up to three times in context).
- **`/qcompact` restored** — steers the live model to write the checkpoint and call `request_compact` (same cache-warm path, optional focus argument); if the model does not call the tool by `message_end`, gallop falls back to `ctx.compact()` (pi's native one-shot), so `/qcompact` always compacts.
- **Fallback chain** — native `/compact`, auto threshold, overflow recovery, a summary under 200 chars, or a user abort all return `undefined` from `session_before_compact`, so pi's native one-shot runs and compaction always works.

### Fixed
- **"Already compacted" re-entrancy** — `ctx.compact()` internally aborts the run executing `request_compact`, which can re-trigger a compaction while the last session entry is still the compaction entry (pi then throws "Already compacted"). A `compactionInFlight` guard skips redundant triggers; it is re-armed only at true new-turn boundaries (new user message, `/qcompact`, new session) — not on `session_compact` or compact complete/error, so the guard stays active through the whole re-trigger window.

### Notes
- **`request_compact` summary-arg pruning** — the checkpoint text also exists as the tool call's `summary` argument in the kept tail (~1k duplicated tokens on every request). A `context` handler prunes that argument from each LLM request once the exact text is verifiably carried by the compaction summary (byte-identical prefix match — gallop appends the file sections after the text, never before). Pre-compact tree views (no `compactionSummary` message), earlier compactions' tool calls, and newer aborted calls fail the check and keep their full argument. The session file is never touched (the TUI transcript still shows the full summary); the rewrite is deterministic, so the prefix stays cache-stable. Out-of-band forking would remove the tail copy by construction but costs a subprocess and byte-identical-prompt fragility (any drift in the serialized tools array cold-prefills the whole fork request, as observed live); the in-session design was kept deliberately.
- The `[Gallop] Resume: <task>` injection is gone (no more free-text resume task); the fixed `[Gallop] Compact done — proceed as commanded.` steer is distinct from stall-detection resume messages.

### Tests
- Rewrote `self-compact.test.ts` (110 tests passing total): file-list helpers, tool behavior (stashing, terminate result, message defaulting, no summary echo, `continue` on/off), `session_before_compact` (custom compaction with file ops, native fallback for missing/short summaries, abort-listener register/cleanup, no stale-summary reuse), re-entrancy guard, `/qcompact` (steering content, focus, non-compliance fallback, no double-compact on compliance, refusal while running), state reset on `session_compact`, and the `context` summary-arg pruning handler (prune on verbatim carry, no-op without a compaction summary, non-matching/too-short args intact, multi-call selection, non-array content tolerated).

## v1.6.1

### Fixed
- **Repetitive-call "nudge+" level dead for successful streaks** — the v1.6.0 success-clearing wiped the current streak's escalation entry too, so count 4 sent a plain nudge instead of the escalated "previous nudge was ignored" warning. Success now clears only entries for *other* fingerprints, keeping the active streak's nudge → nudge+ → block ladder intact while still un-sticking unrelated blocked calls.

### Tests
- Added `escalate()` engine tests (level transitions, immediate escalation, max-level silence, below-threshold decay, UI notifications with severity) and `normalizeToolArgs` coverage for the `edit` branch.

## v1.6.0

### Fixed
- **Sticky repetitive-call blocks** — a blocked fingerprint stayed hard-blocked for the whole session (until compaction/restart), so a legitimate later re-use of the same call (e.g. `npm run build` after editing files) was blocked on first occurrence with a misleading message. A successful call now clears the repetitive escalation state, mirroring the failure-loop success clearing.
- **Settings clobber risk** — Gallop wrote pi's own `~/.pi/agent/settings.json` with an unlocked read-modify-write, racing pi's locked writes (proper-lockfile) and risking lost keys or corrupted JSON. Toggles now live in `~/.pi/agent/gallop.json`; legacy values in settings.json are migrated on first load.
- **Read guard false positives on ASCII CAD formats** — `.stl`, `.obj`, `.step`, `.iges`, `.dxf` are often plain text and are no longer blocked; binary variants (binary STL etc.) are caught by the result sniff. `.dwg` and `.3mf` remain blocked.
- **Binary sniff missed U+FFFD walls** — the read tool decodes bytes via `buffer.toString("utf-8")`, so null-free binaries become walls of U+FFFD replacement chars with no control characters left to flag. `detectBinaryContent` now flags >5% replacement characters, and suppressed summaries strip them from the preview.
- **No-UI circuit breaker message said "0 blocks enforced"** — the count is now captured before the state reset.
- **Blocked calls polluted failure-loop history** — blocked calls still emit `tool_execution_end` with the block reason as the error result; those are no longer recorded as failures or fed to mismatch detection (fingerprints starting with `[gallop]` are skipped).
- **Stall escalation didn't match README** — normal `toolUse` handoffs now reset the consecutive-stall streak, and stalls within the 10s message cooldown still count toward escalation, so fast stuck loops escalate to stop instead of resuming forever.
- **Stale pending task after cancelled compaction** — `pendingTask` is cleared when compaction is aborted or errors, so a later unrelated compaction no longer shows "(will resume)" for an old task.

### Changed
- Dead block thresholds (7) replaced with the effective 5.

## v1.5.0

### Added
- **Read guard for binary files** — `read` calls on known binary extensions (`.pdf`, `.docx`/`.xlsx`/`.pptx`, archives, databases, compiled binaries, media, fonts, design/CAD files, e-books) are blocked at `tool_call` with a remediation hint (e.g. "Use the pdf skill"). The pi read tool has no binary detection and would otherwise dump raw bytes as garbled text into context. Image formats are excluded — both natively supported ones (jpg/png/gif/webp/bmp) and unsupported ones (tiff/heic/...), since pi may add support without notice; the result sniff below covers them. Toggle via `/gallop-read-guard [on|off]` (persisted as `gallopReadGuardEnabled`, default on).
- **Read-result binary sniffing** — the binary output filter now also covers `read` tool results as a safety net for misnamed or extension-less binaries (e.g. a PDF named `report.txt`) and unsupported image formats. Image reads are unaffected (their text note is printable).

## v1.4.0

### Fixed
- **False-positive repetitive-call blocks for nested args** — the default fingerprint branch used `JSON.stringify(a, Object.keys(a).sort())`, and an array replacer drops keys at *every* depth, so `{query:"q", options:{limit:5}}` and `{query:"q", options:{limit:99}}` fingerprinted identically. Replaced with a recursive stable stringify. The test covering this branch also used the `edit` tool name, which has its own branch — now uses `write` plus two nested-args regression tests.
- **Circuit breaker re-trip loop in headless sessions** — the no-UI branch never reset `totalBlocks`, so every subsequent blocked call re-tripped the breaker and re-sent the steer message. Now resets `totalBlocks` alongside the escalation maps.
- **Stall-stop notice spam** — once `stallCount >= STALL_STOP`, every further stall re-sent the "stopping auto-resume" message and error notification. The notice now fires once per stall streak (`stallStopNotified` flag, reset on recovery / `resetAllState`).
- **Potential `pendingToolCalls` leak** — `tool_execution_start` stashes before `tool_call` runs; if `tool_execution_end` never fires for a blocked call, the entry would leak. Map is now capped at 200 entries (oldest dropped).
- **README** — hex head preview documented as 16 bytes; code dumps 64.

## v1.3.0

### Fixed
- **Stall detection for tool-call stops** — `lastItemIsToolUse` checked `type === "tool_use"` but assistant content blocks use `type === "toolCall"`, so it always returned false and "stopped after tool call" stalls were never detected. Now checks `"toolCall"`.
- **Spurious resume on normal tool handoffs** — `stopReason` was compared to `"tool_use"` (snake_case) but the value is `"toolUse"` (camelCase). After the fix above this would have injected a resume message on every normal tool call; now correctly skips normal `toolUse` stops.
- **Reasoning-action mismatch never fired** — two independent bugs: (1) `tool_execution_end` read `event.args`, which doesn't exist on that event, so the failed-call fingerprint was always `toolName:{}`; (2) the mismatch check looked for `type === "tool_use"` / `input` instead of `type === "toolCall"` / `arguments`. Args are now stashed in `tool_execution_start` and looked up by `toolCallId`, and the content-block shape is correct. The check also iterates all tool calls (parallel-safe) and runs before the stall early-return so it actually reaches normal tool handoffs.
- **Repetitive-call block could miss on coerced args** — the block was recorded with a fingerprint from `tool_execution_start` (raw args) but looked up with one from `tool_call` (validated/coerced args). Now looks up the stashed fingerprint first.
- **False repetitive-success nudge after bash failures** — a bash failure left the consecutive-call counter incremented, so a later successful run of the same command could trigger a repetitive-call nudge. The counter now resets on bash failure.

### Changed
- **Removed context usage injection** — the `before_agent_start` context-usage message (`Context: 42.3k / 128k (33%)`) added noise without helping in practice. Removed the handler, the `lastReportedPct` state, and the `formatTokens` helper.

### Performance
- **Binary filter** — encodes the bash output to bytes once instead of twice when building the suppression summary.

## v1.2.2

### Added
- **Binary suppression head/tail preview** — when suppressing binary output, now shows first 3 and last 5 readable lines (stripped of control chars) so the user can verify the command ran correctly without flooding context

### Changed
- **request_compact tool description** — added "Call when" guidance for clearer LLM trigger conditions

## v1.2.1

### Added
- **Edit tool fingerprinting** — `edit` calls are fingerprinted by `path` + short `oldText` prefix per edit, so edits to different regions get distinct fingerprints and won't trigger false repetitive-call detection
- **Edit repetitive-call hint** — suggests making multiple distinct edits in one call instead of repeating the same edit

## v1.2.0

### Added
- **Reasoning-action mismatch detection** — catches when LLM acknowledges an error in thinking but repeats the same failed tool call
- **Escalation pipeline** — failure-loop and repetitive-call detectors escalate: nudge → nudge+ → block
- **Circuit breaker** — after 3 total blocks, pauses agent with Continue/Stop dialog

### Changed
- **Immediate escalation** — removed 30s cooldown; ignored nudge auto-escalates to next level (3→4→5 instead of 3→5→7)
- **Circuit breaker threshold** — lowered from 5 to 3 blocks
- **Shared escalation engine** — extracted duplicated escalation logic from both detectors into `escalate()`
- **State reset consolidation** — `resetAllState()` replaces manual resets across 3 call sites (was missing `lastFailedToolCall`/`llmAcknowledgedError` on circuit breaker continue)
- **Binary detection unified** — `detectBinaryContent()` returns result with reason string; eliminates duplicate non-printable scan in `tool_result`

### Fixed
- Escalation cooldown skipped new entries that needed initial nudge
- Circuit breaker "Continue" path didn't reset mismatch detection state
