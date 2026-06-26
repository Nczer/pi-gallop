# Gallop

Keeps the agent moving. Prevents stalls and manages context lifecycle.

## Features

### Binary Output Filter

Intercepts bash tool results before they enter context. Detects binary output (null bytes, >5% non-printable characters) and replaces it with `[Gallop] Binary output suppressed — N bytes`. Prevents context corruption from accidental `head`, `cat`, or other commands on binary files.

### Stall Detection

Monitors assistant messages for unexpected stops. When the LLM halts mid-thought or mid-tool-call (not a clean `tool_use` handoff), sends a resume prompt.

- Triggers on: `message_end` where last content is `thinking` or `tool_use`
- Skips: `aborted`, `error`, and normal `tool_use` stops
- 10s cooldown to avoid spam
- Sends `[Gallop] Resume: <reason> (stopReason: <value>)` as steer message

#### Stall Escalation

Consecutive stalls escalate to prevent infinite resume loops:

| Stalls | Action |
|--------|--------|
| 1–3 | Normal resume message |
| 4+ | Stronger resume with stall count warning |
| 5+ | **Stop** auto-resume; notify user to try `/new` or `/compact` |

Stall counter resets on any non-stall assistant message.

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

### Compaction + Resume

LLM can request compaction via the `request_compact` tool. After compaction completes, injects a resume message with the pending task.

- `reason` — why compaction was requested
- `pending` — task to resume after compaction
- `customInstructions` — directions for the summarizer

Compaction resets all escalation state (blocks, nudges, stall count).

### Context Usage

Injects context usage stats before each turn (when percentage changes by ≥5 points):

```
Context: 42.3k / 128k (33%)
```
