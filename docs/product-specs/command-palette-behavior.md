# Command Palette Behavior

## Intent

The command palette is the global launcher for fast workbench navigation.
Its scope controls keep broad search and focused navigation in one surface:

- All shows quick actions, recent chats, and Page suggestions, then searches actions, chats, Pages, and available workspace files as users type
- Actions searches the command catalog
- Chats searches current non-archived chats
- Pages searches Library Pages and owns the Page filter controls
- Files searches the selected local workspace through the native file-search session
- result ranking favors fast recall over exhaustive inspection
- matching context is visible directly in the result row through inline highlights and short previews

The palette is a transient overlay and does not become part of durable navigation history.

## Launch and Scope

- `Cmd/Ctrl+K` opens the command palette from anywhere in the app with All selected, including editable surfaces.
- `Cmd/Ctrl+Shift+P` opens the same All scope.
- `Cmd/Ctrl+G` opens Chats.
- `Cmd/Ctrl+P` opens Pages.
- The sidebar `Search` row opens Pages and shows the `Cmd/Ctrl+P` shortcut.
- A leading `>` is plain query text and no longer switches modes.
- The palette searches the complete authorized Page corpus of every available Project context, not only Pages already loaded by a Board or the active Project.
- The palette combines the current non-archived local chat catalog with eligible root chats returned by app-server search. A server-only result is materialized locally only when opened.
- `Search files` is available when the selected context has local workspace roots. It shares native search lifecycle and ranking with the Composer and Files panel. `Enter` on a directory completes its path; accepting a file opens a preview. Remote contexts do not expose local file opening.
- `Force reload skills` is available when the selected chat supports skill discovery. It refreshes that chat's provider and scope, including its Claude Profile and Project or Codex execution host and skill roots. Unsupported providers do not expose the command. A pending refresh cannot replace another chat's inventory after selection changes.
- The palette closes after executing a result.
- Pressing `Enter` on a selected Page result materializes and selects that Page as a durable
  surface: in the active Session when one owns the workbench, otherwise in the target Project
  Scene. An unopened Page follows the same path as a clicked result; closing the palette is not
  evidence that navigation succeeded.
- Closing the palette clears the query and resets the selection index. Reopening starts discovery sections at their initial result counts.
- The top row contains All, Actions, Chats, and Pages; Files appears when local workspace roots are available. Changing scope keeps the current query. Pointer selection and Tab cycling return focus to the search field; arrow navigation within the scope tabs keeps focus on the tabs.
- The palette uses a translucent surface with 65% surface color, a 24px backdrop blur, rounded corners, a hairline boundary, and a shadow. A black overlay at 13.33% opacity lightly dims the workbench.
- The centered palette is 768px wide and 504px high, bounded to 92vw and 90vh. The scope and input rows stay fixed while results scroll, so changing queries or scopes does not resize the surface.

## Scopes

### All Scope

All is the initial scope for `Cmd/Ctrl+K` and `Cmd/Ctrl+Shift+P`.

- An empty query shows the supported `New chat`, `Create Page`, and `Open folder` actions under Quick actions, followed initially by up to five recent chats and five Page suggestions. Development-only mock actions are excluded from Quick actions.
- A one-character query searches actions only.
- At `2` Unicode characters, matching local chat and Page metadata appears in trailing Chats and Pages sections while matching actions remain visible. Available local workspace files are searched through the native file-search session.
- At `2` Unicode characters, All synchronously searches the warm, Core-authorized Page metadata projection and starts bounded Core body enrichment. At `3` characters, Chats additionally merges bounded app-server chat-history results.
- Results remain grouped as actions, Chats, Pages, then Files; scores from different result types are never interleaved.
- Chats, Pages, and Files each initially show up to five results. Each section exposes `Show more` when additional results are available; activating it appends up to five results in that section without closing the palette. Focus stays in the input and selection stays at the insertion point, allowing keyboard navigation to continue through the newly revealed results. Actions and search-status rows do not consume another section's limit, and Page results appear independently of pending chat-history search.
- Changing scope resets section expansion to its initial five-result counts. Page discovery ignores persisted Pages filters because those controls are not visible in All.
- Search actions such as `Search chats`, `Search Pages`, and `Search files` enter the corresponding scope with an empty query. This differs from selecting a scope in the top row, which preserves the query.

### Actions Scope

Actions contains the full command catalog, including when the query is empty.
All uses the same catalog for non-empty queries.

