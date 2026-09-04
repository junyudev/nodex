# NFM Editor Structural Editing Behavior

Status: Active
Last updated: 2026-09-05

Structural preparation has one absolute 10-second deadline, including native
drag/IME cleanup and durable fencing. After 700 ms the document status offers
Cancel; Escape, view deactivation, or disposal cancels pending preparation.
Cancellation removes only that operation's waiter and cannot discard pending
text edits. A cancelled or expired command cannot execute when an earlier save
later completes. Once submitted, the original operation identity and receipt
remain authoritative. See [Document Sync and Recovery](document-sync-and-recovery-behavior.md).

## Purpose

This document is the user-visible source of truth for editing selections that contain owning Page, Canvas, or Database Blocks. These Blocks own state outside the host Page Document, so the complete selection is committed by Core as one structural edit.

## Selection boundary

Purely ordinary text and Block-content edits use the editor's local collaborative fast path. Complete Block-root Copy and Cut use the Structural Clipboard even when the roots contain only ordinary Blocks; partial inline text ranges keep the portable editor clipboard path. If any mutation changes an owning Page, Canvas, or Database root or descendant, the complete selected forest—including ordinary Blocks—is handled by one Core operation. Side-menu drag-and-drop is also a Core-owned structural placement operation even when the dragged forest is ordinary: moving it can cross an owning sibling and therefore change protected placement relationships.

A Block selection remains authoritative whether it was created by pointer drag, the side menu, keyboard navigation, or an atomic Block node selection. A single selected owner never falls back to the last text cursor merely because the editor's text-selection API has no range for that atomic node.

Whole-Block selection visuals follow that authoritative editor selection and use a translucent blue fill rather than a focus ring. Ordinary leaf Blocks fill the available Block row; a structurally selected parent presents its complete visible subtree, including children, as one continuous selection surface. Image Blocks limit the fill to their own media width. While a Block selection surface is visible, native text-range paint inside it is suppressed so the same selection is never represented twice. Only the active editor surface presents its Block selection, so an outer editor's retained selection cannot tint Blocks inside a nested editor. Pointer or focus movement outside every editor hides ordinary Block-selection presentation without rewriting the editor's authoritative selection; an open Block action keeps its frozen target visible through its own explicit presentation lifetime. Side-menu selection keeps its owning editor active while the menu is open. An atomic Block is highlighted during a text-range selection only when the range fully contains it; a nearby Block, a range that merely ends at its boundary, or stale browser selection presentation must not appear selected.

While the Block actions menu owns DOM focus, Copy and Cut continue to target the same highlighted Block roots through the editor's structured-clipboard pipeline. The `Search actions…` input accepts filtering and Paste, but focus alone never replaces the active Block clipboard target. A handled Copy or Cut closes the Block actions menu and restores editor keyboard focus to that same selection, so the visible highlight remains an immediately actionable command target. If the editor declines the command without consuming the clipboard event, the menu stays open and native input behavior remains available.

Ordinary text ranges use the editor's semantic translucent-blue selection paint in both light and dark appearances. The source color remains alpha-based so it composes with the active surface instead of assuming a light background.

An open character-scoped picker, such as Link or Color, retains that inline paint. Native and retained inline selection paint never stack: exactly one translucent-blue layer is visible. An open Block-scoped picker, such as Change block type, Send to chat, or Move to, instead projects the retained target through the same whole-Block fill used by the side menu and suppresses both native and retained inline paint. The underlying text range is left intact so the formatting toolbar remains mounted, while the command and its presentation share one frozen Block-ID target until the picker closes.

An inline Page context has a separate quiet boundary halo. The halo is visible while the Page itself is selected or while the active caret or Block selection is inside its title or body; nested Page contexts show the halo on every containing Page. Moving the active selection outside the context hides the halo. Context halos never imply that their descendant Blocks are selected.

Core normalizes the selection in current Document order. A selected descendant is omitted when its selected ancestor already contains it; owned descendants are still discovered while Core expands the ancestor's complete ownership closure. A stale root, causal-head mismatch, authorization failure, or protected primary Database rejects the whole operation before content changes.

