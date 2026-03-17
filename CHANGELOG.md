# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Added derived-view Kanban block-drop import support for structured filter/sort views, including exact-slot placement when the board can infer safe workflow properties and column-level fallback when the active sort owns visible order.

### Changed
- Matched NFM editor heading typography to the reference scale, including heading weights and drag-handle alignment for heading rows.

### Fixed
- Fixed Kanban drag performance and interaction stability on dense boards by replacing the old sortable runtime with Atlassian Pragmatic Drag and Drop while preserving multi-card moves, gap insertion, and board-to-editor move semantics.
- Fixed NFM editor `cardToggle` rows so property chips now stay inline with the toggle title text and wrapped titles use the full row width, matching kanban card properties.
- Fixed the NFM editor side menu so the add-block `+` now uses the same icon color as the drag handle.
- Fixed sorted Kanban cross-column drag feedback so the destination column now shows a clear in-column target state instead of only subtle outer edge lines.
- Fixed sorted Kanban drag-and-drop so non-default sorts still allow cross-column card moves; only same-column manual ranking stays disabled.
- Fixed Kanban so card drag-and-drop no longer locks completely under active search, filter, or sort rules: filtered boards keep subset-aware reordering, and non-default sorts still allow drag-to-move across columns without pretending to manually rank a sorted column.
- Fixed the unreleased Kanban insert-position indicator so it no longer flickers from board-card/editor-import drag-handler races, and now matches the final persisted drop position for same-column reorders.
- Fixed Card Stage code blocks in light mode after the Streamdown migration by restoring BlockNote's shared dual-theme Shiki parser instead of falling back to a dark-only parser.
- Fixed the recurring NFM side-menu text-selection clipping regression by disabling hit-testing on BlockNote's floating side-menu overlay during mouse drag-selection instead of relying on brittle subtree-only CSS rules.
- Fixed local dev browser-origin HTTP requests so trusted localhost origins now receive the expected CORS headers and untrusted origins are rejected consistently even on unknown API routes.
- Fixed the Projects sidebar active-row workspace control so it no longer renders an invalid nested-button DOM tree that could trigger hydration failures.

## [0.1.5] - 2026-03-16

### Fixed
- Fixed oversized macOS release packages by keeping renderer-only libraries out of shipped runtime dependencies and pruning dead test/source-map/source-tree files from packaged Node modules.

## [0.1.4] - 2026-03-16

### Fixed
- Fixed release automation so macOS packaging now gets a larger CI-only Node heap budget, and the version commit/tag are pushed only after both release builds succeed.

## [0.1.3] - 2026-03-16

### Added
- Added a `Show raw` toggle in the Card Stage toolbar that swaps the rich description editor for a read-only raw NFM view of the current card draft, so debugging serialized content is one click away.
- Added fuzzy full-text card matching to the global command palette, with a cached MiniSearch index so card results now tolerate small typos and rank matches from descriptions, tags, assignees, statuses, column names, project names, and card ids instead of title-only token containment.
- Added Omnisearch-style contextual preview snippets to command-palette card results, with matching title and metadata indicators plus matching description text highlighted and clamped to three lines.
- Added a top-level `Projects` sidebar section for switching the DB view datasource, with inline workspace-folder context and project-management shortcuts so project selection no longer depends on a separate current-project header.
- Added per-column kanban header popovers for collapsing non-empty columns and adjusting each column's persisted width, while keeping counts and the `more actions` trigger visible on collapsed columns.
- Added notarized dual-architecture macOS release automation plus Homebrew tap publishing, so tagged releases now produce signed `arm64` and `x64` installers and can be installed with `brew install --cask nodex` after tapping `Asphocarp/nodex`.
- Added Streamdown 2.4.0-based markdown rendering across Codex threads and raw NFM code blocks, replacing the app-owned transcript Shiki/Mermaid stack with the official Streamdown code, Mermaid, math, and CJK plugins.

### Changed
- Changed the global command palette to match VS Code-style command mode: card search is now the default, and command results only appear when the query starts with `>`.
- Changed `Cmd/Ctrl+Shift+P` to open the global command palette directly in command mode with `>` prefilled, instead of opening the project picker.
- Changed the command palette to open faster, keep the workbench visible behind it instead of dimming the background, and use a heavier floating shadow for separation.

### Fixed
- Fixed the Card Stage history button so it opens reliably again after the navigation-history refactor; the cards overlay no longer clears itself by coupling the selected recent session to the active cards tab.
- Fixed DB view toolbar filter, sort, and display settings resetting after a full window close; they now persist durably per project and per supported view across reopen.

## [0.1.2] - 2026-03-14

