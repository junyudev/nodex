# Database, Pages, and Views Behavior

## Scope and authority

This document owns the user-visible contract for Database Views, Page creation,
Page Stage, Source-defined Properties, and visual Page workflows. The canonical
Database/Data Source/View/Page model is defined in [CONTEXT.md](../../CONTEXT.md).
Durability and synchronization are defined in [Reliability](../RELIABILITY.md).

A Database is a placeable Container with one or more Data Sources and Views. A
Data Source owns schema, row Pages, values, and Page Property layout. A View
targets one Data Source and owns one current Board or List layout, saved
filtering, sorting, grouping, displayed Properties, and optional manual Page
positions. Every visible View tab is one durable View identity. Page content
remains in the Page's owned Document.

## Page keys

Pages in an enabled Database receive a short key such as `LAB-13`. The key is a
readable locator, not Page identity: UUID remains authoritative for Documents,
references, deep links, selection, drag state, caches, and every mutation.
Project creation enables the namespace of its primary Database and exposes that
Database prefix as the Page key prefix. Project rename does not change it.
Create Project does not show or request Page-key settings. The Project and
primary-Database genesis transaction derives a collision-free initial prefix
from the Project name; the transaction remains final authority. Prefix settings
become visible only after the Project exists.

Edit Project keeps the current prefix collapsed by default. Expanding it reads
the primary Database namespace, including its assigned Page count and retained
prefix history. Saving changed Project details and renaming the Database prefix
are two ordered operations: details save first, then the revision-fenced prefix
rename. If the second step fails, the saved details remain saved, the dialog
stays open with the prefix draft, and the namespace is refreshed for an explicit
retry; Nodex never creates another historical alias by attempting an automatic
rollback. An unused old prefix is released; a used one stays reserved and its
allocated keys keep resolving.

Allocation is monotonic and may contain gaps. Archive, delete, retry, and
movement never recycle a committed number. Moving among Views or Data Sources
inside one Database retains the assignment. A cross-Database move receives or
recovers the target Database assignment while every previously allocated key
remains an authorized historical locator for the same Page UUID.

Page Stage does not repeat the contextual Database key in its Page identity.
In Board and List Display Options the Page key is labeled **ID**. The canonical
UUID remains machine identity and is not a View display field. List includes ID
in its default presentation; Board keeps it hidden by default. A personal
Display Option may change either choice without disabling assignment, lookup,
copy, command search, CLI, or Agent results. Publishing the normalized effective
presentation makes the same choice the shared View default. When enabled on
Board, ID is the first quiet metadata line at the top of the card, above the
title and displayed Properties. List keeps ID in its named identity lane. The
lane measures the widest plausible identifier for the prefixes and number
depths in the current projection, so short prefixes do not inherit spacing
sized for longer ones and virtualized rows do not change the lane as individual
numeral glyphs appear.
A Page with no current enabled Database renders no placeholder.
Board and List expose one shared Page context menu. Its Page actions are
`Open in`, `Copy`, `Move to`, and a final separated `Delete` action. `Move to`
relocates the Page to another Database, another Page, or Pages top level as
specified by [Page Relocation](page-relocation-behavior.md).
The development-only `database-page-reorder-menu` capability adds a `Reorder`
submenu containing top, up, down, and bottom positions; ordinary launches omit
that submenu, and unavailable edge positions remain disabled when it is
enabled. This gate affects only the context-menu entry, not drag, keyboard, or
bulk-selection ordering. `Copy` contains `Copy ID` whenever a current Page
key exists, plus `Copy deeplink`, `Copy title`, and `Copy content as Markdown`.
`Copy ID` copies only the user-facing Page key and never falls back to UUID;
`Copy deeplink` remains the distinct UUID-based action. Markdown copy reads the
canonical owned Page Document through the View's current Library or Project
access context rather than a visible View projection. `Open in` contains `Open
in new chat` and `Send to chat…`. Open in new chat atomically creates an
ordinary Project Session and its Linked chat edge before Window Scene
presentation; a presentation failure preserves that durable Chat and relation.

Each Board or List surface owns one short-lived Page menu session. Right-click
resolves only the Page under the pointer; unopened Property editors and
Relation candidate sets do not run. The root action menu appears without an
entry animation, and moving across enabled submenu rows activates the target
submenu in the same or next display frame while preserving the pointer-safe
path into an already open submenu. Switching menus does not commit or rerender
the Page card/row subtree.

Board and List join their loaded Page window with one bounded Workspace Page
Chat activity projection; they never issue a query per Page and never store
Thread state in the Database row model. A shared activity control sits at the
end of the Board title lane and after the List title, without changing Card
height, List density, selection, drag, or title truncation. Working uses the
shared spinner, waiting for approval or user input uses an attention glyph,
system error uses an error glyph, and unread uses an independent 6px blue dot,
so execution and unread can appear together. Error, waiting, working, and
unread controls remain visible. An idle/read relationship is quiet at rest and
reveals a muted Chat glyph on Page hover or focus. The control has a complete
pluralized accessible label and tooltip; color alone never carries state.

If exactly one available unarchived Chat is related, activating the control
opens that durable Project Session directly. Otherwise it opens a Related
chats popover with a bounded initial window, explicit loading/retry/load-more
states, Chat title, Project or Chats scope, preview, execution state, and
independent unread state. Opening the popover does not mark a Chat read;
selecting and focusing the Chat reuses ordinary Chat read semantics. The
popover can remove a relationship without deleting, archiving, or detaching
the Page, Session, or Thread. A failed removal preserves the row and reports
the failure; removing the final relationship closes the empty popover and
removes the control.

