# Nodex - Product Specification

## Overview

Nodex is a local SQLite-based kanban board designed for managing coding agents (e.g., Claude Code). It runs as an Electron desktop app with a Notion-like UI, and also serves a web interface accessible from any browser. All data is stored in a SQLite database that agents can interact with via REST API. Supports multiple independent projects, each with its own kanban board, history, and undo/redo stacks.

## Problem Statement

When working with coding agents like Claude Code, there's no streamlined way to:
1. Visualize and manage task queues across different stages
2. Allow agents to update their own status without complex integrations
3. Track agent progress in real-time
4. Maintain a simple, portable task state

## Goals

1. **Agent-Native**: Agents use REST API to read/write task status
2. **Real-Time Sync**: UI reflects changes instantly via SSE
3. **Human-Friendly**: Notion-like UI for manual task management
4. **Portable**: Single SQLite database file, easy to backup/restore
5. **Local-First**: No external dependencies or cloud services required
6. **Multi-Project**: Independent kanban boards per project

## Non-Goals

- Multi-user collaboration features
- Cloud sync or remote storage
- Mobile-responsive design (desktop-first)
- Complex workflow automation (keep it simple)

---

## Features

### Core Features

#### 1. Multi-Project Support
- Each project has an independent kanban board, history, and undo/redo
- Single-page app with staged workbench shell (left sidebar stage map + horizontal stage rail)
- Stage order: `View -> Card -> Thread -> Diff`
- Sidebar stage sections provide each stage's tab group; stage panels avoid duplicate in-panel tab strips
- Stage rail layout modes:
  - `Sliding window` (default): renders a sliding 1-4 stage window
  - `Full rail`: renders all stages in one horizontal strip
- Focus model is niri-inspired: focused stage is emphasized and auto-revealed in the active layout mode
- `Shift + mouse wheel` inside the stage rail only performs native panel scrolling; it does not change focused stage.
- Full-rail stage widths are user-resizable by dragging either left or right border of a stage panel
- Resizing a full-rail stage panel updates only that panel width (adjacent panel widths stay unchanged)
- Sliding-window mode supports 1-4 visible stage panes; requested pane count persists globally across projects
- Sliding-window mode includes resizable separators between adjacent panes; separator drag updates pane widths in real time and persists per-stage widths globally
- Sliding-window mode auto-caps effective visible panes by available width while preserving requested pane count
- Workbench top toolbar includes sidebar collapse plus sliding-window pane-count decrease/increase actions
- URL sync: `/?project=<id>`, persisted to localStorage
- Sidebar project switcher selects the DB-stage datasource only; it does not reset Card/Thread/Terminal stage contexts
- Task search query is persisted per project and restored on space switching; search input lives in the View stage toolbar
- Desktop supports multi-window in a single app process (`Cmd/Ctrl+N`): each window keeps independent navigation/session state while all windows share the same SQLite data and realtime board-change fanout
- When Nodex opens a window from zero open windows (cold launch, macOS re-activate after all windows were closed), it restores the last focused window's DB view, open card/history session, selected thread tab, and `Recents` list
- Windows opened while another window is already open still start with a fresh workbench session; restart restore does not clone the current window into every new window
- Desktop single-instance behavior is scoped per resolved server profile (`KANBAN_DIR`/`config.toml` dir). Different profile dirs can run at the same time (for example packaged release + dev build), while each profile still enforces one process with many windows.
- Card Stage open/close + selected card state is global across spaces/projects and rendered in the Card stage
- Clicking a card from the View stage in sliding-window mode ensures the Card stage is visible in the current window (`View -> Card`) by refocusing when needed
- Recent card sessions are persisted in a top-level sidebar `Recents` group across all projects, capped at 10 entries
- Entering/selecting a card never mutates `Recents`; leaving a card adds it to the front only if it is not already present, and existing entries keep their current position
- Selecting a recent card session from another project opens that card in the Card stage without changing the currently active project
- Projects with no recent card sessions do not auto-select the History overlay in the Card stage
- Sidebar rows use consistent nested indentation, with quiet top-level section labels for `Recents`, `Cards`, `Threads`, and `Diffs`, plus collapsible status subheaders in `Cards`
- Each top-level sidebar section header includes a `more actions` menu for changing its default row limit (`5`, `10`, `15`, or `20` items), moving the section up/down among visible top-level sections, and hiding the section
- The sidebar `Cards` stage group shows the current DB project's cards grouped by non-empty, collapsible status sections in canonical board order (`Ideas` -> `Done`), using title-only rows and per-section counts; collapsed status sections may still surface their active card row so the current selection stays visible
- Sidebar stage sections show at most each section's configured default row limit per subsection/list by default, with clickable `Show more` / `Show less` controls for longer lists
- Sidebar stage collapse/expand and show-more/show-less interactions animate list height and row visibility
- Hidden top-level sidebar sections stay hidden until re-enabled from Settings -> Workspace -> `Sidebar sections`, and then return in their previously saved order
- When the sidebar is collapsed, hovering the left window edge reveals a transient floating sidebar without shifting the stage rail; moving away or pressing `Escape` dismisses it while keeping the sidebar collapsed
- Sidebar footer includes a settings trigger in the same row as project spaces/switcher controls; this opens a full-page settings overlay with a left navigation rail, a `Back to app` affordance, flat section dividers, dense `Workspace`, `Editor`, and `Card` sections (`Theme`, `Stage rail layout`, `Thread finished notifications`, `Sidebar sections`, `Sans font size`, `Code font size`, `Spellcheck`, `Auto-link while typing`, `Auto-link on paste`, `Recognize bare domains`, `Large paste text threshold`, `Large paste description soft limit`, `Open markdown file links in`, `Kanban card properties`, `Card stage collapsed properties`), a `Worktrees` section (`Worktree start mode`, `Auto branch prefix`, managed-worktree inventory), plus a `Backups` section (auto-backup on/off, frequency hours, retention, manual backup, restore). `Sans font size` defaults to `15px`, persists locally, updates `--vscode-font-size`, and scales the shared sans typography tokens used by the renderer; `Code font size` defaults to `14px`, persists locally, and sets `--vscode-editor-font-size` globally.
- On macOS, traffic-light window controls stay visible at top-left; when the sidebar is expanded, the sidebar collapse control sits beside them in the sidebar top strip, and when collapsed the same control is rendered in the titlebar left region
- Card stage session selection lives in the sidebar alongside the current DB project's grouped card navigator; card history opens as a card-specific overlay from Card Stage
- Settings can choose which optional card-stage rows start behind the Card Stage `more properties` toggle (`Tags`, `Assignee`, `Threads`, `Schedule`, `Agent blocked`, and `Agent status`)
- Terminal is a global bottom foldable panel (VS Code-like) with mixed tabs (`project` shell tabs and `card` shell tabs)
- Terminal panel open/closed state and panel height persist globally in shell state
- `Cmd/Ctrl + J` toggles the global terminal panel from anywhere in the app
- Thread stage is a live Codex workspace in Electron (auth, linked threads, streaming events, approvals)
- Answered `request_user_input` prompts remain visible in the transcript as a compact `Asked N question(s)` disclosure row that stays collapsed by default and expands to show the question/answer pairs
- When a completed turn's latest plan item is non-empty, the composer swaps into an `Implement this plan?` request surface with `Yes, implement this plan` plus an inline `No, and tell Codex what to do differently` freeform path; accepting sends a follow-up prompt prefixed with `PLEASE IMPLEMENT THIS PLAN:` and resets collaboration mode to `Default` for that follow-up turn
- Follow-up prompts sent to an already-running turn appear in the transcript immediately on submit, before `turn/steer` returns; if steering fails the temporary row is rolled back, and if steering succeeds the later authoritative user-message item deduplicates the temporary row instead of rendering twice
- Thread stage project context is stage-local (`threadsProjectId`) and remains stable when DB datasource changes
- By default, desktop notifications fire when a Codex thread finishes; the notification title uses the thread title and the body uses the latest turn message. Settings can disable this.
- Diff stage is an interactive placeholder in this release
- Create/delete projects via switcher dropdown or CLI
- Default project "default" seeded on first boot
- In Electron, startup opens into a blocking bootstrap surface until local initialization completes; when a supported SQLite schema migration is running, that surface shows determinate migration progress and migration-specific status copy
- Project ID: lowercase alphanumeric with hyphens (e.g., `my-project`)
- Project icon: optional per-project emoji persisted in SQLite; when empty, UI shows a project-colored dot
- Project workspace path: optional filesystem path persisted per project and used as Codex thread `cwd`
- Sidebar project header shows the current workspace path under the project title; a folder icon/button opens a native directory picker and saves the selection
- Project icon input in the spaces switcher includes a button that opens the native macOS emoji picker panel
- CASCADE delete removes all cards and history for a project
- Codex thread links are one-owner: one card can own many threads, each thread belongs to one card

