# Architecture

## Overview
Nodex is a local-first kanban platform for coordinating coding-agent work. The Electron main process hosts SQLite state, an embedded HTTP API, and a Codex app-server runtime so CLI clients, browser clients, and the desktop renderer all operate on the same data model while Codex Threads run Electron-first.

## Codemap

### Shared Contracts (`src/shared`)
- `types.ts`: canonical domain model (`Card`, `Board`, `Project`, input payloads, block-drop import payloads).
- `ipc-api.ts`: typed IPC channel surface between preload/renderer/main.
- `card-limits.ts`: centralized payload and field size constraints.
- `assets.ts`: stable `nodex://assets/` URI helpers.
- `nfm/*`: shared Notion-flavored Markdown parser/serializer core used by both main-process storage logic and renderer editor adapters.

### Main Process and Data Layer (`src/main`)
- `index.ts`: application bootstrap (startup-init gating, DB init with migration progress fanout, HTTP server start, multi-window registry, profile-scoped single-instance lock, notifier fanout).
- `instance-scope.ts`: resolves/apply Electron `userData` + `sessionData` paths under the resolved server dir so each configured profile owns its own process lock scope.
- `http-server.ts`: Hono routes for projects, cards, history, backups, and assets.
- `ipc-handlers.ts`: mirrors core operations through IPC, including asset-path resolution and clipboard paste inspection for desktop-only file/folder paste flows.
- `clipboard-paste-inspector.ts`: best-effort Electron clipboard inspection for pasted absolute file/folder paths across supported native formats.
- `kanban/db-service.ts`: SQLite CRUD, move logic, project lifecycle, atomic block-drop import (`sourceUpdates + card creates`), and atomic card-to-editor move drop (`target updates + source delete`) grouped in one transaction.
- `kanban/history-service.ts`: undo/redo and change history records, including grouped undo/redo via `history.group_id` and description hydration from revision ids.
- `kanban/description-revision-service.ts`: top-level NFM block hashing, revision delta/snapshot storage, description reconstruction, and revision/blob garbage collection.
- `kanban/recurrence-service.ts`: recurrence expansion, exception application, and next-occurrence computation.
- `kanban/reminder-service.ts`: runtime reminder scheduler, startup/resume catch-up, receipts, and snoozes.
- `kanban/backup-service.ts`: whole-store backup/restore and scheduler.
- `kanban/schema.ts`: latest-schema bootstrap and the future-ready schema version/migration framework.
- `kanban/card-input-validation.ts`: shared write validation used by all mutation paths.
- `logging/logger.ts`: structured backend logger with child scopes, sensitive-field redaction, bounded payload serialization, and profile-scoped JSONL file persistence under `${KANBAN_DIR}/logs`.
- `workbench-resume-state.ts`: profile-scoped persisted last-window snapshot store under Electron `userData`, plus restore-eligible window gating for app reopen.
- `pty-manager.ts`: PTY process lifecycle management for per-card terminals (spawn, write, resize, kill).
- `codex/codex-app-server-client.ts`: global JSON-RPC client for `codex app-server` stdio lifecycle, handshake, request correlation, and reconnect/backoff.
- `codex/codex-service.ts`: domain facade for account/auth, thread/turn actions, approval + request-user-input handling, and normalized `codex:event` emission.
- `codex/codex-item-normalizer.ts`: maps heterogeneous app-server item payloads into stable renderer-oriented `CodexItemView` shapes (`normalizedKind`, optional `toolCall`, optional `markdownText`).
- `codex/codex-link-repository.ts`: persistence adapter for card-thread links (`codex_card_threads`) plus a legacy/transient per-thread snapshot cache (`codex_thread_snapshots`) used only when Codex session history is not yet materialized.
- `codex/codex-session-store.ts`: reads persisted Codex session artifacts from `$CODEX_HOME` / `~/.codex`, supports both legacy JSON and modern JSONL rollout layouts, and materializes thread detail for restart recovery/import.
- `codex/git-worktree-service.ts`: managed Git worktree creation for card thread starts (`autoBranch` or `detachedHead`) with base-ref resolution, thread-title-driven auto-branch naming (`<prefix><thread-slug>`), and path allocation under `${serverDir}/worktrees`.
- `codex/worktree-environment-service.ts`: lists and validates `.codex/environments/*.toml`, parses environment metadata (`name`, `[setup].script`), and enforces in-repo path boundaries.