The Page context menu also exposes a bounded, schema-driven Property section.
The current writable Board grouping Property appears first, followed by exact
built-in Status, Priority, Assignee, Due date, Tags, and Estimate roles, with
duplicates removed and at most seven direct entries. Remaining active
Properties appear under `More properties…`; root-menu search surfaces a matching
custom Property directly instead of requiring that extra navigation step.
Every Property entry remains a native context submenu. Select and multi-select
submenus host the canonical `PropertyOptionPicker`, including the same search,
rows, selected state, and Status, Priority, Estimate, and Tags presentation used
by Page Stage. Menu entries use the same canonical Property icon resolver as
Page Stage. A single-select choice commits and closes the action menu, while a
multi-select submenu remains open for additional set edits. Tags carries the
same option-creation capability through Board and List adapters; creating a Tag
atomically adds the option and selects it for the target Page. Text and number
Properties such as Assignee use a compact draft-and-save submenu editor; other
Property types embed their canonical shared value editor in the submenu. The
submenu is already the editor-opening action, so Date and Relation expose their
input/calendar or search content immediately and never add a nested `Empty` or
value trigger. Every root menu and Property submenu has one floating-surface
owner for collision bounds, scrolling, ring, radius, and shadow; editor bodies
do not add a second fixed-width shell or horizontal scrollbar.
Changing the Board grouping Property uses the same semantic Page move that owns
group membership and rank; other Board and List Properties use receipt-backed
value mutations.
Right-click edits only the Page under the pointer and never implicitly applies
to the current multi-selection. Selection mutation remains in explicit row and
bulk-selection controls, not the Page context menu. Page title remains Document
authority and is not presented as a Database Property.

View-local search accepts a current canonical key, case normalization, one
optional leading `#`, outer whitespace, and no-hyphen shorthand. Key matching
is exact or prefix-oriented, never fuzzy within the key token; explicit `#`
intent never falls back to title or body. Loaded Board/List rows do not carry
historical aliases. Global search, destination pickers, CLI, and Agent reads use
the authorized Core resolver when historical lookup is required. A compact
query that maps to multiple authorized Pages shows every candidate; a direct
selector reports ambiguity and never chooses the first match. Results keep the
current key in the primary identity slot and show `Matched OLD-13` only when a
historical key matched. Prefix changes refresh current View, Page Detail, and
search projections from one Database LocalCommit without remounting Page
identity or emitting one patch per Page.

## View behavior

Database Views support Board and List layouts. Each View has one current layout,
and each visible View tab selects one exact durable View identity. Board and
List Views execute their saved queries through one runtime; changing tabs
changes View identity, while explicitly changing one View's layout preserves
that View identity and replaces only layout-specific settings. Every legal
Board grouping and subgrouping uses one canonical
Column/Card presentation with whole-card drag, schema-driven compact Properties,
column controls, Page menus, and keyboard behavior. Grouping changes column and
swimlane membership, markers, labels, and semantic tone; it never selects a
different Card presenter. Grouping and subgrouping Properties are structural and
do not repeat in the Card body, while other displayed empty Properties do not
occupy visual rows. Displayed Card values use the same dense Property-chip
grammar as List values and wrap within the Card; multi-select values remain
individually readable, while Priority uses an icon-only closed trigger with its
current value retained in the accessible name and picker. Dense chips use an
opaque host-surface background at rest; direct hover strengthens their
token-derived background, border, and text without changing the surrounding
Card. Due date uses a state-aware calendar mark, adding an overdue indicator
when needed. Configured Created and Updated fields preserve their relative
display order in one quiet, borderless footer row below all Property chips; the
Page key keeps its dedicated identity line above the title. Column headers remain
opaque and sticky while the Board
scrolls; Page and Block drags show the canonical insertion indicator before a
drop. A collapsed target keeps its compact rail, highlights only that target,
and puts its horizontal drop boundary below the complete collapsed header.
User-triggered collapse and expand animate the complete Column width with an
interruptible emphasized ease while the compact rail and full Card surface hand
off through a short directional fade. Header and body stay aligned throughout
the motion; reduced-motion preference changes the same transition into an
immediate state change.
Opening a Board or changing surrounding tab groups presents Column headers and
content directly in their current state; mounting a surface does not replay
collapse/expand motion.
Finite empty groups remain present as canonical collapsed rails instead of
disappearing, while each populated Status column retains the full-width
`New page` launcher. Historical Table, top-level Toggle List, and Calendar layouts
migrate to List; inline `pageRef` and toggle-list Blocks remain editor features.

Grouped Views page independently per group and show the canonical total even
when only one window is loaded. Flat Views use one cursor window. Refresh after
a mutation preserves the loaded span where possible, and an expired cursor
restarts that bounded window rather than silently truncating the result.

Each View owns one ordered rule set: quick Property filters, one optional
advanced AND/OR filter tree, and Sort rules. Quick filters have stable identity,
remain visible while their value is empty, and combine with the advanced tree
through a top-level AND. An incomplete authoring rule does not affect query
results. Its explicit empty operand remains present across personal preference
storage and Core events, while value-less operators omit the operand entirely;
Core validates that distinction before committing either durable or personal
rules. Operators and value controls follow the Property type; Relation values
are selected from authorized Pages rather than entered as Page IDs. Search is
window-local and does not become a saved rule.

Rules and presentation may resolve through independent sparse fields in one
Core personal-preference envelope keyed by durable View ID. View name, target
Source, layout, rank, lifecycle, and default status are always durable. The
personal preference's monotonic revision applies only to that preference;
List disclosure is a separate bounded sparse set changed by idempotent
per-target patches. The current List exposes disclosure only on group headers;
Page occurrences remain expanded and do not create personal disclosure state.
Changing either coordinate never rewrites or conflicts with the other. Each
View remembers one complete Source-Property order plus the displayed-Property
set for its current layout, so hidden Properties retain stable positions. Rule
changes become the current user's effective query immediately. Reset restores
the shared Filter and Sort settings together in one action without clearing an
unrelated presentation override. `Save for everyone` publishes the effective
Filter and Sort settings together in one action and clears both rule overrides
only after the View revision compare-and-swap succeeds; a conflict retains the
personal state. Publication keeps the effective rules visible until a
receipt-fenced canonical View read materializes them, so clearing the personal
patch never flashes the previous shared rules. The same seamless handoff
applies when View presentation is published from the settings rail. Resetting
View preferences does not expand collapsed groups.