Generic Document updates may edit ordinary content, but they cannot create, remove, reparent, clone, or reclassify an owning shell. Page references, mentions, relations, links, and View occurrences remain non-owning and follow ordinary editing semantics.

## Delete and cursor behavior

Backspace, Delete, the block side menu, and a block selection may remove any supported mixture of ordinary Blocks and owners in one operation. The operation commits host Document updates, owner lifecycle and parentage, owned Documents, Canvas scenes, Database state, projections, retention evidence, and its inverse recipe atomically.

After Backspace, the cursor prefers the previous surviving editable Block at its end. After Delete, it prefers the next surviving editable Block at its start. If the host Document would become empty, the same operation creates an empty paragraph and places the cursor there. A user interaction in another surface while Core is committing always wins; a late completion does not steal focus.

Backspace at the start of a paragraph after a consecutive run of Page, Canvas, Database, image, divider, or other atomic Blocks merges that paragraph's inline content into the nearest preceding editable sibling. The atomic run remains in place. The cursor rests at the join between the target's original content and the appended content. The removed paragraph's direct children are promoted one level in their original order at the paragraph's former position, so they remain after the atomic run; nested owners keep their identities and owned Documents. The complete content merge, child promotion, and shell deletion is one structural history entry.

Rich inline content and plain source text are both editable Block content for this boundary. In particular, a Code Block is never skipped or crossed as though it were an atomic Block merely because its source disallows rich-text styles.

Rich-inline non-paragraph Blocks keep their ordinary first-Backspace normalization, such as resetting a list, toggle, quote, callout, or heading to a paragraph; a later Backspace may then perform the atomic-boundary merge. Plain-source Blocks are semantic text boundaries: Backspace at their start is consumed without normalization or lifting, while an immediately following editable text Block may merge into them through the plain-source merge path. If no preceding editable sibling exists at that level, Backspace leaves the Document and cursor unchanged. Deleting an atomic Block remains an explicit Block-selection action.

## Copy, cut, paste, and duplicate

Copying complete Block roots captures an immutable, bounded ownership-closure snapshot at the fenced source head. It includes ordinary selected Blocks, Page Documents and nested owners, Canvas scenes and managed scene assets, Database schema, Data Sources, Views, rows and typed values. Reference edges stay references to their existing targets. A partial inline range remains portable HTML and text and follows the editor's local collaborative history.

The native clipboard carries two complementary presentations. Standard HTML and plain text are the portable fallback. Nodex also writes a bounded descriptor using `application/x-nodex-structural-clipboard+json`; the destination renderer reads that descriptor from its native Paste event and uses its exact write claim to await the application-scoped session. Neither presentation contains the ownership closure or File bytes. A private descriptor, action hint, or ready locator grants no authority by itself: Core verifies Profile and Library scope, Store epoch, manifest hash, capability, current access, destination head, and any available cut claim before paste.

Electron Main owns one application-scoped, ephemeral Structural Clipboard runtime shared by every Nodex window. It coordinates preparing, ready, failed, and superseded sessions; compares every asynchronous publication with the exact native clipboard slot; supports a target waiter arriving before the source begins; and settles pending work from phase-safe timeout, explicit source outcome, renderer loss, Profile replacement, or host shutdown. Timeout may reject registration or capture before deletion starts, but it never infers that a published in-flight Cut preserved its source. It persists no clipboard session and cannot create a structural bundle, cut claim, history entry, or File relationship change. Those remain durable Core authority.

Copy claims the native clipboard synchronously with the portable presentation and private preparing descriptor while Core captures the snapshot. An immediate paste in the same or another window waits for that exact claim. Session registration does not synchronously read the native slot because the browser may still be committing its clipboard event. The later final publication compares the exact claim carried by standard HTML before replacing the native presentation, so a newer copy inside or outside Nodex always wins. If the host runtime is unavailable or has restarted, a valid ready capability carried by the standard rich presentation may still be revalidated by Core; otherwise paste uses the portable fallback. Missing, foreign, malformed, expired, superseded, or unauthorized private data cannot create an owning Block or a live foreign-Profile Library File reference.

