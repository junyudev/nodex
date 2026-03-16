# Engineering Learnings

Status: Verified

This file captures high-signal implementation discoveries that have caused regressions or costly debugging in the past.

### Release CI should inherit Bun from `packageManager`, not `setup-bun` `latest`
When GitHub Actions pins `oven-sh/setup-bun` to `latest`, release validation can drift onto a just-published Bun build that no developer or lockfile update has exercised yet. In Nodex, that surfaced as Ubuntu-only renderer test failures through the `radix-ui` umbrella package while the same commit stayed green locally. Keep `package.json#packageManager` as the single Bun source of truth, let `setup-bun` read that pinned version, and only advance Bun by an explicit repo change that also reruns typecheck/lint/tests.

### Release workflows must not push version commits or tags before packaging succeeds
On March 16, 2026, Nodex release CI created and pushed `release: v0.1.3` before the macOS packaging job proved the candidate could build. The subsequent `electron-vite build` then failed on the hosted macOS runners with a Node old-space heap OOM during renderer chunk generation, leaving partial git release state behind. The release entry workflow should stage an unpushed release candidate, build and verify from that candidate, and only then commit, tag, and push. Also keep a CI-only `NODE_OPTIONS=--max-old-space-size=...` safety margin on the macOS packaging steps, because hosted runner defaults can be lower than what the renderer bundle shape needs.

### Renderer bundle boundaries must stay explicit for heavy package families
On March 16, 2026, the renderer production build had drifted into a single `index-*.js` entry of roughly 10.8 MB, which pushed `electron-vite build` into Node old-space OOM on GitHub-hosted macOS runners during chunk rendering. The stable fix was to keep explicit renderer `manualChunks` for the heaviest package families (`streamdown`, BlockNote/Tiptap, Excalidraw, Cytoscape) and to preserve true lazy boundaries instead of mixing static and dynamic imports for the same package. In particular, if `canvas-view.tsx` lazy-loads `@excalidraw/excalidraw`, do not statically import Excalidraw-owned subcomponents like `Sidebar` elsewhere in the same route tree, or Rollup will pull the package back into the main renderer entry and invalidate the split.

### `mac.icon` packaging must run on macOS 26 runners because electron-builder now requires `actool >= 26`
As of `electron-builder` 26.8.x, setting `mac.icon` to an Icon Composer asset (`.icon`) routes packaging through its `macosIconComposer` path, which rejects `actool` versions below 26.0.0. That means `macos-latest` while it still points to macOS 15, and `macos-15-intel`, will fail packaging even if the app itself builds fine. For Nodex, the clean fix is to keep the checked-in `resources/icon.icon` source of truth and pin release packaging jobs to GitHub-hosted `macos-26` / `macos-26-intel` runners instead of falling back to local-only builds or downgrading to legacy `.icns` in CI.

### Release verification should validate the notarized app bundle, not require a separately signed DMG
On March 16, 2026, release CI failed after a successful package because the workflow ran `spctl --assess --type open` against the DMG and Gatekeeper reported `source=no usable signature`. For Nodex's current electron-builder setup, this is expected: DMG signing is off by default, while `@electron/notarize` submits the app bundle and staples that `.app`. The durable fix is to keep verification on the app bundle (`codesign`, `spctl --type execute`, `stapler validate`) unless the project explicitly opts into DMG signing as a separate distribution requirement.

### Electron packages stay lean only when renderer libraries remain in `devDependencies`
On March 16, 2026, Nodex's packaged app had grown to roughly 800 MB installed because `app.asar` was shipping a full raw renderer `node_modules` tree on top of the already-bundled `out/renderer` assets. With `electron-vite`, renderer-only libraries still need to be installed to build, but they do not need to remain in `dependencies` unless main/preload loads them at runtime. Keep only true main-process runtime packages in `dependencies` (for Nodex: Hono server pieces, `better-sqlite3`, `node-pty`, `smol-toml`), move bundled renderer libraries to `devDependencies`, and explicitly exclude dead package artifacts like `@types`, tests, snapshots, source maps, and published `src/` trees from the packaged app.

### Bun test file order makes `mock.module()` leaks a cross-file hazard for shared renderer modules
Under Bun's sequential test runner, `mock.module()` replacements can bleed into later files because `mock.restore()` does not revert module mocks. In Nodex, `stage-threads-dev-story-page.test.tsx` mocked `./tools/file-change-tool-call`, and a later `ThreadItemRenderer` test silently rendered that stub on Ubuntu, dropping the expected filename label. Avoid `mock.module()` for shared renderer modules that later tests import; prefer rendering the real component with representative mock data, and keep root `tsconfig.json` path aliases available so isolated renderer tests do not depend on unrelated earlier mocks just to resolve `@/...` imports.

### Renderer transport detection must be runtime-based, not cached at module import
`src/renderer/lib/api.ts` is shared by tests that may import it before `window.api` exists, then install the Electron bridge later. Caching `const isElectron = typeof window !== "undefined" && !!window.api` at module load makes later callers fall back to the browser HTTP path forever, which surfaced in release CI as `Unknown IPC channel: app:flush-before-close:done`. Keep Electron-vs-browser detection inside each exported function call, and for component tests prefer mocking a local adapter module (for example `workbench-api.ts`) instead of mocking the shared renderer transport directly.