Filter and Sort authoring lives in one inline rule bar directly below the View
tabs and toolbar. Its open state is a bounded Profile chrome preference per
View, not query state, and existing rules do not force the bar open. Layout
changes and surface remounts do not animate the rule bar into view. Toolbar
Filter and Sort are the direct bar toggles once their relevant authoring state
exists. A rule-free, closed View is the create-first exception: Filter opens an
`Add filter` Property picker at the toolbar button, and Sort opens a `New sort`
Property picker there, without mounting an empty bar. Selecting a Property
creates the rule, opens the bar, dismisses the toolbar picker, and opens the new
rule's editor at its bar token. Existing Sorts route Sort back to the bar token;
when filters or an already-open bar exist without a Sort, Sort toggles the bar
and keeps creation anchored to the toolbar. The bar orders Sort,
advanced-filter, and quick-filter tokens before `+ Filter`; it never renders an
empty `+ Sort` placeholder. Empty tokens use quiet chrome; effective rules use
the app accent. Personal changes keep the Save action active without adding a
persistent marker to every affected token. Hovering or keyboard-focusing Reset
or Save previews only the Sort, advanced-filter, and quick-filter branches that
the action will actually change, using neutral reset and accent save treatments
without moving token geometry. Compact Reset and Save icon actions stay at the
bar tail, while their tooltips explain the personal/shared scope and unsaved
state. Both actions always apply directly to Filter and Sort together.
Settings-rail presentation overrides use the same compact Reset and Save icon
actions. Their multiline tooltips own the scope and restore explanation; the
rail does not repeat that guidance as persistent footer prose.

Quick-filter tokens reorder horizontally and Sort rows reorder vertically with
the shared continuous pointer gesture: mouse and stylus activate after 6px,
then follow every pointer sample, stay clamped to their drag-start container,
preserve the dragged source's own dimensions while crossing differently sized
targets, and commit once on drop without remount flicker. Sort fields are unique
within one View and use type-aware direction wording. The Sort editor is a compact
vertical list: field and direction controls consume only the width their content
needs up to a bounded maximum, a flexible tail lane absorbs remaining row width
before the aligned delete action, and adjacent rows retain a compact 4px gap.
Every row stays inside the floating surface, and its footer offers both Add sort
and whole-list Delete sort actions.

A quick filter opens one Property-specific editor rather than a generic form.
Its compact header owns Property, operator, and a More menu; the More menu puts
Delete filter before Add to advanced filter. Text and number use a direct input,
checkbox exposes Checked and Unchecked rows, select and multi-select expose the
searchable option list directly, Relation exposes the authorized Page search
directly, and Date/DateTime embed the calendar. No quick editor adds a second
value-trigger popover around that content. Editors with no value operand render
only the header.

The advanced editor presents `Where`, AND/OR, Property, operator, value, a compact
tail lane, and row actions as content-dense rule rows in one anchored surface.
Every row resolves its Property, operator, and value tracks independently from
the controls in that row. Changing `contains` to `is` therefore moves the value
control left instead of relocating the same empty width outside the operator
button. The floating surface shrink-wraps the widest row up to the
available viewport rather than imposing a fixed editor width. The second row's
AND/OR control reuses the same 32px outline selector chrome; `Where` and later
static connectors use the primary foreground and align to the connector track
end. Adjacent rows retain a compact gap, and nested groups contribute their
intrinsic width without forcing a larger empty outer surface. Group containers
use a subtle tint while their selectors remain opaque, and every Boolean selector
preserves the editor's left inset instead of overflowing its track. Add filter
rule occupies the available row width while keeping its icon, label, and chevron
clustered at the start. The editor supports duplicate, remove, wrap, unwrap, and
nested groups while limiting interactive authoring to three understandable group
levels. A separated Delete filter footer clears the complete advanced tree.

View Property display and Data Source Page Property layout are independent. A
View owns the complete ordered Property list and the fields shown on its cards
or rows. The fixed Name identity is always first, always visible, and has no
drag handle. Every optional Property has a drag handle in both the shown and
hidden sections. Reordering within a section preserves visibility; crossing the
section boundary changes order and visibility together. Property pointer drag
activates after 6px, retains the threshold-crossing pointer delta on that frame,
then tracks every vertical pointer sample while sibling Properties and the
shown/hidden boundary ease into their candidate positions. The dragged row is
represented by one overlay, preserves its source dimensions, stays horizontally
locked and vertically bounded to the Property list, and commits one presentation
change only on drop. A Data
Source owns the order used when its Pages open and assigns each schema Property **Always show**,
**Hide when empty**, or **Always hide**. Hidden Page Properties remain reachable
through one disclosure; expanding it is Page-session state and does not change
the Data Source layout. Files, Linked chats, and other Page capabilities keep
their own presentation rules and are not schema Properties.

Existing Property rows use semantic icons for built-in identities such as
Status, Priority, and Estimate. User-defined Properties use their value-type
icon, even when their display name resembles a built-in Property. Select uses
the shared Tags icon; Multi-select uses the bulleted-list icon across settings
and Property rows.

Layout, display, Source Properties, and Page layout are available in a settings
rail beside the current Database content. The rail uses back/close navigation
and keeps the Board or List visible while editing. Filter and Sort are not rail
routes; their toolbar actions and tokens share the inline rule-bar controller.
Creating, renaming, duplicating, ordering, linking, or deleting a View happens
inline; a centered Database manager is not part of this workflow. The rail is
local to the Database surface and never replaces the Workbench's user-controlled
global side panel.