#### 2. Kanban Board View
- 8 columns representing workflow stages
- Drag-and-drop cards between columns
- Shift-click in Kanban toggles a temporary multi-selection from the clicked card; selection can span columns, dragging moves the whole selected set together as one grouped undo step, and dropping into editors inserts one `cardToggle` per selected card before deleting all source cards in the same grouped action
- Native block drag from visible NFM editors (Card Stage, including projected inline embed rows) into Kanban columns creates card(s) using move semantics (source blocks are removed)
- Dragging a Kanban card into a visible NFM editor (Card Stage, including projected inline embed rows) creates a standalone `cardToggle` snapshot block and removes the source card (move semantics)
- Card->editor drop is pointer-anchored, blocks self-drop, supports same-project and cross-project sources, and persists as one grouped undo/redo action (target description update + source card delete)
- Card->editor drag shows a live in-editor insertion line (matching BlockNote drop-cursor semantics) even though the drag source is dnd-kit
- `cardToggle` chips (`priority`, `estimate`, `status`) are editable inline in NFM editors and mutate both serialized `meta` and embedded snapshot payload
- Dragging a `cardToggle` block back into Kanban creates card(s) with snapshot-preserved properties (priority/estimate/tags/assignee/due-date/scheduled-start/scheduled-end/blocked) plus current title/description edits
- Block-drop card creation uses pointer-based insertion (top/middle/bottom) with a visible drop indicator
- Block->card import supports strict smart shorthand parsing for non-`cardToggle` blocks (`0..4`, optional estimate `XS/S/M/L/XL`, optional `(tag)`), applying parsed values to `priority`, `estimate`, and `tags`
- Visual card previews with priority badges
- Kanban card property chips (priority/estimate/tags/assignee) render inline with the card title by default, and Settings can move them above the title or below the body
- Right-clicking a Kanban card opens a Radix context menu with a searchable action list; `Copy link` copies an `nodex://card/<card-id>` deeplink to the target card, `Delete` removes the card, and clicking `Move to` advances the same menu into a searchable in-place project picker that moves the card into the same workflow column in the selected project
- Real-time updates when data changes
- Card updates include revision-based stale-write detection: stale edits return typed `conflict` results instead of silent last-write-wins
- Card Stage surfaces conflicts inline with explicit recovery actions: `Reload Latest` (drop local draft fields) and `Overwrite Mine` (retry on newest revision)
- Header task search supports token-contains matching across title/description/tags/assignee/agent status/id in Kanban, All Tasks, and Toggle List views
- While a search filter is active in Kanban view, drag-and-drop is disabled to avoid ambiguous reorder semantics on filtered subsets (including native block-drop import)

#### 3. Toggle-List View
- Third project page tab (`Toggle List`) renders cards as top-level toggle rows in a specialized BlockNote editor
- Each top-level toggle row maps to one card: editable title in row header, with description mapped to child blocks
- Toggle-list editor uses the same shared slash-menu controller as Card Stage (defaults + custom blocks) to keep insertion UX aligned
- Inline embeds (`cardRef`, `toggleListInlineView`) use single-editor projection: referenced card rows are projected as children in the host NFM editor (no nested BlockNote editor instances)
- Projection sync for inline embeds is shared per editor instance (one listener set + owner registry) instead of per-embed listeners, so typing latency remains stable with many embeds open
- Board state sync is shared per project (`useKanban` store-backed): one realtime subscription/fetch pipeline fans out to all consumers and exposes O(1) `cardIndex` lookup
- Card description toggles in Toggle List + inline toggle-list embeds honor NFM `▼` (expanded) / `▶` (collapsed) prefixes on load, and toggle-click changes are persisted back to card descriptions (and synced across views)
- Rule controls above the editor:
  - Single advanced rules surface: grouped filter logic (`OR` across groups, `AND` within group) with status/priority/tag clauses, ordered sort stack editing, and JSONLogic import/export interop
  - property controls: reorder + hide/show for `priority`, `estimate`, `status`
- Rules editing panel is foldable/collapsible so users can keep a compact reading-focused layout
- Folded/expanded state of the rules panel is persisted per project in renderer localStorage
- Row properties render as Notion-like chips (priority/estimate/status) matching existing board/card-stage visual language
- Toggle-list editor surface reuses the same `nfm-editor` styling layer used by Card Stage for consistent typography/spacing/toggle visuals
- Bi-directional sync:
  - editor title/description edits sync back to card updates
  - board updates from Kanban/List/card-stage refresh toggle rows
  - projected-row edits apply local optimistic card patches before remote persistence so board/list views reflect changes immediately
- Structural guard blocks manual insert/delete/reorder/type-change of top-level card rows; structure is rule-driven
- Toggle-list settings persist per project in renderer localStorage (`nodex-toggle-list-settings-v1`)

#### 4. SQLite Database Storage
- Single `kanban.db` file in kanban directory
- Atomic transactions for data integrity
- Schema v18 with projects/cards/history/canvas, Codex card-thread linking metadata, card run-target fields, and per-card optimistic-concurrency revisions

#### 5. Card Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | Yes | 7-character alphanumeric ID |
| `title` | string | Yes | Task name (max 512 chars) |
| `description` | string | No | [Notion-flavored Markdown (NFM)](../references/notion-flavored-markdown-spec.md) details (default: ""), including `<image ...>` blocks and inline `<attachment kind="text|file|folder" mode="materialized|link" ... />` chips with local or managed asset URIs (max 1,000,000 chars) |
| `priority` | enum | No | p0-critical, p1-high, p2-medium, p3-low, p4-later (default: p2-medium) |
| `estimate` | enum | No | xs, s, m, l, xl |
| `tags` | string[] | No | Custom labels (default: [], max 64 tags, each max 64 chars) |
| `dueDate` | date | No | Task deadline (YYYY-MM-DD format) |
| `scheduledStart` | datetime | No | Scheduled start timestamp (ISO 8601) used by Calendar and recurrence windows |
| `scheduledEnd` | datetime | No | Scheduled end timestamp (ISO 8601, must be after `scheduledStart` when both are set) |
| `isAllDay` | boolean | No | Explicit all-day flag; when `true`, schedule is stored as local-day start plus end-exclusive day boundary (`scheduledStart` + `scheduledEnd` required) |
| `recurrence` | object | No | Repeat rule (`daily|weekly|monthly|yearly`, interval, optional weekdays, optional inclusive until date) |
| `reminders` | object[] | No | Reminder offsets in minutes before each occurrence start (`[{offsetMinutes}]`, deduplicated) |
| `scheduleTimezone` | string | No | IANA timezone used to anchor recurring schedule expansion |
| `assignee` | string | No | Who's working on it (max 256 chars) |
| `agentStatus` | string | No | Current agent status message (max 1,024 chars) |
| `agentBlocked` | boolean | No | Whether agent is blocked (default: false) |
| `runInTarget` | enum | No | Where new card threads run: `localProject` (default), `newWorktree`, `cloud` (mock/blocked) |
| `runInLocalPath` | string | No | Optional local folder override used when `runInTarget=localProject`; empty means project workspace path |
| `runInBaseBranch` | string | No | Optional base branch for new worktree creation (`runInTarget=newWorktree`) |
| `runInWorktreePath` | string | No | Persisted managed worktree path used for sticky reuse when `runInTarget=newWorktree` |
| `runInEnvironmentPath` | string | No | Optional repo-relative `.codex/environments/*.toml` path used when creating a new managed worktree |
| `revision` | number | Yes | Monotonic per-card revision used by optimistic stale-write detection (`card:update expectedRevision`) |
| `created` | datetime | Yes | Creation timestamp (ISO 8601) |
| `order` | number | Yes | Sort order within column (0-indexed) |

#### 6. Inline Card Creator
- Notion-style inline form in each column
- Cards created via the inline creator are inserted at the top of the current column
- Quick-add with priority, estimate, tags
- Enter to save, Escape to cancel
- Priority/estimate dropdowns use Radix Select popper positioning for reliable rendering with custom trigger chips
- Click-outside save/cancel logic ignores portaled select menus so property selection does not dismiss the creator