### Added
- Added notebook-style `threadSection` blocks in the Card Stage editor so `Cmd/Ctrl+Enter` can send an explicit structure-preserving plain-text section payload, including marker-child content and nested child sections scoped to their sibling blocks, to a sticky Codex thread without leaving the editor; typing `---`, using the slash menu, or sending from unsectioned content can create a section marker, and sends now open a confirmation preview by default.
- Added a global command palette on `Cmd/Ctrl+K` and `Cmd/Ctrl+P` for jumping to cards across projects and running common shell commands like project picker, task search, settings, view switches, and terminal toggling.
- Added browser-style workbench back/forward navigation on `Cmd/Ctrl+[` and `Cmd/Ctrl+]`, with matching `Go back` and `Go forward` actions in the command palette.
- Added filtered kanban drag-and-drop support so search results can still be moved between columns or reordered without disturbing hidden non-matching cards.
- Added shared view-local filter and sort controls to the DB toolbar for Kanban, Table, and Toggle List, including compact active-rule pills in the toolbar’s bottom band with a condensed sort chip plus filter separators.
- Added an explicit empty-priority (`-`) option to toggle-list and shared DB-view filter rules, including raw-rule serialization that preserves empty-priority intent instead of relying on legacy “all priorities” matching.

### Changed
- Refined Kanban drag feedback on dense boards so board drags keep a static source ghost plus a non-layout-shifting insertion indicator, same-column reordering no longer live-shifts the whole list, drag overlays now portal to the document root with source-locked geometry so they start under the cursor instead of appearing offset, and dropping onto the visible gap between cards inserts at that gap instead of snapping to column end.
- Replaced plain status dots with semantic status icons across shared status chips and sidebar status groups, so Kanban, table, editor, thread metadata, and the Cards sidebar all use the same clearer workflow language.
- Simplified the card workflow to five canonical statuses (`draft`, `backlog`, `in_progress`, `in_review`, `done`) plus an internal `archived` flag, and updated recurring completion snapshots to archive `done` cards instead of using a hidden archive column.
- Switched persisted card ids to canonical lowercase UUID-v7 values, simplified Codex thread-link storage so `thread_id` is the sole primary key, and dropped the historical in-app upgrade chain for pre-migrated local databases.
- Changed card deeplinks to the canonical `nodex://cards/<card-id>` schema and removed the startup rewrite pass for older deeplink variants.
- Moved DB view switching out of the sidebar and into a sticky View-stage toolbar with Notion-like tabs and inline search chrome that now stays pinned above every board, table, canvas, and calendar surface.
- Updated the View-stage Table tab to use a table-specific icon instead of the generic list glyph.
- Normalized the inner view padding for table, calendar, and canvas so they line up with the existing kanban and toggle-list gutters.
- Moved top-level Toggle List rules plus both Toggle List and Kanban display controls into the View-stage toolbar, and made table-header sorting write through to the same persisted per-view sort state.
- Replaced the standalone "Show empty estimate" checkbox in Display settings with inline toggle icons on the Estimate and Priority property rows, so both fields can show `[-]` placeholders when empty.
- Extended those empty `priority` / `estimate` placeholder toggles to kanban cards as well as toggle-list rows.
- Changed the toggle-list Rules panel so a top-right `Raw` toggle swaps the visual rules editor with the raw JSON editor directly.
- Priority is now empty by default and can be cleared back to empty across the card editor, inline creator, and compact card surfaces.

### Fixed
- Fixed card-stage typing lag in the NFM editor by keeping freeform text drafts local until save/blur instead of broadcasting every keystroke through the shared project board state, while still letting Kanban card surfaces reflect the in-progress draft for that card without feeding those overlays back into Card Stage, re-rendering the full interactive card shell on every keypress, or triggering a render loop.
- Matched Kanban’s empty `priority` / `estimate` placeholder chips to Toggle List exactly, including the rendered `-` label, shared chip styling/token logic, and the same click-to-edit dropdown behavior as filled Kanban property chips.

## [0.1.1] - 2026-03-12

### Added
- Added pasted attachment chips for oversized text, pasted files, and pasted folders, with save-in-Nodex support for text/files and local-path linking for files/folders.

### Changed
- Expanded local asset handling beyond images so pasted attachments can resolve previews and metadata through the shared `nodex://assets/...` pipeline.
- Refined the titlebar sliding-window pane controls so they flank the minimap, `+` grows to the right before falling back left, and `-` always removes the right-most visible pane.
- Reworked card-description history storage so repeated large description edits now write compact revision deltas and checkpoints instead of duplicating full description blobs in every history row.
- Reworked the card history overlay so description edits now render as block-level revision deltas and snapshots by default, with an optional collapsed full diff viewer when you need the entire document context.
- Added a Backups settings control for per-project history retention so you can configure how many history rows are kept before pruning.