The inline View strip is also the direct View-management surface. Selecting an
inactive tab changes the active durable View; selecting the active tab again,
or right-clicking any tab, opens that exact View's action menu. The menu offers
Rename, a personal **Display as** choice for text/icon presentation, Edit view,
Source settings, Copy link, Duplicate, and Delete. It uses the same visual and
keyboard conventions as other Nodex context menus. Rename opens the settings
rail with the current name selected; Duplicate creates and selects a durable
copy, then opens the same focused name editor. Delete requires confirmation and
is unavailable for the final View. Pointer drag reorders the visible tabs
directly after a short activation threshold; the gesture stays local until
drop. Crossing the threshold retains the complete pointer delta on that same
frame, after which the dragged tab tracks every horizontal pointer movement
while sibling tabs ease into candidate slots. The dragged tab is clamped to the
exact horizontal viewport of the View tab list, independent of where inside the
tab the pointer began; it cannot translate vertically or edge-scroll beyond the
list. Drop persists one placement operation and restores the authority order if
the write fails. The rail header ellipsis invokes the same target-aware action
model, so toolbar and rail never maintain divergent View commands.

The Database toolbar spans the complete View and remains a 40px top row. On a
desktop surface the rail begins exactly below that toolbar and occupies one
290px right-side region; no second empty width owner surrounds its controls.
Opening it does not resize or reflow the Database content. The rail overlays the
content's right edge and enters from 12px toward the inline end while fading from
transparent to opaque over 200ms with CSS `ease`. Reduced-motion preference
compresses the same transition to 1ms. Closing removes the rail directly rather
than replaying a decorative exit.
Root settings use a compact View label
and inline View identity row; nested routes use a left-aligned back/title/close
header. Menu and Property rows are 28px with 14px labels, while section labels
use the smaller 12px hierarchy. The root does not repeat a second View list:
durable View identity and View creation stay in the toolbar's inline View strip,
and active-View actions remain reachable from the View identity control. Standard
body rows use 400 weight and a 16.8px line height. Leading semantic icons use the
compact 16px Nodex scale; secondary drag handles use 14px. Labels and leading
icons share the primary foreground; trailing values, chevrons, section labels,
meta actions, and disabled states provide the quieter hierarchy instead of
globally muting action icons. The rail inherits Nodex's semantic main-surface and
foreground tokens rather than maintaining a private light/dark palette. The
application blue accent is reserved for compact actionable or selected states:
Property visibility's **Hide all** / **Show all** actions, the active Layout tile,
enabled switches and selection checkmarks, and keyboard focus outlines. Ordinary
labels and leading icons remain primary foreground.

Compact identity fields keep their semantic one-pixel boundary and subtle input
surface visible at rest. View rename and new Property naming share this chrome;
focus changes the boundary color instead of revealing the field for the first
time. Inline option editors remain visually lighter where the surrounding row
already owns the interaction boundary.

Personal presentation and disclosure changes converge across mounted windows as
typed deltas authorized by the durable View. They do not claim a shared View,
Data Source, Database, or Page projection change, so a personal toggle cannot
refresh Board/List content or invalidate Library navigation. Reconnect replay
preserves those deltas; a Store-epoch replacement rehydrates both personal
authorities while retaining the last readable surface until the handover.
Personal presentation persistence is optimistic and serialized: its background
`saving` phase never disables, dims, or removes drag eligibility from settings
controls. Initial hydration and an explicit durable publication are the only
presentation phases that lock those controls.

Display Options derives valid group fields, intrinsic Page identity fields,
finite empty groups, completion controls, and visible Properties from the active
Source schema. It also exposes the Board-only **Show description** toggle, which
controls only the Page description preview in Board cards, defaults to visible,
and does not change Page content, search authority, or List rows. Page key is
labeled ID and follows the same personal override, reset, and
default-publishing flow as other display fields. It is included in the default
List presentation and omitted from the default Board presentation. Hiding any optional
field collapses only that field's track; the
remaining Page identity cells, Property cells, group headers, and nested guides
retain their named-column alignment. List is a dense,
full-width 40–44px task-row surface whose sections match Board groups and
subgroups; it has no spreadsheet header, column resizers, rounded card stack, or
inline foreign Page Document. Its controls use the shared Nodex dropdown,
button, switch, popover, and checkbox primitives. Selectors backed by Source
Properties, options, or other growing data catalogs are searchable; closed
presentation enums remain compact selection menus without a redundant search
field. Board and List share bounded group windows, selection, Page-open behavior,
Property editors, and mutation receipts. On Board, a normal pointer click on the
title or any non-interactive part of a Page card opens that Page; card Property
controls, menus, and drag gestures keep their own interaction instead of
opening the Page.

Data Source queries accept typed filters, sorts, and an explicit Property
projection without creating or changing a View. Native CLI calls authorize the
selected Project through Core; Agent calls validate their bound Turn before
entering the same query implementation. An omitted projection includes active
Properties; an empty projection includes none, including Relation previews.
Saved View display fields and manual ordering never expand an explicit Data
Source projection. Continuation cursors bind query rules and projected Property
identities, so changing either requires starting a new query.

The CLI exposes Source, Property, and Option discovery as bounded windows with
stable identities and explicit continuation. `ls` on a Page reads only direct
navigable children; on a Database it reads Page rows from its uniquely active
Data Source, without borrowing a saved View's filters. Multiple active Sources
require selecting a Source explicitly. Property reads return canonical values
and per-value revisions, including null/revision zero for unset active fields.
Scalar `properties set` and typed multi-edit `properties apply` share Core's
atomic mutation; a stale replacement revision rejects the whole edit group.

Database row authority always carries canonical Property values. In particular,
select and multi-select values remain stable option IDs through View windows,
List occurrence windows, optimistic row patches, Page Stage, filtering, sorting,
grouping, Page creation, and update commands. Core row contracts do not carry a
parallel display-value map. Board, List, Page Stage, Filter controls, active-rule
summaries, and local search derive labels and colors only from bounded option
registries; a missing registry entry is an explicit unknown option, never a
fallback display name inferred from the identity. Closed controls request option
windows for their currently selected IDs before the picker opens, continuing
across pages until every visible label resolves or the authoritative registry
proves the ID missing. `Loading…` therefore represents an active request only;
an idle or failed registry cannot leave visible Property chips permanently
loading. A Property registry contains at most 100 options; names and colors are
bounded as canonical UTF-8 metadata at every Core and transport read/write seam.

