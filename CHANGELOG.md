# Changelog

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