### Fixed
- Fixed BlockNote drag-handle delete getting the side menu stuck at a stale position after removing a block.
- Fixed the Cards sidebar so status groups start collapsed by default instead of opening every group on first render.
- Fixed sidebar status-group collapse and `Show more` state resetting after reload; both now persist per project.
- Fixed default plain-text code blocks exporting as ` ```text`; they now serialize with bare triple-backtick fences unless you choose a real language.
- Fixed copying text from inside an NFM code block so plain-text clipboard output no longer adds surrounding triple backticks.
- Fixed local database growth from repeated large description edits by dropping legacy inline history during the schema v21 migration, seeding fresh description revisions from current cards, and enabling incremental SQLite auto-vacuum.

## [0.1.0] - 2026-03-10

### Added
- Initial public release.

## [0.0.9] - 2026-03-09

### Added
- Added a kanban card context menu, deeplink wiring for cards, and cross-project card moves.
- Persisted the last workbench window state so the shell can restore its previous layout.
- Added structured backend logging for the local-first runtime.

### Changed
- Made card properties inline by default and unified selector and chip-editor chrome across the card experience.
- Tightened the history panel layout and jump-to-latest affordance for denser navigation.
- Renamed the app from Aboard to Nodex, unified the icon set, and migrated legacy asset URIs to the `nodex://assets/...` scheme.

### Fixed
- Fixed card-move menu interactions, selector focus behavior, side-menu text selection clipping, NFM tab-boundary focus escape, and project-manager open request consumption.
- Fixed project edit form seeding, restored a missing BlockNote utility source, tightened collapsed-toggle keyboard behavior, sped up local installs, and restored editor autolinking.

## [0.0.8] - 2026-03-08

### Added
- Added Codex sidebar section actions in the workbench shell.
- Expanded documentation for NFM clipboard and copy behavior.
- Added a grouped cards sidebar navigator with collapsible active groups and a cleaner DB view selector.

### Changed
- Removed the final legacy schema-version compatibility shim.
- Removed legacy asset compatibility paths, simplified schema bootstrap, dropped remaining old migration layers, and switched schema tracking to SQLite `user_version`.
- Flattened asset storage and rewrote legacy asset URIs automatically at startup.
- Unified inline and block clipboard serialization so plain-text copy preserves more editor structure and inline markers.
- Refined sidebar section headers, chevrons, recents behavior, and hover/resize timing so the shell feels more immediate.

### Fixed
- Fixed cut-aware clipboard payload generation, nested-copy parent lookup, and related code-block copy polish.
- Fixed the v19 asset migration cursor during the storage cleanup.
- Stabilized sidebar show-more collapse state and recents ordering.

## [0.0.7] - 2026-03-07

### Added
- Added collaboration Plan-mode UI, including required-input cards, multi-question navigation, answered-state rendering, and post-plan implementation flow.
- Added optimistic thread prompts, thread message copy/edit actions, copied-state feedback, and a general UI dev-story page.

### Changed
- Made Codex steering prompts fully optimistic so follow-up direction appears immediately while the runtime catches up.

### Fixed
- Fixed request-card keyboard flow, drag-preview cleanup, and pointer hit-testing around copied and draggable thread content.
- Fixed steered-thread active-status resets.

## [0.0.6] - 2026-03-05

### Added
- Added multi-window support, revision-based card conflict handling, selective install targets, and New Window app-menu and dock actions.
- Added stage-alias and settings-toggle shortcuts.
- Added inline card-property chip editing in the card stage.
- Added a project-wide optimistic journal for card mutations.
- Added instant tooltips for Codex file links.
- Added a connected-account rate-limit tooltip and thread completion notifications.

### Changed
- Scoped the Electron single-instance lock by server profile and refined thread running and elapsed indicators.
- Kept the kanban store alive across stage switches and auto-collected converged local overlays to make optimistic updates durable across the shell.
- Restyled Codex markdown links and aligned themed link token colors.
- Refined running-thread and empty-thread status rendering so the stage communicates runtime state more clearly.

### Fixed
- Fixed false stale-write conflicts during rapid card updates.
- Fixed same-card card-stage sync when external kanban mutations land while a card is open.
- Fixed Codex worktree startup races.

## [0.0.5] - 2026-03-04

### Added
- Added card run-targets with managed worktree startup, reusable per-card worktree paths, environment setup selection, auto-generated thread titles, and title-derived branch naming.
- Streamed worktree and setup progress directly into the new-thread UI and added a card-stage dev-story harness.

### Changed
- Renamed the side peek into the card stage, merged run-target controls into the Threads row, and tightened thread-stage composition and typography.
- Defaulted managed worktree starts to detached `HEAD` and surfaced the active thread cwd more clearly in the UI.

