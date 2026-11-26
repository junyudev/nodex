# Command Palette Behavior

## Intent

The command palette is the global launcher for fast workbench navigation.
Its scope controls keep broad search and focused navigation in one surface:

- All shows quick actions, recent chats, and Page suggestions, then searches actions, chats, Pages, workspace filenames, and file contents as users type
- Actions searches the command catalog
- Chats searches active and archived chats
- Pages searches active and archived Library Pages
- Files searches filenames on the selected computer through the native file-search session
- Text streams literal matches from file contents on the selected computer
- result ranking favors fast recall over exhaustive inspection
- matching context is visible directly in the result row through inline highlights and short previews

The palette is a transient overlay and does not become part of durable navigation history.

## Launch and Scope

- `Cmd/Ctrl+K` opens the command palette with All selected, including from editors and dialogs. A focused Terminal uses this chord to clear its output.
- `Cmd/Ctrl+Shift+P` opens the same All scope.
- Chats opens from its scope tab, `O T`, or the configurable `Search chats` command, which has no default shortcut. `Cmd/Ctrl+G` and `Cmd/Ctrl+Shift+G` navigate Workbench Find.
- `Cmd/Ctrl+P` opens Pages.
- The sidebar `Search` row opens Pages and shows the `Cmd/Ctrl+P` shortcut.
- A leading `>` is plain query text and no longer switches modes.
- All, Pages, and Chats search **Everywhere** by default. Their search option is the place control at the right of the footer, which lists every Project with its marker and checks the current place. Choosing a Project narrows all three scopes, and reopening the palette resets the place to Everywhere.
- The palette finds readable root chats across the Profile, including projectless chats and archived chats from every Provider.
- `Search files` and `Search text in files` are always discoverable. When the current context has no workspace, their folder control opens a host-aware chooser. Search roots are transient and never change Project sources. File and directory results open through the same host-qualified file navigation owner as file links; Text results also pass their exact one-based line and UTF-16 column. Remote paths never fall through to local filesystem opening.
- `Force reload skills` is available when the selected chat supports skill discovery. It refreshes that chat's provider and scope, including its Claude Profile and Project or Codex execution host and skill roots. Unsupported providers do not expose the command. A pending refresh cannot replace another chat's inventory after selection changes.
- The palette closes after executing a result.
- `Open folder` and `Cmd/Ctrl+O` choose a local directory, reuse an active Project with exactly that source folder or create one named after the folder, and focus that Project's new-chat composer without clearing its draft or attachments. A multi-folder Project is not reused for a single-folder request, so the selected folder becomes the execution directory. Canceling the picker leaves navigation unchanged. Directory search results remain file-navigation actions, distinct from opening a Project.
- Pressing `Enter` on a selected Page result materializes and selects that Page as a durable
  surface through the same content route as a clicked result. Project Pages retain their Project presentation; Pages without a Project open through the Library route. An unopened Page follows the same path as a clicked result; closing the palette is not
  evidence that navigation succeeded.
- Opening uses an explicit query when supplied, otherwise a valid selection from the originating editor, then the last All/Files query. A selected query is trimmed, single-line, at most 256 UTF-16 units, and never read from a password field. The search input selects the opening query for replacement. Closing preserves the last broad query; reopening resets result selection and section expansion.
- Closing synchronously releases the dialog before restoring the originating element and its directional native-input or document selection, including shadow-root editors. Disconnected or shortened selection endpoints are ignored; restoration does not scroll the document.
- The palette reads top to bottom as search field, results, then a footer with the scope tabs on the left and the selected scope's search options on the right. The tabs contain All, Actions, Chats, Pages, Files, and Text, including before a workspace has been chosen. Changing scope keeps the current query. Tab and Shift+Tab in the search field cycle scopes; pointer selection and Tab cycling return focus to the search field; arrow navigation within the scope tabs keeps focus on the tabs. F6 moves from the search field to the scope's first search option, or to its tab when the scope has none, and F6 inside the footer returns to the search field. The search field describes Tab and F6 to assistive technology instead of showing a key hint. A drill-in such as Theme hides the footer.
- The palette uses a translucent surface with 65% surface color, a 24px backdrop blur, rounded corners, a hairline boundary, and a shadow. A black overlay at 13.33% opacity lightly dims the workbench.
- The centered palette is normally 768px wide and 504px high. Width and viewport bounds account for window zoom; the result viewport is bounded between 120px and 440px with a 64px chrome allowance. The search field and the footer stay fixed while results scroll, so changing queries or scopes does not resize the surface.
- At regular width (at least 700 CSS pixels of surface content), scope tabs and search options share the footer row. Long folder or Project names truncate within the remaining space; opening file-type history must not add a row or move the search field. Compact windows wrap the search options under the tabs, inside the footer. Folder labels expose their full paths on hover. Layout and semantic text hierarchy are verified in Chromium with long names, saved masks, both appearances, and window zoom.

