# NFM Editor Page Connection Behavior

Status: Active
Last updated: 2026-08-26

## Purpose

This document is the user-visible source of truth for connecting one Page to another in the NFM editor.
It distinguishes presentation from ownership and gives each intent one predictable entry point.
Typed `@` boundaries and the shared suggestion-session lifecycle are owned by
[NFM Editor Suggestion Menu Behavior](nfm-editor-suggestion-menu-behavior.md).

## Four Page occurrences

| Occurrence           | Editor entry                                        | Stored identity                                         | Owns or moves target |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------- | -------------------- |
| Page Mention         | type `@`, `+`, or `[[`; or choose `/Mention a page` | inline `pageMention.targetPageId`                       | No                   |
| Page Reference Block | `/Embed page…` and choose a Page                    | `pageRef.targetBlockId` plus the shell Block ID         | No                   |
| Page Link            | create a link or paste over selected text           | ordinary link with `nodex://pages/<page-id>`            | No                   |
| Owning Page Shell    | `/Subpage…` or typed Move to                        | Core-created `page` shell whose Block ID is the Page ID | Yes                  |

The first three never change parentage, Database membership, grants, or copy closure.

## Page Mention

Canonical NFM is:

```xml
<mention-page url="nodex://pages/<page-id>" />
```

The parser accepts only the exact self-closing tag with one canonical URL attribute.
Invalid tags remain literal text.
The editor stores only `targetPageId`; current title and availability are resolved under the nearest host content-access context.

The visual is an inline semantic icon and underlined title, not a pill or card.
Database Pages with an authorized workflow Status use that Status icon; Pages without one use the generic Page icon.
It is one keyboard-selectable atom: when the caret is directly beside it, `ArrowLeft` or `ArrowRight` selects the complete non-editable token, and plain `Enter` opens the available Page through the same host navigator as a click.
The editor keeps that atom range without exposing native text-selection painting; hover and keyboard focus use the same compact highlight overlay on the chip, with a small visual overflow beyond its content box.
When an available Page mention has keyboard focus, the editor also shows a compact anchored `Open page` affordance with the `↵` Enter hint below the token; this is an action hint, not an additional editable text range.
It remains readable when navigation is unavailable.
Hovering the mention shows a compact tooltip resolved under the same content-access context: current title, archived state when applicable, and a bounded Page preview. Missing, deleted, invalid, or unreadable targets show only a safe state explanation; the tooltip never exposes raw IDs, deeplinks, transport errors, or target content outside that authorized read model.
Clicking or pressing `Enter` on an available mention opens the Page through the host navigator; it never delegates the internal deeplink to the browser.
Mention serialization never injects the target body into search, title, clipboard, or Agent prompt text.
Choosing `/Mention a page` replaces the slash command with a visible `@`, leaves the caret after it, and enters the normal `@` suggestion flow so the user can continue typing a query.
It does not select a Page immediately or introduce a separate picker or occurrence type.

The `@` menu presents three semantic result sections—`Mention a page`,
`Mention a chat`, and `Date`—followed by Page-creation actions; reminders
belong to `Date`. `+` is Page-only and places Page-creation actions before Page
results once the query is non-empty. `[[` is Page-only and places Page results
before Page-creation actions. All three entry points use the same authorized
Page candidate source and produce the same persisted Page Mention occurrence.
When a query has no reference matches, the menu remains open so the user can continue typing or Backspace into a useful query. Authorized Page-creation actions remain available for the literal query; `No matching mentions` is shown only when the session has neither reference results nor creation actions. The menu closes only through the normal explicit dismissal, selection, focus, caret, or Block lifecycle.
An empty query orders them as Date, Page, then Chat so Today and Now advertise the temporal affordance.
For a non-empty query, sections follow the relevance of their strongest result; explicit date intent therefore leads, followed by exact title, Page key, title prefix, broader title, and content matches, with active-project context used only as a tie-break boost.
Each section has an independent visible budget so one abundant provider cannot crowd out the others.
When a fetched section has more candidates, `N more results` is a real peer option in that section: pointer click or keyboard selection expands all currently fetched remainder without closing the mention menu or changing the query.
Its label uses secondary emphasis at rest and returns to primary emphasis on hover, focus, or keyboard selection so it reads as a utility action rather than another result.
The expanded section replaces the utility row with its remaining candidates; other sections keep their independent bounds.

Page-creation actions use the current query as the new Page title. `New
sub-page` creates an owning child of the Page whose editor contains the
session. `New page in…` lets the user choose another authorized destination
Page without abandoning the query. In both cases, one Core-owned mutation
creates the Page and its independent Document, inserts its owning Page shell at
the chosen destination, and replaces the original trigger/query with a Page
Mention in the source text. Deleting that mention later never deletes or moves
the created Page.

Creation is atomic across ownership and inline content. A stale Document head,
permission failure, invalid destination, or any other rejected command leaves
the literal trigger/query available for correction and creates no Page or
owning shell. One Undo removes both the created Page and its inserted mention;
one Redo restores both with the same identities.