### Card Stage freeform text drafts should stay local until save, not patch the shared board store on every keystroke
`title`, `description`, `assignee`, and `agentStatus` already have local card-stage draft state plus debounced/blur persistence. Mirroring those drafts into the shared Kanban store on every keystroke (`onPatch`) turns editor input into a project-wide realtime update: sidebar groups, card menus, and card previews all rerender, and card surfaces can re-run NFM/plain-text extraction for every typed character. Keep freeform text drafts local inside the card stage and publish only persisted saves; reserve optimistic store patches for discrete card-property changes where cross-surface immediacy matters. If other surfaces need live draft previews, project them through a scoped per-card draft overlay store so only readers of that specific card rerender.

### Draft overlay producers must never consume their own merged overlay back through props
Scoped per-card draft overlays are safe only when the producer and consumer graphs stay one-way. If `CardStage` writes an overlay for `card-1`, and the shell reads that overlay, merges it into the base card, and passes the merged card back into `CardStage`, the draft-sync effect can oscillate between "overlay matches base, clear it" and "local draft differs, restore it", causing a React maximum update depth loop. Keep `CardStage` hydrated from the persisted/base card only; restrict overlay reads to sibling preview surfaces like Kanban cards that are not also writing that overlay.

When you do project overlays into Kanban, subscribe at the smallest presentational leaf that actually needs the draft text. Do not subscribe the full interactive card shell (`useSortable`, context-menu wrapper, drag refs, menu triggers) to per-keystroke draft updates. That shell churn can amplify unrelated native platform work, including Electron/macOS menu validation noise while typing.

### macOS 26 icons should treat the checked-in `.icon` as the authoring source, not regenerate it during build
For Nodex, flat PNG/ICNS fallback assets are not enough on macOS 26: the system can wrap them in a gray enclosure instead of the intended white plate. The working path is to keep `resources/nodex-icon.svg` as the source for flat fallback rasters (`icon.png` / `icon.icns`), but keep the macOS 26 Icon Composer document in `resources/icon.icon/` as a checked-in authored asset. Do not regenerate that `.icon` package from the SVG during `sync:icons`; doing so silently discards manual Icon Composer adjustments and produces the wrong installed icon. Let packaging compile the checked-in `.icon` asset catalog instead of checking a generated `Assets.car` into the repo.

### Tailwind-scanned node_modules UI packages need explicit `@source` entries or imported components silently lose utility styling
Importing a package stylesheet like `@blocknote/shadcn/style.css` is not enough for Tailwind v4 to emit the utility classes referenced by that package's TSX files. If a local component stops using the same utility names (for example `bg-popover` / `text-popover-foreground`), the compiled bundle can silently drop those utilities and third-party rendered surfaces become transparent or unstyled. For Tailwind-based packages rendered from `node_modules`, add an explicit `@source` entry in `src/renderer/globals.css` (for BlockNote shadcn: `@source "../../node_modules/@blocknote/shadcn";`) so menus, toolbars, side menus, and nested popovers keep their upstream chrome regardless of local source usage.

### Browser-scoped renderer theme tokens must follow the root `.dark` class, not raw `prefers-color-scheme`
`design.local/tokens.css` is compiled for standalone browser demos and uses `@media (prefers-color-scheme: dark)` for browser-window theme tokens. The actual renderer theme source of truth is `ThemeProvider`, which toggles `.dark` on `document.documentElement`. When mirroring design-local surface tokens into `src/renderer/styles/design-system-theme.css`, keep browser-scoped light/dark overrides keyed to `:root.dark[data-codex-window-type="browser"]` (and the light `[data-codex-window-type="browser"]` state) so manual theme selection still wins over OS preference.

### Toggle-drop drag source must be resolved lazily, not at dragstart time
In `toggle-drop.ts`, the native `dragstart` listener on `.nfm-editor` fires BEFORE BlockNote's React-delegated `DragHandleButton.onDragStart` (React 18 delegates events to the root, which is above `.nfm-editor` in the bubble chain). At `onDragStart` time, `NodeSelection` hasn't been dispatched yet, so `.ProseMirror-selectednode` isn't applied and `editor.getSelection()` still reflects the old cursor. Defer drag source identification to the first `dragover`/`onDrop` call via a lazy `resolveDragSource()`, where `.ProseMirror-selectednode` and `editor.getSelection()` are authoritative. Never fall back to `editor.getTextCursorPosition()` — it returns the text cursor, not the drag source.

### Reuse one drag-source resolver for both editor-internal and cross-surface drops
Block drag source resolution (PM multi-node selection, single node selection, BlockNote selection fallback, selected-node DOM fallback) should live in one shared helper (`drag-source-resolver.ts`) and be reused by both `toggle-drop.ts` and Kanban external import handling. Duplicated resolver paths drift quickly and reintroduce off-by-one selection bugs in one path.

### Keep card->editor drops on dnd-kit by bridging pointer state, not by making cards natively draggable
Kanban card reorder already relies on dnd-kit sensors and sortable state. Adding native HTML `draggable` to cards causes gesture conflicts and inconsistent drag lifecycles. For card->editor imports, keep dnd-kit as the single drag source and bridge with a lightweight global card-drag session (payload + pointer center) plus a registry of external editor drop targets resolved via `elementsFromPoint`.

### dnd-kit card drags need a bridged editor insertion indicator
BlockNote/ProseMirror drop-cursor visuals are driven by native drag events. When card drags originate from dnd-kit, ProseMirror's built-in dropcursor is not triggered, so editor targets must render a synthetic insertion line from pointer-anchored block resolution (`elementsFromPoint` + block midpoint fallback). Keep indicator computation in the same helper used for actual insert placement so preview and final insertion cannot drift.