The structural command queue and history lane have the same lifetime as their BlockNote editor. Page Stage may detach and remount a tab's React view while retaining that editor; each active view rebinds its current Document participant to the retained structural controller before input is accepted. Rebinding cannot change Library, authorization scope, Document, generation, or Store epoch; those changes require a new owner. External commands use the same admission, preparation lifetime, and focus-resume rules, never a late result-adoption path. Consecutive copy or cut commands therefore remain ordered while a prior commit updates the surface or the user switches tabs. Every pending capture reaches a terminal result; an unavailable or stalled session leaves the source unchanged and never silently degrades an owner to title-only clipboard content.

Copy never changes the source. Cut follows the fixed order `capture → native clipboard claim verification → source delete and durable cut claim → source LocalCommit admission`. Main exposes a Cut as structurally ready only after the final step. A failure before source deletion leaves the complete source unchanged; if the claimed portable presentation is still valid, Paste inserts that safe copy instead. The first valid paste of an available Core cut claim moves the original identities, whether it inserts at a caret or replaces a selected forest. Later pastes clone the immutable snapshot with fresh Block, Document, Canvas, Database, Data Source, View, and row identities.

Paste freezes its semantic target and a sanitized portable fallback synchronously, before waiting for structural readiness. The target is expressed with stable Block and replacement coordinates rather than the current browser selection. Changing focus, selection, Page, or window during the wait therefore cannot redirect the Paste. Immediately before commit, the destination surface synchronizes and fences the current Document head; if the frozen target is still valid, structural content or the frozen fallback is materialized at that target. If the target no longer exists, Paste fails clearly instead of inserting at a later caret. Keyboard Paste and the native context-menu Paste use this same planner. A wait longer than the quiet threshold may show a non-persistent `Pasting…` decoration at the frozen target; it never enters the Document, Undo history, Files inventory, or focus model.

Pasting while a Block selection contains an owner replaces the complete selection in one Core transaction. The same replacement boundary handles ordinary HTML, Markdown, BlockNote, plain text, files, oversized-text attachments, and a verified structural clipboard capability. Direct non-composition typing and Enter over that selection use the same atomic replacement command. The original closure and the inserted closure are both captured in one inverse recipe, so failure changes neither side and Undo removes the replacement while restoring the original identities in one step. When the insertion consumed a cut claim, that same Undo also returns the moved closure to its source; Redo performs the complete replacement again. Input-method composition remains owned by the editor until it produces a committed replacement event.

A cloned root title advances one canonical trailing positive-number suffix, or appends ` (1)` when no such suffix exists. Titles are display values, not uniqueness keys. Non-owning references inside the clone continue to target their original resources.

Duplicate and drag/copy use the same closure planner without changing the system clipboard. A same-Document drag moves the normalized root forest—including every child subtree—as one operation and keeps root order stable. Dropping at its current location or inside the moved subtree is a no-op. Drag/move otherwise preserves identities and is rejected when the destination is inside the moved ownership closure. Mixed structural selections may move between Page Documents; destinations that would require converting ordinary Blocks into Database rows remain separate typed product actions.

Images and attachments keep their stable Library File IDs through every
structural operation. A cross-Page move changes only the source and target body
occurrences. Copy, duplicate, ordinary paste, and whole-Page copy share the same
File identities; whole-Page copy additionally reproduces explicit Page paths.
No Block operation transfers File ownership, appends a File version, or allocates
a target path. Undo and Redo restore only the relationships changed by their
structural transaction and do not rewind a shared File head.

The center of a collapsed Toggle list or toggle Heading is an append-to-children target. It presents one quiet blue highlight across the toggle header, moves or copies the complete selected root forest to the end of that toggle's children, and keeps the toggle collapsed. The narrow top and bottom edge bands remain before/after targets and present the ordinary insertion line instead. These feedback states are mutually exclusive and come from the same semantic target that is committed, so one gesture produces one fenced structural transaction and one Undo entry. After an append-to-children drop, focus remains on the visible toggle header rather than moving into a hidden child. In nested editors, only the deepest eligible editor owns the feedback and commit.

