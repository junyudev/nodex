# Workbench Shell

## Intent
The workbench shell presents project work as a staged horizontal pipeline inspired by niri-like focus movement.
The sidebar project switcher controls the DB stage datasource, while Cards/Threads/Terminal keep stage-local project context and remain mounted in one horizontal shell.

## Layout
- Left sidebar: global stage map (`View`, `Card`, `Thread`, `Diff`) and bottom project switcher.
- The sidebar header includes a compact DB-view selector: the selected view expands into an icon-and-label pill while the other DB views stay icon-only buttons in the same row.
- The `Cards` sidebar stage group contains current DB-project cards grouped by non-empty status plus a `Recent` subsection for persisted cross-project card sessions.
- When collapsed, the sidebar can be temporarily revealed by hovering the left window edge; it floats above the stage rail instead of reflowing it.
- Top toolbar actions: sidebar collapse/expand and sliding-window pane-count decrease/increase.
- Stage rail: horizontal panel rail with stage-specific tab groups.
- Stage rail supports two modes:
  - `Sliding window` (default): a sliding 1-4 stage window with resizable separators between adjacent panes.
  - `Full rail`: all stages rendered in one horizontal strip.
- Terminal: global foldable bottom panel (VS Code-like), outside the stage rail.
- Visible stages:
  - sliding window: 1-4 stage panels render at once; focused stage and direction determine the contiguous visible window.
  - full rail: all stages render at once and remain mounted.
  - focused stage is visually emphasized and auto-revealed without forced centering.
  - titlebar pane controls flank the minimap: `-` sits on the left and removes the current right-most pane, while `+` sits on the right and appends the next right pane when available before falling back to prepending the left pane at the right edge.
- Stage order: `View -> Card -> Thread -> Diff`.

## Stage Semantics
- View: existing board/list/toggle-list/canvas/calendar host with search toolbar.
- Card: Card Stage editor session tabs; history opens as a card-specific overlay from Card Stage, and the sidebar mirrors card navigation with collapsible current DB-project status groups plus a `Recent` session subsection. Status groups start collapsed by default, and a collapsed status group may still keep its active card row visible under the header.
- Thread: Codex app-server-backed thread workspace with account/auth controls, a permission mode selector, streaming turn/item feed, reverse navigation to owning card, and stage-local project context (`threadsProjectId`).
- Diff: interactive mock placeholder for diff previews.
- Terminal panel: mixed tabs (`project` and `card` bound), globally docked at bottom, with per-tab project routing.

## Threads Rendering Model
- Item rendering is registry-driven: `stage-threads/thread-item-renderer.tsx` dispatches by structured `normalizedKind` and tool metadata instead of ad-hoc text heuristics.
- Tool calls route through `stage-threads/tools/get-tool-component.tsx`:
  - specialized cards: command, file-change, MCP, web-search
  - generic fallback card for unknown tools, showing JSON args/result/error/raw payloads when expanded
  - tool cards are collapsed by default across all tool types
- Dev-only story harness: append `?dev-story=threads-panel` (alias: `threads`) to the renderer URL in development mode to open an isolated mock Threads panel with scenario presets and interaction controls.
- Dev-only card-stage story harness: append `?dev-story=card-stage` (aliases: `card`, `cardstage`) to open an isolated mock Card Stage page with preset scenarios and thread-property controls for UI refinement.
- Dev-only general UI story harness: append `?dev-story=ui-components` (aliases: `ui`, `components`) to open a gallery of shared renderer primitives and recurring Nodex interaction patterns.
- Assistant-like text (`assistantMessage`, `plan`, `reasoning`) renders with `stage-threads/markdown/markdown-core.tsx` and `streamdown` in static or streaming mode.
- User transcript bubbles expose hover/focus message actions under the bubble: `Copy message` and a mock-only `Edit message` control styled from the `design.local/copy-edit-buttons.html` reference. The newest assistant text message exposes the same under-message copy affordance without the edit control.
- Running-thread status rows use verb-led summaries: contiguous exploration actions coalesce into `Exploring` / `Explored` groups (absorbing adjacent reasoning steps in the same turn), generic commands render as `Running command` while active and `Ran …` once settled, and MCP calls render as `Calling …` / `Called …`.
- Threads use follow/read modes: if the viewport is near the bottom, new items auto-scroll into view; if the user scrolls up, auto-scroll pauses and a floating catch-up button appears above the composer to jump back to latest.
- Running thread tabs render a live indicator dot in the tab strip.
- Sidebar thread items replace their default thread glyph with a live running indicator while active; the Thread stage group icon also reflects running state.
- The composer footer’s bottom-right context ring uses live `thread/tokenUsage/updated` data from Codex. It shows the active thread’s current context-window fill level, and hovering the ring reveals percent-full plus `used / window` token details when available.
- Markdown security and capability profile:
  - `remark-gfm`, `remark-math`, optional `remark-breaks`
  - `rehype-raw` -> `rehype-sanitize` (extended schema) -> `rehype-harden` -> `rehype-katex`
  - Mermaid is rendered from fenced blocks and sanitized before SVG insertion.