### List projection and task hierarchy

List is a virtual grid over Core-authored occurrence rows. Group headers are
36px with a 2px first-row gap, Page rows are 44px, row surfaces are inset 8px,
and each nested level shifts the complete visible Page identity cluster by 24px
while preserving named-column alignment. Hierarchy guides anchor to the leading
identity lane. Their overlay spans the full 44px Page row: a parent stem begins
5px above the row edge, a child elbow begins 15px from the row top, and a final
child stem is 16px tall. Guides use the solid divider contrast and maintain
consistent opacity across Page-row boundaries. A transient occurrence weakens
its Page content and row-state surface to 60%, while its hierarchy guide remains
part of the full-opacity structural overlay. Nested descendants remain visible
without a Page-row disclosure control. Group, subgroup, Page, and transient
occurrences have stable path keys independent of Page identity. Group collapse
hard-removes that group's occurrences without row tweening. This separation
keeps cross-group hierarchy legible without implying membership in the current
group. The mounted View
session restores a logical row anchor, continues bounded windows near the
viewport end, keeps field widths monotonic, and hides trailing low-value fields
before compressing the title column.

A Data Source task hierarchy is the projection of its fixed `task_parent`
Property, not a second graph. `task_parent` is a required cardinality-one
self-Relation: every active row, including a root, retains one positive,
monotonic Relation value revision; a child has one Relation edge whose target is
its parent and whose edge metadata carries sibling rank. Generic Relation edits,
List nesting, and batch drag commands all compare and update that same value
revision. Parent and sibling rank form one semantic coordinate on the moved
Page. Ordered insertion uses fractional ranks: only Pages whose parent or
logical sibling position changes advance their Parent value and Page metadata
revisions. A rare order-preserving rank rebalance may rewrite untouched sibling
rank encodings but must not advance those siblings' semantic revisions. Repeating
the same ordered Parent command is a no-op. Each parent must be an active row in
the same Data Source, cycles are
forbidden, and maximum depth is ten. Removing a parent from the Data Source
clears its own Parent value, removes its incoming child edges, advances every
affected value revision, and promotes its direct children to task roots without
moving or rewriting Page Documents. Archiving retains the Relation so restore
recovers the hierarchy, but the active List projection temporarily treats a
child of an archived parent as a root instead of hiding it beneath an invisible
row. Search and filtering may include transient
ancestors needed to explain matching descendants, so the same Page can have
multiple visible occurrences while selection and mutations deduplicate by Page
ID.

List selection supports replace, toggle, contiguous range, all matching with
sparse exclusions, a roving keyboard cursor, context actions, and a bulk action
bar. A normal pointer click on either the title or any non-interactive part of a
Page row opens that Page; it does not convert navigation into selection.
Pointer selection is explicit: the row checkbox toggles an occurrence and
Shift-click extends the current range, while Property controls remain isolated
from both Page-open and selection. Selection-state paint in a
List row is immediate rather than tweened. A visible Status or Priority icon is
also its inline editor trigger: opening it must not select or open the Page. The
editor uses the shared searchable Property option picker, and choosing an option
commits through the same optimistic, receipt-backed Property mutation path as
other editors. Built-in task Properties keep their canonical options available
when a bounded option window is not embedded in the current projection.
The roving cursor records the next List tab stop, not an enduring DOM-focus
command. Only an unconsumed keyboard-navigation request may move focus to a
Page row; selection commands, View projection refreshes, and edits in another
surface never replay an earlier row-focus request.

An ordinary Page-row drag resolves against the target row midpoint as a raw
before/after edge; the exact midpoint belongs to `after`. A leaf target keeps
that edge at its current sibling level. `after` on a target that already has
children normalizes to the first child slot, so the insertion guide uses the
prospective child depth. Adjacent row halves that describe the same sibling
boundary resolve to one stable insertion slot, and its circular endpoint sits
on the prospective parent branch rather than following the hovered row's raw
indent. Holding Option/Alt explicitly appends inside a Page, and group headers
accept only a root-level inside drop. Transient hierarchy context cannot
originate a drag, and a target inside the moved closure is never committable.

Dragging an occurrence moves its concrete subtree as one semantic action.
Transient rows are skipped as values but do not stop traversal; selecting an
ancestor and descendant normalizes to one source root; duplicate occurrences
are resolved by path and written once per Page. Cross-group adoption updates
every concrete Page in the closure, while Parent and rank changes apply only to
the normalized roots, preserving all internal Parent edges and child ranks.
Core resolves the full occurrence graph and commits Property, Parent, and order
writes atomically from one semantic operation; a bounded renderer window never
authors descendant IDs or primitive inverse operations.

The active source row alone becomes translucent, while descendants stay in
place. A body-portaled compact preview represents the initiator, mirrors its
visible Priority, readable ID, Status, and title columns, and shows the concrete
Page count; rows do not live-shift during pointer movement. Returning the source
to its unchanged structural slot is a silent no-op: it creates no mutation,
error, toast, or Undo entry. After drop,
a conservative optimistic projection remains until a receipt-fenced canonical
window confirms the same parent, group, and order semantics. A typed revision
conflict rolls back without clearing the readable List; a new gesture uses fresh
occurrence authority. Successful moves are silent.
Their opaque Core recipe enters the window's bounded content history for the
same Library, access context, and Store epoch. Page body, Page title, Board and
List shortcuts replay this same interaction order; native input drafts,
comboboxes, menus and independent editors retain their input boundaries.

