# Review Right Panel Behavior

Status: Active
Last updated: 2026-08-25

## Purpose

The Review right-panel tab is Nodex's code-review workspace for an attached thread. It selects a review source, renders changed files, navigates the file tree, opens source previews, starts protocol review requests, and routes commit or pull-request follow-up work through the active thread.

## Shell And DOM Contract

Review is available only in a Session Scene with an attached Thread. Project Home, the Pages Scene, and threadless draft Sessions do not expose Review and cannot own a Review surface. Review is a Session singleton, but its durable tab id stays separate from the DOM id used by the right-panel shell. Review tab chrome and the active tabpanel expose `data-tab-id="diff"`. The active panel exposes `role="tabpanel"`, `aria-label="Review"`, and `data-app-shell-tab-panel-controller="right"` when mounted in the right panel.

The right panel owns `aside[data-app-shell-focus-area="right-panel"]`, the left resize handle, shadow edge, tab strip, close/plus/expand controls, and overflow containment. The Review body root is `grid h-full min-h-0 w-full grid-rows-[auto_1fr]`.

## Toolbar Contract

The toolbar is a two-column compact header with `h-toolbar-pane`, bottom border, primary surface background, and `review-header` container name. Control order is fixed:

- Source selector.
- Aggregate `+N` / `-N` stats.
- `Review options`.
- `Collapse all diffs` / `Expand all diffs`.
- `Jump to file`.
- Split/unified diff toggle.
- `Hide files` / `Show files`.
- `Commit or push`.
- `Create PR`.

The source selector is a pure Review data-source switch. It does not start a Codex review request or send a prompt. Its visible local-source menu order is `Unstaged`, `Staged`, `Commit`, `Branch`, `Last turn`; `Commit` opens a flyout with branch commits and selecting a commit only stores the commit SHA and switches the diff source to `commit`.

Toolbar icon controls use the compact review toolbar preset: square `h-token-button-composer` buttons with tertiary text color, transparent border, hover list background, and active file-tree state on `bg-token-foreground/5`. `Jump to file`, split/unified, and `Hide files` / `Show files` are icon-only. The file-tree toggle uses the shared Codex side-panel files glyph. `Commit or push` and `Create PR` use tertiary pill buttons with Codex SVG glyphs, visible labels at `review-header` widths of `625px` and wider, and icon-only square behavior below that container width.

Aggregate `+N` / `-N` stats use the Review toolbar text rhythm: `text-size-chat mr-1 shrink-0 select-none` layered on the shared diff stats element. Review must not pass `text-xs` to these stats.

`Jump to file` opens an end-aligned `panelWide` searchable menu with `contentMaxHeight="list"` and no separator between the search row and results. Empty query results sort by file name, then parent path. Search scores the basename first and falls back to the full path. Each result row uses the wrapped dropdown item body: filename is the primary `shrink-0 text-token-foreground` label, and the folder path is a secondary `min-w-0 flex-1 text-token-description-foreground` label rendered after the filename with middle truncation.

`Review options` includes view/query actions only and uses iconized menu rows. For Git-backed sources the order is `Refresh`, `Enable/Disable word wrap`, separator, `Load full files` / `Don't load full files`, `Enable/Disable rich preview`, `Enable/Disable word diffs`, `Hide/Show white space`, and `Copy git apply command`. Expand/collapse-all is a standalone icon action immediately after `Review options`; its tooltip and accessible label describe the action it will perform. The copy action reads a capped full patch through the read-only Review patch query and writes a `git apply --3way` heredoc only when that query succeeds. Review request actions must live in an explicit review-start surface, not inside the source selector or the `Review options` menu. The old restriction against word diffs, rich preview, full-file loading, and manual file-tree resizing no longer applies.

## Source And State Contract

Supported source kinds are:

- `last-turn`
- `unstaged`
- `staged`
- `branch` with optional base branch
- `commit` with commit SHA and optional title
- `pull-request` with PR number

Selected transcript turns can still open an internal selected-turn diff, but selected turns are not a primary source menu item.

`last-turn` reads the newest available completed `turn-diff` transcript item's raw `unifiedDiff` first, then falls back to that turn's summary `diff`. A newer prose-only or in-progress turn does not hide the preceding completed diff. The completed `turn-diff` item is the preferred source because it preserves the app-server turn diff payload plus patch-batch metadata when available; when the app-server turn diff is missing or empty, main may populate this item from completed patch batches with path-aware hunk folding.

Review treats unified diff text as renderable content only after file safety classification. Binary, oversized, invalid-text, or unsupported file changes remain metadata rows with their original path and action, but they do not feed `@pierre/diffs`, full-file loading, or body text search. These rows render typed placeholders such as `Binary file changed` or `File too large to display`; they still appear in the file tree and can match path search.