## Turn into

`Turn into` supports Text, Heading 1/2/3, Toggle heading 1/2/3, Bulleted list,
Numbered list, To-do list, Toggle list, Quote, Callout, and Code. An
ordinary-only selection is reclassified in one local collaborative
transaction. When the selected host forest contains a Page, Core performs one
typed structural transaction for the complete forest. Canvas and Database do
not have a lossless ordinary representation and therefore reject the complete
action.

An ordinary Block with children cannot be turned into a leaf target such as a
normal Heading or Code. The menu disables that target instead of dropping or
hiding its subtree.

A turned Subpage keeps its Block ID. Its rich Page title becomes the ordinary
Block's inline content. A container target receives the Page body roots as
direct children. A leaf target keeps those roots as immediately following
siblings. Both forms preserve IDs, order, hierarchy below each root, and deeper
owner identities. Nested Pages
that moved with that body inherit the enclosing host Page as their owning Page
parent. The original Page Document becomes dormant and inaccessible while the
ordinary Block is active; structural history retains that Document until the
action can no longer be undone.

One Undo restores the same Page ID, Page Document ID, rich title, body,
Properties, grants, projections, and nested-owner parentage. Redo performs the
same typed transition again and preserves identity while Document heads remain
monotonic. A changed active subtree, claimed dormant Document, or conflicting
nested-owner placement fails closed instead of overwriting concurrent work.
An open tab for the turned Page remains a stable Page reference and presents
the normal unavailable state until Undo restores the Page capability.

After a successful conversion, the editor resumes at the end of the last
result root. A user-selected focus target, tab, or Stage chosen while the
operation is pending always wins over that default resume target.

## Undo and redo

Each mounted editor surface owns one chronological history lane. Local Yjs StackItems and opaque Core structural history tokens appear in the lane in the order the user acted. Remote collaborative changes do not create local entries.

Project-bound and trusted Library editor surfaces use the same structural and
text-history operations. Project surfaces still require their Project's current
content access; Library surfaces retain Library authority instead of borrowing
the Project used to attribute a receipt. Capability reads, Cut consumption,
Undo and release follow the original access scope, and lifecycle changes notify
the affected recipe's Project even when a Library surface performs the inverse.
A retained local surface cannot change between Library and Project authority.

The lane follows the editor surface rather than an individual runtime binding. Its collaborative backend exists when the editor is registered, before any EditorView mounts. Embedded Page Documents keep the same local text and structural history across provider updates and retained-view remounts. A missing collaborative backend is an initialization error, never permission to create an incomplete structural-only history.

Structural gestures reserve their chronological position before asynchronous preparation; the response fills that position rather than becoming the newest action. Forward structural commands and history replay share one executor. Later independent text can still be edited and undone while an earlier structural command is pending. Repeated Undo/Redo gestures queue at their owning surface instead of falling through to another history stack. Each request is limited to gestures admitted before that request, so it cannot wait on a later command queued behind itself. Text capture closes at structural admission and completion.

Content commands enter the same SurfaceHistory Module used by Database Views.
Move to Database belongs to the source editor's timeline. It reserves the gesture
before fencing the source or resolving the destination; its complete transfer
request remains available for exact recovery if the response is lost. A target
Database Drop instead belongs only to that target View's timeline. Neither path
may expose an older action while the transfer outcome is unknown.
Dropping Data Source Pages into an editor belongs to that receiving editor's
timeline, for both Move and Copy. Admission precedes its destination fence;
recovery retries the identical ownership-transfer request. A receipt without a
complete inverse leaves a whole-action barrier, never exposes older Undo, and
releases any unused single-direction history token. It is not a Document-to-Document
Block selection edit and does not borrow the source View's history.
The NFM Adapter supplies native captures, semantic inverse evidence and typed
request preparation; it does not keep a second command queue or history stack.
A response that cannot confirm the outcome retains the original request and
blocks dependent commands and earlier Undo. Local typing remains captured.
Recovery confirms that exact attempt before any new request is prepared;
selection, focus and File notifications never decide whether content committed.
The native Edit menu shows the focused surface's next action and availability.
Embedded Views and native inputs keep their own history; a stale focus or owner
snapshot cannot replace a newer menu observation. Waiting and blocked actions
show a compact notice in their surface, with Check again or Retry when safe.
Reset history requires confirmation, changes no content, and retires the entire
surface timeline without interrupting confirmation of submitted requests.
If the original receipt can no longer be confirmed, the action stays blocked
until Reset history. Receipt expiry is neither a rejection nor permission to
repeat the edit under a new identity, and cannot settle a Cut as source-preserved.
An inverse retired before preparation finishes is not submitted. Retirement
after submission transfers recovery responsibility without erasing the attempt.