### Dense dnd-kit boards stay responsive when sortable shells are thin and same-column reorders freeze layout
`useSortable` and `useDroppable` can rerender every registered item/container while a drag is active. For dense Kanban columns, keep the sortable wrapper cheap (transform, listeners, selection chrome), move expensive card content into a memoized child, and render `DragOverlay` with a non-sortable presentational card instead of reusing the sortable component. Prefer a static source ghost plus one absolutely positioned insertion indicator over live sibling displacement and full-column hover previews so drag feedback does not keep recomputing transforms for the whole list or shifting card layout; then scope sibling-freeze behavior to same-column reorders only.

### dnd-kit DragOverlay should be portaled and geometry-locked to the source node
DragOverlay positioning is computed from the active draggable's measured rect. If the overlay preview renders inside layout-constrained ancestors or with different width/height than the source card, the preview can appear offset from the cursor on drag start even when pointer math is otherwise correct. The robust fix is to portal `DragOverlay` to `document.body` and lock the preview width/height from `active.rect.current.initial` captured at drag start, instead of trying to compensate with ad hoc cursor-offset modifiers.

### dnd-kit column hits need pointer-derived insertion math, not container-end fallback
In a sortable column with real visual spacing (`gap`, margins, or any future separator treatment), collision detection can legitimately report the column droppable instead of a specific card when the pointer is in the space between siblings. Treating every column hit as `cards.length` causes drops in those gaps to append to the end even though the user targeted a middle insertion slot. Keep the visual spacing mechanism independent from drop logic: once the target column is known, derive the insertion index from the live pointer Y against the rendered card rects. For pointer drags, reconstruct the pointer from `activatorEvent + delta`; only fall back to overlay/card center when there is no pointer coordinate source (for example keyboard drags).

### Radix `asChild` triggers must forward ref and arbitrary DOM props all the way to the real element
When a surface is used as a Radix trigger (`ContextMenuPrimitive.Trigger asChild`, `Popover.Trigger asChild`, etc.), converting that surface from a DOM node into a custom component can silently break the trigger if the component does not `forwardRef` and spread arbitrary DOM props onto the underlying element. For draggable card surfaces, keep the trigger surface as a proper DOM-forwarding wrapper so Radix can attach right-click/focus handlers while dnd-kit still attaches drag listeners.

### BlockNote side-menu drags append a `.bn-drag-preview` to the root, so cleanup cannot rely only on the drag handle
BlockNote's side-menu drag lifecycle clones the selected block DOM and appends it to the document root as `.bn-drag-preview` at `(0,0)` for `dataTransfer.setDragImage(...)`. Their shipped styles make it nearly invisible but still hit-testable, so during editor->kanban drags it can steal `dragover`/`drop` and clicks from the board's top-left area even before a cleanup bug is involved. During editor->kanban "turn blocks into cards", the source blocks are removed before the drag handle's React `onDragEnd` is guaranteed to run, which can also strand that invisible preview after drop. The safe pattern is both: CSS `pointer-events: none` on `.bn-drag-preview`, and editor-level native drag cleanup (`drop`/`dragend`) that calls the SideMenu `blockDragEnd()` path plus a fallback removal of orphaned `.bn-drag-preview` nodes.

### Visible BlockNote side menus must disable the entire subtree during mouse text selection
Setting `pointer-events: none` only on BlockNote's floating side-menu wrapper is not enough for our editor stack. The wrapper can become non-interactive while descendant buttons remain hit-testable, and with our custom add button / widened drag gutter that is enough to truncate native Chrome/Electron text drag selections. The reliable fix is to arm a local guard on primary-button `mousedown` inside `.ProseMirror`, keep the side menu visible, and disable pointer events on `.bn-side-menu` plus all descendants until `mouseup`.

### `cardToggle` snapshots should carry both human-readable `meta` and machine-readable snapshot payload
For round-trip drag (`card -> cardToggle -> card`), a serialized `meta` string alone is not enough to preserve full card properties (tags, assignee, due date, scheduled start/end, blocked state). Store an encoded snapshot payload alongside `meta`, update both when editable chips change (`priority`, `estimate`, `status`), and prefer snapshot defaults while applying `meta` token overrides on export back to Kanban.

### Grouped undo only works predictably when source updates + target creates are one DB transaction
For block-drop import (move semantics), avoid split mutations (`update source` then `create cards`). Use one transaction and write all history rows with the same `group_id`; then grouped undo/redo can reliably reverse/apply in one step (`undo`: reverse chronological, `redo`: chronological) without split-brain state.

### Project-scoped Card Stage persistence must sync card snapshots on every patch/update
Keeping Card Stage state per project is not enough by itself; if the stored `card` snapshot is only set on open, switching projects can remount stale data and appear to lose in-progress edits. Wrap Card Stage handlers so `onPatch`/`onUpdate`/`onMove` also update the persisted peek snapshot for that project.

### Card writes need defense-in-depth limits at both HTTP boundary and db-service
To prevent runaway payload growth from parser/serializer bugs or hostile clients, enforce card write size limits in two places: route-level HTTP body caps (return `413`) and field-level validation in `db-service` (covers both HTTP and Electron IPC). Keep limits centralized in shared constants so behavior stays consistent across transports.

### Link-label escaping must round-trip through parser + serializer to avoid exponential growth
If link labels are parsed as raw text (for example, ``[...] (url)``) but always escaped during serialization, repeated saves can grow backslashes exponentially (`f(n)=2f(n-1)+1`) on escaped markers like `\*`. Parse link labels with the same backslash-unescape rules used for normal text so save cycles are idempotent, and keep a regression test that loops many round-trips on representative markdown.