Review presentation state follows renderer scope ownership. The containing Session Scene supplies Thread and Route identity; Review config carries only optional Project workspace metadata and never substitutes for those scopes. Diff mode, hide-whitespace, wrap, word-diff, rich-preview, and full-file preferences belong to App scope and survive Review unmounts and task switches. Source identity, commit/base ref, file-tree visibility and width, selected canonical path, filter, and expanded paths belong to the task Route scope and restore when retained routes are revisited. Menu state, DOM rows, retry timers, abort controllers, and focus affordances remain component-local. Raw diffs, file contents, comments, and other conversation authority never enter these atoms.

Diff disclosure uses the same two-level model as Codex: one source-scoped all-expanded default plus sparse per-file overrides. Expand/collapse-all changes that default and clears the overrides; toggling or revealing one file writes only that file's override. Files that arrive later inherit the active default, removed files lose stale overrides, deleted files remain intrinsically collapsed unless individually opened, and changing the Review source resets the global default to expanded. The toolbar icon follows the global default, so a single per-file or deleted-file state does not invert the next bulk action.

Turn changed-file navigation carries only source identity plus a canonical repository-relative path. It writes a new monotonic reveal request even when the same file is clicked twice, activates the durable Review singleton, waits for the source and row to mount, expands/selects the file, and scrolls it to the start. A newer reveal cancels an older one. Absolute cwd paths, patch `a/`/`b/` prefixes, and rename aliases resolve through the same canonical path boundary; ambiguous aliases fail closed.

An application-tool open carries a bounded one-shot source/path request in the target
Session's Review surface until that surface mounts. The Route consumes its exact operation
identity once and removes the pending request; later user source changes are not overwritten
by replaying the same opening. The containing Session still supplies Thread and Route identity.

## Empty-State Contract

No-change states are source-specific. `staged` with no diff renders `No staged changes` with `Accept edits to stage them`; `unstaged` with no diff renders `No unstaged changes` with `Code changes will appear here`. These stage-filter empty states do not render the generic Review illustration. When a Git branch diff is available and the active source is not already `branch`, the empty-state action is the secondary toolbar-size `View branch diff` button. Clicking it only switches the Review source to `branch`; it must not call `codex:review:start` or send a prompt.

Generic no-diff states render `No file changes yet` with the Codex 66x73 document illustration. A missing last-turn diff says `The latest diffs are no longer available.`; a retained last-turn diff whose files are no longer renderable says `The last turn was committed or reverted.`; an internal selected-turn diff that has expired says `The selected turn diff is no longer available.`; ordinary Git no-diff states say `Changes in this project will appear here.`. The Review body remains a split container in empty states, so an open file-tree pane stays visible and shows its own `Filter files…` / `No matching files` state instead of disappearing behind the main empty state.

## Diff And File Tree Contract

Review builds one file entry per display path. If a legacy or fallback patch payload contains repeated `diff --git` sections for the same path, Review folds them into a single row and single file-tree item: stats and search text accumulate across all sections, while inline diff rendering uses the last parsed file diff for that path. Git-backed sources normally arrive as net diffs already, but the same path-fold guard applies to every source.

File entries are metadata-first. A row may have `fileDiff: null` when the path is binary, too large, invalid text, or otherwise unavailable. Renderer code must branch on the row load status before rendering a diff body: `loaded` rows render `FileDiff`, while `binary`, `diff-too-large`, and `unsupported` rows render placeholders. Review never sends full old/new texts through `MultiFileDiff`; full context expands the existing partial `FileDiffMetadata` only after validating its hunks against both complete line arrays. Binary file line stats are nullable, matching Git `numstat` semantics, and aggregate stats treat null values as absent rather than as displayed zeroes.

