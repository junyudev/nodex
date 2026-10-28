# Backend Logging

## Purpose

This document is the source of truth for Nodex's backend logging system.

The backend logger exists to make local debugging fast and reliable, especially for:

- Codex app-server connection failures
- Codex thread and turn lifecycle debugging
- approval and `request_user_input` stalls
- worktree setup failures
- HTTP request failures
- integrated terminal lifecycle issues
- reminder and backup scheduler failures
- main-process startup and shutdown problems

The Electron logger is implemented in
[src/main/logging/logger.ts](../../src/main/logging/logger.ts). The native Core
uses the same policy through
[crates/nodex-core-server/src/logging.rs](../../crates/nodex-core-server/src/logging.rs).

## Design Goals

- Structured first: logs are JSON lines, not ad hoc console strings.
- Local-first: logs persist on disk under the active Nodex profile.
- Safe by default: common secret-bearing fields are redacted before write.
- Bounded: large payloads are truncated so logging cannot explode on huge objects or prompts.
- Sink-specific: terminal, durable file, and observer thresholds are independent.
- Backpressure-aware: slow disks and terminals cannot create unbounded in-memory write buffers.
- Cheap to adopt: services use child loggers with contextual bindings instead of building custom wrappers.
- Non-fatal: logging must never throw back into application control flow.

## Storage Model

When file logging is enabled, backend logs are written under:

`$NODEX_HOME/logs`

Default file naming separates concurrently running producers:

- `backend-YYYY-MM-DD-SSS.log`, where `SSS` is a monotonically increasing segment number
- `core-<profile-hash>-YYYY-MM-DD-SSS.log` for the native Core; the bounded
  Profile hash keeps custom shared log directories collision-free without
  exposing the Profile path

Important properties:

- One JSON object per line.
- Files rotate at 10 MiB by default.
- Each producer's segments are bounded by both a 14-day retention policy and a
  100 MiB budget. A producer never rotates or unlinks another live producer's
  active segment.
- Bounded asynchronous file queues isolate disk I/O from business work. Queue
  pressure discards trace/debug/info before warn/error and emits one structured
  dropped-record summary for the accumulated pressure interval.
- Electron terminal output has no additional queue. A full stdout or stderr
  stream drops subsequent terminal records until `drain`; dropped terminal
  output does not affect files or observers. Records larger than 64 KiB,
  including the newline, are omitted from terminal output.
- Files are created with mode `0600`; a newly created log directory uses mode `0700`.
- File failures disable only the file sink and attempt one emergency terminal
  error through the same protected terminal writer. A terminal write failure
  disables that stream for its lifetime without reporting back into logging.
- The active profile is determined by the same `NODEX_HOME` resolution used elsewhere in the app.
- Bootstrap and runtime diagnostics use the same serializer, sink thresholds,
  queues, and retained backend segments. Before acquiring the single-instance
  lock, a launch uses only terminal and observer sinks so a rejected second
  instance cannot modify the primary's files. Early startup exits flush pending
  diagnostics before quitting; there is no separate bootstrap log.

## Default Runtime Behavior

Unpackaged non-test runtime defaults:

- console logging: enabled
- console level: `warn`
- file logging: enabled
- file level: `info`
- observer level: `warn`

Packaged runtime defaults:

- console logging: disabled
- file logging: disabled

Packaged builds therefore do not create backend log files by default. Logging can still be
enabled for diagnostics by explicitly setting `NODEX_LOG_CONSOLE=true` or
`NODEX_LOG_FILE=true`.

Test runtime defaults:

- console logging: disabled
- file logging: disabled
- observer level: `warn`

Test code can still subscribe to emitted log entries in memory via `subscribeToBackendLogs(...)`.

## Configuration

The logger is configured entirely by environment variables for now.

Supported variables:

- `NODEX_LOG_LEVEL`
  - allowed values: `trace`, `debug`, `info`, `warn`, `error`, `silent`
  - legacy fallback applied to every sink that does not have a sink-specific level
- `NODEX_LOG_CONSOLE_LEVEL`
  - terminal threshold; default: `warn`
- `NODEX_LOG_FILE_LEVEL`
  - durable JSONL threshold; default: `info`
- `NODEX_LOG_OBSERVER_LEVEL`
  - default in-process subscriber threshold; default: `warn`
- `NODEX_LOG_CONSOLE`
  - enables/disables stdout/stderr sink
  - accepted falsey values: `0`, `false`, `no`, `off`
  - accepted truthy values: `1`, `true`, `yes`, `on`
- `NODEX_LOG_FILE`
  - enables/disables file sink
- `NODEX_LOG_DIR`
  - overrides the default `${NODEX_HOME}/logs` directory
  - relative paths resolve from `process.cwd()`
- `NODEX_LOG_RETENTION_DAYS`
  - default: `14`
- `NODEX_LOG_MAX_FILE_BYTES`
  - maximum segment size; default: `10485760` (10 MiB)
- `NODEX_LOG_MAX_TOTAL_BYTES`
  - global backend-segment budget; default: `104857600` (100 MiB)
