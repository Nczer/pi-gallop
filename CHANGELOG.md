# Changelog

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