#### 7. Card Stage Editor
- Notion-style slide-out panel for card details
- Always-editable fields (no edit mode toggle)
- Auto-save on close (1s debounce + immediate save on blur)
- Card Stage visibility context is global: switching spaces/projects and views keeps the current Card Stage state/card until explicitly closed
- Card Stage draft fields survive view/space switching because local patch/update/move operations keep the active card snapshot in sync
- Card Stage Properties includes schedule editing with an `All-day` mode toggle.
- Card Stage Properties includes a `Run in` selector for new thread execution target: `Local project` (with optional folder override picker), `New worktree` (base-branch selector + environment selector for `.codex/environments/*.toml`), and `Cloud` (mock/unavailable).
- Timed mode uses start/end `datetime-local` inputs with quick actions (`Set schedule`, `Now + 1h`, `Clear`) and automatic end-after-start guardrails.
- All-day mode uses start/end `date` inputs (end shown as inclusive in UI, persisted as end-exclusive storage) with the same guardrails.
- Tag input suggests existing project tags while typing via native autocomplete options (excluding tags already on the current card)
- BlockNote block editor for description (Notion-flavored Markdown)
- BlockNote structural animations are mostly disabled in-editor (including indent/unindent depth transitions) to keep editing interactions immediate
- NFM link labels are escape-normalized on parse, so repeated auto-save cycles remain idempotent (prevents exponential backslash growth on escaped markdown markers inside link text)
- NFM autolink behavior is renderer-configurable: typing and paste recognition can be toggled independently, bare-domain recognition defaults on, and paste-time matching is intentionally strict enough to leave repo paths, slash-separated path segments, local file paths, and filename-like text such as `foo/bar/baz.md`, `local/code-block-mock-ui/action-menu-popper.com`, or `nfm-editor-copy-behavior.md` plain by default
- Detailed autolink rules and examples: [NFM Editor Autolink Behavior](./nfm-editor-autolink-behavior.md)
- Card writes are validated before persistence (field limits + enum/type checks), and oversized HTTP payloads for create/update are rejected with `413`
- `Shift+Enter` hard line breaks are persisted within the same block across app restarts
- Enter-created blank paragraph lines are persisted as `<empty-block/>` and preserved across app restarts
- Toggle headings (`▶# Heading`) supported: headings with collapsible children, matching Notion's toggle heading behaviour
- Toggle open/closed state is persisted in NFM using `▼` (expanded) / `▶` (collapsed) markers; state survives save/reload cycles via a localStorage bridge that pre-populates BlockNote's `defaultToggledState` on editor init and reads DOM `data-show-children` on save
- `ArrowUp` / `ArrowDown` across a collapsed toggle boundary preserve browser-native visual-line movement and never jump into hidden edge non-inline children while the toggle stays collapsed
- Typing `## ` inside a toggle header converts it to a toggle heading (preserves toggle state)
- `Cmd+Enter` toggles the current toggle block or toggle heading open/closed while editing
- `Enter` at end of an open toggle header (or toggle heading) with no children still creates a first child paragraph (Notion fallback) instead of a sibling block
- `Enter` in the middle or at the end of any inline parent block that already has children splits trailing parent text into a new first child paragraph
- `Backspace` at the start of a leaf child block under an inline parent always merges into the previous sibling, or into the parent if it is the first child
- `Enter` at the start of an empty leaf child block under an inline parent creates a sibling paragraph in the same child group instead of unindenting
- `Cmd+A` selects only the current block content while editing
- Normal copy/cut uses one cut-aware clipboard model across `blocknote/html`, `text/html`, and structure-preserving `text/plain`; it preserves the rich clipboard payloads and rewrites `nodex://assets/...` paths only in `text/plain` for external use when the sync asset-path prefix is available
- Detailed copy rules and examples: [NFM Editor Copy Behavior](./nfm-editor-copy-behavior.md)
- `Cmd/Ctrl+F` opens in-editor find for NFM description with sticky find bar, match count, previous/next navigation (`Enter`/`Shift+Enter`), and highlighted matches; when editor text is selected, the find query seeds from that selection
- Replace controls are hidden by default and shown in a second row only when toggled; supports `Replace` (current match) and `Replace All`
- Find/replace UI uses a floating dark two-row panel (top: find + nav, bottom: replace) anchored in-editor without shifting document content
- Search includes text inside collapsed toggles; collapsed toggle ancestors are expanded only when navigating to a matched result inside them
- Drag-hovering collapsed toggle headers (`toggleListItem`, toggle headings, and `cardToggle` rows including projected rows under `cardRef` / `toggleListInlineView`) keeps a stable, Notion-style overlay highlight with pointer-coordinate hit-testing plus drop-time active-target fallback for side-menu retargeting (no rapid flicker), and supports diagnostics via `window.__TOGGLE_DND_DEBUG__ = true`
- Image blocks are supported in NFM (`<image source="...">Caption</image>`) and render in both editor and read-only previews
- Mouse drag/range selections that span image blocks show a blue-tinted image-block highlight/outline so inclusion is visually explicit
- Image block floating toolbar includes `Copy image` (copies image bytes when supported, otherwise copies resolved image URL text)
- Pressing `Space` while an image block is focused opens a larger centered modal preview; pressing `Space` again closes it (Esc/click outside also close)
- Double-clicking an image block opens the same large preview modal
- Image preview modal includes zoom controls (`+`, `-`, reset) with a visible zoom percentage
- Pasting images uploads them to shared local assets and inserts image blocks automatically
- Pasting from Notion preserves block structure (including toggle blocks and nested children) when Notion clipboard metadata is present
- Notion paste preserves inline rich text marks (`bold`, `italic`, `strikethrough`, `code`, `underline`) and inline text/background colors from Notion annotation metadata (`h` color tokens)
- When pasting plain text that exceeds the configurable `Large paste text threshold` (default `100,000`) or would push the description near the configurable `Large paste description soft limit` (default `750,000`), Nodex intercepts the paste and offers `Save in Nodex`, `Paste anyway`, or `Cancel`, with a truncated, scrollable preview of the pasted text and character/line metadata in the dialog
- On Electron desktop, if the native clipboard exposes actual file or folder entries, Nodex intercepts the paste before default BlockNote handling. File paste offers `Save in Nodex`, `Keep as link`, or `Cancel`; folder paste offers only `Keep as link` or `Cancel`. Plain copied absolute paths in `text/plain` do not trigger this prompt, and browser runtime does not promise file/folder paste parity
- `Save in Nodex` stores pasted text/files in shared local assets and inserts an inline `attachment` chip. Saved text-like attachments open a scrollable preview capped to `200` lines or `64 KiB`
- `Keep as link` inserts an inline `attachment` chip that references the original absolute path for pasted files/folders; this option is not shown for oversized plain-text prompts, and it is the only supported folder-paste action
- `Paste anyway` bypasses the attachment flow and inserts the oversized text directly into the note despite the warning
- Attachment chips stay inline with surrounding paragraph content, show only concise label/icon chrome, reveal a short hover hint, and open a click popover with metadata plus `Open`, `Reveal`, `Copy path`, and `Open original` actions when an original path exists
- Detailed attachment-chip rules and examples: [NFM Editor Attachment Chip Behavior](./nfm-editor-attachment-chip-behavior.md)
- Slash menu (`/`) for inserting block types
- Slash menu includes a custom `Toggle List Inline View` block insertion item
- `Toggle List Inline View` is a custom NFM block (`<toggle-list-inline-view ... />`) that renders a low-distraction inline sequence of toggle rows for a chosen source project
- Inline block row headers reuse existing property chip styles (`priority`, `estimate`, `status`) on the same title line
- Inline block is rendered full-width in the editor flow with a chrome-less container (no extra wrapper margin/padding/background/indent), card rows use the standard toggle-caret icon style, and `toggleListInlineView` block-content padding is reset to `0`
- Inline embed root rows explicitly cancel BlockNote nested-group left margin so `toggleListInlineView` rows stay left-aligned with surrounding blocks
- Inline controls remain available via lightweight top-right actions without adding persistent container chrome
- `toggleListInlineView` top-right action bar includes a dedicated drag handle button that drags the embed owner block directly
- `cardRef` owner dragging is available from the left BlockNote side-menu drag handle; when hovering projected rows/descendants, the handle targets the owning `cardRef` block (not the projected child row)
- Inline block actions support source-project selection and foldable advanced rules editing (single dense control surface), with rules-panel expanded state persisted in localStorage (not in NFM block props)
- Inline toggle-list rules persist canonically as `rulesV2` (base64url JSON); old status/priority/tag/rank attrs are ignored.
- `toggleListInlineView` excludes the current host document card by default when source project matches the host; users can include it from Rules (`Include current host card`)
- Inline card rows are projected directly into the host NFM editor tree as child `cardToggle` rows; drag handles and block DnD operate on one editor surface (no nested side-menu conflict)
- `cardRef` / `toggleListInlineView` are childless embed blocks at persistence boundaries: parser/adapter/serializer normalize away direct children so NFM always stores them as self-contained tags (`toggleListInlineView` persists `rules-v2="..."` when explicit rules are present, otherwise current defaults apply in-memory).
- Dropping host-document blocks onto a `toggleListInlineView` owner/root boundary creates cards in the inline view's source project instead of nesting blocks under the embed; target status/index are inferred from pointed row neighbors and active rank/filter rules (best-effort)
- Projected row roots are structure-guarded for manual insert/delete/reorder, but dragging a projected row root out to host-doc scope materializes it into a standalone `cardToggle` and deletes the source card using source-project metadata (works for same-project and cross-project projected sources); child blocks inside projected rows remain freely draggable in/out
- Inline block recursion is guarded: nested same-source inline views render an infinity placeholder (`∞`) instead of expanding recursively
- Drag-handle block menu includes a `Send blocks` submenu with `Append to card...` and `Turn into cards...`; both remove the selected source blocks (move semantics), and persist grouped history updates for affected card descriptions/creates
- Drag handles, formatting toolbar, block selection
- Delete card action
- View history button opens a card-specific overlay timeline for the currently open Card Stage card
- History panel supports operation filters, keyboard/list navigation, and entry-level detailed views (update before/after field diffs, move from/to columns, create/delete snapshots)

#### 8. Edit History & Undo/Redo
- Full edit history tracked in SQLite `history` table
- Session-scoped undo stacks (each renderer/browser tab has independent history)
- Keyboard shortcuts: `Cmd+Z` (undo), `Cmd+Shift+Z` (redo) — see `docs/KEYBOARD_SHORTCUTS.md` for full reference
- Operations tracked: create, update, delete, move
- Grouped undo/redo is supported via `history.group_id` so one undo can revert a multi-step atomic action (for example: block-drop import creates + source updates)
- Delta storage (only changed fields stored, not full snapshots)
- History panel is card-scoped (opened as an overlay from Card Stage) and shows a per-card edit timeline with timestamps, plus selectable detail panes for field diffs and snapshots
- History panel is resizable (640–1400px, default 960px) with width persisted in localStorage
- **Revert single change**: Undo a specific history entry (update, move, create, or delete) — creates a new forward history entry so the revert is itself visible and reversible
- **Restore to point**: Time-travel a card to any historical state by reconstructing from creation snapshot + forward deltas; applies field updates and column moves as needed
- Action buttons shown in entry detail view with inline confirmation flow; disabled for undo meta-entries
- Card stage auto-refreshes card state after history mutations via `onCardMutated` callback
- Toast notifications after undo/redo actions

#### 9. Whole-Store Backups
- Manual backup creation via CLI/API (`kanban.db` + `assets/`)
- Automatic backups every 6 hours with retention of latest 28 auto backups
- Restore requires explicit confirmation and creates a pre-restore safety backup by default
- Backup artifacts are stored under `~/.nodex/backups/<backup-id>/` with a versioned `manifest.json`

#### 10. Canvas View (Excalidraw)
- Canvas tab provides a freeform whiteboard per project for card brainstorming and visual mapping.
- Scene persistence stores Excalidraw `elements`, `appState`, and `files` so embedded images survive reloads/project switches.
- Canvas payload supports image-heavy scenes up to 20 MB over HTTP transport.
- Canvas saves are flushed on page lifecycle transitions and during app-window close handshake to reduce lost edits when quitting.

