# ADR 0052: File placement is independent of ownership

- Status: Superseded for File ownership, exclusive rehome, and owner-closure copy by [ADR 0057](0057-library-files-and-page-relations.md); canonical placement and narrow presentation authority remain valid
- Date: 2026-08-29

## Context

A Page File has one stable identity and one owner Page. Images and attachments
place that identity in a Document. Requiring every placement to be in the owner
Page made ownership and presentation the same relation: cross-Page Block
transfer had to clone File metadata, allocate a target path, rewrite the
Document, and advance a second manifest. Every new structural path then had to
remember that special composition. Block-to-Page promotion did not, so a valid
subtree containing an image could not become a Page. The same restriction also
made a stable File URI unusable anywhere outside its owner.

Cloning on placement is semantically surprising. Moving a Block silently
creates another File identity, copying a Block forks metadata without an
explicit ownership action, and later replace or rename behavior depends on how
the placement arrived. It also turns a simple Document occurrence into a
cross-aggregate mutation.

## Decision

File ownership and File placement are independent relations:

- every File still has exactly one owner Page, logical path, manifest, version
  history, and lifecycle;
- an image or attachment may place that File identity in any Page Document in
  the same Library;
- move, copy, and Block-to-Page promotion carry the placement without cloning
  or rewriting File identity;
- whole-Page copy clones Files directly owned by the copied closure, while a
  placement whose owner is outside the closure keeps its existing File identity.

Placement remains non-owning, but an exclusive semantic move has one derived
ownership consequence. After Core persists the complete source and target
placement projections, it rehomes a File only when all of the following hold:

- the operation is an identity-preserving typed move, not copy, duplicate,
  ordinary paste, deletion, generic Document persistence, or a Page-shell move;
- the File's current owner is the source host Page;
- the moved forest originally contained at least one placement of that File;
- every live post-state placement of the File is in one target host Page.

If another placement survives, or the source placement was already foreign,
the move remains valid and ownership does not change. The caller expresses only
the structural move; it cannot request or suppress rehome independently.

Rehome preserves File ID, current bytes, Blob hash, creation provenance, body
URIs, and the complete immutable version chain. It appends a `rehome` version
whose owner is an audit fact. The target logical path is preserved unless its
portable namespace already contains that path, in which case Core allocates the
same deterministic ` (N)` suffix used for new Files. The source and target
Documents, placement projections, namespace, both Files manifests, history,
receipt, and LocalCommit commit or roll back together.

A canonical placement grants a deliberately narrow presentation capability.
Read access to the containing Page may resolve the File's current logical
metadata and current bytes. It does not grant access to the owner Page, owner
Files manifest, version history, mutations, or lifecycle operations. A File ID by
itself is never a bearer capability: Core verifies the requesting Page and its
current `block_asset_refs` projection on every current-content read.

Generic collaborative persistence may introduce a placement only when the
acting Project can already read the File owner or another canonical placement.
Typed Core structural compilers carry authorization evidence from their source
Document, including transactions that remove the source projection before
writing the target. Missing, deleted, cross-Library, and unauthorized Files are
rejected before Document commit. Non-Page Documents cannot contain Page File
placements.

The owner Page's Files inventory remains direct and complete. Its body-usage
projection counts only placements in that owner Page, because the Files row is
a de-duplication view of the owner Page body rather than a global backlink
count. Deletion protection is global: a File cannot be deleted while any Page
still places it.

Logical Page deletion retains direct Files and versions. When an external Page
still places an owned File, physical retention keeps the deleted owner closure
until the last external placement disappears. Current bytes therefore remain
stable for surviving placements. Blob backup and garbage collection continue
to follow retained File versions, not placements or renderer state.

## Consequences

Block structural operations no longer allocate hidden File copies or expose a
File policy flag at every caller. One Library-internal ownership-move Module
derives the narrow exclusive consequence from canonical post-state placements
and composes it into each identity-preserving move path. Copy-like and ambiguous
paths continue to mutate only Documents and placement projections.

Copy and Cut of every complete Block-root forest enter the Structural Clipboard,
so keyboard movement of an ordinary image, attachment, or parent subtree reaches
this rule without a File-specific renderer path. The first valid paste of a cut
capability is a move and may rehome, including when paste replaces a target
selection; later pastes and Copy are copies. Undo and Redo are new semantic
moves and re-evaluate exclusivity against their resulting canonical placement
set. Promotion Undo is
stricter because it removes the generated Page: it preflights current File
heads, namespace, placements, and target guard. One transaction reverses
required rehomes, restores the source placement, and purges the generated Page.
A conflict leaves all state and the history entry intact.

Rename and replace remain owner actions and immediately affect every placement
of that identity. This is consistent with mentions and other stable references:
the occurrence presents the current target rather than a snapshot. Core emits
Page-scoped content invalidations for foreign placements without pretending
their Files manifests or body-usage revisions changed. It also emits an exact
Document-scoped derived signal when the Page File reference multiset changes;
this invalidates placement-based reads without creating File state or exposing
inventory. Users who need an independent File use whole-Page copy or an explicit
future File-copy operation.

The containing Page's Files dialog does not list foreign placements because it
is an ownership inventory. The body still presents and can save the placed
File. Removing that placement does not cause a File to appear in the containing
Page's Files dialog; the File remains in its owner inventory.

Core reports ownership moves as a post-commit consequence. Only the initiating
surface may turn a collision-driven path change into one bounded success
message; ownership-only changes are silent. Other windows converge from exact
source and target manifest effects. Retained Page File query caches are
invalidated at application scope, including while a Page tab is unmounted, and
preserve their previous inventory while refetching. No renderer-owned
optimistic File model or rollback path exists.

## Rejected alternatives

Cloning on every cross-Page placement preserves owner-local reads but gives a
move unexpected copy semantics and forces every structural compiler to
coordinate two aggregates. Treating `nodex://files/<id>` as unrestricted read
authority is simpler but turns an opaque identifier into a bearer token and can
leak bytes across Project grants. Unconditionally moving ownership with any
placement would be ambiguous when other placements survive or the moved
placement is foreign; the exclusive post-state rule avoids that ambiguity.
Adding a second shared-asset type duplicates File identity, versions, and
lifecycle without improving the user model.