### General child-group Enter/Backspace behavior is safest with schema-gated inline parents plus ProseMirror split/merge helpers
For BlockNote nested child groups, applying Enter/Backspace behaviors beyond toggles should gate on parent `blockSchema[type].content === "inline"` so paragraph/heading/list/card-toggle parents are supported while non-inline wrappers are skipped. Keep high-level guards in keyboard handlers, and do structural edits (merge child into sibling/parent; split parent trailing content into first child) in ProseMirror transaction helpers injected from `nfm-editor-extensions.ts` for reliable cursor placement and child-order control. For Backspace specifically, any leaf child at block start should merge upward into its previous sibling (or the parent if it is the first child), including tail children in quote/list/toggle contexts.

### Never re-couple sidebar DB project switching to Thread/Card/Terminal routing
The sidebar project switcher is DB-stage datasource selection only. Re-coupling it to Thread/Card/Terminal context causes cross-stage resets and stale cross-project writes. Keep `dbProjectId` scoped to DB view/search/cache, keep Threads on `threadsProjectId` (or active thread project), keep Card Stage entity-driven by its session project, and keep Terminal routing on each tab's `projectId`.

### Shared `localStorage` is the wrong restart-resume boundary for independent Electron windows
Electron windows in the same session share origin `localStorage`, so moving workbench restore state there would make restart persistence work at the cost of collapsing independent multi-window sessions into one shared shell state. Keep live window state in `sessionStorage`, and persist only one explicit last-window snapshot through the main process under profile-scoped `userData`.

### Toggle-list editors need the same toggle-state bridge as Card Stage (IDs + localStorage + DOM-readback)
`ToggleListCardEditor` (used by both Toggle List tab and `toggleListInlineView`) serializes child descriptions through a separate mapping/sync path, so Card Stage-only fixes are insufficient. To preserve `▼`/`▶` state end-to-end, this path must: assign explicit IDs when converting NFM→BlockNote children, pre-populate `localStorage` before `replaceBlocks`/`updateBlock`, read `data-show-children` from DOM before BN→NFM serialization, and observe `data-show-children` mutations because toggle clicks can skip ProseMirror transactions.