#### 11. Calendar View
- Calendar tab shows scheduled cards in a day-grid timeline (4-day or week view).
- Calendar has a dedicated all-day lane above the timed grid, and all-day cards render only in that lane.
- Multi-day all-day cards render as one horizontal span across covered day columns using end-exclusive day range semantics.
- All-day lane overflow is vertical-scrollable.
- A draggable separator between all-day lane and timed grid resizes lane height; height preference persists per project and day-count view in localStorage.
- The separator is keyboard-accessible (`ArrowUp`/`ArrowDown` with `Home`/`End` bounds) and exposed as an ARIA horizontal separator.
- Timeline hour height auto-fits to available panel height with a minimum readable hour height.
- `Shift + mouse wheel` navigates by one day per step as a smooth rolling window (including week view), without requiring toolbar clicks.
- In Calendar view, `Shift + mouse wheel` is handled by the calendar surface first (including the calendar toolbar), and does not trigger stage switching or stage-rail horizontal scrolling.
- Users can drag existing calendar cards to move them across visible days and times while preserving duration.
- Calendar move-drag uses native drag lifecycle, so the drag ghost follows the pointer across the desktop (including when leaving the app window).
- Dragging supports timed/all-day conversion:
  - Timed -> all-day: sets `isAllDay=true`, snaps start to local midnight of target day, and preserves span as `ceil(duration/24h)` days (minimum 1).
  - All-day -> timed: sets `isAllDay=false`, drops at target slot time, preserves meaningful sub-day duration when available, otherwise uses 1 hour fallback.
- During an active drag move, target feedback is region-specific:
  - Timed target: source card stays ghosted at origin while a timed ghost preview is shown in-grid.
  - All-day target: source card stays ghosted at origin while an all-day ghost span appears in the all-day lane.
  - Outside calendar target: a cancel indicator appears and dropping does not change schedule.
- Side-by-side lane width is driven by peak simultaneous overlap within a connected overlap chain, so transitive-only neighbors do not create phantom extra lanes.
- Users can resize scheduled ranges by dragging the top or bottom edge of a calendar card; updates snap to 15-minute slots.
- Calendar rendering is occurrence-based (`calendar:occurrences`) so recurring cards expand into time-windowed event instances.
- Calendar event cards display a repeat indicator on occurrences derived from recurring cards, with a distinct icon for the first occurrence in each series.
- Card Stage exposes repeat settings (frequency, interval, weekly weekdays, inclusive end date), reminder offsets, and schedule timezone.
- Users can complete or skip a specific occurrence from Calendar quick actions and from Card Stage.
- Completing an occurrence creates a new snapshot card in hidden status `n-archive`; archived events remain visible on Calendar with muted styling.
- Recurrence logs are not exposed in product UI or API.
- Occurrence schedule edits support scope: `this`, `this-and-future` (series split), and `all`.
- For recurring event drag/resize from Calendar, the app prompts with explicit scope choices before persisting. On the first occurrence in the current series, it shows `Only this occurrence` and `All occurrences`; on non-first occurrences, it shows `Only this occurrence` and `This and future`.
- Choosing `Only this occurrence` detaches that occurrence into a standalone non-recurring card while the original series skips that occurrence.
- Choosing `This and future` trims the original series to end the day before the selected occurrence and creates a new series from the selected occurrence onward; when selected on the first occurrence, it behaves like `All occurrences` (no split).
- For drag-based recurrence schedule moves (`All occurrences` and `This and future`), if the series has an inclusive end date (`untilDate`), that date shifts by the same calendar-day delta as the dragged occurrence so series length is preserved.
- Desktop reminders fire while the app is running, include startup/resume catch-up, and notification click deep-links to the target card Card Stage.

#### 12. Codex Threads (Electron-only in this phase)
- New threads are created from a card and linked immediately to that card.
- Thread creation requires the first user prompt and immediately starts the first turn.
- New threads auto-generate a concise title from the first user prompt using `scripts/generate-thread-title.md` (`gpt-5.1-codex-mini`, reasoning effort `low`) unless an explicit thread name is provided.
- Thread stage always includes a persistent `New thread` tab.
- In Card Stage `Threads`, pressing `New` focuses the Thread stage `New thread` tab (no inline Card Stage prompt composer).
- The `New thread` tab shows the selected project/card context and uses the stage composer for the first prompt.
- Card `Run in` defaults to `Local project`, so new threads run in `runInLocalPath` (when set) or the project workspace path.
- `New worktree` run target creates a managed Git worktree under `${serverDir}/worktrees/<rand4>/<project-id>` and links thread cwd to that worktree.
- For `New worktree`, first thread creation persists the managed worktree path on the card (`runInWorktreePath`), and subsequent new threads for that card reuse it.
- If the persisted managed worktree path is missing/invalid (for example deleted outside Nodex), thread start recreates a managed worktree and overwrites `runInWorktreePath`.
- For `New worktree` before first creation (no persisted `runInWorktreePath`), Card Stage shows an environment selector populated from `<workspace>/.codex/environments/*.toml`, with a `No environment` option and an `Environment settings` action that opens `<workspace>/.codex/environments` in the file manager.
- If `runInEnvironmentPath` is selected and points to a valid `.toml` file with `[setup].script`, that script runs in the newly created managed worktree before `thread/start`.
- Environment setup failure aborts thread creation, does not persist `runInWorktreePath`, and best-effort removes the just-created managed worktree.
- During `New worktree` creation, the `New thread` panel shows a real-time setup log view (`Creating a worktree and running setup.`) with streamed progress from worktree creation and setup script output.
- Reusing an existing persisted `runInWorktreePath` does not re-run environment setup.
- Settings -> `Worktrees` shows managed inventory deduplicated by resolved worktree path (reused paths appear once).
- Settings -> `Worktrees` delete removes the managed directory (prefer `git worktree remove --force` when metadata is available, otherwise recursive delete) and unlinks all thread links that target the same managed path.
- Card Stage `Threads` row shows a `Reset worktree` control when reusing a persisted path; reset clears `runInWorktreePath` so the next thread creates a fresh managed worktree.
- Worktree base branch resolution order is: remote HEAD symbolic ref, then `main`, then `master`, then current branch, then first available local branch.
- Global worktree creation mode is configurable in Settings -> `Worktrees`: `Auto branch` (creates `<prefix><thread-slug>`; default prefix is `nodex/`, and thread slug is derived from the thread title by lowercasing, keeping the first 5 words, stripping non-`[a-z0-9]`, then joining with `-`) or `Detached HEAD` (default).
- `Cloud` run target is explicitly blocked in both renderer preflight and backend thread-start validation in this release.
- Sending from `New thread` creates the thread and switches focus to the newly created thread tab.
- As soon as a turn starts, the transcript shows the submitted user prompt optimistically and keeps that bubble visible above the pending `Waiting for response…` state until live response items arrive; when the live user-message item later arrives, it is deduped instead of rendering twice.
- Threads can navigate back to the owning card (`Open card`) from the Thread stage.
- Running threads keep syncing in the background when users switch to another thread tab; returning to the running tab preserves live state (including stop affordance and existing tool-call logs).
- Thread tabs show a running indicator for actively executing threads.
- Sidebar thread entries (and the Threads group icon) switch to a running indicator while execution is active.
- In-app account UX supports account read, ChatGPT/API-key login, login cancel, logout, and a `Connected` tooltip that refreshes on reveal and shows the remaining primary/secondary rate-limit windows when available.
- Approval policy is per-project: `auto` by default, with optional `manual` mode in Thread stage.
- Thread stage composer exposes real Codex model and reasoning-effort selectors; selections persist globally in local storage and are applied to the first turn of new threads and subsequent turns.
- Thread stage composer exposes collaboration mode presets (`Default`, `Plan`) sourced from app-server `collaborationMode/list` with a client fallback to `Default` + `Plan` when unavailable.
- Collaboration mode selection is persisted locally per thread context (`thread:<threadId>`) and per new-thread draft context (`draft:<projectId>:<cardId>`), with draft selection migrated to the created thread after first-turn creation.
- Thread and turn start requests include `collaborationMode` when selected; `Plan` mode enables clarifying-question flows through `item/tool/requestUserInput`.
- Multi-question `request_user_input` cards preserve keyboard continuity: using `Left` / `Right` to move between questions keeps focus on the next question's equivalent answer control instead of dropping focus out of the card, and option questions let `ArrowDown` move from the last preset choice into the free-form row while `ArrowUp` at the start of that free-form field returns to the preset choices.
- Thread stage composer also shows the real Git branch for the effective thread `cwd` (falling back to the project workspace path), and that branch chip auto-refreshes when the current worktree switches branches outside the app.
- Threads composer uses one round icon button: it sends when idle, shows a spinner immediately while the prompt send is pending, and switches to a stop icon while Codex is running so users can interrupt immediately.
- Threads composer send shortcut defaults to `Enter` (with `Shift+Enter` for newline) and is user-configurable in Settings -> Editor -> `Thread send shortcut` (`Enter` or `Cmd/Ctrl+Enter`).
- Absolute local file links rendered anywhere in the app (for example `/workspace/project/file.ts#L71`) open in the configured desktop app instead of falling through as raw browser/file URLs, and the original click is consumed so editor widgets do not also open the same href in a browser tab/window. In Codex thread markdown, hovering those links shows an immediate tooltip with the full local path and resolved line/column when present.
- `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` auto-accept in `auto` mode.
- `item/tool/requestUserInput` always requires explicit user input in UI.
- `item/plan/delta` streams incremental plan content; both `text` and `markdownText` stay in sync during reducer updates for markdown-first rendering.
- `serverRequest/resolved` clears stale pending approval and user-input queue entries by request id.
- Codex thread items are normalized into structured renderer data (`normalizedKind`, optional `toolCall`, optional `markdownText`, optional `rawItem`, optional lifecycle `status`). Top-level duplicate fields such as `text`, `command`, `cwd`, and `aggregatedOutput` are not part of the normalized shape.
- Assistant, plan, and reasoning content render through a sanitized markdown pipeline with GFM tables/task-lists, math (KaTeX), Mermaid diagrams, and streaming-safe parsing for in-progress turns.
- Reasoning (`Thinking`) items stay visible while in progress and are hidden after completion by default; users can keep completed reasoning visible by disabling Settings -> Editor -> `Hide thinking when done`.
- Tool activity renders as structured expandable cards instead of plain text dumps: specialized cards for command execution, file changes, MCP, and web search, plus a generic fallback card that always exposes args/result/error/raw payloads for unknown future tool types.
- Tool-call header labels use a two-tone hierarchy for scanability: the leading action phrase (for example, `Explored`, `Searched web`, `Ran`) is emphasized over trailing detail text.
- Command execution cards consume parsed `commandActions` metadata (`read`, `listFiles`, `search`) to show exploration summaries (for example, `Explored 4 files, 1 search`) and per-action transcript rows (`Read`, `Listed`, `Searched`).
- Consecutive exploration-only command execution items in the same turn are coalesced into one transcript card before render so exploration activity is summarized as a single grouped entry.
- While the current turn is still active, the trailing coalesced exploration section remains visually `in progress` (`Exploring` shimmer) until a non-exploration item appears in that same turn or the turn stops.
- Exploration sections are expanded by default only while they are `in progress`; once exploration settles, they collapse by default.
- Command execution headers show `in <cwd>` only when the command ran outside the active project's workspace path.
- Tool-call transcript state is durably snapshotted in SQLite and merged with runtime reads so existing tool logs are preserved across thread tab switches and app restarts.
- Browser/HTTP transport returns explicit unsupported errors for `codex:*` methods in this release.