- Visual styling is scoped via `.codex-markdown` and `codex-tool-*` primitives in `src/renderer/globals.css`, keeping all colors/typography on Nodex design tokens.

## Focus and Navigation
- Focusing a stage scrolls only as needed so the focused stage is fully visible.
- Sliding-window focus uses nearest-window behavior: changing focus shifts the visible window only as much as needed to include the target stage.
- `Ctrl+Tab` / `Ctrl+Shift+Tab` still cycle stage focus order.
- `Shift + mouse wheel` is reserved for native horizontal panel scrolling and does not step focus.
- Full rail: dragging either left or right border of a stage panel resizes only that panel width (neighbor widths do not change).
- Sliding window: dragging any separator resizes the adjacent pane pair in real time so content follows the pointer; width persistence commits on pointer release.
- Sliding-window separators use the same surface tone as adjacent panes and keep a single-line seam aesthetic.
- Sidebar stage groups mirror stage tab state and allow direct stage/tab focus.
- Current-project card groups in the sidebar ignore the View-stage search query and remain a stable navigator for the selected DB datasource project.

## Persistence
- Stage focus is persisted globally (not keyed by DB datasource project).
- Sidebar stage section expansion (including the top-level `Recents` group) and stage tab selections are persisted per project.
- Sidebar card-status subgroup expansion and per-section overflow expansion (`Show more` / `Show less`) are persisted per project.
- Full-rail stage panel widths are persisted globally after panel border resize.
- Sliding-window requested pane count (1-4) is persisted globally.
- Sliding-window pane widths are persisted globally by stage id.
- Card stage tabs derive from persisted recent card sessions.
- The `Recents` sidebar group is driven by persisted cross-project recent card sessions, capped at 10 items and updated only when the current card is left; leaving inserts only cards that are not already present, so existing entries keep a stable order.
- The Cards sidebar's grouped current-project rows are derived from the shared `useKanban` board snapshot for `dbProjectId`; they do not create separate persisted tab state.
- Thread stage tabs always include a persistent `New thread` tab, plus linked Codex thread tabs derived from persisted metadata in SQLite (`codex_card_threads`) and refreshed from runtime events.
- Thread background sync is preserved when changing the selected thread tab; active-thread detail refresh runs independently of the currently selected tab.
- Bottom terminal panel persists open/closed + panel height globally.
- Terminal tabs persist mixed `project`/`card` mode state.
- Codex permission mode preference (`sandbox`/`full-access`/`custom`) is persisted in renderer localStorage per project and mirrored to main process.
- In Threads stage, the permission selector defaults to `Custom (config.toml)` when no project-specific preference has been set yet.
- The Threads permission menu shows hover tooltips for each mode; the `Custom (config.toml)` tooltip reflects the parsed effective `sandbox_mode` and `approval_policy` from the resolved Codex config file when available.

## Keyboard Model
- `Ctrl+Tab` / `Ctrl+Shift+Tab`: next/previous stage.
- `Cmd/Ctrl+1..4`: jump to stage index.
- `Cmd/Ctrl+Alt+1..9`: jump to project index.
- `Cmd/Ctrl+Alt+1..9` updates DB datasource project only.
- `Cmd/Ctrl+Shift+P`: open project picker.
- `Cmd/Ctrl+J`: toggle global bottom terminal panel.