### BlockNote toggle state requires a localStorage bridge because block IDs aren't stable across NFM round-trips
BlockNote's `defaultToggledState` stores toggle open/closed state in `localStorage` keyed by `toggle-${block.id}`. Since NFM round-trips (parse → serialize) don't preserve block IDs, localStorage entries become orphaned on every reload. Fix: assign explicit IDs via `crypto.randomUUID()` during NFM→BN conversion, pre-populate localStorage before editor creation, and read DOM `data-show-children` at save time. A `MutationObserver` on `data-show-children` attribute changes detects toggle clicks (which don't produce ProseMirror transactions) and triggers save.

### Inline embedded BlockNote editors can inherit unwanted root indent from `.bn-block-group .bn-block-group`
Because `toggleListInlineView` renders a nested BlockNote editor inside the outer editor DOM, BlockNote's global nested-group rule (`.bn-block-group .bn-block-group { margin-left: 24px; }`) can shift the entire embedded root to the right. Fix with a scoped override on the inline embed container (`.nodex-toggle-inline-card-editor .bn-editor > .bn-block-group { margin-left: 0; }`) so only embed root alignment is corrected and normal child nesting indent remains.

### Inline toggle-list save should avoid cursor jumps by minimizing local churn and deferring inbound sync while focused
In `ToggleListCardEditor`, debounced outbound save should not trigger duplicate optimistic board updates (`patchCard` + `updateCard`), because redundant re-renders can destabilize nested editor cursor state. Use only `updateCard` for persistence, and defer inbound `replaceBlocks` / `updateBlock` reconciliation while the embedded editor has focus; replay deferred reconciliation on blur so background sync stays correct without moving the active caret mid-edit.

### Shared custom block specs should live in leaf modules to avoid schema import cycles
If one schema module (`toggle-list-schema`) imports from another schema module (`nfm-schema`) while a custom block renderer in that chain imports back into the first schema, ESM evaluation can hit TDZ errors like `Cannot access '<export>' before initialization`. Keep reusable custom block specs (e.g. callout) in leaf modules (`callout-block.tsx`) and inject schema instances into shared editor components instead of importing schema singletons inside them.

### Inline toggle-list navigation is most robust when summary focus is editor-native and host routing is handle-based
For `toggleListInlineView`, avoid standalone `<input>` summaries. Use an embedded `cardToggle` BlockNote editor so summary focus/cursor is native ProseMirror state, register a per-inline-block boundary-focus handle, and let the outer editor route Up/Down via that handle plus top-level-only neighbor lookup (`:scope > .bn-block-outer > .bn-block[data-id]`) to avoid nested-editor block-ID pollution.

### Prevent inline embed arrow races by intercepting keydown before ProseMirror capture handlers
For `content: "none"` custom blocks, ProseMirror can select the whole block (`NodeSelection`) on Up/Down at textblock boundaries before app-level bubble listeners run. Handle boundary arrow routing in a capture-phase keydown path (or ProseMirror `handleKeyDown`) and add a recovery path that, when current block is `toggleListInlineView`, routes Up/Down into last/first summary input.

### Up/Down flow across custom inline embeds works best with split handling at both boundaries
For keyboard navigation across `toggleListInlineView`, handle arrows in two places: summary inputs should route Up/Down to previous/next summary (or exit to neighboring editor blocks), and parent editor keydown should route boundary Up/Down from normal blocks into first/last summary. A single-side handler leaves one direction broken.

### Chrome-less inline embeds should avoid container affordances and wrapper indentation
For low-distraction inline blocks inside BlockNote, remove custom container margin/padding/background/border and avoid extra child-wrapper indentation around nested editors. Keep any controls absolutely positioned and non-layout-affecting so the block reads like native toggle rows in the parent document flow.

### Editable `content: "none"` BlockNote embeds need event isolation and local draft sync
For custom embed blocks that render editable controls (input + nested editor), isolate pointer/key events from the parent ProseMirror node view (`stopPropagation` on row controls) and keep per-row local drafts with debounced blur-flush saves. Sync drafts back from board state only when not focused and not mid-debounce to avoid cursor jumps while still reflecting remote updates.

### BlockNote toggle caret size can unintentionally scale with heading/parent typography
BlockNote toggle SVG uses `1em` dimensions; custom caret replacements using `em` also inherit container font size. In derived editors (like card-toggle children), this can make toggle icons appear oversized. Pin toggle button/caret size with px in scoped editor CSS (e.g. `.nodex-toggle-list-editor .bn-toggle-button::before`) for stable icon sizing.

### Custom BlockNote embed blocks may need explicit full-width block-content overrides
BlockNote applies default `.bn-block-content` padding/width behavior that can make custom embed-like blocks look inset. For full-bleed inline embeds, set a targeted rule (e.g. `.nfm-editor .bn-block-content[data-content-type=\"toggleListInlineView\"] { width: 100%; padding: 0; }`) and keep it after broad editor rules like `.nfm-editor .bn-block-content { padding: 4px 2px; }` so the inline-view override wins.

### `:has(...)` on `.bn-block` can overmatch ancestors unless the first combinator is constrained
For React custom blocks like `cardRef` and `toggleListInlineView`, BlockNote renders `.bn-block-content[...]` inside a direct `.react-renderer` child of the owning `.bn-block`, not as a direct `.bn-block-content` child. A broad selector like `.bn-block:has(.bn-block-content[data-content-type="cardRef"] [data-active="true"])` matches every ancestor `.bn-block` that contains that subtree, causing ancestor highlight bleed. Use a constrained first combinator that anchors to the owner structure, e.g. `.bn-block:has(> .react-renderer .bn-block-content[data-content-type="cardRef"] [data-card-ref-shell][data-active="true"])` or `.bn-block:has(> .react-renderer .bn-block-content[data-content-type="toggleListInlineView"] [data-inline-view-shell][data-active="true"])`.

### Custom slash-menu extensions need a single shared `SuggestionMenuController`
To add custom slash items while keeping BlockNote defaults, disable `BlockNoteView` built-in `slashMenu` and mount one shared `SuggestionMenuController` that merges `getDefaultReactSlashMenuItems(...)` with app-specific items. If default slash remains enabled, menus can conflict/duplicate and custom items won’t stay consistent across editors.

### Reuse toggle keyboard handlers across custom toggle-like block types
When adding custom toggle row blocks (like `cardToggle`), shared Enter/Backspace handlers should treat them as toggle parents too; otherwise key behaviors diverge between editors. Keep toggle-type checks centralized (`toggleListItem`, toggleable `heading`, `cardToggle`) so child-creation and empty-child deletion behavior stays consistent.

### Share BlockNote extension bundles across editors to keep UX aligned
When multiple editors should behave the same (Card Stage and Toggle List), centralize extension setup (`disableExtensions`, input/shortcut overrides, paste handler) and shared drag/toggle-drop wiring into reusable editor modules instead of duplicating `useCreateBlockNote` config per view. This prevents UX drift and reduces bug-fix duplication.

### Inline embeds should use single-editor projection when drag handles must work inside embed children
Nested BlockNote editors inside `content: "none"` embed blocks (`cardRef`, `toggleListInlineView`) can conflict with BlockNote SideMenu editor targeting (`findClosestEditorElement`) and hide/steal drag-handle interactions for nested children. The robust fix is a single-editor projection model: render referenced card rows as projected `cardToggle` children in the host editor tree, strip projected subtrees before host NFM serialization, and guard projected row roots against manual structural edits while keeping child blocks draggable in/out.

### Projection performance requires shared stores/controllers, not per-embed listeners
Per-embed sync wiring scales linearly with embed count: each embed adding its own board subscription/fetch path and editor listeners (`onChange`, `onSelectionChange`, `MutationObserver`, `focusout`) causes duplicated reconcile/patch work and long `message` tasks when many projected embeds are open. The stable pattern is two shared layers: a per-project board store (single realtime subscription + deduped fetch/mutation fan-out + shared `cardIndex`) and a per-editor projection sync controller (single listener set + owner registry + targeted owner flush/reconcile). Keep embed hooks as thin registration facades.

### Projection outbound saves should patch locally before remote mutation
For projected `cardToggle` edits (`cardRef`/`toggleListInlineView`), run a local `patchCard` before awaiting `updateCard` so Kanban/List views update immediately while the remote write is in flight. Keep store-side no-op guards so repeated identical optimistic patches do not trigger extra rerenders.

### Inbound projection reconcile must treat unsynced local projected edits as outbound-busy
If inbound reconcile compares projected-row signatures before local projected edits are captured as pending outbound patches, stale `projectedRows` can overwrite freshly moved/edited projected-row content (notably after drop into projected rows). In `projection-sync-controller`, capture/merge current projected patches on local `onChange`, gate inbound reconcile on `pendingPatchByCardId`, and avoid replaying queued inbound snapshots after successful outbound sends.

### Post-mutation board refreshes should wait for stale in-flight fetches, then refetch
`kanban-store.fetchBoard()` dedupes concurrent requests by returning the same in-flight promise. If a write path (`moveCard`, import, etc.) starts while an older fetch is already running, awaiting `fetchBoard()` can settle with stale pre-mutation data. Combined with mutation cooldown suppressing immediate realtime refresh, same-project UI can stay stale until remount. Use a dedicated `refreshBoard()` that awaits current `inFlightFetch` first and then issues a new fetch, and avoid calling `markMutation()` for no-op local patches so cooldown does not suppress useful realtime updates.

### Meta strings can drive rich non-editable chips in custom BlockNote rows
For derived row blocks (like `cardToggle`), keep editable title content separate and render property chips from a serialized `meta` string (`[P0] [L] [Backlog]`) in the custom block renderer. This keeps sync payloads simple while still matching existing chip visuals via stable CSS class mapping.

### Derived card editors need stable block IDs to preserve per-block UI state
For card-derived BlockNote documents (like Toggle List), use deterministic top-level block IDs (`toggle-card-<project>-<cardId>`) and treat membership/order as source-of-truth from board + rules. Then do structural replace only when membership/order changes; otherwise patch block content/props/children in place and skip dirty/in-flight cards to avoid sync races and collapse-state loss.

### Custom image actions should be added via a custom FormattingToolbarController
BlockNote’s image floating panel actions come from formatting toolbar items. To add app-specific actions like `Copy image`, disable default `formattingToolbar`, render your own `FormattingToolbarController`, and compose `getFormattingToolbarItems()` with the custom button so built-in file actions remain intact.

### Renderer HTTP base must come from runtime, not a hardcoded localhost port
Hardcoding `http://localhost:51283` in renderer helpers breaks Electron image upload/asset fetch when `[server].port` is changed in `config.toml`. Resolve API base at runtime: Electron should use a preload-injected server URL from main process; browser mode should use `window.location.origin` (except local Vite dev on `:51284`, which should target API `:51283`); keep default `51283` only as fallback.

### History diff UI should merge previous/new keys to preserve "cleared" fields
`history.new_values` is JSON-serialized, so keys with `undefined` values are omitted. For accurate field-level history diffs (especially when a value is cleared), derive changed fields from the union of `previousValues` and `newValues` keys, not from `newValues` alone.

### Card stage tag suggestions can use native datalist with zero custom dropdown state
For lightweight tag autocomplete, `Input` already forwards native props, so wiring `list` + `<datalist>` is enough to show existing tags while typing. Build suggestions from board-wide unique tags, exclude tags already on the card, and keep Enter-to-add behavior unchanged.

### BlockNote find/highlight should use ProseMirror decorations + transaction meta
For in-editor search, avoid manual DOM wrapping of matched text. Use a ProseMirror plugin (`Decoration.inline`) and drive query/navigation through `tr.setMeta(pluginKey, action)` so highlights survive re-renders and doc changes. Keep toggle expansion separate from query updates; only expand collapsed toggle ancestors when navigating to an active match.

### Keep find input focused during search navigation
If find-next navigation forces editor focus, repeated `Enter` breaks because keystrokes stop going to the find input. For NFM find UX, avoid calling `editor.focus()` during reveal so users can keep pressing `Enter` to jump through matches, and use sticky find UI so controls remain visible while scrolling long notes.

### Selection scroll may need a DOM-level fallback in blurred editors
`tr.scrollIntoView()` after updating selection can be unreliable when focus stays in a find input instead of the editor. After setting the active match selection, run a post-render fallback (`requestAnimationFrame`) to scroll `.nfm-search-match-active` into view so navigation consistently reveals the hit.

### Sticky overlay toolbars should use a zero-height layer to avoid content shift
If a sticky toolbar is rendered in normal flow, mounting it pushes editor content down. For NFM find UI, use a sticky wrapper with `height: 0` and `pointer-events: none`, then place the interactive panel inside with `pointer-events: auto` so it stays visible while scrolling without shifting document layout.

### Flex find bars need `min-width: 0` on inputs to prevent icon overlap
In a single-row find toolbar with input + counters + icon buttons, a `width: 100%` input can overflow and push controls off-screen. Apply `flex: 1` and `min-width: 0` on the input in the top row so long queries truncate correctly and controls stay visible.

### Radix Select `item-aligned` needs `SelectValue` for custom triggers
Radix Select's default `position="item-aligned"` computes placement using an internal `valueNode` from `<SelectValue />`. If a custom trigger omits `<SelectValue />`, content can fail to position and appear "not opening". For custom chip/button triggers, prefer `position="popper"` (or add `SelectValue`) and make outside-click handlers ignore portaled select content so selecting an option does not auto-close the parent editor.

### Use SQLite online backup API for WAL-safe snapshots
With WAL mode enabled, raw file copies can miss committed state unless checkpoint sequencing is perfect. In Nodex, use `better-sqlite3` `db.backup(...)` for backup snapshots, then copy assets separately, and never treat `kanban.db` file-copy alone as a reliable live backup strategy.

### JSONL default output is safer for agents than CSV defaults
CLI tabular outputs (`ls`, `history`, `query`, `schema`, etc.) now default to JSON Lines instead of CSV so agents can stream/parse one record per line without header handling or CSV escaping edge cases. Keep `--csv`, `--json`, and `--table` as explicit format overrides.

### CLI typos were accidentally starting server mode
The old dispatch logic treated any unknown first argument as server-start args, so typos like `nodex lss` could start server mode instead of failing fast. Keep command resolution strict, and only auto-fallback to server mode when arguments clearly look like serve flags/path usage.

### HTTP JSON dueDate values must be normalized before db-service calls
`db-service` expects `dueDate` as `Date` (or unset), but HTTP JSON requests carry strings. Normalize `dueDate` in HTTP handlers (`YYYY-MM-DD` or ISO string → `Date`, `null`/`""` → clear) to avoid runtime `.toISOString()` type errors.

### BlockNote background colors use plain color tokens, not `_bg` suffixes
NFM inline/block background colors use `*_bg` (`purple_bg`), but BlockNote style props expect plain color names (`backgroundColor: "purple"`). Always normalize NFM→BlockNote (`*_bg` → plain) and BlockNote→NFM (plain → `*_bg`) in the adapter; otherwise background highlights silently fail to render in the editor.

### CLI TOCTOU races require server-side column resolution, not client-side lookup
When multiple agents use the CLI concurrently, a two-request pattern (lookup card column → operate on card) creates a time-of-check-time-of-use race: another agent can move the card between the lookup and the operation, causing silent "Not found" failures. Fix: make `columnId` optional in all server-side card operations (`getCard`, `updateCard`, `deleteCard`, `moveCard`) so the server resolves it internally within the same synchronous block. This collapses each CLI command to a single HTTP request. Also wrap all write operations (card mutation + history recording) in `db.transaction()` — since better-sqlite3 transactions are per-connection and `getDb()` returns a singleton, history-service calls within a transaction callback are genuinely atomic even though they independently call `getDb()`.

### IPC handler registration should be idempotent in Electron main
In Electron dev workflows with reloads, re-running `registerIpcHandlers()` can throw duplicate-handler errors on the first already-registered channel and prevent later channels from being registered, which leads to selective `No handler registered for '<channel>'` runtime failures. Register IPC handlers through a helper that first calls `ipcMain.removeHandler(channel)` and then `ipcMain.handle(channel, listener)` so channel maps are always fully refreshed.

### Notion inline styles/colors come from legacy title annotation tuples
Notion clipboard rich text often arrives as `properties.title` tuples like `["text", [["b"], ["i"], ["h","teal_background"]]]`. Preserve inline formatting by mapping `b/i/s/c/_` to bold/italic/strikethrough/code/underline and map `h` color tokens (`teal`/`teal_background`) to NFM-compatible colors (`green`/`green_bg`).

### Notion paste metadata survives as custom MIME and should be preferred over HTML
When copying from Notion in Chromium, structural block data is available via `text/_notion-blocks-v3-production` (and on native pasteboard encoded inside `org.chromium.web-custom-data`). For preserving structures like toggles, handle this MIME first via BlockNote `pasteHandler` and only fallback to default HTML/plain-text paste when Notion payload parsing fails.

### BlockNote file paste/upload requires `uploadFile` or file blocks never finish
BlockNote's file insertion flow creates a placeholder block first and then calls `editor.uploadFile(file, blockId)` to populate `props.url`. Without `uploadFile`, paste/drop image behavior effectively fails. In Nodex, keep `uploadFile` wired in `useCreateBlockNote` and avoid persisting unresolved image blocks with empty URLs.

### Stable media references should use app-specific asset URIs
Persisting absolute `http://localhost:...` image URLs inside NFM is brittle when host/port changes. Store canonical `nodex://assets/<file>` URIs in descriptions and resolve them to HTTP at render time (`resolveFileUrl` in editor and a renderer helper in read-only views).

### ProseMirror DOM is read-only for custom attributes
**Never** `setAttribute()` on ProseMirror-managed DOM nodes (`.bn-block-outer`, `.bn-block`, `.bn-block-content`, etc.). ProseMirror's MutationObserver detects mutations, marks nodes dirty, and re-renders — stripping any attributes not in the schema/decorations. The exact code path: `viewdesc.ts` → `patchAttributes()` removes attributes not in the computed decoration set.

**Fix pattern**: Place overlays/markers as children of elements **outside** ProseMirror's managed tree (e.g., React container divs), and use bounding rect calculations to position them. Attributes on React-managed elements (like `.nfm-editor`) are safe.

### Debugging lesson: find WHO before fixing HOW
When a DOM attribute flickers, don't assume it's your own code clearing it. First check if a framework (ProseMirror, React, etc.) is stripping it via its own reconciliation. Read the framework's DOM update source (`node_modules/`) to confirm the actual code path before writing a fix.

### BlockNote toggle-drop implementation
- `toggle-drop.ts` handles drag-and-drop onto collapsed toggle headers
- Overlay lives in `.nfm-editor` container (React-managed), positioned via `getBoundingClientRect()` relative to container
- `data-toggle-drop-active` on container is safe (not PM-managed)
- Guard-first pattern in `onDragOver` prevents flicker from transient `e.target` changes
- `revalidateActiveTarget()` handles PM DOM node replacement by re-resolving via blockId

### `.closest()` is dangerous for nested BlockNote blocks
**Never** use bare `.closest(".bn-block[data-id]")` to resolve a block ID from an arbitrary DOM element. For nested children, `.closest()` walks UP past the child's `.bn-block-outer` → `.bn-block-group` → parent's `.bn-block[data-id]`, returning the **parent** ID instead. Use the three-step `resolveBlockId()` helper in `toggle-drop.ts`: check self match, then `:scope >` direct child, then `.closest()`.

### BlockNote multi-block drag selection
When user shift+clicks multiple blocks and drags, BlockNote creates `MultipleNodeSelection` (not `NodeSelection`), so `.ProseMirror-selectednode` may NOT be applied. `editor.getSelection()` has an off-by-one for `MultipleNodeSelection`: it uses `getNearestBlockPos(doc, selection.to)` where `.nodeAfter` at the `to` position points to the NEXT block, not the last selected one. The `MultipleNodeSelection.nodes` array itself is correct (populated via `doc.nodesBetween` with exclusive `to`). **Fix**: duck-type the PM selection (`sel.nodes` for multi, `sel.node` for single) to read block IDs directly from the selection's node attrs instead of going through `editor.getSelection()`.

### BlockNote extension priority: `runsBefore` required to override built-in handlers
Custom `createExtension()` with a `keyboardShortcuts` handler for a key already handled by a built-in block spec extension (e.g., `Enter` on `toggleListItem`) will **NOT** run first by default. Both get the same priority (~101), and TipTap's reversal logic gives the built-in handler the tiebreak. **Fix**: Use `runsBefore: ["<built-in-extension-key>"]` to create a topological dependency that raises your extension's priority.

### BlockNote Backspace handler lifts nested blocks before empty-block deletion
In BlockNote's default `KeyboardShortcutsExtension`, Backspace checks `liftListItem("blockContainer")` at block start **before** its "delete empty inline block" path. We keep a custom child-group merge handler to override that path whenever the caret is at the start of a leaf child under an inline parent, including quote/list/toggle tail children. It merges content into the previous sibling (or parent if first child) via a ProseMirror-level operation (`mergeIntoBlock` in `nfm-editor-extensions.ts`) and places cursor at the join point. The merge uses `tr.delete` + `tr.insert` + `TextSelection.create` in a single transaction rather than BlockNote's `updateBlock`/`removeBlocks` (which loses cursor position). Similarly, Enter at position 0 of an empty child creates a new sibling (`child-group-enter.ts`) instead of unindenting.

### BlockNote toggle headings use `isToggleable` prop on heading blocks
BlockNote natively supports toggle headings via `isToggleable: true` on the heading block (when `allowToggleHeadings` is enabled, which is the default). No custom block type needed. The heading renders with the same `.bn-toggle-wrapper` / `.bn-toggle-button` DOM as `toggleListItem`. NFM syntax: `▶# Heading`, `▶## Heading`, etc. To make the `## ` input rule preserve toggle state when typed inside a toggle, disable built-in `"heading-shortcuts"` and provide a custom extension that checks `editor.getTextCursorPosition().block.type` in its `replace()` function.

### 0-delay cross-view sync is safest with optimistic journal rebase, not mutable snapshot writes
For card-domain writes, keep a per-project store model of `baseBoard + optimisticEntries` and derive UI board snapshots by replaying non-superseded entries. This avoids stale fetch/realtime payloads wiping in-flight local edits. Treat debounced/local draft patches as retained overlays (not pending network mutations), and treat remote mutations as pending entries. Use conflict-key superseding (LWW) so older in-flight writes no longer affect derived state when newer writes target the same card fields.

### Card stale-write conflict should be typed control flow, not generic mutation error
For concurrent card edits (especially multi-window), use revision-based stale-write detection (`expectedRevision`) and return a typed result (`updated | conflict | not_found`) from transport boundaries. Do not throw stale-write conflicts as generic exceptions: the optimistic journal should supersede/rebase conflicting overlays, refresh base board, and let UI choose a resolution action (`Reload Latest` or `Overwrite Mine`) without polluting global mutation-error channels.

### Electron single-instance lock must be scoped by server profile
`requestSingleInstanceLock()` is process-profile based, not app-install aware. If `userData` is left at the default app path, a dev build and packaged build can collide and launch into the same running process. Before requesting the lock, set Electron `userData`/`sessionData` under the resolved server profile dir (`KANBAN_DIR` / `config.toml`), so each profile enforces single-process semantics independently.

### Card Stage controllers must reconcile same-card prop updates (not only card-id switches)
If Card Stage local form state only hydrates when `cardId` changes, external updates to the same card (drag to a new status/column, priority edits from Board/List) can appear unsynced. Keep a same-card reconcile path that mirrors server/store fields into local state, while guarding actively edited draft fields so typing is not interrupted.

### Calendar recurrence interactions need a second optimistic layer
Even with board-level optimistic patches, calendar occurrence lists are fetched projections and won't update in the same frame. For complete/skip/scope-edit interactions, keep a local occurrence overlay map (`hide` / `upsert`) keyed by occurrence id (`cardId:occurrenceStart`) and merge it over fetched occurrences. Drop overlay entries automatically when fetched server state catches up or on mutation failure rollback.

### VS Code theme token generation should target semantic text/icon vars
`design.local/tokens.css`'s foreground model is not the old `--foreground` / `--foreground-secondary` / `--foreground-tertiary` layer. Keep generated `--vscode-*` foreground and icon aliases anchored to `--color-text-foreground*` and `--color-icon-*` instead; otherwise secondary/tertiary text tokens like `descriptionForeground`, placeholder text, badge text, and dim terminal colors silently drift from the design-token source of truth.

### Renderer-facing token aliases should own fallback chains for optional VS Code inputs
When a renderer utility consumes a semantic token like `bg-token-input-background`, keep its resilience in the alias definition (`--color-token-input-background`) instead of scattering runtime overrides across components. Use nested `var()` fallback chains so the semantic token resolves through the matching VS Code token first and then the local surface token contract (for input surfaces, `--vscode-input-background` -> `--color-background-elevated-primary`). This keeps utilities stable and prevents individual thread/composer surfaces from drifting.

### Design-local utility classes should be generated, not reimplemented
`design.local/index.css` is the broadest compiled source for the runtime `@layer utilities` block, including selectors like `.text-token-description-foreground`, opacity variants, placeholder variants, and the larger generic Tailwind utility surface. Keep that block generated into renderer CSS instead of manually recreating subsets in `design-system-theme.css`, or the runtime utility surface will drift from the actual compiled source of truth.

---