## Scopes

### All Scope

All is the initial scope for `Cmd/Ctrl+K` and `Cmd/Ctrl+Shift+P`.

- An empty query shows the supported `New chat` and `Open folder` actions under Quick actions, followed by up to five recent chats and five Page suggestions. These recents do not offer `Show more`; their scope tab lists more.
- A one-character query searches actions, available workspace filenames, and file contents. Files and Text remain absent from an empty All query.
- All searches the selected place for Pages and chats. Workspace filenames and file contents use the current Project context. Switching back to Files or Text within the same opening restores its temporary folder selection.
- At `2` Unicode characters, matching chat and Page metadata appears in trailing Chats and Pages sections while matching actions remain visible. Workspace filename and text searches continue independently of those thresholds.
- At `2` Unicode characters, All synchronously searches the warm, Core-authorized Page metadata projection and starts bounded Core body enrichment. Once the query has a word of `3` characters, or `2` CJK characters, Chats also lists chats matched only by their message history.
- Results remain grouped as actions, Top result when present, Chats, Pages, Files, then Text.
- Chats, Pages, Files, and Text each initially show up to five results. Text can expand to its 100 matching-line backend limit. Each section exposes `Show more` when additional results are available; activating it appends up to five results in that section without closing the palette. Focus stays in the input and selection stays at the insertion point, allowing keyboard navigation to continue through the newly revealed results. Actions and search-status rows do not consume another section's limit, and Page results appear independently of pending chat-history search.
- Changing scope resets section expansion to its initial five-result counts.
- Search actions such as `Search chats`, `Search Pages`, `Search files`, and `Search text in files` enter the corresponding scope with an empty query. This differs from selecting a scope tab, which preserves the query.

When the highest-ranked content match is strong, All shows it as **Top result**
after the Actions groups and before Chats. The row uses its focused-scope
presentation, including an available excerpt. It appears once. Archived
Page and chat rows have a trailing **Archived** label.

### Actions Scope

Actions contains the full command catalog, including when the query is empty.
All uses the same catalog for non-empty queries.

- Commands are grouped as Suggested, Chat, Navigation, Panels, Project, Configure, Settings, Skills, and App.
- Search installed local skills under Skills: by name in All, and by name or description in Actions. Open a result beside an active chat or in Customize from elsewhere. Force reload skills remains available for the current conversation's skill catalog.
- Disabled commands remain visible with their reason, but keyboard selection skips them and they cannot be executed.
- Commands use customized command-keymap shortcut labels where a matching command id exists.
- Command rows omit explanatory subtitles unless needed to explain an unavailable action.
- The application catalog contains only working capabilities in development and production. Every action uses its owning command handler; unavailable context may temporarily disable a supported action.
- Visible, enabled Settings sections are directly searchable in the Settings group and navigate through the Settings route owner, opening the group or Agent card the query names, as Settings search does.
- Navigation offers `Switch to <Space>` for every connected Space other than the window's own, through the same switch as the account menu's Space list.
- Theme opens a nested page with a search field, a Back row, light/dark switching, and the existing per-appearance accent presets. Previews and the current-preset check reflect the same persisted appearance owner as Settings. Entering or leaving this page clears its query; scope tabs are hidden while it is open. Escape or an outside dismissal returns one level before closing the root menu.
- `Toggle browser panel` and `Open Page Stage` are intentionally not part of the command catalog.