- `NODEX_LOG_MAX_QUEUE_ENTRIES`
  - maximum pending records; default: `10000`
- `NODEX_LOG_MAX_QUEUE_BYTES`
  - maximum pending serialized bytes; default: `8388608` (8 MiB)
- `NODEX_LOG_STREAM_BUFFER_BYTES`
  - writable-stream high-water mark; default: `1048576` (1 MiB)
  - Electron backend only; Core uses its dedicated blocking writer thread
- `NODEX_LOG_FLUSH_TIMEOUT_MS`
  - per-stream shutdown/rotation flush bound; default: `2000`
- `NODEX_LOG_MAX_STRING_LENGTH`
  - default: `1200`
- `NODEX_LOG_MAX_ARRAY_LENGTH`
  - default: `20`
- `NODEX_LOG_MAX_OBJECT_ENTRIES`
  - default: `40`
- `NODEX_LOG_MAX_DEPTH`
  - default: `6`

The array/object/depth settings apply to the Electron logger's arbitrary-object
serializer. Core instrumentation accepts only explicitly named scalar fields,
so those three limits are unnecessary there. Core shares the sink, level,
directory, retention, file/queue byte, string, and flush settings.

Example:

```bash
NODEX_LOG_CONSOLE_LEVEL=warn \
NODEX_LOG_FILE_LEVEL=debug \
NODEX_LOG_RETENTION_DAYS=30 \
NODEX_LOG_DIR=/tmp/nodex-logs \
vp run dev
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

Native Core request chains use the same camel-case query vocabulary:

- `requestId`
- `connectionId`
- `adapter`
- `module`
- `operationId`
- `receiptKey` (`<module>:<operation-id-hash>`)
- `writerCommandId`
- `eventSequence`
- `queueWaitMs`
- `transactionMicros`

Caller-provided `connectionId`, `operationId`, and safe resource identities are
stored as bounded `sha256:<prefix>` correlation values. They remain stable
within a Profile/process diagnostic chain without persisting arbitrary caller
strings.

Block/Document mutation acknowledgement logs may also include:

- `workerDurationMs`: total time spent inside the Block mutation worker for the request
- `queueWaitMs`: time from main enqueue to worker execution/ack accounting
- `transactionMs`: synchronous local-store mutation duration measured in the worker
- `mainEventLoopLagMaxMs`: maximum main-process event-loop delay sampled while awaiting the worker ack
- `updateBytes`: encoded Yjs update size for Document mutations when available
- `summaryBytes`: approximate returned summary size when available

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

### Native Core

[crates/nodex-core-server/src/lib.rs](../../crates/nodex-core-server/src/lib.rs)
and the shared SQLite writer seams log:

- startup readiness, explicit/idle/signal/version-handoff drain, and shutdown
- one completion record for every authenticated or rejected UDS request, using
  a fixed allowlisted route label without query parameters; unknown paths use
  the literal `unmatched`
- successful connection binding and Adapter identity
- Module operation/receipt correlation, including exact duplicate receipts
- writer queue wait and command duration through a child span that survives the
  dedicated SQLite writer thread
- semantic deadline records with the bounded request class, declared budget,
  elapsed and admission-wait time, active/queued execution counts, and current
  phase (`admission`, `module_cpu`, reader checkout/query, writer
  queue/execution, or response)
- actual `IMMEDIATE` transaction completion or rollback duration
- committed event publication by Module and durable sequence
- replay range and explicit resynchronization boundaries
- bounded domain failure codes without error messages or recovery payloads

Core never logs request bodies, document bodies, Yjs/Canvas/Awareness bytes,
SQL text or values, prepared-operation tokens, bearer capabilities, runtime
socket paths, or local source paths. The authenticated health response exposes
the process-local cumulative `dropped_log_records` count so queue loss remains
observable even if the file sink is under pressure.

### App Lifecycle

[src/main/bootstrap.ts](../../src/main/bootstrap.ts) and [src/main/app/MainApplicationLive.ts](../../src/main/app/MainApplicationLive.ts) log:

- bootstrap startup/import failures
- main-process startup
- each retained initialization phase transition and its preceding duration
- native Core selection disposition/reason plus Host artifact validation,
  selection, authenticated connection, and total launch durations
- candidate artifact-hash duration, Store-open duration, and preparation outcome
  forwarded through the Core startup advisory stream
- renderer document-load and renderer bootstrap completion duration/outcome,
  once per owned window
- fatal startup failure
- `before-quit`
- `window-all-closed`
- uncaught exceptions
- unhandled promise rejections

### Codex App-Server Runtime

The scoped Codex runtime under [src/main/codex-runtime](../../src/main/codex-runtime) and the
protocol companion package under
[packages/effect-codex-app-server](../../packages/effect-codex-app-server) report endpoint
generation, handshake, retry, child termination and protocol failures through the Main Effect
logger. Protocol logging records safe method/request metadata and schema diagnostics; it never
copies raw params, prompts, tokens, environment values or undecodable wire payloads into logs.
The stderr transport channel is not itself a severity: unclassified lines persist as `info`, while
declared trace/debug/info/warn/error levels retain their actual severity. The service does not
duplicate these records or turn ordinary stderr diagnostics into user-visible errors.

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
- protocol errors surfaced from the lower-level client

Codex-specific logging policy:

- do not dump full prompt bodies by default
- log `promptLength` plus a bounded `promptPreview`
- prefer IDs, counts, status flags, cwd, and duration fields

### Integrated Terminal

[src/main/terminal-manager.ts](src/main/terminal-manager.ts) logs:

- create/attach failures
- local backend spawn and exit
- restart actions
- owner guard failures
- close and shutdown cleanup

### Backup

[src/main/local-store/backups.ts](src/main/local-store/backups.ts) logs:

- queued backup creation
- backup creation success/failure
- queued restore
- restore start/success/failure
- invalid backup entries found during listing
- auto-backup scheduler config/start-stop/failure

### Reminders

[src/main/local-store/reminders.ts](src/main/local-store/reminders.ts) logs:

- scheduler start/stop
- per-tick summary
- snoozes
- tick failures

### Block and Document Mutations

[Core mutation ingress](../../src/main/ipc/handlers/CoreMutationIpc.ts) and the
[native Core writer](../../crates/nodex-core/src/infrastructure/writer.rs) log:

- worker queue, transaction, and main-event-loop lag metrics for Card lifecycle, Block property, Database, Document, relocation, transfer, history, and maintenance commands
- durable Document generation/head/update-size evidence without title/body content
- bounded acknowledgement and authority-derived summary sizes where available
- typed retry/conflict/failure codes without raw mutation payloads

Content logs must never include raw Card title/body bytes, Markdown text, Yjs update bytes, or local recovery artifacts. Document sync/mutation logs may include only bounded byte counts, durable generation/head, update identity, queue/transaction timing, and typed outcome evidence. `Card` in a log field is the product alias for the affected Block, not evidence of a Card snapshot write path.

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
- use `debug` for successful hot-path events; reserve `info` for lifecycle boundaries or slow operations

## Development Runtime Metrics

High-volume `dev runtime metric` records are disabled by default. Start the app
with `vp run dev --enable runtime-metrics` to enable them for that invocation.
They are emitted at `info`, so the default durable file sink
captures an explicitly enabled diagnostic run without sending it to the default warn-only terminal.

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

1. Find the relevant day file in `${NODEX_HOME}/logs`.
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
rg '"subsystem":"codex"' ~/.nodex/logs/backend-2026-03-09-*.log
```