- Commands are grouped as Suggested, Chat, Navigation, Panels, Project, Configure, Skills, and App.
- Disabled commands remain visible with their reason, but keyboard selection skips them and they cannot be executed.
- Commands use customized command-keymap shortcut labels where a matching command id exists.
- Command rows omit explanatory subtitles unless needed to explain an unavailable action.
- Unsupported shell commands appear only in development as disabled mock rows with a `Mock` badge; production hides them entirely. Supported Nodex-only actions appear in the closest matching group.
- `Toggle browser panel` and `Open Page Stage` are intentionally not part of the command catalog.

### Chats Scope

Chats is opened by `Cmd/Ctrl+G`, the Chats scope control, or `Search chats`.

- Chats shows chat rows only.
- Commands and Pages are hidden entirely in Chats.
- Empty query shows recent and pinned sidebar chats when available.
- User-facing row text uses `chat`; internal data structures may still use `thread`.
- Chat metadata search is local and immediate. Transcript discovery and snippets come only from the bounded app-server search path described below.

### Pages Scope

Pages is opened by `Cmd/Ctrl+P`, the sidebar `Search` row, the Pages scope control, or `Search Pages`.

- Pages shows Page rows only.
- Commands and chats are hidden entirely in Pages.
- Empty query shows default Page suggestions.
- Pages keeps a trailing `Filter` button on the search-input row.
- Query-fresh metadata rows appear in the input event. While Core body enrichment is pending, `Loading more Pages…` appears below the current results; `No matching pages.` appears only after the current query, filters, Project scope, and projection revision have settled with no matches.
- Typing a newer query or closing the palette cancels obsolete body enrichment as normal control flow. Superseded work never produces a Main-process error or changes the current query to an unavailable state.
- A failed enrichment keeps synchronous metadata rows and shows `Full Page search is unavailable`. It never falls back to an incomplete corpus assembled from mounted Boards.
- Clicking `Filter` opens a transient popover with property filters for status, priority, tags, assignee, and project. Escape closes the popover before the palette. Closing it returns focus to the Page search field without an intervening tooltip layer.
- When any palette filters are active, the palette shows a compact summary row directly under the input, using the same compact pill language as the DB view toolbar.
- Palette Page filters persist across palette reopen and app reload, but the free-text query still clears on close.

### Files Scope

Files uses the shared native file-search controller and reports loading, empty, and failure states. All uses the same controller for queries of at least two characters when local workspace roots are available.

- Query changes update the existing native session; host/root changes, leaving an eligible search scope, and closing the palette release it.
- Directory results complete the query; file results open a preview in the selected owner.
- File search has no default keyboard binding; its configurable binding leaves `Cmd/Ctrl+P` assigned to Pages.

## Page Search Model

### Search fields

Core Page search matches the following normalized fields:

- title
- Page key and historical Page-key prefixes
- Page id
- typed Property display text, including tags, assignee, status, and priority
- indexed Page body text

Normalization is Unicode NFKC normalization, lowercasing, and whitespace tokenization. A multi-term query requires every term to match somewhere on the same Page.

### Ranking

One Rust search kernel, used natively by Core and as renderer WASM, produces metadata order and evidence. Complete Core search may add body evidence/results. Match classes are ordered by specificity:

- current or historical Page key
- exact Page id, then Page-id prefix
- exact, prefix, then typo-tolerant title token
- exact, prefix, then typo-tolerant Property token
- exact or token-prefix body match

Short terms do not use typo tolerance. Longer terms permit a bounded edit distance, and fewer edits rank first inside the same match class. Free-text search stays separate from palette filters; lifecycle, authorization, Project scope, and filters narrow the eligible corpus before Core applies the result bound.

Filter semantics:

- status, priority, assignee, and project filters are multi-select unions
- tag filters support `Any`, `All`, and `None` matching modes
- tag identity includes Data Source, Property, and option IDs so equal labels from different schemas do not collapse

### Ordering

For non-empty queries, Core sorts by:

1. match specificity across all query terms
2. active-project preference
3. explicit recent-Page preference
4. body-search rank when metadata evidence is otherwise equal
5. Page update time and stable Page identity

For empty queries, Core returns suggestions ordered by:

1. active-project preference
2. explicit recent-Page preference
3. Page update time
4. stable Page identity

### Projection lifecycle

