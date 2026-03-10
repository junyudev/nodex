# Backend Logging

## Purpose

This document is the source of truth for Nodex's backend logging system.

The backend logger exists to make local debugging fast and reliable, especially for:

- Codex app-server connection failures
- Codex thread and turn lifecycle debugging
- approval and `request_user_input` stalls
- worktree setup failures
- HTTP request failures
- PTY lifecycle issues
- reminder and backup scheduler failures
- main-process startup and shutdown problems

The logger is implemented in [src/main/logging/logger.ts](src/main/logging/logger.ts).

## Design Goals

- Structured first: logs are JSON lines, not ad hoc console strings.
- Local-first: logs persist on disk under the active Nodex profile.
- Safe by default: common secret-bearing fields are redacted before write.
- Bounded: large payloads are truncated so logging cannot explode on huge objects or prompts.
- Cheap to adopt: services use child loggers with contextual bindings instead of building custom wrappers.
- Non-fatal: logging must never throw back into application control flow.

## Storage Model

By default, backend logs are written under:

`$KANBAN_DIR/logs`

Default file naming:

- `backend-YYYY-MM-DD.log`

Important properties:

- One JSON object per line.
- Files are appended to for the current day.
- Old files are pruned by retention policy.
- The active profile is determined by the same `KANBAN_DIR` resolution used elsewhere in the app.

## Default Runtime Behavior

Non-test runtime defaults:

- level: `info`
- console logging: enabled
- file logging: enabled

Test runtime defaults:

- level: `info`
- console logging: disabled
- file logging: disabled

Test code can still subscribe to emitted log entries in memory via `subscribeToBackendLogs(...)`.

## Configuration

The logger is configured entirely by environment variables for now.

Supported variables:

- `NODEX_LOG_LEVEL`
  - allowed values: `trace`, `debug`, `info`, `warn`, `error`, `silent`
  - default: `info`
- `NODEX_LOG_CONSOLE`
  - enables/disables stdout/stderr sink
  - accepted falsey values: `0`, `false`, `no`, `off`
  - accepted truthy values: `1`, `true`, `yes`, `on`
- `NODEX_LOG_FILE`
  - enables/disables file sink
- `NODEX_LOG_DIR`
  - overrides the default `${KANBAN_DIR}/logs` directory
  - relative paths resolve from `process.cwd()`
- `NODEX_LOG_RETENTION_DAYS`
  - default: `14`
- `NODEX_LOG_MAX_STRING_LENGTH`
  - default: `1200`
- `NODEX_LOG_MAX_ARRAY_LENGTH`
  - default: `20`
- `NODEX_LOG_MAX_OBJECT_ENTRIES`
  - default: `40`
- `NODEX_LOG_MAX_DEPTH`
  - default: `6`

Example:

```bash
NODEX_LOG_LEVEL=debug \
NODEX_LOG_RETENTION_DAYS=30 \
NODEX_LOG_DIR=/tmp/nodex-logs \
bun run dev
```

## Log Entry Shape

Every emitted log entry includes these base fields:

- `ts`: ISO timestamp
- `level`: `trace|debug|info|warn|error`
- `msg`: message string
- `pid`: process id

Most entries also include child logger bindings and call-specific fields. Typical examples:

- `subsystem`
- `component`
- `requestId`
- `threadId`
- `turnId`
- `projectId`
- `cardId`
- `cwd`
- `durationMs`
- `status`
- `error`

Example:

```json
{
  "ts": "2026-03-09T12:34:56.789Z",
  "level": "info",
  "msg": "Starting Codex turn",
  "pid": 12345,
  "app": "nodex",
  "scope": "backend",
  "subsystem": "codex",
  "component": "service",
  "threadId": "thr_123",
  "projectId": "default",
  "cardId": "abc1234",
  "cwd": "/workspace/project",
  "permissionMode": "sandbox",
  "promptLength": 84,
  "promptPreview": "Fix the failing worktree setup and add more diagnostics."
}
```

## Redaction Rules

The logger redacts fields whose key names match this sensitive pattern:

- `password`
- `pass`
- `secret`
- `token`
- `apiKey`
- `api-key`
- `authorization`
- `cookie`
- `session`
- `credential`

Redaction is key-name based and recursive. Matching values are replaced with:

`[REDACTED]`

Important caveat:

- redaction is based on field names, not semantic inspection of arbitrary strings
- if a secret is embedded in a non-sensitive field name like `detail` or `message`, it may still be logged
- callers should prefer derived metadata such as `promptLength`, `promptPreview`, IDs, counts, and statuses instead of raw payload dumps

## Bounded Serialization

The logger serializes arbitrary objects defensively.

Rules:

- strings are truncated to `NODEX_LOG_MAX_STRING_LENGTH`
- arrays are capped to `NODEX_LOG_MAX_ARRAY_LENGTH`
- plain objects are capped to `NODEX_LOG_MAX_OBJECT_ENTRIES`
- nested traversal stops at `NODEX_LOG_MAX_DEPTH`
- circular references become `[Circular]`
- non-plain objects become tags like `[Map]`, `[Set]`, or `[ClassName]`
- `Error` values are expanded into `name`, `message`, `stack`, and `cause`

This is intentional. Logs are for diagnosis, not full-fidelity archival.

