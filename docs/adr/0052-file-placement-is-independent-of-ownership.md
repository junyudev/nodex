# ADR 0052: File placement is independent of ownership

- Status: Accepted
- Date: 2026-08-28

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

Block structural operations now mutate only Documents and placement
projections. They no longer allocate hidden File copies, resolve path
collisions, advance target manifests, or require each transfer path to compose a
File-clone protocol. The same behavior covers ordinary cross-Page move/copy and
Block-to-Page promotion.

Rename and replace remain owner actions and immediately affect every placement
of that identity. This is consistent with mentions and other stable references:
the occurrence presents the current target rather than a snapshot. Core emits
Page-scoped content invalidations for foreign placements without pretending
their Files manifests or body-usage revisions changed. Users who need an
independent File use whole-Page copy or an explicit future File-copy operation.

The containing Page's Files dialog does not list foreign placements because it
is an ownership inventory. The body still presents and can save the placed
File. Removing that placement does not cause a File to appear in the containing
Page's Files dialog; the File remains in its owner inventory.

## Rejected alternatives

Cloning on every cross-Page placement preserves owner-local reads but gives a
move unexpected copy semantics and forces every structural compiler to
coordinate two aggregates. Treating `nodex://files/<id>` as unrestricted read
authority is simpler but turns an opaque identifier into a bearer token and can
leak bytes across Project grants. Moving File ownership with a Block is
ambiguous when the File has other placements. Adding a second shared-asset type
duplicates File identity, versions, and lifecycle without improving the user
model.