- SQLite remains the durable source of Page metadata, Properties, body-search rows, and resource lifecycle.
- Core may reuse a derived in-memory Page-search projection only while both Store epoch and commit head still match the read snapshot. The first read after a committed change rebuilds it before answering.
- Core publishes a read-only metadata bootstrap fenced by Profile/Store identity, commit head and the exact query. Library change events refresh affected Pages or replace the snapshot; an identity or query change invalidates it before further synchronous reads.
- The renderer prewarms this projection, queries it synchronously on every live input, and debounces only complete Core enrichment. It does not persist the projection or implement matching/ranking in TypeScript.
- All and Pages request at most `60` Page results. All initially displays `5`; Show more reveals the next batch without replacing the authoritative search or clearing existing body matches. Pages displays up to `60`.
- Filter facets come from the same current Core projection as search results.

## Page Result Presentation

### Primary line

Each Page result renders:

- a Page icon in All or the canonical Project marker in Pages
- Page key when available and Page title
- project and column subtitle for non-empty queries

If the query matched the title, Core returns the exact display-text segments to highlight inline rather than asking the renderer to reconstruct a match.

### Secondary match indicators

If the query matched other fields, the result may render compact indicator chips from Core's typed evidence for:

- `tag`
- `assignee`
- `status`
- `id`

These chips render only for fields that actually matched.
They are intentionally compact and subdued so they explain why a result appeared without overpowering the title.

### Description preview

If the query matched body or Property text, the result renders a contextual preview below the subtitle:

- excerpt is selected by Core from authoritative matched sources
- a multi-term query keeps up to three matched fragments, each bounded to 240 Unicode characters; evidence for the same source window merges its highlights before selection
- selection favors information beyond the title, additional query-term coverage, and distinct sources; separate windows in a long Block retain their shared Block identity
- the same selected evidence feeds complete Core search previews and CLI search; ranking and access filtering are unchanged
- each excerpt fragment centers around an actual matched term
- excerpt is trimmed with leading/trailing ellipses when taken from the middle of the source
- preview is clamped to `3` lines
- Core-provided matched spans are highlighted inline

If a result has no body or Property excerpt, no preview is shown.

In All, Page rows stay compact: metadata badges are omitted and a body excerpt is clamped to one line. Focused Pages retains the full match treatment above. Empty-query suggestions omit the subtitle in both scopes.

## Chat Search Model

Chat search indexes the local chat catalog in the renderer and treats app-server `thread/search` as a bounded supplement and discovery source.

### Indexed fields

Chat metadata search indexes:

- title
- preview
- git branch
- project name
- cwd
- chat id

The local index includes non-archived project-backed, projectless, and sessionless chats. The app-server supplement may add eligible root chats that are not local yet. Archived chats, side chats, ephemeral conversations, parent-linked subagents, and internal helper threads are excluded at the main-process boundary.

### Ranking

Chat metadata search uses an in-memory MiniSearch index. It is intentionally not persisted in IndexedDB because chat metadata is small and already fetched on palette open.

Field boosts are:

- title: `8`
- preview: `4`
- git branch: `2.5`
- project name: `3`
- cwd: `2`
- chat id: `1`

Query semantics match Page metadata search:

- multiple terms combine with `AND`
- prefix matching is enabled for terms with length `>= 2`
- fuzzy matching uses the shared term-length-sensitive thresholds

For empty queries, chat results preserve sidebar ordering: pinned rows first, then the sidebar's recency ordering.
For non-empty queries, the best matched field orders results first (`title`, `preview`, `branch`, `project/cwd`, then id), followed by relevance and recency. Pickers may place active-Project results first without changing this shared match order.

### App-server search

The renderer requests bounded chat search through `codex:threads:palette:search`, with a 200 ms debounce:

- the request limit is capped at `60`
- Chats searches for every non-empty query; All starts at `3` characters
- main calls paginated app-server `thread/search`, ordered by `updated_at` descending, until it reaches the result limit or exhausts the cursor
- main drops archived, ephemeral, parent/subagent, and internal-source rows, guards repeated cursors, and enriches hits from local thread/session/Project state when available
- a normalized query/limit cache lasts 30 seconds and identical in-flight requests are deduplicated
- renderer results are accepted only for the current normalized query; a stale response cannot replace newer rows
- expanding the same query retains confirmed content matches while the larger request loads or fails; changing the query or closing the palette clears them
- app-server errors show a compact fallback status while local metadata matches remain interactive
- Nodex stores no transcript copy, FTS table, retry state, or backfill queue for this feature

### Chat Result Presentation