### Columns

| # | ID | Name | Purpose |
|---|-----|------|---------|
| 1 | 1-ideas | Ideas | Raw task ideas, not yet refined |
| 2 | 2-analyzing | Analyzing | Tasks being researched/scoped |
| 3 | 3-backlog | Backlog | Refined tasks ready for planning |
| 4 | 4-planning | Planning | Tasks with implementation plans |
| 5 | 5-ready | Ready | Tasks ready for agent pickup |
| 6 | 6-in-progress | In Progress | Currently being worked on |
| 7 | 7-review | Review | Completed, awaiting review |
| 8 | 8-done | Done | Finished tasks |

`n-archive` is an internal hidden status used for occurrence completion snapshots; it is not rendered as a Kanban column.

---

## Technical Architecture

### Tech Stack
- **Desktop**: Electron with electron-vite (v5) + Vite 7
- **UI**: React 19, shadcn/ui, Tailwind CSS
- **Block Editor**: BlockNote (@blocknote/core, @blocknote/react, @blocknote/shadcn)
- **Description Format**: [Notion-flavored Markdown (NFM)](../references/notion-flavored-markdown-spec.md) with custom parser/serializer
- **HTTP Server**: Hono (embedded in main process)
- **HTTP Server Port**: Configurable via `[server].port` / `KANBAN_PORT` (default 51283)
- **Drag & Drop**: @dnd-kit/core, @dnd-kit/sortable
- **Database**: better-sqlite3 (in main process)
- **Real-Time**: IPC events (Electron) / SSE (browser fallback)
- **Codex Runtime**: main-process `codex app-server --listen stdio://` JSON-RPC bridge
- **Transport**: Dual-mode — IPC when in Electron, HTTP fetch when in browser
- **Codex Transport**: Electron IPC only (no browser parity in this phase)
- **Package Manager**: Bun
- **Local Assets**: Uploaded images are stored under `~/.nodex/assets/` and served via flat asset HTTP routes
- **Backups**: Whole-store snapshots are stored under `~/.nodex/backups/<backup-id>/`

### Directory Structure
```
nodex/
├── bin/
│   └── nodex.mjs              # Unified CLI (server + agent + project commands)
├── skills/nodex-kanban/
│   └── SKILL.md                # Agent skill documentation
├── .github/
│   └── workflows/
│       └── release.yml         # CI/CD: build + publish on git tag push (v*)
├── ~/.nodex/                  # Default storage directory
│   ├── kanban.db               # SQLite database
│   ├── kanban.db-wal           # Write-ahead log
│   ├── assets/                 # Uploaded images
│   └── backups/                # Whole-store backup snapshots (db + assets)
├── electron.vite.config.ts     # electron-vite config (main, preload, renderer)
├── electron-builder.yml        # Electron packaging + signing + publish config
├── homebrew-cask-template.rb   # Template for Homebrew tap distribution
├── resources/
│   ├── icon.icns               # macOS app icon
│   ├── icon.png                # PNG app icon
│   └── entitlements.mac.plist  # macOS hardened runtime entitlements
├── src/
│   ├── shared/
│   │   ├── types.ts            # Shared TypeScript types (Card, Board, Project, etc.)
│   │   ├── ipc-api.ts          # Type-safe IPC channel map (IpcApi, IpcEvents)
│   │   ├── assets.ts           # Shared asset URI helpers (nodex://assets/...)
│   │   └── card-limits.ts      # Shared card payload/field size limits
│   ├── main/                   # Electron main process
│   │   ├── index.ts            # App entry: BrowserWindow, IPC registration, HTTP server
│   │   ├── ipc-handlers.ts     # ipcMain.handle() registrations
│   │   ├── http-server.ts      # Hono HTTP server (configured port) for CLI + browser
│   │   └── kanban/
│   │       ├── config.ts       # Configuration (KANBAN_DIR + backup env)
│   │       ├── asset-service.ts # Image upload/storage/read helpers
│   │       ├── backup-service.ts # Backup create/list/restore + auto scheduler
│   │       ├── card-input-validation.ts # Card write validation across HTTP + IPC
│   │       ├── db-service.ts   # SQLite CRUD (projects + cards)
│   │       ├── db-notifier.ts  # EventEmitter for changes
│   │       ├── schema.ts       # Latest database schema bootstrap + version guard
│   │       └── history-service.ts  # History tracking logic
│   ├── preload/
│   │   └── index.ts            # contextBridge: exposes window.api (invoke, on, serverUrl, assetPathPrefix)
│   └── renderer/               # React SPA (Vite dev server on port 51284)
│       ├── index.html          # HTML entry
│       ├── main.tsx            # React root
│       ├── app.tsx             # Workbench shell orchestration
│       ├── components/workbench/ # Sidebar + stage rail + staged panel shells
│       ├── env.d.ts            # Window.api type declaration
│       ├── components/
│       │   ├── kanban/
│       │   │   ├── board.tsx              # DnD context, layout, undo/redo
│       │   │   ├── column.tsx             # Column with droppable
│       │   │   ├── card.tsx               # Draggable card
│       │   │   ├── card-dialog.tsx        # Card creation dialog
│       │   │   ├── inline-card-creator.tsx
│       │   │   ├── list-view.tsx          # Table view of all cards
│       │   │   ├── toggle-list-view.tsx   # Rule-driven toggle editor view of cards
│       │   │   ├── project-switcher.tsx   # Radix Popover project dropdown
│       │   │   ├── card-stage.tsx          # Card editor panel
│       │   │   ├── nfm-renderer.tsx       # Read-only NFM block renderer
│       │   │   ├── history-panel.tsx      # Card edit history timeline
│       │   │   ├── undo-toast.tsx         # Undo/redo notification
│       │   │   └── editor/
│       │   │       ├── nfm-editor.tsx     # BlockNote-based NFM editor
│       │   │       ├── nfm-editor-extensions.ts # Shared BlockNote extension/paste setup
│       │   │       ├── nfm-slash-menu.tsx # Shared slash-menu controller (defaults + custom items)
│       │   │       ├── nfm-formatting-toolbar.tsx # Shared formatting toolbar composition
│       │   │       ├── callout-block.tsx  # Shared custom callout block spec (used by multiple schemas)
│       │   │       ├── card-toggle-block.tsx # Custom BlockNote card row toggle block
│       │   │       ├── toggle-list-inline-view-block.tsx # Custom inline embed block for project toggle-list view
│       │   │       ├── toggle-list-card-editor.tsx # Toggle List tab card-toggle editor core
│       │   │       ├── projection-card-toggle.ts # Shared projection helpers for inline embeds
│       │   │       ├── projection-sync-controller.ts # Per-editor projection owner registry + shared listeners/flush pipeline
│       │   │       ├── use-projected-card-embed-sync.ts # Registration facade for projection sync + helper exports
│       │   │       ├── copy-image.ts      # Clipboard helpers for image block copy action
│       │   │       ├── copy-image-button.tsx # Custom image floating toolbar action
│       │   │       ├── search-extension.ts # ProseMirror decoration plugin for in-editor find
│       │   │       ├── notion-paste.ts    # Notion clipboard parser + paste insertion helpers
│       │   │       ├── toggle-backspace.ts # Toggle child Backspace merge handler
│       │   │       ├── toggle-enter.ts    # Toggle child Enter handlers (enter-to-child, empty-enter)
│       │   │       ├── nfm-schema.tsx     # Custom BlockNote schema (callout + toggleListInlineView)
│       │   │       ├── toggle-list-schema.ts # Toggle-list BlockNote schema (cardToggle + toggleListInlineView)
│       │   │       └── use-editor-drag-behaviors.ts # Shared drag-state + toggle-drop editor wiring
│       │   └── ui/                        # shadcn/ui components
│       └── lib/
│           ├── api.ts            # Transport abstraction (IPC or HTTP fetch)
│           ├── assets.ts         # Image upload + asset URI resolution helpers
│           ├── http-base.ts      # Runtime HTTP base resolver (Electron serverUrl / browser origin)
│           ├── card-search.ts    # Shared token search helpers for kanban/list filtering
│           ├── kanban-store.ts   # Per-project shared board store + realtime/fetch dedupe + cardIndex
│           ├── use-toggle-list-settings.ts # Per-project persisted toggle-list rules/settings
│           ├── types.ts          # Re-exports from ../../shared/types
│           ├── utils.ts          # cn() helper
│           ├── nfm/              # Notion-flavored Markdown library
│           │   ├── types.ts      # NfmBlock, NfmInlineContent, NfmColor types
│           │   ├── parser.ts     # parseNfm(string) → NfmBlock[]
│           │   ├── parser-inline.ts   # Inline rich text parser
│           │   ├── serializer.ts      # serializeNfm(NfmBlock[]) → string
│           │   ├── serializer-inline.ts # Inline rich text serializer
│           │   ├── blocknote-adapter.ts # NFM ↔ BlockNote block converter
│           │   ├── extract-text.ts    # Plain text extraction for previews
│           │   └── index.ts           # Barrel exports
│           ├── toggle-list/      # Toggle-list view rules + mapping + sync helpers
│           │   ├── types.ts
│           │   ├── settings.ts
│           │   ├── rules.ts
│           │   ├── meta.ts
│           │   ├── meta-chips.ts
│           │   ├── inline-view-props.ts
│           │   ├── block-mapping.ts
│           │   └── sync.ts
│           ├── use-kanban.ts     # React hook for board state
│           ├── use-history.ts    # React hook for undo/redo
│           ├── use-projects.ts   # React hook for project CRUD
│           ├── use-keyboard-shortcuts.ts # Undo/redo shortcut handler
│           └── use-workbench-shortcuts.ts # Workbench navigation shortcut handler
├── out/                        # Build output (electron-vite build)
│   ├── main/index.js
│   ├── preload/index.js
│   └── renderer/
├── dist/                       # Packaging output (electron-builder)
│   ├── Nodex-*.dmg            # macOS installer
│   ├── Nodex-*.zip            # macOS zip (for auto-update + Homebrew)
│   └── latest-mac.yml          # Auto-update metadata
└── package.json
```