Portable fallback is part of its reserved Paste gesture, including when Undo
was requested while the clipboard was still preparing. Ordinary local fallback
records one native inverse in that gesture. Replacing a selection containing
an owning Block still uses one Core replacement, even with portable content.
An unconfirmed Cut never reports that its source was preserved: the exact delete
must first be confirmed as committed or authoritatively rejected.

External Block drops and all Block Move-to-Page actions follow that same
admission rule: both source and destination Document preparation run inside the
reserved command. Waiting for either Document cannot reorder the gesture after
text entered during that wait.

Keyboard shortcuts, committed `historyUndo`/`historyRedo` input, and the editor's programmatic Undo/Redo all use the same owner. An empty history still owns its input. Text replay consumes at most one specified engine item; a no-effect item is considered in the chronological lane before proceeding, so the engine cannot skip past a structural action. New input during an asynchronous inverse remains recorded and makes that inverse's redo unreachable.

Capture-phase shortcuts respect the same embedded event boundary as BlockNote
NodeViews. A nested Page body owns its own input even inside such a boundary;
its title, Canvas scene, Database View and native input controls never invoke
the containing Page's history. Composer history remains independent of Page
history. The application menu routes to the focused surface, not the most
recently edited Page.

Undoing a structural edit executes a new Core transaction from its single-use inverse token. Core returns a fresh inverse token for redo; it never rewinds SQLite or replays the original command. Deleting and restoring an owner therefore preserves the same owner and Document identities while leaving unrelated collaborator changes intact. Replacement history swaps the currently active closure with the retained opposite closure, so paste and direct typing do not create a separate delete entry. Exact File identities and any Page-entry relationships are part of that same forward transaction and LocalCommit; they are never patched optimistically by the renderer. A conflict keeps the entry at the top of history instead of skipping to an earlier action.

Core's ordinary Block Promotion into Library or Data Source returns the opposite
structural history capability. Repeated reversal preserves the same generated
Page, Document generation, rich body and wrapper identities. Copy retirement
keeps its owned Document intact; Move restores the original source forest and
retains the target Document for replay. Data Source membership, Page Key,
Properties and manual positions keep their identities while the row is retired.
Library order uses surviving neighbors outside the retired batch. Promotion
history preserves exact File identities and Page relationship clocks without
changing shared File heads or copying the source Page's path entries. A later
shared File content update does not block structural Undo or Redo. Detached
history bodies retain their File identities until the capability is released.
Closed or released history cannot
reactivate those identities, while an exact committed request still returns its
original receipt. A symmetric capability is not returned for schema-changing
or Relation-carrying batches. The editor admits only the complete structural
capability into its timeline; an incomplete batch leaves a whole-action barrier
and releases its unused single-direction token. Promotion Undo and Redo share
the ordinary structural replay, reconciliation and release path.

A new local branch clears both kinds of redo entry together. Structural tokens that leave the reachable lane are explicitly released, including when the editor surface ends, so retention does not keep deleted closure state indefinitely. Releasing a cut history token also gives up its move claim; the immutable clipboard snapshot may still be pasted as a copy.

Promoting a restored ordinary Block again is a new command, not Redo. It keeps
the Block identity but creates a new Page Document lifetime; a retained dormant
Document from the earlier branch cannot collide with or replace it. Returning
the same Page to the same Data Source reactivates its stable membership and Page
Key with advancing revisions. The earlier branch cannot overwrite this work.