Each chat result renders a chat icon and title. Empty-query recent rows keep a compact single-line layout with the Project name at the trailing edge when available. Non-empty queries add project, cwd basename, branch, and updated date metadata plus any matching preview or snippet.

Metadata matches highlight title, project/Chats context, cwd, branch, and preview characters inline without badge-like match chips. App-server snippets are normalized and highlighted against the current query in the renderer. CJK, emoji, and combining marks use one code-point coordinate system so highlighting never corrupts visible text.

## Command Search Model

- Commands are matched in All and Actions.
- Command ranking remains lightweight and heuristic rather than MiniSearch-based.
- Ranking considers exact/prefix/substring and fuzzy subsequence matches across title, subtitle, and keyword text, plus explicit command priority and active-state bonus.
- Matching command-title characters are highlighted inline; a failed fuzzy attempt leaves the original title untouched.
- Result limits remain separate from Page limits.

## Keyboard Behavior

- The search field keeps focus while the selected result is exposed through the combobox's active descendant. Result rows do not enter the Tab sequence.
- `ArrowDown` / `ArrowUp`, or `Ctrl+J` / `Ctrl+N` and `Ctrl+K` / `Ctrl+P`, move selection and skip disabled commands. Selection stops at the first and last enabled result instead of wrapping.
- `Home` / `End`, or `Meta+ArrowUp` / `Meta+ArrowDown`, jumps to the first or last enabled result.
- `Alt+ArrowUp` / `Alt+ArrowDown` moves to the first enabled result in the previous or next group, stopping at the first or last group.
- `Enter` executes the selected result. A directory completes the path; `Show more` expands its section. Both keep the palette open.
- `Tab` / `Shift+Tab` in the search field cycles forward/backward through available scopes, wrapping at either end and preserving the query.
- `F6` moves focus from the search field to Filter in Pages, or to the active scope tab in other scopes. From Filter or the scope tabs, `F6` returns to the search field.
- The scope row uses tablist semantics. `ArrowLeft` / `ArrowRight` moves between scope tabs and activates them; `Home` / `End` selects the first or last scope. Keyboard scope navigation retains focus on the tabs and preserves the query.
- `Escape` closes the palette directly, including with a non-empty query. An open nested Page filter popover consumes Escape first.
- IME composition prevents palette keyboard commands from executing or closing the palette while text is being composed.

## Result Limits

- All with an empty query shows supported quick actions and initially up to `5` chats and `5` Pages.
- All with a non-empty query shows up to `100` matching command rows and, once the relevant search threshold is met, initially up to `5` chats, `5` Pages, and `5` native file/directory matches.
- Each All content section expands independently in increments of `5` through `Show more`. Chat request budgets grow with expansion, up to `60`; Page expansion reveals the already bounded `60`-result search, and native Files retains its `50`-match bound. Expansion stops at the available results or that category's bound. Status rows do not displace another category.
- Actions shows up to `100` matching command rows.
- Chats shows up to `25` chat rows, with pending history-search status below the current results.
- Pages shows up to `60` Page rows, with pending enrichment status below the current results.
- Files displays up to `50` native file and directory matches after path exclusions.

The palette owns transient scope, query, section expansion, and selection. A single
result model composes command groups and independently bounded discovery sections,
including their expansion rows and search status. Search providers retain their
own ranking, query freshness, and lifecycle rules; expanding one section does not
change another section's result order or budget.

## Execution Semantics

### Page results

Executing a Page result:

- closes the palette
- opens that Page in a durable Page Stage panel tab
- preserves the current DB-project selection if the Page belongs to another project

### Command results

Executing a command result:

- closes the palette
- runs the associated shell/workbench action

### Chat Results

Executing a chat result:

- closes the palette
- opens the attached project session for that chat
- shows the existing unattached-chat toast only if the result is stale and its session link disappeared after search

Supported actions currently include:

- go back / go forward
- new chat, rename chat, archive chat, pin/unpin chat, and open chat in a new window
- toggle sidebar, side panel, and bottom panel
- open Files, Browser, Review, Terminal, and DB View panel tabs
- open side chat for an attached active chat
- open settings and keyboard shortcut settings

## Non-Goals

- full query DSL in Page mode
- quoted phrase operators
- inline search qualifiers or advanced query syntax
- persistent search history
- multi-snippet previews per chat
- syntax-colored rich-text previews

The palette is intentionally biased toward immediate navigation rather than becoming a full search product. Filtering should feel like a lightweight extension of the existing workbench toolbar language, not a separate advanced-search feature.
