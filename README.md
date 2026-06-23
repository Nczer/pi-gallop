# Gallop

Keeps the agent moving. Prevents stalls and manages context lifecycle.

## Features

### Stall Detection

Monitors assistant messages for unexpected stops. When the LLM halts mid-thought or mid-tool-call (not a clean `tool_use` handoff), sends a resume prompt.

- Triggers on: `message_end` where last content is `thinking` or `tool_use`
- Skips: `aborted`, `error`, and normal `tool_use` stops
- 10s cooldown to avoid spam
- Sends `[Gallop] Resume: <reason> (stopReason: <value>)` as steer message

### Failure-Loop Detection

Tracks bash commands that fail repeatedly with the same error. When a command fails ≥3 times within a 5-turn window with the same error fingerprint, injects a nudge with contextual hints.

- Normalizes commands (whitespace, case) for fuzzy matching
- Fingerprints errors by last meaningful line
- Provides hints for common patterns: ENOENT, permission denied, package managers, syntax errors
- 30s cooldown per command+error combo to avoid spam
- Sends `[Gallop] Failure loop detected: <details>` as steer message

### Repetitive-Call Detection

Tracks consecutive tool calls with identical arguments across **all tools**. When the same tool+args repeats ≥3 times in a row, injects a nudge to break the loop.

- `read` — fingerprints by file path; hints to analyze content already in context
- `bash` — fingerprints by normalized command; hints to use output or move on
- Other tools — fingerprints by sorted JSON of args
- Resets counter on any different call
- 30s cooldown per fingerprint to avoid spam
- Sends `[Gallop] Repetitive action detected: <details>` as steer message

### Compaction + Resume

LLM can request compaction via the `request_compact` tool. After compaction completes, injects a resume message with the pending task.

- `reason` — why compaction was requested
- `pending` — task to resume after compaction
- `customInstructions` — directions for the summarizer

### Context Usage

Injects context usage stats before each turn (when percentage changes by ≥5 points):

```
Context: 42.3k / 128k (33%)
```