Each file diff card exposes its canonical path through `data-review-path`, plus `group/file-diff`, `codex-review-diff-card`, a toggle marked `data-app-action-review-file-toggle`, and an `Open in` action. The filename itself is a semantic button: ordinary click opens the shared right-side Files preview, double click makes that Files tab durable, and modified or middle click opens the configured external editor. The icon-only `Open in` action is the explicit external path and must not be routed into Files. The diff scroll viewport is zero-inset horizontally; file rows must not sit inside an extra padded or gapped card list. The file row surface uses `--codex-diffs-surface` with the primary surface fallback and adds `pb-0.5` only while expanded. The sticky row header is a `group/diff-header` strip with blurred surface mix, `text-size-chat`, `py-0.5 ps-3 pe-2`, a file-type icon, path label, a chevron toggle button that appears on header hover or when the toggle itself has keyboard focus, right-aligned stats, and icon-only `Open in`. Row-level `+N` / `-N` stats inherit that `text-size-chat` header size and must not add a smaller `text-xs` override. Diff rendering uses `@pierre/diffs` through `src/renderer/lib/diff-presentation.ts` and must pass the Review-specific host style/options rather than feature-local shadow-DOM CSS. Review options are `hunkSeparators: "line-info"`, `collapsedContextThreshold: 1`, `expansionLineCount: 20`, `diffIndicators: "bars"`, `lineDiffType: "word-alt"` while word diffs are enabled, and native `overflow: "wrap"` or `"scroll"` according to the wrap preference. Capped mode temporarily forces `"scroll"` without changing that preference. Separator wrappers align to the package line-number column via `grid-template-columns: var(--diffs-column-number-width) auto` and `padding-inline: 2px`; do not add local first-child margins or fixed expand-button widths.

The Review scroll surface uses the real `@pierre/diffs/react` `Virtualizer` with an intersection margin of 1000px. Offscreen diff bodies are package-owned virtual placeholders; CSS `content-visibility` and delayed bulk rendering are not correctness mechanisms. Collapsing a textual row keeps its `FileDiff` instance connected and changes the package-owned `options.collapsed` layout flag, allowing Pierre to invalidate its approximate height and reconcile the same observed host instead of racing a bulk disconnect against stale placeholder measurements. A row is memoized and reads only its own full-content cell. Files above 2000 changed lines disable word-level diffing and use plain-text language presentation.

The file tree is a right split pane. It has a minimum logical width of `200px`, a maximum width of `60%`, and hidden-state preservation for filter, expanded paths, selection, and width. The open pane outer shell uses `relative flex h-full shrink-0 border-l border-token-border-default`; inline style owns only `width`, `maxWidth: "60%"`, and `opacity: 1`. Do not add pane-level padding, background, overflow clipping, or a dimmed opacity; the inner content wrapper is `flex h-full min-h-0 w-full flex-col`. The left resize separator is a 16px hit target with `role="separator"` and `aria-orientation="vertical"`: `group absolute flex touch-none select-none z-40 top-0 bottom-0 left-0 w-4 -translate-x-2 cursor-col-resize active:cursor-col-resize`, containing an opacity-0 gradient line that appears on hover/active. The tree search uses the shared `Filter files…` field chrome: `px-2 pt-2 pb-px` search container, leading search glyph, `h-token-button-composer` rounded input surface, and a clear button only while a filter is present. The tree rows use the same 8px horizontal inset as the search input, so the rounded input and row backgrounds share the same left and right edges. The tree preserves ancestor folders during filtering and keeps focused/selected rows synchronized with the active diff path.

Review and Files share the `@pierre/trees` adapter in `components/ui/file-tree.tsx`. Its long-lived model owns Shadow DOM rows, selection, keyboard focus, compressed folders, sticky ancestors, guides, and virtualization. Review uses 29px rows, a 13px font, 6px row padding, zero row margin, a 10px icon/text gap, and a 20px Git lane. Files uses 28px rows. File-type sprites are 16px. Review folders use the foreground color; file names use the tertiary color and become foreground on hover or selection. Filenames preserve extensions when truncated; compressed folder paths truncate each segment independently.

Added, deleted, and modified files show the corresponding outlined square plus, minus, and dot in the Git lane. Renamed and untracked files retain `R` and `U`; copied files use added, and type changes or conflicts use modified. Changed directories show a muted modified-color dot. File names never inherit Git decoration colors. Turn patches derive status from parsed diff metadata, independently of current working-tree status. Display-path collisions receive distinct internal tree identities while retaining the real path for selection and file actions.

Existing review comments show a bubble and count before the Git lane. Pending composer drafts are excluded. If the repository declares `linguist-generated`, Filter options offers `Filter generated files`; its task-scoped setting filters both the tree and diff rows. The Git worker resolves attributes for current entries, including turn paths and nested overrides, without loading file contents into the renderer.

A file's context menu offers its preferred external opener, available alternative openers, `Save as…`, `Copy path`, and `Add to chat`. Directory rows do not open this menu. Actions use the full real path; choosing an alternative opener does not change the saved preference. `Save as…` selects a native destination and copies bytes through Main; cancellation or the same source file leaves the source unchanged. `Add to chat` appends a file reference to the current composer without sending.

Large diff mode activates when any of these are true: file count is above 128, total changed lines are above 9000, total changed bytes are above 12582912, or a single file changes more than 15000 lines.