### API Endpoints

#### Backup Routes (global)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/backups` | List all backups (newest first) |
| POST | `/api/backups` | Create manual backup (body: `{label?}`) |
| POST | `/api/backups/[backupId]/restore` | Restore whole-store backup (body: `{confirm: true, createSafetyBackup?}`) |

#### Project Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project (body: `{id, name, description?, icon?, workspacePath?}` where `icon` is an optional emoji) |
| GET | `/api/projects/[projectId]` | Get project details |
| PUT | `/api/projects/[projectId]` | Rename/update project (body: `{newId?, name?, description?, icon?, workspacePath?}`) |
| DELETE | `/api/projects/[projectId]` | Delete project (cascades cards + history) |

#### Board Routes (project-scoped)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/[projectId]/board` | Fetch all columns and cards |
| POST | `/api/projects/[projectId]/board` | Create new card (request body capped at 2MB; oversized requests return 413) |
| GET | `/api/projects/[projectId]/column` | Fetch single column (query: `?id=X`) |
| GET | `/api/projects/[projectId]/card` | Fetch single card (query: `?cardId=Y` or `?columnId=X&cardId=Y`) |
| PUT | `/api/projects/[projectId]/card` | Update card properties (`columnId` optional — server resolves; optional `expectedRevision` enables stale-write detection; stale writes return `409` with `{status:\"conflict\", card, columnId}`; request body capped at 2MB; oversized requests return 413) |
| DELETE | `/api/projects/[projectId]/card` | Delete card (query: `?cardId=Y` or `?columnId=X&cardId=Y`, optional `&sessionId=Z`) |
| GET | `/api/projects/[projectId]/calendar/occurrences` | List calendar occurrences in a time window (`?start=ISO&end=ISO&search=...`) |
| POST | `/api/projects/[projectId]/card-occurrence/complete` | Complete one occurrence (body: `{cardId, occurrenceStart, source, sessionId?}`) |
| POST | `/api/projects/[projectId]/card-occurrence/skip` | Skip one occurrence (body: `{cardId, occurrenceStart, source, sessionId?}`) |
| PUT | `/api/projects/[projectId]/card-occurrence` | Update occurrence timing with scope (body: `{cardId, occurrenceStart, scope, updates, sessionId?}`) |
| PUT | `/api/projects/[projectId]/move` | Move card between columns (`fromColumnId` optional — server resolves; when provided, returns 409 if card not in expected column; supports optional `newOrder`; omit to append to end) |
| POST | `/api/projects/[projectId]/card-import-block-drop` | Atomic block-drop import: source updates + target card creates in one grouped transaction |
| GET | `/api/projects/[projectId]/events` | SSE stream for real-time updates |
| GET | `/api/projects/[projectId]/history` | List recent history (query: `?limit=N&offset=N&sessionId=Z`) |
| GET | `/api/projects/[projectId]/history/card` | Card-specific history (query: `?cardId=X`) |
| POST | `/api/projects/[projectId]/history/revert` | Revert a single history entry (body: `{historyId, sessionId?}`) |
| POST | `/api/projects/[projectId]/history/restore` | Restore card to historical state (body: `{cardId, historyId, sessionId?}`) |
| POST | `/api/projects/[projectId]/undo` | Undo last operation |
| POST | `/api/projects/[projectId]/redo` | Redo last undone |
| POST | `/api/projects/[projectId]/query` | Execute read-only SQL query |
| GET | `/api/projects/[projectId]/schema` | Get database schema |

#### Asset Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/assets/images` | Upload image via multipart `file`; returns `{source}` with canonical `nodex://assets/<file-name>` URI |
| POST | `/api/assets/resources` | Upload or materialize pasted text/files/folders; accepts multipart `file` or JSON `{localPath}` and returns `{source, name, mimeType, bytes}` |
| GET | `/api/assets/[fileName]` | Serve asset bytes for editor/read-only rendering |

### Database Schema

```sql
-- Schema v13

-- Projects table
CREATE TABLE projects (
  id TEXT PRIMARY KEY,              -- slug: lowercase alphanumeric + hyphens
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',    -- optional project emoji icon
  workspace_path TEXT,              -- optional filesystem cwd for Codex threads
  created TEXT NOT NULL             -- ISO datetime
);

-- Cards table
CREATE TABLE cards (
  id TEXT PRIMARY KEY,              -- 7-char alphanumeric
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL,          -- "1-ideas" through "8-done"
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'p2-medium',
  estimate TEXT,                    -- nullable: xs, s, m, l, xl
  tags TEXT NOT NULL DEFAULT '[]',  -- JSON array
  due_date TEXT,                    -- YYYY-MM-DD
  assignee TEXT,
  agent_blocked INTEGER NOT NULL DEFAULT 0,
  agent_status TEXT,
  run_in_target TEXT NOT NULL DEFAULT 'local_project',
  run_in_local_path TEXT,
  run_in_base_branch TEXT,
  run_in_worktree_path TEXT,
  run_in_environment_path TEXT,
  created TEXT NOT NULL,            -- ISO datetime
  "order" INTEGER NOT NULL          -- position in column
);

CREATE INDEX idx_cards_project_column_order ON cards(project_id, column_id, "order");

-- History table
CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,          -- 'create', 'update', 'delete', 'move'
  card_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,          -- ISO 8601
  previous_values TEXT,             -- JSON: changed fields before
  new_values TEXT,                  -- JSON: changed fields after
  from_column_id TEXT,              -- move only
  to_column_id TEXT,                -- move only
  from_order INTEGER,               -- move only
  to_order INTEGER,                 -- move only
  card_snapshot TEXT,               -- JSON: full card for create/delete
  session_id TEXT,                  -- browser session UUID
  group_id TEXT,                    -- grouped action UUID
  is_undone INTEGER NOT NULL DEFAULT 0,
  undo_of INTEGER,                  -- links to undone entry
  CHECK (operation IN ('create', 'update', 'delete', 'move'))
);

CREATE INDEX idx_history_project ON history(project_id);
CREATE INDEX idx_history_card ON history(card_id);
CREATE INDEX idx_history_timestamp ON history(timestamp DESC);
CREATE INDEX idx_history_session ON history(session_id);
CREATE INDEX idx_history_group ON history(project_id, group_id);

-- Codex card-thread links
CREATE TABLE codex_card_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL UNIQUE,
  thread_name TEXT,
  thread_preview TEXT NOT NULL DEFAULT '',
  model_provider TEXT NOT NULL DEFAULT '',
  cwd TEXT,
  status_type TEXT NOT NULL DEFAULT 'notLoaded',
  status_active_flags_json TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  linked_at TEXT NOT NULL
);

CREATE INDEX idx_codex_card_threads_project_card_updated
  ON codex_card_threads(project_id, card_id, updated_at DESC);
CREATE INDEX idx_codex_card_threads_project_updated
  ON codex_card_threads(project_id, updated_at DESC);
```

### Real-Time Sync Flow

**Electron path (IPC):**
```
Database Write → EventEmitter (notifier) → mainWindow.webContents.send()
    → window.api.on("board-changed") → useKanban hook → UI re-renders
```

**Browser path (HTTP + SSE):**
```
Database Write → EventEmitter (notifier) → SSE push (Hono /events endpoint)
    → EventSource listener → useKanban hook → UI re-renders
```

The transport layer (`src/renderer/lib/api.ts`) auto-detects the runtime and uses the appropriate path. In Electron, renderer HTTP routes resolve from a preload-injected server URL; in browser mode they resolve from same-origin (with localhost Vite dev fallback to default API port `51283`). SSE events are scoped per project.

Codex Threads emit a separate Electron IPC stream (`codex:event`) from the main-process Codex domain service; browser mode intentionally does not provide Codex parity in this phase.

---

## CLI Reference

The `nodex` binary serves two roles: starting the server and running agent commands.

### Server Commands

```bash
nodex                            # Start server with defaults
nodex serve [path] [-p port]     # Explicit server start
nodex serve --dev                # Development mode
```

Server options:
- `[kanban-path]` - Path to kanban directory (default: `~/.nodex`)
- `-p, --port <port>` - Port to run on (default: 51283)
- `--dev` - Run in development mode with hot reload

### Project Commands

```bash
nodex projects                          # List all projects
nodex projects add <id> <name>          # Create a project
nodex projects mv <old-id> <new-id>     # Rename a project (updates all references)
nodex projects rm <id>                  # Delete a project (and all its data)
```

### Config Commands

```bash
nodex config                     # Edit config interactively
nodex config show                # Show resolved config with sources
nodex config show --json         # JSON output
```

### Agent Commands

```bash
nodex ls [column]                # List cards (all or by column)
nodex get <card-id>              # Get card details (auto-resolves column)
nodex add <column> <title>       # Create card
nodex update <card-id> [opts]    # Update card (minimal output; -v for full details)
nodex rm <card-id>               # Delete card (auto-resolves column)
nodex mv <card-id> <from> <to> [order] [opts] # Move card (atomic claim)
nodex history [--card <id>]      # View edit history
nodex undo                       # Undo last operation
nodex redo                       # Redo last undone
nodex query "<sql>" [params...]  # Run read-only SQL query
nodex schema                     # Show database schema
nodex backups [subcommand]       # List/create/restore backups
# Aliases: list/show/create/remove/delete/move/hist
```

