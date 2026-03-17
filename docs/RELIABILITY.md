# Reliability

## Reliability Goals
- Maintain durable local task state across app restarts.
- Keep board views synchronized across Electron and browser clients.
- Keep Codex thread state synchronized between main-process runtime, persisted Codex session history, SQLite link metadata, and renderer views.
- Provide safe recovery paths for destructive operations.

## Data Durability Model
- SQLite runs in WAL mode (`db-service.ts`) for resilient write/read behavior.
- SQLite schema version state is tracked in `PRAGMA user_version`.
- SQLite file reclamation runs with `PRAGMA auto_vacuum = INCREMENTAL`; startup migration applies `VACUUM` when switching to that mode, and history pruning opportunistically runs `PRAGMA incremental_vacuum`.
- Card and history writes are wrapped in transactions for atomicity.
- Project deletion cascades card/history rows to prevent orphaned state.
- Card descriptions remain materialized on `cards.description`, while historical description changes are stored in `description_revisions` / `description_blocks` and referenced from history rows via revision ids.
- Codex thread-card metadata persists in `codex_card_threads` (project/card/thread ownership, cached status, archive state).
- Persisted Codex session files under `$CODEX_HOME` / `~/.codex` are the preferred recovery source for linked thread turns/items across tab switches and app restarts.
- `codex_thread_snapshots` remains a transient/legacy fallback cache for threads whose session rollout has not materialized yet.
- Project rename updates linked Codex rows transactionally with project metadata updates.

## Backup and Restore
- Whole-store backups include `kanban.db` and asset files.
- Manual and scheduled backups are managed by `backup-service.ts`.
- Restore requires explicit confirmation and supports pre-restore safety backup.

## Sync and Event Delivery
- Electron path: DB change notifier -> main-process fanout to all open windows -> IPC event -> hook refresh.
- Electron startup path: renderer blocks behind a preload-driven bootstrap screen until main-process initialization resolves; the migration-progress IPC path remains available for future supported SQLite migrations so users are not left on a blank window.
- Electron single-instance lock scope is profile-aware: main process sets `userData`/`sessionData` under resolved `KANBAN_DIR` before calling `requestSingleInstanceLock`, so independently configured installs can run concurrently.
- Browser path: DB change notifier -> SSE stream -> hook refresh.
- Renderer applies short mutation cooldown to reduce stale refresh races.
- Renderer IPC board-change subscriptions filter by `projectId` to avoid unrelated refresh churn across windows/projects.
- Reminder path: main-process scheduler scans due reminders every 30s, dedupes with `reminder_receipts`, and emits desktop notifications while app is running.
- Resume/startup catch-up replays missed reminders within the configured catch-up window and still dedupes by receipt keys.
- Codex path: `codex-service` emits normalized `codex:event` IPC updates; renderer reduces events into thread/turn/item state.
- Codex client startup is handshake-gated (`initialize` + `initialized`) and reconnects with backoff on unexpected child exit.
- Backend observability now includes structured JSON-line logs under `${KANBAN_DIR}/logs`, covering HTTP requests, app lifecycle, PTY, backup/reminder jobs, and Codex client/service flows (thread start, turn start, approvals, user-input, reconnects, worktree setup).
- Detailed logging behavior, configuration, and extension guidelines live in `docs/product-specs/backend-logging-spec.md`.

## Failure Modes and Handling
- Oversized card payloads return HTTP `413` before DB work.
- Invalid inputs fail at validation boundary with actionable errors.
- Not-found resources return `404` from API routes.
- Current builds expect the latest SQLite schema; explicit older schema versions fail fast during startup with an unsupported-version error instead of attempting in-app migrations.
- Stale card writes with `expectedRevision` return typed conflict payloads (`status: "conflict"`; HTTP `409`) and do not apply partial updates.
- Backup restore failures surface explicit error responses.
- Reminder delivery is at-least-once at scheduler level, then effectively exactly-once per `(project_id, card_id, occurrence_start, offset)` via receipt uniqueness.
- Missing Codex CLI binary surfaces explicit `missingBinary` connection status in UI.
- Codex runtime subprocess launch augments binary lookup with common install directories (for example `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`) so packaged macOS app launches are less sensitive to GUI `PATH` differences.
- `codex:*` API calls in browser mode fail fast with explicit unsupported errors.
- Approval/user-input pending requests are rejected on Codex service shutdown to prevent hung renderer promises.
- Codex thread start tolerates rollout materialization lag (`empty session file`) by degrading to summary-only thread reads until full turn history becomes available.
- Codex follow-up turns tolerate app-server cold state after app restart: if `turn/start` reports `thread not found` for a persisted thread, the service issues `thread/resume` and retries once.
- Codex item hydration dedupes equivalent textual messages (`userMessage`, `assistantMessage`, `plan`, `reasoning`) across replay/live ID mismatches (for example synthetic `item-<n>` IDs from reads vs live `msg_*`/`rs_*` IDs) so follow-up text does not render twice.
- Backend log serialization is bounded (string/object/array limits) so debugging stays available even when services encounter unexpectedly large payloads.

## Operational Checks
- Before release: run `bun run typecheck`, `bun run lint`, `bun test`.
- Before enabling CI signing secrets: do one local notarization dry run and verify `codesign --verify --deep --strict`, `spctl --assess --type open`, and `xcrun stapler validate` against the generated macOS artifacts.
- Release CI publishes only after both `arm64` and `x64` notarized artifacts pass verification; tap sync runs after GitHub Release publication and should be retried independently if the external tap push fails.
- The authoritative release runbook for workflow triggers, job ordering, secret requirements, artifact naming, and rerun strategy is `docs/release-macos.md`.
- Before risky migrations/refactors: create a labeled manual backup.
- Keep retention settings in sync with local storage constraints.
- After large history-prune events, expect incremental vacuum to reclaim free pages gradually rather than in one blocking rewrite.