## Search Contract

Review does not own a local find bar. It registers a global content-search source with `domain: "diff"`. Search stores at most 250 matches while preserving the exact total; capped labels show that exact total with `+`, while next/previous navigation cycles only through the stored matches. Match ids are exactly `diff:<path>:<hunkId>:<start>`. Each match carries the path, `path` or zero-based hunk id, hunk line bounds, UTF-16 start/end offsets, and a 24-character before/match/after snippet. Activation expands and reveals the virtualized `data-review-path` row. For a single-line body match it first targets the matching additions/deletions `data-line`, then writes the stable match id across that line's Pierre shadow-root syntax tokens; path or multiline matches use the file-level fallback. It centers only that exact mark.

Local search indexes a path pseudo-hunk followed by the already-loaded partial diff hunks; it never searches aggregate patch text, complete old/new files, or unchanged full-file context. Local Git search is allowed as soon as the review is not capped, generated-file classification is complete, and every partial diff is loaded—full-file cells are irrelevant. Otherwise the Git worker searches the current repository generation by streaming `git diff --unified=3`, uses `git check-attr linguist-generated`, and commits a result only while that internally acquired generation remains valid. Generated files are excluded entirely, including their path pseudo-hunk; a normal binary diff can still produce a path-only match. Search does not accept a caller-owned `snapshotGeneration`. Query changes and unmount abort the active worker request, and request plus repository generation ownership prevents older results from entering state.

The streamed diff is consumed incrementally and is never retained as an aggregate patch. A successful result still scans the complete stream so `totalMatches` remains exact; stdout volume is bounded by the process deadline rather than the partial-diff byte cap. Stderr, the unfinished current line, stored matches, and process lifetime are independently bounded. A malformed diff with a single unterminated line above the safe diff limit fails the search instead of publishing a partial count.

## Backend Contract

Renderer code uses the typed `GitWorkerClient` behind the Electron renderer transport; it does not call Electron or Main Git implementations directly. Main authorizes one narrow worker message channel and routes responses/events to the owning renderer. There are no operation-specific snapshot or live-query IPC handlers.

Git-backed Review reads use worker methods `stable-metadata`, `status-summary`, `review-summary`, `branch-diff-stats`, `review-diff`, `review-cat-file`, `review-generated-paths`, `review-search`, `review-patch`, `branch-commits`, `base-branch`, `merge-base`, and `blame-file`. Repository mutations use `git-init-repo`, `apply-patch`, `checkout-branch`, `create-branch`, and `commit` in the same worker-owned repository lane. Commit/PR message and GitHub/push orchestration remain narrow Main interfaces, but their repository reads also go through the worker. Every successful local mutation advances or refreshes the worker-owned repository generation before the affected UI converges.

The worker live-query registry serves `stable-metadata`, `branch-metadata`, `status-summary`, `review-summary`, `branch-diff-stats`, `branch-commits`, and `base-branch` through typed updated/failed events. Review summary can publish `tracked` then `complete` for unstaged/branch sources; branch diff stats does the same when untracked files are requested; branch commits and base-branch metadata publish only `complete`. Base-branch results preserve both local and remote identities, and branch Review prefers the remote ref (for example `origin/main`) before its local counterpart. One renderer Query coordinator routes publications into TanStack Query caches and owns subscribe/release/restart recovery; components keep only display state.

The worker canonicalizes repository identity and shares identical direct/live queries by method, normalized parameters, and repository generation. Summary and branch-diff-stats refresh for config, HEAD, index, remote-ref, and working-tree changes. Branch-commits and base-branch refresh only for config, HEAD, and remote-ref changes. Repository generation binds summary, diff, cat-file, search, and patch work; an older response is typed stale data and cannot enter current renderer state. Watcher failure retains the last consistent query value and marks recovery required. Cancellation, stale, timeout, non-zero exit, and output-limit outcomes remain operation results rather than Electron handler errors.

`review-diff` accepts `cwd`, `source`, structured file requests, `snapshotGeneration`, `baseBranch` / `baseRef`, `commitSha`, `hideWhitespace`, `hostConfig`, and `operationSource: "review_model"`. Renderer ownership has two tiers: stable tracked/untracked initial group Queries use canonical repository/comparison plus file-revision identities and infinite freshness; only a missing, failed, or revision-mismatched entry enables its five-second per-path fallback Query. Repository generation remains a request fence but is intentionally absent from the stable cache identity, so a live generation change with unchanged revisions performs no additional diff request or parse. Requests coalesce after two microtasks, separate tracked and untracked groups, preserve independent fallback cancellation/retry state, and propagate AbortSignal cancellation to the worker. The worker trusts the summary-owned structured paths and does not rebuild the repository summary before reading their patch bodies. A typed stale result triggers at most one refresh/retry against a newer generation.