## Current Instrumentation Coverage

### App Lifecycle

[src/main/index.ts](src/main/index.ts) logs:

- main-process startup
- fatal startup failure
- `before-quit`
- `window-all-closed`
- uncaught exceptions
- unhandled promise rejections

### HTTP

[src/main/http-server.ts](src/main/http-server.ts) logs:

- server startup
- one completion record per request
- request id via `x-nodex-request-id`
- method, path, status, duration, origin
- uncaught request failures through `app.onError(...)`

Severity policy:

- `info` for normal responses
- `warn` for 4xx responses
- `error` for 5xx responses and uncaught handler failures

### Codex App-Server Client

[src/main/codex/codex-app-server-client.ts](src/main/codex/codex-app-server-client.ts) logs:

- client start and stop
- codex binary probe failures
- child process spawn details
- handshake success/failure
- connection-state transitions
- reconnect scheduling
- JSON-RPC request send/completion/timeout/failure
- server requests received and resolved
- stderr lines
- invalid protocol payloads
- child exit events

For `thread/start`, `turn/start`, and `turn/steer`, the client logs summarized parameters rather than raw payload dumps.

### Codex Service

[src/main/codex/codex-service.ts](src/main/codex/codex-service.ts) logs:

- account snapshot reads
- thread start for card
- resolved run location
- first turn start
- thread readiness/failure
- turn start and fallback resume flow
- turn steer
- turn interrupt
- approval request receipt and resolution
- user-input request receipt and resolution
- worktree setup script start/finish/failure
- thread and turn lifecycle notifications
- protocol/stderr events surfaced from the lower-level client

Codex-specific logging policy:

- do not dump full prompt bodies by default
- log `promptLength` plus a bounded `promptPreview`
- prefer IDs, counts, status flags, cwd, and duration fields

### PTY

[src/main/pty-manager.ts](src/main/pty-manager.ts) logs:

- spawn
- reconnect
- exit
- kill
- spawn failure

### Backup

[src/main/kanban/backup-service.ts](src/main/kanban/backup-service.ts) logs:

- queued backup creation
- backup creation success/failure
- queued restore
- restore start/success/failure
- invalid backup entries found during listing
- auto-backup scheduler config/start-stop/failure

### Reminders

[src/main/kanban/reminder-service.ts](src/main/kanban/reminder-service.ts) logs:

- scheduler start/stop
- per-tick summary
- snoozes
- tick failures

## Using the Logger in New Backend Code

Pattern:

```ts
import { getLogger } from "../logging/logger";

const logger = getLogger({ subsystem: "codex", component: "example" });

logger.info("Did something important", {
  threadId,
  durationMs,
});
```

Guidelines:

- create one module-level logger per file
- always bind a stable `subsystem`
- add `component` when the subsystem is broad
- log durable identifiers, not just prose
- log start/end/failure around long-lived operations
- prefer derived metadata over full raw payloads
- pass `error` objects directly when you need stack information

## What To Log

Good candidates:

- lifecycle boundaries
- retries and reconnects
- state transitions
- external process execution
- request/response timing
- typed failure paths
- branch decisions that explain surprising behavior

Bad candidates:

- unbounded payload dumps
- repeated hot-path chatter with no debugging value
- secrets
- renderer-only UX events that already have enough visibility elsewhere

## Reading Logs for Codex Debugging

Recommended workflow:

1. Find the relevant day file in `${KANBAN_DIR}/logs`.
2. Filter for `subsystem":"codex"`.
3. Narrow by `threadId`, `turnId`, `projectId`, or `cardId`.
4. Reconstruct the sequence:
   - app-server start/connect
   - `thread/start`
   - `turn/start`
   - server approval/user-input request
   - notification updates
   - reconnects or protocol errors

Useful shell examples:

```bash
rg '"subsystem":"codex"' ~/.nodex/logs/backend-2026-03-09.log
```

```bash
rg '"threadId":"thr_123"' ~/.nodex/logs/backend-2026-03-09.log
```

```bash
rg '"level":"error"' ~/.nodex/logs/backend-2026-03-09.log
```

## Failure and Safety Properties

- Logging failures are swallowed; application code should continue.
- File writes are best-effort append-only.
- Logger shutdown is called during app quit, but logs should still be treated as diagnostic rather than transactional data.
- The logger is not a security audit log or compliance system.

## Tests

Current logger-specific tests live in:

- [src/main/logging/logger.test.ts](src/main/logging/logger.test.ts)
- [src/main/codex/codex-app-server-client.test.ts](src/main/codex/codex-app-server-client.test.ts)

They cover:

- redaction
- truncation
- file persistence
- structured Codex RPC logging

## Known Limitations

- configuration is env-only; there is no UI settings surface yet
- redaction is name-based, not content-aware
- there is no log rotation by size, only daily files + retention pruning
- there is no viewer UI inside Nodex yet
- logs are local diagnostics, not immutable audit records

## Future Extensions

Reasonable next steps if needed:

- UI or settings-surface controls for log level
- on-demand log bundle export for bug reports
- size-based rotation in addition to daily files
- correlation IDs propagated from IPC entrypoints into deeper service calls
- a lightweight in-app log viewer for Codex debugging