### Preload Boundary (`src/preload`)
- `index.ts`: minimal `window.api` bridge that exposes `invoke`, event subscription, runtime server URL, and the cached Electron asset-path prefix used for synchronous local asset-path resolution.

### Renderer Application (`src/renderer`)
- `app.tsx`: workbench orchestration, Electron startup-gating screen, reminder deep-link handling, and feature-flagged shell entry.
- `components/workbench/*`: staged workbench shell (`left-sidebar`, `stage-rail`, `main-view-host`, `stage-threads`) and shell composition.
- `components/workbench/stage-threads/*`: Codex transcript rendering modules (item dispatcher, markdown pipeline, tool-card registry/specializations).
- `components/kanban/*`: board UI, card-stage editor, history panel, toggle-list UI.
- `components/kanban/editor/*`: BlockNote/NFM integration, custom blocks and inline attachment chips, keyboard behaviors, paste-resource prompting/materialization, single-editor projection helpers for `cardRef`/`toggleListInlineView` children, a shared per-editor projection sync controller (`projection-sync-controller.ts`) that owns one listener set and an owner registry, shared editor drag session coordination for editor->board drops, card-drag target registry for board->editor drops, bridged in-editor drop-indicator rendering for Pragmatic Drag and Drop card drags, and `cardToggle` snapshot/meta round-trip helpers.
- `lib/api.ts`: transport facade over explicit Electron and browser transport adapters (IPC in Electron, HTTP+SSE in browser).
- `lib/kanban-store.ts`: shared per-project board store with one realtime subscription, deduped fetches, optimistic journal rebase (`baseBoard + pending/local ops`), LWW conflict superseding, typed conflict resolution (`updated|conflict|not_found`), and O(1) `cardIndex` lookup map.
- `lib/use-kanban.ts`, `lib/use-history.ts`, `lib/use-projects.ts`: stateful hooks over API channels (`use-kanban` is store-backed via `useSyncExternalStore`).
- `lib/use-workbench-state.ts`: persisted workbench shell state with explicit project-context slices: `dbProjectId` (DB stage datasource), `threadsProjectId` (Thread stage context), entity-driven card context, and terminal per-tab project identity; DB view/search remain keyed by `dbProjectId` while focus/panel/sliding-window-pane-count/terminal shell UI is global.
- `lib/app-close-flush.ts`: renderer-side close-flush coordinator so all registered async flushers complete before one final Electron close ack is sent.
- `lib/workbench-resume.ts`: renderer helpers for consuming/saving the durable last-window snapshot and building snapshot payloads from live shell state.
- `lib/dock-layout.ts`: dock split-tree helpers for the current persisted shell layout model.
- `lib/use-workbench-shortcuts.ts`: app-wide stage-first keyboard shortcut mapping.
- `lib/use-terminal.ts`: ghostty-web terminal lifecycle hook with cached instances, fit/resize handling, IPC wiring, and theme sync.
- `lib/use-codex.ts`, `lib/codex-store.ts`: Codex Threads state, event reduction, approval/user-input queues, and API actions.
- `lib/codex-collaboration-mode-settings.ts`: local per-context collaboration mode persistence (`thread:*`, `draft:*`) with draft->thread handoff after thread creation.
- `lib/nfm/*`: renderer wrappers over the shared NFM core plus the BlockNote adapter and clipboard/read-only helpers.
- `lib/toggle-list/*`: rule engine and mapping logic for toggle-list views.

## Data and Event Flow
1. Renderer issues a command through `lib/api.ts`.
2. Transport resolves to IPC or HTTP based on runtime.
3. Main process writes through `db-service`, recurrence helpers, and records history.
4. `db-notifier` emits `board-changed`.
5. Electron main broadcasts `board-changed` to all open windows; renderer store subscriptions filter by `projectId`.
6. Renderer shared project stores (`kanban-store`) receive IPC/SSE board-change signals and dedupe refresh work per project.
6. Reminder scheduler polls occurrences, dedupes delivery via receipts, and emits `reminder:open` to renderer on notification click.