Git-backed Review builds its file list from machine-readable Git metadata before renderer diff parsing. The worker uses no-textconv/no-ext-diff, colorless Git diff commands and reads `--name-status -z`, `--numstat -z`, and `--raw -z` style metadata so binary files can be represented even when no textual hunk exists. File summaries include nullable line stats, raw status, old/new object ids, and a per-file revision identity when Git can provide one. Untracked discovery uses normal-status directory expansion and materializes at most 256 paths per completion result, reporting the omitted count. Untracked files are diffed with `git diff --no-index -- /dev/null <path>` instead of pre-reading the worktree file as UTF-8.

The live summary is metadata-only and returns file summaries plus stage counts and `snapshotGeneration`; it never sends an aggregate textual patch as the normal render path. `review-diff` is the partial body loader and returns typed load statuses for binary, oversized, unsupported, timed-out, and load-failed rows instead of decoded text. Renderer parses each loaded path once and reuses that metadata/object identity across a tracked-to-complete publication, so adding untracked rows does not reparse or rerender already loaded tracked rows.

`Load full files` defaults on, but loading is row-local. A file must be expanded, partial, textual, changed, generated-classification-ready, and intersecting the viewport before it can request full content; new, deleted, pure-rename, gitlink, binary, oversized, collapsed, and offscreen rows do not request it. Requests wait 40ms and batch at most four Git objects per `git cat-file --batch` command. Each object is byte-parsed and capped at 5 MiB with a 30-second command timeout. Working-tree fallback is allowed only for a missing next-side object. Failed or unvalidated expansion keeps the partial diff visible.

`review-patch` is a read-only full-patch query used for commands such as `Copy git apply command`; it does not mutate the worktree or index. Patch application and revert actions use worker method `apply-patch`, which is the only Git-backed Review operation that applies patch content.

GitHub pull-request review uses typed `gh`-backed IPC:

- `gh-cli-status`
- `gh-pr-status`
- `gh-pr-checks`
- `gh-pr-comments`
- `gh-pr-diff`
- `gh-pr-comment`
- `gh-pr-merge`
- `gh-pr-update`
- `gh-pr-create`

When `gh` is missing, unauthenticated, or the repository has no remote, main returns typed disabled states. Renderer surfaces disabled/error UI from those states instead of inferring capability from missing data.

## Review Requests And Comments

Explicit review-start actions call `codex:review:start` with protocol-native targets where possible:

- uncommitted changes -> `{ type: "uncommittedChanges" }`
- base branch -> `{ type: "baseBranch", branch }`
- commit -> `{ type: "commit", sha, title }`
- unsupported custom scopes -> `{ type: "custom", instructions }`

Delivery defaults to `inline`.

Diff lines are commentable in the Review panel. Hovering a changed line exposes the `@pierre/diffs` gutter utility slot (`data-gutter-utility-slot > button[data-utility-button]`) with the package plus icon. Clicking the plus, dragging a gutter line/range, or right-clicking a hovered line and choosing `Request changes` creates a local line annotation draft unless that exact `${side}:${lineNumber}` already has a model comment, local pending comment, or open draft. `side` is `additions` for right-side/new lines and `deletions` for left-side/removed lines.

Local drafts render in the diff annotation slot as `Local comment` cards. The header shows `Comment on line Rn` / `Comment on line Ln`, or `Comment on lines ... to ...` for ranges. The editor placeholder is `Request change`; empty drafts cannot be submitted. New drafts expose `Cancel` and `Comment`. Submitted local comments stay as editable pending annotation cards with `Save` and `Delete`, and also appear as removable composer attachment chips until sent.

Pending review-diff comments are sent with the next thread turn, queued follow-up, or steer. Renderer stores them in `CodexPromptInput.commentAttachments`; main converts each one into a text user input and also writes structured JSON to `additionalContext["review-diff-comments"]` with `kind: "application"`. Each attachment includes `type: "comment"`, text content, `position.path`, `position.side` (`left`/`right`), `line`, optional `start_line` / `start_side`, and optional `localDiffHunk`.

Assistant `::code-comment{title body file start end priority}` directives are parsed separately from normal text and render as readonly Codex line annotation cards on matching file diffs. File-level comments without `start` still render above the file diff. GitHub pull-request inline review comments use the PR review-comments API, preserving path, line, side, range, reply id, author, URL, and outdated state instead of treating issue-level PR comments as inline annotations.