### Fixed
- Fixed run-target sync after thread start, thread reads before materialization, managed-worktree deduping and deletion semantics, stop-button state, CLI TOML parsing, and setup buffer and symlink validation.

## [0.0.4] - 2026-03-02

### Added
- Added configurable collapsed card-stage properties.
- Added a hover-reveal floating sidebar, a global right-pane width, and saner default width limits for the cards stage.
- Added real Codex model, reasoning, permission-mode, branch-selector, and live context-window controls in the thread stage.
- Added Toggle List Rules v2 with JSONLogic interop, editor support for opening markdown file links, and a redesigned settings overlay.

### Changed
- Moved kanban card properties to the top of the card UI and flattened the toggle-list rules panel into a denser Linear/Arc-inspired layout.

### Fixed
- Restored stage shortcuts while editing NFM and fixed the floating-sidebar offscreen shadow.
- Fixed Codex permission hints, branch watcher refresh, thread-stage rebase cleanup, and several remaining thread-stage UI issues.
- Fixed NFM code-fence round-tripping.

## [0.0.3] - 2026-02-27

### Added
- Added a weekly calendar with drag-to-create, drag/resize editing, an all-day lane, recurrence support, reminders, and richer event cards.
- Added the staged workbench shell with docked panels, calendar-aware navigation, settings surfaces, project emoji icons, floating search, and dual-pane stage-rail workflows.
- Integrated Codex app-server threads into the workbench with markdown rendering, tool cards, file diffs, running indicators, follow mode, persistent logs, and better exploration summaries.
- Added smart prefix parsing for block-to-card import and inserted inline-created cards at the top of the target list.

### Changed
- Reworked the shell toward a denser niri-like rail layout with glassy macOS-inspired chrome, collapsible sidebars, and a more focused titlebar and stage model.
- Consolidated calendar scheduling into a unified popover and improved special-copy and image-preview behavior in the editor.
- Shortened kanban priority badges to `P0` through `P4`.

### Fixed
- Hardened the local API by binding to loopback, enforcing a stricter localhost origin policy, validating backup IDs and calendar payloads, and capping SQL query output.
- Fixed recurring-calendar move semantics, overlap lanes, ghost previews, active-thread stop states, replayed Codex items, and a long tail of thread-stage and shell layout issues.
- Fixed Codex binary discovery in installed builds and code-block inline-copy newline escaping.
- Fixed CSS `@property` placement and ArrowDown visual-line movement from collapsed toggles whose first child is an image block.
- Fixed card-reference delete guards, active-border scoping, projected toggle-drop overwrite races, and the BlockNote toggle auto-open behavior.

## [0.0.2] - 2026-02-17

### Added
- Added richer projected inline-card workflows, including drag-handle send actions, cross-project drag/drop, childless embed normalization, and persisted projected-chip edits.
- Added inline card references, a terminal with running indicators, and an Excalidraw canvas view for card-level brainstorming.
- Added bidirectional NFM/Kanban drag-and-drop with grouped undo, spellcheck controls, richer toggle-list rules controls, and clickable property chips.

### Changed
- Replaced the terminal integration with `ghostty-web`.
- Reworked projected-card synchronization around a shared kanban store and editor controller, and made the side peek global across tabs and projects.

### Fixed
- Fixed projection reconciliation timing, focus retention, duplicate row updates, optimistic patch sync, and several inline-toggle chrome issues.
- Fixed NFM color parsing edge cases and isolated side-peek undo handling so editor undo stays scoped correctly.

## [0.0.1] - 2026-02-13

### Added
- Bootstrapped the product as a local-first kanban board for coding agents, then grew it into a packaged Electron app with web support, distribution tooling, and a CLI for automation.
- Added multi-project support, project rename/config flows, All Tasks list views, side-peek editing, detailed edit history with undo/redo, and agent-facing read and SQL introspection APIs.
- Added the NFM editor stack on top of BlockNote, including toggle blocks, Notion import fidelity, image asset paste/upload, dark mode, search/replace, and the first toggle-list views.
- Added whole-store backups, stricter card-write validation, keyboard shortcuts, empty-column auto-collapse, and persistent card and side-peek state.

### Changed
- Migrated persistence from TOML files to SQLite and tightened CLI behavior around config, output, and server defaults.
- Moved the app from a simple board UI toward a richer desktop shell with Electron packaging, better chrome, and more persistent project-aware navigation.

### Fixed
- Fixed SSE controller shutdown handling, optimistic card updates, toggle drag/drop stability, editor newline and empty-line persistence, inline creator dropdowns, tag and estimate edge cases, and a long run of early UI fit-and-finish issues.