The content owner reserves each data gesture before asynchronous preparation and
serializes its forward commands and inverses. Later replies fill their original
slots; a queued Undo cannot wait for a gesture admitted behind it. Each View
participant validates Library, access context, Store epoch and View identity for
admission; View identity is a command target, not a separate chronology. A ready
View preserves its participant during ordinary projection refresh or presentation
rerender. Authority changes cannot attach old actions to the new scope.
Transfer-toast Undo addresses the exact transfer and only runs while that entry
is the latest eligible action in the shared content timeline. A newer Page title,
body or other View action makes that exact target ineligible; the toast never
undoes a newer action.
Board and List forward edits and replay use the same receipt-fenced presentation
lifecycle. Each returns the complete authoritative receipt to the content owner;
neither rebuilds the admitted request nor maintains a separate history.
An uncertain response keeps its place and blocks dependent commands
and older Undo. Recovery resends the frozen request and operation identity.
Only a known non-commit or supported no-op removes a pending action. If its
receipt can no longer be recovered, a permanent barrier remains; expiry does
not authorize executing the action with a new identity.
Closing or resetting a View hands uncertain Promotion and structural replay
attempts to Main for exact confirmation and subsequent capability release,
without revoking the input while the writer might still consume it.

Scalar Property values (including Status), multi-select patches and manual View
positions produce one Core inverse for the entire data gesture. A mixed batch of
these operations is atomic during both execution and Undo. Core records canonical
before/after values and logical position runs, not physical rank keys. It validates
the complete target set's current write authority before reading or comparing
Property or position post-images. This also applies to List inverses and mixed
inverse batches: an unauthorized target cannot expose its values through a
different conflict result, and no permitted part is written first. Changed Property
types, deleted options, changed View direction or ambiguous positions block the
whole inverse. Unrelated values remain untouched. Successful inverse replies are
idempotent under their original operation ID, including after a lost reply.
Position commands always use visual order; Core alone converts descending order
to physical ranks. An unchanged supported gesture creates no history barrier.
History captures complete selected runs and canonical root neighbors, not hidden
child ranks or a loaded window. Forward, Undo and Redo share bounded positioning.
Large initial orders or exhausted local rank space return explicit preparation
without committing the gesture; resumable maintenance prepares that View without
blocking unrelated Property edits. Physical rank maintenance preserves semantic
history; a View reset or changed logical anchors may block it. Page relocation
restores logical neighbors; Database copies get fresh ranks for captured order.

Relation, hierarchy, schema and other edits without a whole-gesture Core inverse
form an explicit history barrier. Undo explains that the latest edit cannot be
reversed and leaves earlier moves intact; it must not skip the edit and undo an
older Move. A batch can only enter history when its inverse covers the whole
gesture; a List-move suboperation receipt cannot make a mixed batch undoable.
Each data inverse is bounded to 4,096 affected identities and 8 MiB. Shared content
history retains at most 500 completed entries and 64 MiB of evidence, evicting a
contiguous oldest prefix; an oversized gesture never uncovers an older action.
Independent controls remain interactive while another command is pending;
accepted commands wait in gesture order. A position-dependent drag waits for
the preceding placement's canonical rendered handoff, so a new gesture never
captures stale projection or position revisions. Scalar, multi-select, manual-order and
whole List-move inverses return the evidence for Redo. List replay restores
discontiguous selections across their original parents and validates every
affected logical value, parent and ordered run before writing. Each successful
replay captures its next inverse from the committed content, so subsequent
Undo/Redo never reconstructs placement in the renderer. A new effective edit
retires Redo; a known rejection or no-op preserves it. Ordinary Block promotions
with a complete Core capability enter this same Undo/Redo timeline. Schema-changing
or Relation-carrying promotions without that capability form a whole-action barrier,
not a partial Undo followed by a Redo barrier. Their unused one-way token is
released; the success notification offers Undo only for a complete inverse.
Consumed inverses are not released twice. Retiring the surface or a Redo branch
releases the remaining reachable capabilities through Main's cleanup owner.
Routine edits do not insert status sections into Board or List. The fixed
Workbench `Content edits` control stays quiet for short waits, shows delayed
activity, and exposes unknown or blocked actions through an attention indicator
and a manually opened recovery popover. A committed edit still awaiting its
canonical projection is described as updating the View, not saving. Recovery
is scoped to the original Library/access context. Ordinary pending work offers
no reset action. When reset is safe, it requires confirmation and clears the
complete shared content timeline without changing content or abandoning
submitted requests. Native menu labels and availability
follow the focused input boundary; native inputs retain their own history. Keyboard and native-menu history requests share the same content owner,
including when empty, pending, or blocked. A nested Property input keeps its own
text history. An embedded View submits through its own Adapter while sharing
chronology with Page content; the parent editor never interprets a View receipt.
Closing a Board or List Page menu returns focus to the surviving View when the
menu item’s Page has regrouped or disappeared from the current result, unless
the user has moved focus elsewhere. Undo/Redo follows shared content interaction
order without requiring that View to remain focused. Immediately undoing a Block
drop removes promoted Pages and restores the source Blocks; Redo restores the
same generated identities.

List also accepts native NFM Block drags from another mounted editor in the
same renderer window. Under manual order or an inferable writable Property
sort, a root Page-row half resolves to a truthful root-level gap and reuses the
existing insertion line; group and subgroup headers, empty Lists, nested rows,
and non-inferable sorts use a quiet destination-surface highlight instead.
External Blocks do not author child
nesting: a nested row resolves to its owning group, because Option/Alt already
means Copy for Block transfer. At a root gap under writable Property sorts,
Core adopts the visible neighbors' writable sort prefix for both Page moves and
Block promotion. Under title or created sorting, the destination group is exact
but the intrinsic sort owns the final visible position.
Free-text search, read-only Views, non-Project contexts, incomplete or stale
Core projections, and cross-Project/store sessions fail closed. The renderer
sends only the raw occurrence target, exact projection expectation, and
effective List presentation; Core atomically resolves group/subgroup and sorted
Property values, root placement, shorthand, source Move/Copy, receipt, and Undo.

Primary and subgroup headers paint an opaque full-width sticky surface through
the scrollport's top edge. The scroll container must not introduce transparent
top padding above that sticky plane, so a scrolled Page row can never show
through as a seam above the header. Light and dark List presentations preserve
the same geometry, density, and interaction hierarchy; each theme supplies an
opaque surface plus distinct hover, selection, group, text, icon, chip, checkbox,
focus, and drop-indicator colors.