```bash
rg '"threadId":"thr_123"' ~/.nodex/logs/backend-2026-03-09-*.log
```

```bash
rg '"level":"error"' ~/.nodex/logs/backend-2026-03-09-*.log
```

## Failure and Safety Properties

- Serialization, observer, console, and file failures cannot escape into application code.
- Terminal error listeners are installed before writing. Synchronous throws,
  asynchronous write callbacks, error events, and stream closure disable only
  the affected terminal stream. Listeners remain attached to absorb delayed
  errors; stream failures never enter global uncaught-exception reporting.
- File writes are best-effort append-only within the active segment; closed segments are never reopened unless a later process resumes the latest same-day segment below the size limit.
- The writer waits for `drain`, bounds queued records and bytes, and favors warn/error records under pressure.
- Shutdown waits for queued records and stream completion up to the configured flush bound.
- Logger shutdown is called during app quit, but logs should still be treated as diagnostic rather than transactional data.
- The logger is not a security audit log or compliance system.

## Tests

Current logger-specific tests live in:

- [src/main/logging/logger.test.ts](src/main/logging/logger.test.ts)
- [src/main/logging/terminal-sink.test.ts](../../src/main/logging/terminal-sink.test.ts)
- [src/main/logging/stdio-failure.test.ts](../../src/main/logging/stdio-failure.test.ts)
- [src/main/codex-runtime/CodexRuntime.node.test.ts](../../src/main/codex-runtime/CodexRuntime.node.test.ts)
- [packages/effect-codex-app-server/src/client.test.ts](../../packages/effect-codex-app-server/src/client.test.ts)
- [packages/effect-codex-app-server/src/protocol.test.ts](../../packages/effect-codex-app-server/src/protocol.test.ts)
- [src/main/dev-runtime-metrics.test.ts](src/main/dev-runtime-metrics.test.ts)

They cover:

- redaction
- truncation
- independent sink filtering
- file persistence, rotation, global capacity, and queue-pressure priority
- asynchronous terminal failures, closed pipes, backpressure, and independent durable logging
- structured Codex RPC and stderr severity logging
- explicit dev-metric opt-in

## Known Limitations

- configuration is env-only; there is no UI settings surface yet
- redaction is name-based, not content-aware
- there is no viewer UI inside Nodex yet
- logs are local diagnostics, not immutable audit records

## Future Extensions

Reasonable next steps if needed:

- UI or settings-surface controls for log level
- on-demand log bundle export for bug reports
- correlation IDs propagated from IPC entrypoints into deeper service calls
- a lightweight in-app log viewer for Codex debugging