### Chats Scope

Chats is opened by the Chats scope control, `O T`, or `Search chats`.

- Chats shows chat rows only.
- Commands and Pages are hidden entirely in Chats.
- Empty query lists pinned chats first, then the most recent chats.
- User-facing row text uses `chat`; internal data structures may still use `thread`.
- Chat metadata matches answer each keystroke; message-history matches follow once typing pauses, as described in [Chat Search Model](#chat-search-model).

### Pages Scope

Pages is opened by `Cmd/Ctrl+P`, the sidebar `Search` row, the Pages scope control, or `Search Pages`.

- Pages shows Page rows only.
- Commands and chats are hidden entirely in Pages.
- Empty query shows default Page suggestions.
- Typing a newer query or closing the palette cancels obsolete body enrichment as normal control flow. Superseded work never produces a Main-process error or changes the current query to an unavailable state.
- A failed enrichment keeps synchronous metadata rows and shows `Full Page search is unavailable`. It never falls back to an incomplete corpus assembled from mounted Boards.

### Files Scope

Files and Composer use the same file search service. On this computer, fuzzy search includes hidden files, respects Git, `.ignore`, and `.rgignore` rules, and lists directories with searchable descendants. It follows symbolic links that leave a root but never re-enters a root through one: a linked folder whose real location is inside the same root is skipped, because its contents are already searchable under their real path and governed by that path's ignore rules. Linked files are listed under their own names. All searches names from the first non-empty character. Empty Files shows up to ten recently opened files on the selected host and within the selected roots.

Names match like a fuzzy finder. The query's characters appear in order anywhere in the root-relative path, with more weight at the start of a name, a word, or a path segment, so `fileindxmod` finds `file-index-module.ts`. Case is ignored and accented letters also match their plain forms. Spaces separate terms that must all match; a term starting with `'` must appear exactly, `^` anchors it to the start of the path, a trailing `$` to its end, and `!` excludes paths that match it. For a single plain term without a path separator, a file named exactly as the query ranks first, then the best folder with that name, then other files whose name matches, then matches elsewhere in the path; equal scores order by path. Search returns at most 50 results, and typing more of the same query narrows its previous matches. Rows highlight the matched characters in the name and folder. While an edited query runs, the previous matches stay visible until its first results arrive. Every host ranks the same way.

On this computer, every search over the same root shares one index. It lists the root once and follows file changes: created, renamed and removed names appear in the next query without listing the root again, and changing an ignore file updates the folders it governs. A root nobody searches stays indexed for five minutes; a root that cannot be watched is listed again for each new search. One root indexes at most 1,050,000 names, and all indexed roots together at most 1,150,000; idle roots make room first. Six minutes after the last search closes, file search stops its background process to return that memory, and the next search lists its folders again. Changes inside folders reached through symbolic links appear once the root is listed again.

A search never fails as a whole and never withdraws matches it has shown. It settles with the matches it found and, when it could not search everything, the first reason in root order:

- **Too large**: a root holds more names than its limit, or listing it outlasted its time or output bounds. The names listed so far stay searchable and the root stays indexed. The palette reads `“<folder>” is too large to search completely`.
- **Missing** or **unreadable**: a root no longer exists, or Nodex may not read it, such as a privacy-protected folder on macOS. Other roots are still searched. The palette reads `“<folder>” no longer exists` or `Nodex doesn’t have permission to read “<folder>”`, and the next query lists the root again.
- **Unavailable**: search itself could not run, for example because its process stopped twice for the same query or its session was lost twice. The palette offers a selectable `Couldn’t search files. Select to retry` row after any matches.

The explanation appears directly below the Files results, in Files and in All; Files tabs show it as their search status. A lost search session is started again once before a query reports it.

- Query changes update the existing native session; host/root changes, leaving an eligible scope, and closing release it.
- Absolute paths and `~/` use host-qualified metadata lookup instead of fuzzy matching. Home shorthand resolves on that host. Missing paths show an empty result; transient lookup failures offer retry. Explicit folder overrides constrain absolute lookup to their roots, while a default Project context permits an explicitly entered outside path.
- Choosing a directory keeps that explicit boundary even when it equals the Project's root. Choosing the Project or complete folder context clears the override.
- Changing host, roots, query, or lookup generation fences previous responses. Directory results close the palette and open the directory; they do not complete a Composer mention.
- The folder control is shared with Text. It offers the current Project or complete folder context and a directory chooser. Its subdued label names the Project, folder, or temporary search directory; opening or hovering the control changes its background without brightening its text. The chooser re-enables the folder control before restoring focus after selection, cancellation, or an error.
- The directory chooser starts with no selection and offers `Select current folder`. Typing an absolute path selects that path and filters child directories in its parent; a trailing separator browses the directory directly. Up/Down cycle the suggestions, Enter accepts the active suggestion without navigating into it, and clicking a directory navigates into it. `Choose` accepts the selected path. Parent navigation, full-path tooltips, and hidden directories are available. Remote browsing uses the remote filesystem and preserves the host when choosing a path.
- The temporary folder selection survives closing and directly reopening Text in the same context. A new opening in another scope clears it; changing host or Project roots never borrows another context's selection. It is not persisted across application restart.
- File search has no default keyboard binding; `Cmd/Ctrl+P` remains assigned to Pages.

### Text Scope

Text searches file contents through Main's scoped workspace search service. This is independent of Page body search and does not require a cloud search index.

- Queries are literal, single-line strings of at most 256 UTF-16 units; smart case matches lower-case queries without case sensitivity and respects explicit capitals. CR, LF, and NUL are rejected.
- Each edit starts after a 50ms debounce. Query, file mask, host, roots, or priority-folder changes cancel previous work. Closing the palette cancels its request; destroying the renderer or Main scope releases all its subprocesses.
- Results stream in backend order. While the same host/roots refresh, previous matches may remain visible but cannot be selected or opened until they belong to the current request. Switching hosts or roots immediately removes stale results.
- Loading indication is delayed 500ms. Empty, invalid-query, invalid-mask, unsupported-host, missing-runtime, failed-search, and limited-result states are distinct. Fast searches do not flash a spinner.
- A failed request clears any retained results from an older query. Its error appears in the result flow before any valid matches already received from the current request; those matches remain usable. Errors never cover results or become selectable rows.
- Each compact result shows a highlighted line preview and filename with line number. Duplicate filenames gain relative paths and root labels. UTF-8 byte offsets from the search process are converted to UTF-16 offsets before display and navigation; previews are capped at 512 units without splitting surrogate pairs, with at most 32 highlight ranges.
- File types accepts comma-separated glob patterns with `!` exclusions. Escaped commas and commas inside balanced braces or brackets remain in their pattern; malformed patterns do not start a process. Include patterns precede exclusions. Enter in the field saves its mask and returns to search; ArrowDown opens previous masks. Pattern length is bounded to 256 units.
- File types appears once a search folder is available. Its field uses the primary outline without an additional focus ring; validation errors remain in the results. Folder and history controls use tertiary text, while result locations and progress or limit messages use secondary text.
- Query and mask history is keyed by host and Project roots, bounded to 20 contexts, 30 queries, and 20 masks each. Empty Text recalls previous queries. Accepting a result or leaving Text records the latest valid query and mask; intermediate typed prefixes are not added to history.
- A temporary folder selection changes the searched roots while retaining that host's current Project query and file-type history. Without a matching Project context, the chosen roots provide the history scope.
- The search reads hidden files and does not follow symlinks. It does not apply `.ignore` or `.rgignore` rules. Git ignore rules apply within Git repositories by default; explicit positive File types patterns can override those rules for matching files. Explicit negative File types patterns and dependency/build/cache directory exclusions still apply. Recent-folder prioritization preserves these same filtering rules.
- It searches roots sequentially, prioritizing up to 20 recent file parent directories without duplicate matches. Files over 10MiB are skipped; each child is limited to 30 seconds and 128MiB of output. A request stops at 100 matching lines and exposes that limit in Text.
- Local searches use the verified bundled ripgrep runtime. Remote POSIX searches use a trusted executable outside workspace roots or a pinned, checksum-verified runtime. Remote Windows reports its unsupported capability explicitly. Search processes and remote paths remain owned by their execution host.

## Text matching

Page and chat discovery share the same rules. Search ignores case, character width,
and accents on Latin, Greek, and Cyrillic letters. Straight and curly apostrophes
are equivalent. Highlights keep the original text. Library title filters use
the same text folding for literal substring matches.

Search recognizes segments at punctuation, case boundaries such as `pageSearch`
and `JSONSchema`, and between letters and digits. Chinese and Japanese characters
and emoji can match on their own. An apostrophe between letters keeps them together.
A query word can match adjacent segments in order, with a prefix on the last
segment. For example, `page_search` finds `PageSearchKernel`, `first` finds
`local-first`, and `迁移` finds `数据库迁移方案`. In a Page body or chat
message, a single Latin letter or digit must match a whole segment.

Every required query word must match the same Page or chat. Words can be spread
across fields and across Blocks or messages. Common words such as `the` and
`and` become optional when the query contains other words.

Whole segments, prefixes, joined metadata segments such as `vscode` for
`VS Code`, and English stems such as `migrate` for `migration` are strong
matches. When a word has no strong match in the searched text, four characters
allow an adjacent swap, five allow one edit, and nine allow two. The first
character must agree unless the first two were swapped. A query made entirely
of digits requires the typed digits. A fragment of four or more characters
inside a segment, such as `figur` in `configuration`, ranks below the other
classes.

## Page Search Model

Find searches every readable Library Page, including standalone Pages and
Pages in Databases without a Project. It puts active results before archived
results and prefers the active Project within each group before limiting the
answer. Matching can span the Page key, ID, title, Properties, and body Blocks.
Strong matches lead loose matches within each placement group. Page key and ID
lead each tier, followed by title, Property values, body, and context. A phrase
in one field or Block breaks ties, followed by recent use, relevance, edit time,
and stable identity.

Keys, titles, IDs, and Properties appear first. Body evidence and loose matches
follow, with the relative order of already shown results preserved. While body
coverage is incomplete, Pages shows “Still indexing Pages. Some matches may not
appear yet.” Use a Database View for structured filtering.

### Page result presentation

Rows show a Page icon, the Page key and title, and a fixed-width location column at the trailing edge: the Project's name, or the Page's Library path for Pages outside a Project. Matching title text highlights in place. A second line appears only to explain a match.
In Pages, compact badges on that line can identify a matching tag, assignee, status, or ID.

Body or Property hits show an excerpt centered on the matched text. Up to three
fragments can show different contributing words. The excerpt fits one line in All
and two in Pages. A settled search that reaches its search budget shows
`More matches exist. Keep typing to narrow them.` below the ranked results.

## Chat Search Model

Chat pickers cover readable root chats from every Provider, including projectless
and archived chats. Pickers that target a Thread, such as Page chat mentions
and Send to chat, list started chats. Empty queries show pinned and recent chats.
Empty queries put active chats before archived chats.
For typed queries, strong matches come before loose matches. Within each class,
active chats precede archived chats and the active Project is preferred within
each archive group. This order applies before the result limit.
The archived-chats settings page provides restore and delete actions.

Search matches titles, Projects, branches, pull requests, opening prompts, and
available messages. Agent Runtime indexes messages from every available Provider,
including native Codex. It also indexes completed command lines up to 4,096 characters
and the paths of changed files. History joins in the background and reports partial
coverage while it catches up. Native Codex history refreshes when a chat changes or its host
connects again; an idle Profile does not reread it, apart from a sweep every five minutes that
recovers missed changes and drops removed chats.

The weakest required word determines the match class. Within each placement
group, title leads other metadata, followed by message and then command or path. A phrase in
one field, use, hit frequency, and recency break ties. Each chat appears once.

Strong metadata matches appear as the user types. Opening prompts, loose matches,
and history follow after a short pause while rows already shown retain their relative order. Hits from available sources stay usable
while another source loads or reports incomplete coverage.

### Chat result presentation

Rows show a chat icon, the title, and the Project in the same trailing location
column as Pages. The title and a matching Project highlight in place. A matching
message, opening prompt, branch, or pull request adds an evidence line, labeled
`You` or `Agent` when the author is known; it fits one line in All and two in Chats.

While any search in the scope is still running, a spinner fades in at the top-right
corner of the palette after a short delay, and the empty state waits for it; results
already shown stay usable. Text keeps its own delayed progress. Below the chat
results, a status row can show `Some chat history couldn’t be searched` or
`Chats couldn’t be searched`.
When history is incomplete, the coverage row appears even if the query has no
matches. The narrowing prompt appears when the result limit omits ranked
matches. Both notices can appear for the same query.

## Command Search Model

- Commands are matched in All and Actions. In All, a command appears only when its name matches or a keyword starts with each query word, so content the query names is not pushed down by loose matches in paths or descriptions.
- Command ranking remains lightweight and heuristic.
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
- Unmodified `F6` moves from search to the first Files/Text search option, the place control in Pages, or the active scope tab elsewhere. From the options or scope tabs it returns to search. Composition and modified/default-prevented events do not trigger this transfer.
- The scope row uses tablist semantics. `ArrowLeft` / `ArrowRight` moves between scope tabs and activates them; `Home` / `End` selects the first or last scope. Keyboard scope navigation retains focus on the tabs and preserves the query.
- `Escape` dismisses the topmost open Tooltip, options popover, directory chooser, or nested Theme page before closing the palette, including with a non-empty query. A hovered hint closes first even when search keeps keyboard focus; hidden or inert background popups do not intercept Escape. Dismissing the directory chooser returns focus to the folder control and keeps the palette open.
- IME composition prevents palette keyboard commands from executing or closing the palette while text is being composed.

## Result Limits

- All with an empty query shows supported quick actions and initially up to `5` chats and `5` Pages.
- All with a non-empty query shows up to `100` matching command rows and, once the relevant search threshold is met, initially up to `5` chats, `5` Pages, and `5` native file/directory matches.
- Each All content section expands independently in increments of `5` through `Show more`. Chat request budgets grow with expansion, up to `60`; Page expansion reveals the already bounded `60`-result search, and native Files retains its `50`-match bound. Expansion stops at the available results or that category's bound. Status rows do not displace another category.
- Actions shows up to `100` matching command rows.
- Chats shows up to `25` chat rows, with message-history status below the current results.
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
- opens that Page in a durable Page Stage panel tab, using its Library route when it has no Project
- preserves the current Database View Project selection if the Page belongs to another Project
- for a body match, reveals the matching Block and opens the Page domain of [Workbench Find](content-search-behavior.md) on the matched text with the matching Block occurrence active so Find can continue through other occurrences

### Command results

Executing a command result:

- closes the palette
- runs the associated shell/workbench action

### Chat Results

Executing a chat result:

- closes the palette
- opens that chat's Session
- for a history result with a message location, reveals the matched message and opens the chat domain of Workbench Find on its text with the matching occurrence active. Command and file-change matches open the chat.
- reports that the chat couldn’t be opened if it was removed after it was listed

Supported actions currently include:

- go back / go forward, and switch to another Space
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