Opening a Page, changing Display Options, and switching between Board and List
preserve the last readable Database surface instead of replacing it with an
opening screen. Background reads update only the affected projection and hand
over atomically. An inactive alternative layout does not preload or refresh its
windows; selecting List starts its Core occurrence projection on demand and then
retains the last accepted window. List ordering never passes through a temporary
Board-derived order. Permission
revocation, checkpoint/reset, authorization loss, and Store replacement remain
hard-clear boundaries.

Rapid List coordinate replacements keep one first-window read in flight and
skip obsolete intermediate targets. Board group-window reads and load-more-all
use at most eight concurrent Core reads, independent of the number of groups.

Every mounted Board or List remains subscribed to its exact durable View while
another Page Stage or window edits Page titles and Source Properties. A
same-renderer title edit projects into visible cards and rows immediately;
cross-window edits converge through the cursor-fenced Project projection without
remounting the Database surface. A projection checkpoint may fence stale
authority and repair the loaded span, but it cannot detach later effects from a
consumer that remains mounted.

Inline View row patches are optional and have a fixed writer-work budget. Core
checks candidate counts before computing group totals or an absolute row
position; archived, removed, and projection-stale candidates still consume that
budget. Large or multi-row changes publish the same exact View read requirement
without a partial row patch. Mounted consumers then repair their loaded span
from the canonical, commit-fenced read.

Workflow-status List groups use the canonical `Triage`, `Plan`, `Build`,
`Review`, and `Ship` labels. Each writable status group ends with a compact
create action that opens the standard Page composer already seeded to that
status. Their icons form one compact progress family: Triage uses a segmented
ring, Plan an empty ring, Build a half-filled ring, Review a three-quarter-filled
ring, and Ship a filled ring with a knocked-out check. Shape communicates state
at 14–16px while semantic color remains supplementary. Status values use a flat
icon-and-neutral-label presentation; the surrounding row or trigger owns hover,
focus, and selection backgrounds, so status itself never adds a nested pill.
Set-like Tags and Labels remain compact chips. Custom non-status option labels
remain data-defined.

Every Page participates in its View's complete manual order, including Pages not
yet explicitly positioned. Manual direction applies to the complete sequence;
null policy applies to nullable Property values, not manual order. Optional
position metadata still distinguishes an unpositioned Page. Making it explicit
or maintaining physical ranks does not reorder untouched Pages.
Board drag, Board keyboard movement, and manual List
movement write one View-global rank. Cross-group Board movement commits the
target grouping Property values and rank in one atomic Database mutation from
stable Page and View identities. Under a writable Property sort, Board and List
infer the Property prefix needed for the selected visible gap and commit it with
the move; View-global fractional rank remains the final stable tie-break among
Pages with equal sorted values. Detailed behavior is specified in
[Board Drag and Drop Behavior](board-drag-and-drop-behavior.md).

A moved Page run reserves rank space as one batch. When its two neighboring
ranks have enough space, positioning preserves every untouched sibling rank;
batch size alone must not force a rebalance through repeated gap subdivision.

## Page creation

Every eligible `New page` entry point opens one app-owned composer bound to the
exact writable View and semantic insertion target. Unmounting the originating
Board does not discard the draft or move authority to another Board.

The composer owns an uncommitted title/body Document draft plus compatible
Status, Priority, Estimate, and Tags selections from the target Source schema.
These property controls form a compact chip strip. Each chip keeps its semantic
icon visible and, when empty, shows the property name rather than a generic
empty-value label. An empty value may use `Empty` when the surrounding row or
section already identifies the property.
Estimate uses one half-filled triangular semantic glyph across property labels,
values, pickers, Page summaries, and View rows.
Opening or editing the composer creates no Page, option, history, or Database
row. Each selected Tag keeps its preallocated canonical option ID. Its name is
metadata only when that same submit introduces the option; an existing option's
identity is never re-resolved from its label. Submit creates Page identity,
title, body, membership, any new options, values, and View placement atomically.
A failed submission keeps the complete draft and exact selected identities.

Closing a modified draft provides short-lived reversible recovery using only
serializable authored data. Live editors, Y.Docs, DOM nodes, and authority
tokens never enter draft recovery state. `Create more` starts a clean title/body
while retaining the user's selected properties and presentation choice.
Recreating the composer's temporary editor preserves its authored description;
each mounted editor receives a live draft Document, never a previously closed one.

## Page Stage

Page Stage opens one stable Page identity through Page Detail independently of
its current parent. Library-, Page-, and Data Source-parented Pages all expose
the same title, body, history, Threads, and Page-intrinsic run/schedule controls.
Opening a Page never creates membership or moves it into a Database.

Title and body mount only after a ready authorized Document descriptor and
initial sync barrier. They edit the canonical collaborative Document directly;
there is no ordinary whole-body autosave, projection-seeded initialization, or
whole-Page conflict overwrite. A title-only Page opens with a valid empty-body
editor while NFM/plain-text export remains empty.

Page Stage may show Source Properties only when the Page is currently parented
by a Data Source and the corresponding schema/value coordinates are valid.
Losing or changing membership removes only that capability; Page identity,
Document, content, and local editing surface remain stable.

Mounted surfaces own independent caret, selection, and presence. Their local Page
body/title and Database edits share window-local content interaction history
within the same authority scope; remote changes never enter it. Durable history is a semantic revision
timeline; restore applies a new forward mutation and never rewinds collaborative
causality. Exact revision and retention behavior remains a reliability concern.

## Properties

Property identity and type, not display name, select behavior. Reserved
Properties such as Status, Priority, Estimate, Tags, schedule boundaries, and
Assignee may use focused controls only when their exact registered types match.
Custom or malformed Properties use the typed fallback.