Agent command options:
- `-p, --project <id>` - Project to operate on (default: "default")
- `--url <url>` - Server URL override
- `--session-id <id>` - Session ID for undo/redo tracking
- `--jsonl` - Output JSON Lines (default)
- `--json` - Output JSON array/object
- `--csv` - Output CSV
- `--pretty` - Pretty-print JSON output (use with `--json`)
- `--table` - Output aligned plain-text tables
- `-v, --verbose` - Verbose output (e.g. full card details after update)
- `-d, --description <text>` - Card description (supports `@file` / `@-` for stdin)
- `-P, --priority <p>` - Priority level
- `-e, --estimate <e>` - Size estimate
- `-t, --tags <t1,t2>` - Comma-separated tags
- `-a, --assignee <name>` - Assignee
- `--yes` - Required confirmation flag for destructive backup restore
- `--no-safety-backup` - Skip automatic pre-restore safety backup
- `--label <text>` - Optional backup label for `nodex backups create`
- `--clear-description` - Clear description (update/mv)
- `--clear-tags` - Clear tags (update/mv)
- `--clear-assignee` - Clear assignee (update/mv)
- `--clear-due` - Clear due date (update/mv)
- `--clear-agent-status` - Clear agent status (update/mv)
- `--no-agent-blocked` - Clear blocked state (update/mv)
- `--full` - Include full card fields in `ls`
- `--description-chars <n>` - Truncate `ls --full` descriptions to `n` chars (default: 240)
- `--description-full` - Include full description in `ls --full`

CLI parsing is strict: unknown options and invalid enum/date values fail fast with actionable errors.

Column shorthand: `5`, `ready`, or `5-ready` all resolve to `5-ready`.

### Backup Commands

```bash
nodex backups                                   # List backups
nodex backups create [--label <text>]           # Create manual backup
nodex backups restore <backup-id> --yes         # Restore backup with safety backup
nodex backups restore <backup-id> --yes --no-safety-backup
```

### File/Stdin Input

Text fields (`--description`, `--agent-status`, `--title`) support reading from files or stdin:

```bash
nodex add 3 "Task" -d @./plan.md        # Read from file
cat spec.md | nodex add 3 "Task" -d @-  # Read from stdin
```

---

## Configuration

### Config File: `.nodex/config.toml`

TOML config for both agent and server settings. Resolution order (later wins):
1. Defaults
2. `~/.nodex/config.toml` (user-level, auto-generated if no config exists)
3. `.nodex/config.toml` walked up from CWD (project-level overrides user-level)
4. Env vars: `NODEX_*` for agent, `KANBAN_*` for server
5. CLI flags: `--url`, `--session-id`, `--project`, `--port`, `[path]`

```toml
# .nodex/config.toml
url = "http://localhost:51283"
session_id = "my-agent"
project = "default"

[server]
dir = "~/.nodex"
port = 51283
backup_auto_enabled = false
backup_interval_hours = 6
backup_retention = 28
history_retention = 1000
```

**Dev/production separation**: Use project-level `.nodex/config.toml` for dev settings (different port/dir) and `~/.nodex/config.toml` for production. When running `nodex --dev` from a project directory, the project-level config takes priority. When the Electron app is launched directly (e.g., from Dock), only `~/.nodex/config.toml` is read.

**Electron renderer API base resolution**: Main process resolves server port from the same config chain (`config.toml` + env), starts HTTP server on that port, and injects `serverUrl` through preload. Renderer HTTP helpers (including image upload and asset URL resolution) consume this runtime URL so `[server].port` changes are honored; browser mode uses same-origin except local Vite dev (`:51284`) which falls back to default API port (`:51283`).

### Server Environment Variables
```bash
KANBAN_DIR=~/.nodex     # Kanban directory (default: ~/.nodex)
KANBAN_PORT=51283        # Port (default: 51283)
KANBAN_BACKUP_AUTO_ENABLED=false   # Enable auto backups (default: false)
KANBAN_BACKUP_INTERVAL_HOURS=6    # Auto backup interval in hours (default: 6)
KANBAN_BACKUP_RETENTION=28        # Auto backup retention count (default: 28)
KANBAN_HISTORY_RETENTION=1000    # Max history entries per project (default: 1000, 0 = unlimited)
```

These can also be set via the `[server]` section in config.toml. Env vars override TOML values.

In the desktop app, Settings -> Backups updates `~/.nodex/config.toml` `[server]` backup fields and reapplies the auto-backup scheduler immediately. If `KANBAN_BACKUP_*` environment variables are set, those values remain effective and the UI marks the overridden fields.

### Agent Environment Variables
```bash
NODEX_URL=http://localhost:51283
NODEX_SESSION_ID=my-agent
NODEX_PROJECT=default
```

Environment variables can be passed directly. CLI arguments take precedence.

### Development
```bash
bun install
bun run dev              # electron-vite dev (renderer on :51284, HTTP API on :51283)
```

### Production
```bash
bun run build            # electron-vite build → out/
bun run start            # electron out/main/index.js
```

### Packaging & Release
```bash
bun run package          # Build + create macOS DMG + ZIP in dist/
bun run release          # Build + publish DMG/ZIP to GitHub Releases
```

To release a new version:
```bash
# 1. Bump version in package.json
# 2. Tag and push
git tag v0.2.0
git push --tags
# 3. GitHub Actions builds, signs, and publishes to GitHub Releases
```

For code signing and notarization, set these env vars (or GitHub Secrets):
- `CSC_LINK` — Base64-encoded .p12 certificate
- `CSC_KEY_PASSWORD` — Certificate password
- `APPLE_ID` — Apple ID email
- `APPLE_APP_SPECIFIC_PASSWORD` — App-specific password
- `APPLE_TEAM_ID` — 10-character Apple Team ID

---

## Agent Integration

### Design: CLI + REST API

Agents use the **`nodex` CLI** for all board operations. The CLI wraps the REST API with ergonomic commands, strict option/value validation, auto-column-resolution, and config file support. The REST API remains available for direct HTTP access.

### How Agents Use the Board

```bash
# 1. Read ready tasks (uses default project, or set --project)
nodex ls 5

# 2. Claim a task atomically (fails if another agent already claimed it)
nodex mv abc1234 5 6 --agent-status "Starting work..."

# 3. Update status while working
nodex update abc1234 --agent-status "Running tests..."

# 4. Mark as blocked if stuck
nodex update abc1234 --agent-blocked --agent-status "Blocked: Need API credentials"

# 5. Complete task - move to review
nodex mv abc1234 6 7 --agent-status "Ready for review"

# Working with a specific project
nodex --project my-app ls 5
nodex --project my-app add 5 "New feature"

# Create a manual safety snapshot before risky changes
nodex backups create --label "before release refactor"

# Restore full board state (db + assets)
nodex backups restore <backup-id> --yes
```

### CLI vs REST API

| Action | CLI Command | REST API |
|--------|------------|----------|
| List projects | `nodex projects` | GET `/api/projects` |
| Create project | `nodex projects add <id> <name>` | POST `/api/projects` |
| Rename project | `nodex projects mv <old> <new>` | PUT `/api/projects/[projectId]` |
| Delete project | `nodex projects rm <id>` | DELETE `/api/projects/[projectId]` |
| List cards | `nodex ls [column]` | GET `/api/projects/[projectId]/board` |
| Get card | `nodex get <id>` | GET `/api/projects/[projectId]/card?cardId=Y` |
| Create card | `nodex add <col> <title>` | POST `/api/projects/[projectId]/board` |
| Update card | `nodex update <id> [opts]` | PUT `/api/projects/[projectId]/card` |
| Delete card | `nodex rm <id>` | DELETE `/api/projects/[projectId]/card?cardId=Y` |
| Move card | `nodex mv <id> <from> <to> [opts]` | PUT `/api/projects/[projectId]/move` (atomic: 409 if card not in `fromColumnId`) + optional PUT `/api/projects/[projectId]/card` (property updates) |
| History | `nodex history` | GET `/api/projects/[projectId]/history` |
| Undo/Redo | `nodex undo` / `nodex redo` | POST `/api/projects/[projectId]/undo` / `redo` |
| SQL query | `nodex query "<sql>"` | POST `/api/projects/[projectId]/query` |
| Schema | `nodex schema` | GET `/api/projects/[projectId]/schema` |
| List backups | `nodex backups` | GET `/api/backups` |
| Create backup | `nodex backups create` | POST `/api/backups` |
| Restore backup | `nodex backups restore <id> --yes` | POST `/api/backups/[backupId]/restore` |

The server auto-resolves `columnId` for get/update/delete — agents only need the card ID. `mv` requires explicit `<from> <to>` columns for atomic claim semantics (409 if card already moved). Each CLI command issues a single HTTP request (no pre-lookup), eliminating TOCTOU races when multiple agents operate concurrently.

### Output Format

All CLI output is **JSON Lines by default** (machine-readable, one object per line). Use `--json` for JSON array/object output, `--csv` for CSV, or `--table` for aligned plain-text tables.

```bash
nodex ls 5                  # JSONL (one card object per line)
nodex get abc1234 --json    # JSON object
nodex ls 5 --csv            # CSV table
nodex ls 5 --table          # aligned plain-text table
nodex ls 5 --full           # full card fields + truncated description
nodex ls 5 --full --description-full  # full description
nodex ls --offset 10 --limit 10      # paginate (skip 10, take 10)
```

### SQL Query Examples

```bash
# Count cards by column
nodex query "SELECT column_id, COUNT(*) as count FROM cards GROUP BY column_id"

# Find high-priority blocked cards
nodex query "SELECT * FROM cards WHERE priority IN (?, ?) AND agent_blocked = 1" p0-critical p1-high

# Search by title pattern
nodex query "SELECT * FROM cards WHERE title LIKE ?" "%bug%"
```