Surface shutdown cancels its local preparation and hands cleanup to Main;
accepting that handoff is not a fabricated Core commit. Pending writes remain
owned while their result is recovered, including forward Promotion and ordinary
structural commands. Confirmation and release continue when the surface closes
but its window remains open; late inverse tokens never reopen a closed surface.
Window reload, renderer loss and window destruction close only
that window generation's retention lifetime. Other windows' history survives.
Suspension and temporary disconnection do not expire interactive history.

Core history-state notifications reach independently subscribed windows. A source
Cut superseded by a destination Paste is removed by its exact capability, while
the source's other actions remain. Reconnection and structural replay reconcile
reachable tokens in bounded reads. Consumed or unavailable actions are not
silently skipped; an uncertain inverse still recovers its original receipt.

Structural restoration can replace collaborative addresses while preserving
Block identity. A local capture group therefore retains only its affected
fields and stable forest coordinates. Core-authored address fences mark the
affected history for semantic replay. Undo then validates the recorded
post-state of changed fields and restores their prior state in one Library
transaction, producing a fresh inverse token. Text, rich-text formatting,
properties, ordinary creation/deletion, split/merge, and nesting use the same
contract. Unchanged fields and unrelated collaborator edits remain intact;
ambiguous anchors or concurrent changes to the same field block the entry.
The bridge cannot create/delete a typed owner or rewrite its separate Document.

First-child-group insertion and removal participate in the same local semantic
history as existing children. Creating and then deleting an ordinary Block
before the first sync remains undoable after structural address replacement.
If that Block was never registered in Core, Undo registers its fresh identity
through the normal ordinary-Block creation guards; it cannot reuse a collected
identity, take a Block from another Document, or mint an owning shell.

Semantic replay restores the capture group's original caret or selection using
stable Block identities and content offsets; redo restores its final selection.
These bookmarks survive collaborative address replacement and retained-view
remounts. A missing Block never redirects the selection into an unrelated one,
and focus chosen by the user while a replay is pending always takes precedence.

A source surface cannot use its old content history to edit a Block currently
in another Document. That history remains blocked until the structural move
returns the Block to its authorized source placement. Other surfaces' history
and retention remain independent, even when they share one live Y.Doc.

## Bounds and recovery

One structural selection is bounded to 10,000 roots and 10,000 Blocks; ordinary replacement trees are additionally bounded to 128 levels; an ownership closure is bounded to 1,024 owned Documents and a 64 MiB canonical payload. Every command is Store-epoch-bound, exact-head-fenced, Project-authorized, and idempotent by operation identity and request hash.

A semantic history patch is bounded to 10,000 changed identities and 8 MiB of
JSON. Core rejects an invalid patch atomically, without consuming the entry or
undoing an earlier action.

Each editor retains at most 500 reachable history entries, including reserved gestures, and a conservative
64 MiB encoded-evidence budget across text and structural entries, with at most
10,000 retained Block/ancestor/sibling identities. The budget
includes changed fields, capture-group update bytes and retained deletion
payload, even when a group's net semantic change becomes empty. There are at
most one executing command and 100 waiting commands per surface;
excess commands fail before execution, without falling through to another owner.
Normal eviction removes the oldest Undo prefix and, if necessary, the farthest
Redo future. A local group beyond its byte or semantic replay limit keeps its
content, retires the inaccessible earlier prefix, and reports that Undo is no
longer available for that edit. New subsequent edits can be undone normally.
An evicted pending inverse cannot make a late Redo reachable; Main recovers the
exact outcome before releasing its original and resulting capabilities.

Clipboard bundles and history recipes hold normalized retention edges while active. Ending history immediately prevents replay; physical reference removal runs in bounded maintenance slices and conservatively retains content until committed. Local text history separately retains its reachable identities before a pending Document save can delete them, including before its first structural bridge. Repeated typing on the same Block does not create per-keystroke retention writes. Closing the surface releases its set; late updates cannot reactivate it. A consumed, superseded, or explicitly released recipe cannot be replayed. Transport response loss is recovered by idempotent receipt replay and canonical Document synchronization; renderer code does not construct compensation edits.
