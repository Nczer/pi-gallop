# Gallop

Keeps the agent moving. Prevents stalls and manages context lifecycle.

## Features

### Stall Detection

Monitors assistant messages for unexpected stops. When the LLM halts mid-thought or mid-tool-call (not a clean `tool_use` handoff), sends a resume prompt.

- Triggers on: `message_end` where last content is `thinking` or `tool_use`
- Skips: `aborted`, `error`, and normal `tool_use` stops
- 10s cooldown to avoid spam
- Sends `[Gallop] Resume: <reason> (stopReason: <value>)` as steer message

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