**Security:** Only SELECT queries are allowed (enforced via SQLite's `Statement.readonly`). Parameters are positional (`?` placeholders).

---

## Design Decisions

### Why SQLite?
- **Atomic transactions**: Move operations are atomic, no data corruption
- **Fast queries**: Indexed lookups, no file parsing overhead
- **Single file**: Easy to backup, restore, or move
- **No server**: Embedded database, no separate process needed
- **WAL mode**: Good concurrent read performance

### Why Multi-Project in One Database?
- **Single file**: One `kanban.db` contains all projects, easy to manage
- **Foreign keys with CASCADE**: Deleting a project automatically cleans up all related data
- **Shared schema**: No duplicate table definitions across databases
- **Atomic cross-project queries**: SQL can query across projects if needed

### Why Electron?
- Desktop app with native window management
- Preload script provides secure IPC bridge via contextBridge
- Main process hosts both SQLite and HTTP server in one long-lived process
- No need for globalThis singleton hacks (unlike Next.js server)
- Browser fallback: UI also works at `http://localhost:51284` via HTTP fetch

### Why Dual Transport (IPC + HTTP)?
- **Electron (IPC)**: Fast, no network overhead, no CORS concerns
- **Browser (HTTP)**: Allows accessing the board from any browser without Electron
- Transport abstraction (`api.ts`) makes this transparent to hooks/components
- Renderer HTTP base is runtime-aware: preload-injected `serverUrl` in Electron, same-origin in browser (with local Vite dev fallback to `:51283`)
- SSE provides real-time updates in browser mode; IPC events in Electron mode
- Renderer dedupes realtime fan-out by project: one shared board subscription/fetch path updates all `useKanban` consumers in that project

### Why SSE for Browser Mode?
- Simpler implementation for one-way updates
- Automatic reconnection
- No additional dependencies

### Why Local Database?
- No server setup required
- Easy to inspect with any SQLite client
- Portable single file
- Works offline

### Why SQLite Online Backup API for Backups?
- **WAL-safe snapshots**: `db.backup(...)` captures consistent state from a live WAL database
- **Atomic backup directories**: Stage in temp dir and rename into place
- **Restore safety**: Auto pre-restore safety backup and rollback staging protect against failed restores
- **Whole-store recovery**: Backups include both `kanban.db` and `assets/`

### Why Stable Asset URIs?
- **Port-independent storage**: NFM descriptions stay valid even if server host/port changes
- **Flat asset ids**: canonical asset references use `nodex://assets/<file>` so image blocks stay portable while file lookup remains a simple single-directory join
- **Simple rendering**: URI resolves to HTTP route in editor (`resolveFileUrl`) and read-only renderer
- **Safer lifecycle**: Deferred cleanup avoids accidental data loss from aggressive orphan deletion

### Why CLI for Agents?
- **Ergonomic**: `nodex mv abc1234 5 6` vs multi-line curl commands
- **Concurrency-safe**: Server-side column resolution means each CLI command is a single atomic HTTP request — no TOCTOU races when multiple agents operate simultaneously
- **Auto-resolution**: Agents don't need to track card column IDs
- **Strict parsing**: Unknown flags/invalid values fail fast instead of silently being ignored
- **Flexible output**: JSONL by default, plus `--json`, `--csv`, and human-friendly `--table`
- **Config files**: TOML config at `.nodex/config.toml` avoids repeating `--url`
- **File input**: `@file` / `@-` for uploading plans or descriptions
- **REST API still available**: CLI wraps the API; direct HTTP access remains for advanced use

### Why REST API?
- **Consistent interface**: Same HTTP patterns for all operations
- **JSON responses**: No database queries required by agents
- **Granular reads**: Fetch just one column or card instead of entire board

### Why Write Limits in App Layer?
- **Stops runaway growth early**: Field-level validation blocks exponential-content bugs before they hit SQLite/history
- **Transport parity**: `db-service` validation protects both HTTP and Electron IPC writes
- **Resource protection**: Route-level body caps reject oversized requests with `413` before JSON parsing/DB work
- **Operational simplicity**: Limits live in shared constants, so values stay consistent across modules

### Why Popper Positioning for Inline Creator Selects?
- **Radix compatibility with custom triggers**: Avoids `item-aligned` dependence on `SelectValue` value-node measurement
- **Reliable placement**: Dropdown menus anchor consistently in narrow kanban columns
- **Safer click-outside behavior**: Portaled menu interactions can be excluded from inline creator auto-dismiss logic
- **Safe writes**: API ensures valid data, agents can't corrupt database
- **Race condition safety**: Transactions handle concurrent writes properly

### Why Shared Slash-Menu Controller?
- **Single extension point**: Add custom block insertions (like `toggleListInlineView`) while preserving BlockNote default slash items
- **Consistent UX across editors**: Card Stage and Toggle-List editor use the same slash composition and filtering behavior
- **Avoid duplicate overlays**: Explicitly disabling built-in `slashMenu` prevents stacked/default menu conflicts

### Why Shared Toggle-List Card Editor Core?
- **DRY behavior parity**: Toggle List tab and inline toggle-list embeds use one implementation for schema setup, structural guards, and card sync
- **Navigation correctness**: Boundary Up/Down routing is centralized around native `cardToggle` summaries and host callbacks, reducing `NodeSelection`/DOM-race edge cases
- **Safer maintenance**: Fixes to sync/debounce/rules apply once instead of drifting across duplicated editor implementations

### Why Schema-Gated Child-Group Keyboard Overrides?
- **Broader consistency**: One Enter/Backspace policy works for all inline parent blocks with children, not just toggle-type parents
- **Safer scope**: Schema-gating (`content: "inline"`) avoids applying text merge/split semantics to non-inline wrappers
- **Deterministic precedence**: Enter extension declares `runsBefore` list-item shortcut extensions so custom child-group behavior intercepts before built-in list item Enter handlers
- **Consistent child merge**: Backspace at the start of any leaf child under an inline parent always merges that child upward, regardless of whether it is the tail child
- **Stable caret behavior**: ProseMirror-level split/merge helpers set cursor positions in one transaction, avoiding cursor drift from multi-step high-level updates

### Why TOML for Server Config?
- **Unified config**: Agent and server settings in one file, one resolution chain
- **Dev/production split**: Project-level `.nodex/config.toml` for dev, `~/.nodex/config.toml` for production
- **Direct launch support**: Electron app reads `~/.nodex/config.toml` without needing env vars
- **CLI bridge**: `cmdServe()` resolves TOML (with CWD walk-up) and passes final values as env vars to the Electron child process, since the child's CWD is `packageRoot`

### Why Session-Scoped Undo?
- **Independent tabs**: Each browser tab has its own undo stack
- **No conflicts**: Users can't accidentally undo each other's changes
- **Simple mental model**: "My undo undoes my actions"
- **Persisted in DB**: History survives page refresh (sessionStorage holds session ID)

### Why Delta Storage for History?
- **Space efficient**: Only store changed fields, not full card snapshots
- **Fast queries**: Smaller records = faster reads
- **Exception for delete**: Full snapshot stored to enable recreation
- **Card ID preserved**: Deleted cards restore with same ID

### Why BlockNote for the Editor?
- **Notion-like UX out of the box**: Drag handles, slash menu, block selection, formatting toolbar
- **Native block nesting**: Children blocks are first-class (crucial for NFM's tab-indented structure)
- **Built on ProseMirror/Tiptap**: Battle-tested engine, active development
- **Custom block types**: `createReactBlockSpec` for callout blocks (extensible for future types)
- **shadcn/ui integration**: `@blocknote/shadcn` uses the same UI primitives as the rest of the app

### Why Notion-Flavored Markdown (NFM)?
- **Notion compatibility**: Same format used by Notion API, enabling future integrations
- **Block-level structure**: Tab indentation for children, `{color="Color"}` attributes, XML-like advanced blocks
- **Editor-local indentation boundaries**: If `Tab` or `Shift+Tab` cannot change nesting, the keystroke is swallowed instead of moving focus into hover-only editor chrome
- **Human-readable**: Descriptions remain readable in raw text (CLI, database inspection)
- **Custom parser/serializer**: Pure functions in `src/renderer/lib/nfm/`, independent of editor library
- **Three-layer architecture**: NFM string ↔ NfmBlock tree ↔ BlockNote blocks — clean separation of concerns
- **Read-only renderer**: Card previews use `NfmRenderer` (lightweight, no editor overhead)

---

## Future Features

### Phase 2: Agent Triggers (Planned)
- Auto-trigger Claude Code when card moves to specific column
- Webhook support for external integrations
- Custom column actions

### Phase 3: Enhanced UI
- Filtering by priority, tags, assignee
- Search across all cards
- Archive view for done cards
- Dark mode improvements

### Phase 4: Multi-Agent Support
- Agent assignment and load balancing
- Parallel task execution
- Dependency tracking between cards

---

## Glossary

| Term | Definition |
|------|------------|
| **Agent** | AI coding assistant (e.g., Claude Code) that interacts via API |
| **Card** | A single task/item on the board |
| **Column** | A vertical list representing a workflow stage |
| **Project** | An independent kanban board with its own cards and history |
| **Card Stage** | Slide-out panel for viewing/editing card details |
| **SSE** | Server-Sent Events for real-time updates (browser mode) |
| **IPC** | Inter-Process Communication between Electron main and renderer |
| **Transport** | Abstraction layer (`api.ts`) that routes calls to IPC or HTTP |
| **Main Process** | Electron process hosting SQLite, IPC handlers, and Hono HTTP server |
| **Preload** | Electron script that bridges main ↔ renderer via contextBridge |
| **Session ID** | UUID identifying a browser tab's undo/redo stack |
| **History Panel** | Slide-out panel showing a card's edit timeline |
| **Delta** | Partial record of changed fields (vs full snapshot) |