Rows are title-only by default.
A second line appears only when it explains a content match, disambiguates duplicate titles, reports an unavailable embed, or shows a Page key that the user explicitly queried.
Search excerpts are bounded around matched locations and highlight matching text in titles, Page keys, and excerpts. Multi-term content matches merge highlights from the same excerpt or compose up to three distinct fragments, so one term cannot hide the evidence for another.
Page search uses the same Rust metadata kernel, normalized token, prefix, typo-tolerant title ranking, and indexed match evidence as the Command palette. The prewarmed Core-authorized metadata projection supplies query-fresh rows in the input event; complete Core search only enriches those rows or adds body-only matches.
Core decides corpus visibility and authorization; the shared kernel decides metadata ordering, matched terms, and display-text highlights before the result bound. The renderer only groups semantic providers or adds presentation-only disambiguation.
If complete Core search fails, the menu keeps its synchronous metadata rows and presents Page-search unavailability as a status item rather than an empty match set.
For Mention and Link reads, the editor supplies the host Page identity and Core omits only a same-Page body match before ranking and bounding results, so the current Page remains discoverable through an empty recent search or an explicit title/Page-key match. Embed reads omit this source context and keep their separate disabled self/ancestor rows.
Content matching remains exact, substring, or token-prefix based so a fuzzy typo cannot fabricate a body match.
When the index expands a prefix or typo to a complete matched term, the row highlights that actual term and moves the excerpt window close enough to keep it visible before CSS ellipsis, even when the full source excerpt is shorter than the nominal character budget.
Database Page rows use their workflow Status icon; Pages without a Status use the generic Page icon at the standard compact-menu size.
Tooltips preserve useful context that does not fit in the row, including the full title, full untruncated excerpt, Page location/key/status, or Chat context.

## Page Reference Block

`/Embed page…` opens a compact caret-anchored Page picker.
No Block is created until a target is chosen.
The resulting `pageRef` is a non-owning shell that can disclose the target Page body when authorized.
Removing it removes only the shell.

Any disclosed Page body—whether referenced or owning—is an independent editor.
Pointer, keyboard, drag, resize, clipboard, and selection events inside it
belong to that editor and never select or focus the enclosing shell. Only the
active editor paints its Block selection; an inactive ancestor may retain its
logical selection for return navigation but cannot add a blue wash over the
disclosed body.

The picker and `@Page` use Page ID as the candidate key and the same authorized candidate source.
The embed picker retains the Page candidate order; the sectioned `@` menu ranks those candidates within the Page section and orders that section against Chat and Date by its strongest result.
Unavailable, self, and recursive-ancestor embed targets fail closed.
The embed picker preserves its source Block before opening and inserts only if that Block is still the active insertion point.
Cancel creates no placeholder; a stale insertion point is reported and leaves the Document unchanged.
Changing an existing Reference Block’s target is intentionally not an operation: remove the old shell and run `/Embed page…` again so the new connection has a new shell identity and disclosure state.

## Page Link and paste

A canonical Page deeplink is an internal link action.
Editable and readonly surfaces open it through Page navigation; they never send it to the browser or shell.

When the clipboard contains only one exact canonical Page deeplink:

- selected inline text becomes a Page Link;
- a collapsed caret in a non-empty inline Block inserts a Page Mention and trailing space;
- an empty paragraph becomes a Page Reference Block;
- code blocks keep the URL literal;
- structured HTML/Markdown/BlockNote clipboard and files keep their existing handlers.

## Ownership

Creating or moving a Subpage is a typed Core lifecycle operation fenced against the current parent Document head.
The renderer never creates an owning `page` shell as generic ProseMirror content.
A reference-mounted Page uses its own host runtime as parent authority, not the outer Stage route.
`/Subpage…` atomically replaces the chosen empty paragraph with the Core-created owning shell; cancellation and head conflicts leave no incomplete Page Block.

An owning Subpage participates in the shared [structural editing contract](nfm-editor-structural-editing-behavior.md). Backspace, Delete, block selection, Copy, Cut, Paste, Duplicate, Move to, drag/drop, Undo, and Redo may operate on a mixture of ordinary Blocks and Page, Canvas, or Database owners through one fenced Core transaction.
A keyboard deletion keeps a stable surviving cursor visible after the commit; a focus target chosen elsewhere while the command is pending always wins.
Owner shells remain childless: Tab indentation and generic insert/move commands cannot place an ordinary Block beneath them.
Core-authorized structural results arrive as remote Yjs changes and are admitted by that boundary.
Removing a non-owning `pageRef`, Page Mention, or Page Link remains an ordinary Document edit and never deletes its target Page.

## Derived references

Page Mention, Page Reference Block, and Page Link occurrences derive first-class Page reference edges with presentations `mention`, `reference_block`, and `link`.
Repeated occurrences in the same source Block and presentation aggregate an occurrence count.
Library Page content reads expose these Page references alongside Block, Database View,
and Thread references, preserving presentation and occurrence counts for CLI and other consumers.
Owning Page shells do not derive backlinks.
The normalized edge records the syntactic occurrence independently of the
target's current Page capability. If the same target Block is temporarily
ordinary, the occurrence remains normalized but resolves as unavailable and
cannot grant access or expose a preview. Restoring the Page capability makes
the existing occurrence resolve again without rewriting the source Document.
Backlink rows and counts include only source Pages readable in the caller's content-access context.

The Page Stage shows a collapsed `Referenced by` section below the body only when at least one authorized source Page is known.
An authorized zero-result does not render the section.
Its count is the number of unique authorized source Pages; rows are grouped by source Page and source Block, retain presentation kinds and occurrence count, and use bounded keyset pagination.
Opening a row navigates to the source Page and focuses the exact source Block after its editor is ready.
Adding or removing a Page occurrence invalidates both old and new target Page projections so an already-mounted section converges without a manual refresh.