Every Property selector and option editor follows that same identity rule.
Status, Priority, and Estimate use their canonical option order, labels, and
value glyphs in Filter, conditional-color, Page, Board, List, and Source settings
surfaces; they never fall back to generic Select dots or Tags tokens. Priority
uses the distinct P0–P3 value icon set. Their authoritative registries continue
to own membership, labels, and colors while the semantic editor supplies each
recognized identity's canonical ordering and visual. Tags and custom option
Properties retain the generic option-token UI.

The Source Property editor supports the current text, number, checkbox, date,
date-and-time, select, multi-select, and Relation types. A Property can be
renamed, assigned its type-specific format or relation target/cardinality, and
reordered without changing identity. Number formats and date formats are schema
metadata consumed consistently by Page Stage, Board, and List. Select and
multi-select options have durable identity, order, label, and color; renaming,
recoloring, and reordering an option never rewrites stored Page values.

Option registries own option identity, order, labels, colors, and revisions.
The bounded Status, Priority, and Estimate registries begin loading when their
owning surface mounts, before their pickers open, so a closed-value projection
never leaves the picker at only its current selection. Tags and custom
registries remain lazy and load from their picker.
Scalar changes use their captured field revision; set-like changes preserve
add/remove intent. Status in Page Stage follows this same scalar Property path;
it is not translated into a Board move or manual-position write. Conflicts and
collection failures stay on the control or popover that owns the action and do
not hide unaffected fields.

Any mutation that advances a Page Block's metadata or lifecycle also refreshes
its existing schedule index in the same transaction, even when the operation
does not change schedule values. A Page detail read rejects stale schedule
source coordinates rather than combining schedule data with a newer Page
authority.

Relation is a one-way Page-reference Property targeting one Data Source. Its
schema declares cardinality `one` or `many`, and that cardinality selects the
mutation grammar. A single Relation stores zero or one target and uses a
value-revision-fenced replace/clear command. A multi Relation is an unordered
unique set with idempotent edge patches plus a distinct revision-fenced whole-set
clear command. A one Relation rejects set patches; a many Relation rejects
single-target replacement. Both use the same normalized edge table and a
JSON-null value revision header. Relation never
changes ownership or grants access. Compact values show visible targets plus
hidden/restricted counts; inaccessible targets disclose neither identity nor
title. Candidate and selected lists are bounded and paged. Removal of a
restricted target uses a Core-authored opaque edge handle rather than a guessed
Page ID; the many-Relation clear command can remove every edge without
disclosing targets. Generic Relation references survive target membership and
lifecycle changes until explicitly removed. The standard `task_parent` Relation
adds same-Source activity, acyclicity, depth, sibling-order, copy-as-root, and
parent-removal promotion policy without creating another storage authority.
Relation supports contains/not-contains/empty/not-empty filters and is not
sortable or groupable in this release.

Removing a Property requires explicit confirmation and is blocked while a View
still references it. Core rechecks the current schema and View references at
commit time. A removed Property first enters the Source's recoverable Deleted
list with its values, option registry, and Page-layout position intact. Restore
reactivates the same identity. Permanent deletion is available only from that
Deleted list and retires the identifier so a later Property cannot inherit old
values or references.

Conditional color rules belong to one View and are evaluated in their displayed
order. The first matching rule supplies the row or card decoration; later rules
do not layer over it. A rule uses the same Property-typed operator and value
contract as View filters. Creating one begins with a searchable Property choice;
the selected Property then remains the rule's stable subject. Rules are reordered
through their drag handles because display order is also evaluation priority.
The dragged rule preserves its source dimensions while crossing rules with
different editor heights.

Every rule has either a fixed semantic background or an option-derived
background. Select and Multi-select rules may inherit the matching Property
option's color while the row has a value; Multi-select uses the first selected
option. Empty-value conditions always use a fixed background. A missing or
unrecognized option color leaves the matched card or row at its default
background. Board and List apply the result to the whole card or row.
Conditional-color edits synchronize automatically to the shared View after a
short debounce whenever every typed rule is complete. Valid draft rules preview
against the currently rendered rows immediately. Publication uses the shared
receipt-fenced optimistic View-definition journal, which keeps that definition
composed over canonical reads until the LocalCommit receipt materializes in the
View projection. The editor stays interactive during publication and retains a
newer local draft while an earlier publication hands off to canonical state.
Closing the editor flushes any complete draft that has not already entered the
publication lane. Incomplete typed rules remain local and are never published.
Rules refer to stable Property and option identities, are repaired when those
dependencies change, and never mutate option colors or Page values.

## Page editor behavior

Page title and body support the registered rich-text and Block families,
including nested Pages, references, Database View references, images,
attachments, tables, toggles, and thread sections. Exact syntax is owned by
[Nested Markdown](../references/nested-markdown-spec.md); focused interaction
contracts are indexed in [Product Specifications](index.md).

Owning Page, Canvas, and Database shells cannot be removed, duplicated,
reclassified, or replaced through generic editor commands. Their lifecycle and
movement use the shared
[structural editing authority](nfm-editor-structural-editing-behavior.md).
Ordinary Blocks use Document edits within one Document and Block Transfer across
Documents. When a selection contains an owner, Core commits the complete mixed
root forest, ownership closure, and inverse recipe as one structural mutation.
Every document-bearing owner shell is childless. Indenting, inserting, or moving
an ordinary Block beneath one is rejected.
This invariant is enforced on the actual local Block transaction before it
enters the collaborative Y.Doc, not only on keyboard or side-menu commands.
Remote Core delivery is admitted so authorized structural commits converge.
The complete parent capability and presentation contract is defined in
[NFM Editor Block Children Behavior](nfm-editor-block-children-behavior.md).

Large or native clipboard input uses explicit bounded flows. Saved assets use
managed asset identity; external links remain links. Exact attachment, copy,
table, mention, side-menu, and thread-section behavior belongs to the focused
NFM specifications linked from [the index](index.md).

## Calendar and reminders

Schedule, recurrence, occurrences, and reminders are Page behavior, not
Database layouts. The complete contract is in
[Calendar and Reminders Behavior](calendar-and-reminders-behavior.md).