Codex Threads flow:
1. Renderer sends `codex:*` IPC actions (`lib/api.ts` + `use-codex.ts`).
2. Renderer loads `collaborationMode/list` via IPC and resolves active collaboration mode from local per-context persistence (`thread:*` or `draft:*`).
3. `codex-service` resolves card run target (`localProject` / `newWorktree` / `cloud`), including sticky per-card managed-worktree reuse via `runInWorktreePath`; for freshly created worktrees, it optionally executes selected `.codex/environments/*.toml` `[setup].script` before thread start.
4. For fresh worktree creation, `codex-service` emits `codex:event` `threadStartProgress` updates (`creatingWorktree` / `runningSetup` / `startingThread` / terminal `ready|failed`) with streamed stdout/stderr chunks so renderer can render real-time setup logs.
5. `codex-service` persists thread cwd in `codex_card_threads` (payload cwd or resolved fallback) so follow-up turns keep the same execution location.
6. `codex-link-repository` persists one-owner card-thread link metadata in SQLite, while `codex-session-store` rehydrates transcript history from persisted Codex session artifacts and falls back to SQLite snapshot cache only before session materialization.
7. Runtime notifications/server requests are normalized into structured `CodexItemView` events (`normalizedKind` + optional `toolCall` + markdown-ready text), including plan streaming (`item/plan/delta`) and queue cleanup parity (`serverRequest/resolved`).
8. Main process broadcasts `codex:event` to renderers; `codex-store` reduces deltas into thread state.

Workbench reopen flow:
1. Main process marks only windows created from zero-open-window state as restore-eligible.
2. Renderer bootstrap consumes the last saved workbench snapshot through IPC before mounting the shell.
3. Live workbench state continues to persist window-locally in `sessionStorage`.
4. On close, renderer flush coordinator runs registered flushers (canvas, workbench/card snapshot) and sends one final close ack.
5. Main process saves only the last-focused window snapshot, under the profile-scoped Electron `userData` path.

## Invariants
- Persistent truth is split by ownership: Nodex-owned board/link metadata lives in SQLite, while Codex-owned transcript history is recovered from persisted Codex session artifacts; renderer state is a cache.
- All card writes must pass `card-input-validation` constraints.
- Recurrence exceptions and reminder receipts are project-scoped and persisted in SQLite.
- Completing an occurrence creates a `done` card with `archived = true`; archived cards stay out of board/sidebar/toggle-list flows but still surface in calendar occurrence queries.
- `move` operations are claim-safe: optional `fromStatus` enables optimistic concurrency checks.
- `card:update` supports optimistic concurrency claims with `expectedRevision`; stale claims return typed `conflict` with latest card snapshot and do not mutate DB state.
- Project-scoped data stays isolated (`project_id` on cards/history with cascading cleanup).
- Renderer never accesses SQLite directly.
- Custom editor behavior must preserve NFM round-trip fidelity.
- Codex links are one-owner: one card can own many threads; each thread belongs to exactly one card.
- Codex thread creation is card-first and includes immediate first-turn submission for durable thread materialization.
- Codex thread/turn cwd must use the linked thread cwd when present (not only project workspace fallback).
- `cloud` run target is intentionally blocked at backend thread-start.
- For `newWorktree`, card-level `runInWorktreePath` is reused when available; missing/invalid paths are recreated and overwritten on the card.
- For `newWorktree`, optional `runInEnvironmentPath` stores a repo-relative `.codex/environments/*.toml` path. Its `[setup].script` runs only when creating a new managed worktree (not when reusing an existing persisted path).
- Environment setup failure aborts thread start, does not persist `runInWorktreePath`, and triggers best-effort cleanup of the newly created managed worktree.
- Managed worktree inventory is derived from linked thread cwd values rooted under `${serverDir}/worktrees`, deduplicated by resolved worktree path.
- Codex thread execution requires a project `workspacePath`; browser transport explicitly does not support Codex threads in this phase.

## Cross-Cutting Concerns

### Reliability
- WAL mode + transactional writes for consistency.
- Whole-store backups include DB and asset files.
- SSE fallback keeps browser clients reactive when IPC is unavailable.
- Codex runtime has startup gating (`initialize`/`initialized`), connection-state surfacing, and restart/backoff handling.

### Security
- Renderer runs behind preload bridge; no direct Node API access in app code.
- HTTP write routes enforce body limits and field validation.
- SQL query endpoint is read-only (`Statement.readonly` enforcement).
- Codex approval requests are policy-controlled (`auto`/`manual` per project) before command/file-change execution proceeds.

### Observability and Debugging
- History records capture create/update/move/delete deltas.
- Backend services emit structured logs (JSON lines) with child-scoped context for HTTP, PTY, backup/reminder, and Codex runtime flows.
- Backend logs persist under `${KANBAN_DIR}/logs` with bounded serialization and sensitive-field redaction for debugging without dumping raw secrets.
- Detailed logging reference: `docs/product-specs/backend-logging-spec.md`.
- Editor subsystems include focused tests for parser, keyboard behavior, and sync edge cases.
