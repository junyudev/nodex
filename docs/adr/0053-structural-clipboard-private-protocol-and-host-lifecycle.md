# ADR 0053: Structural clipboard uses a private protocol and host-owned lifecycle

Status: Accepted; File ownership and Page relation rules amended by [ADR 0057](0057-library-files-and-page-relations.md)

## Context

Copying complete Block roots is not equivalent to serializing editor HTML. The
selection may contain stable Block identities, owning Pages, Canvases,
Databases, history, and Library File references. Core therefore captures an
immutable ownership closure and issues a capability for later paste. Capture,
native clipboard publication, source deletion for Cut, and target paste cross
the renderer, Electron Main, and Core runtimes.

The browser clipboard event must claim the native clipboard synchronously, while
Core capture and Cut deletion are asynchronous. A user may Paste in another
Nodex window before the source window finishes those operations. Renderer-local
pending state cannot coordinate that case, and using `text/html` simultaneously
as portable content, internal routing, and native-slot ownership makes fallback
and authority ambiguous.

Library File references add a related coherence requirement. A Page occurrence
may read the current content of a File without receiving direct File authority.
Structural movement preserves that Library-owned File identity and changes only
the source and target Page relationships. Page-wide cache invalidation loses the
affected File identity, reloads unrelated media, and makes authorization changes
difficult to reason about.

## Decision

### Clipboard protocol has three layers

Structural copy and cut publish three distinct kinds of evidence:

1. Standard `text/html` and `text/plain` presentations provide portable content.
2. `application/x-nodex-structural-clipboard+json` provides a private,
   versioned routing descriptor for trusted Nodex windows.
3. A Core-managed bundle, capability, and optional cut claim provide durable
   structural authority.

The private descriptor is bounded to 4 KiB of UTF-8 and decoded with an
exact-key, fail-closed schema. It contains only the protocol version, lifecycle
phase, native write claim, action hint, and a ready capability locator when
available. It never contains a Block forest, Page content, File bytes, a mutable
record graph, or a second copy of the Core bundle.

The descriptor has `preparing` and `ready` phases. `preparing` lets another
window rendezvous with work that has not finished. `ready` identifies a Core
bundle that must still pass complete Core validation. The action hint may
describe Copy or Cut intent, but it cannot authorize a move.

Standard presentations are mandatory even when the private descriptor is
available. Another application, another Profile, an unsupported platform, a
restarted host, or malformed private data therefore receives useful portable
content. A ready structural locator may also be recoverable from the standard
rich presentation after the ephemeral Main runtime is gone, but it remains
subject to the same Core validation. Portable fallback cannot create owning
Blocks and sanitizes foreign-Profile Library File references instead of creating
dead `nodex://files/...` placements.

Every asynchronous clipboard publication compares an exact write claim with the
current native slot. A newer copy always supersedes older work, including a copy
performed by another application. The write claim is causal evidence only.

Chromium transports event custom data through an opaque platform representation.
The native ClipboardEvent can read it, but Electron's raw and Web custom MIME
writers do not reproduce that event representation. Nodex therefore keeps the
original Chromium-owned formats instead of reading and reconstructing them.

On macOS, a small in-process Node-API Adapter uses public AppKit operations. Main
compares the HTML claim from a bounded, materialized observation, then passes its
pasteboard generation to a synchronous conditional enhancement. AppKit rejects
each format update if another process took ownership, including between the last
generation check and the setter. The generation additionally fences later copies
by another Nodex window. The Adapter never clears or redeclares the board, adds
types, or rewrites opaque Chromium data. Ordinary File-path resolution changes
only text; structural publication updates text first and HTML last, then verifies
both within the same generation.

This is not an OS-atomic multi-format replacement. Partial enhancement retains
portable content and cannot authorize source deletion; a failed or superseded
publication reports failure. `begin` only registers the session because it may
arrive before Chromium commits the copy event. Publication and its completion
observation run in one short, interruption-protected host operation; Core capture
and source deletion remain outside it.

### Electron Main owns the ephemeral lifecycle

Electron Main hosts one application-scoped `StructuralClipboardRuntime` inside
the Main Effect Scope. This is the single seam for native structural clipboard
coordination across all trusted Nodex windows.

Its small interface supports four semantic operations:

- begin or attach a source capture under an exact write claim;
- publish a verified Copy-ready result or a Cut candidate;
- settle the Cut after source LocalCommit admission;
- resolve the exact claim for a target Paste.

The Module hides preparing, ready, failed, and superseded state;
waiter-before-begin rendezvous; bounded waiters; native compare-and-swap;
timeout; source and target sender lifetime; Profile replacement; and shutdown
cleanup. Repeated target waiters for one claim share the same readiness result,
while Core still serializes consumption of a single-use cut claim. A published
HTML capability still resolves through an existing host session; it cannot bypass
the source Cut commit barrier. Only a host without that session uses it as a
recovery candidate. A newer publication supersedes older preparing work, not a
Cut whose source deletion is already in flight.

Timeout is fail-closed by lifecycle phase. It may expire an unregistered or
preparing claim because a later publication will then be rejected before source
deletion. It does not resolve a published Cut while source deletion is in
flight: elapsed time cannot prove whether that durable command committed. That
phase resolves only from explicit source settlement, source disposal, Profile
replacement, or Scope shutdown.

IPC identity is bound from the trusted sender and current host authority. A
renderer cannot name another source window, broaden Profile scope, or finalize a
claim it does not own. Source destruction before a valid terminal result settles
the session without inventing a move. Target destruction cancels only that
target's wait. Scope release settles all pending sessions and retains no process
global outside the application Scope.

The runtime is deliberately ephemeral. It writes no clipboard lifecycle rows to
SQLite and does not become a recovery ledger. A restart discards pending host
coordination; a valid ready Core capability may still be recovered through the
standard presentation, while an incomplete capture degrades to portable
content.

### Core remains the durable structural authority

Core alone owns the immutable clipboard bundle, capability hash, lease,
single-use cut claim, source deletion, target materialization, identity
allocation, history recipe, authorization, and exact File retention evidence.

Copy becomes ready after the exact native publication has been verified. Cut
remains preparing until the source deletion and durable cut claim commit and the
source renderer admits the corresponding LocalCommit. Only then may Main expose
the session as Cut-ready to another window. Failure before source deletion leaves
the source unchanged. Failure to establish move authority may use the verified
bundle as a structural copy when Core allows it; otherwise it uses the frozen
portable fallback.

The first Paste that presents a valid, available Core cut claim may preserve
identities. Every later Paste and every Copy paste clones. Private MIME, HTML,
Main readiness, renderer state, and optimistic UI can never substitute for that
claim.

### Paste freezes target intent and fallback

The destination handles the clipboard event synchronously. Before waiting, it
freezes:

- a stable target intent expressed with Block and replacement coordinates;
- the sanitized standard HTML and text fallback;
- the exact native write claim being resolved.

Selection, focus, Page, and window changes during the wait do not redirect the
Paste. Immediately before materialization, the destination synchronizes and
fences the current Document head. A still-valid frozen target receives either
the Core structural result or the already-frozen fallback. If that target no
longer exists, the operation fails instead of using the current caret. Keyboard
Paste and native context-menu Paste use the same planner.

Waiting may project a quiet, non-persistent affordance at the target. That
projection never enters the Document, collaboration state, Undo history, Files
inventory, or focus authority. The renderer performs no optimistic structural
insertion or File relationship change.

### File read coherence preserves exact identity

Core delivery retains the File identities already known by the committing
Module:

- File metadata, content, and lifecycle effects identify every
  affected File ID;
- Page Document effects identify the File IDs added to and removed from the
  canonical reference set;
- Page entry manifest revision and body-usage revision remain independent
  inventory authorities.

A placement-count change that leaves reference-set membership unchanged does
not invalidate File bytes. Ordinary Document typing and an unrelated File
mutation carry no invalidation for the current File.

The renderer owns one shared `FileReadCache` keyed by Store epoch, access
context, authorized read source, File ID, and optional exact version. The Module hides in-flight metadata
and byte deduplication, negative authorization results, exact listener fan-out,
stale-while-revalidate, bounded retention, image object URL ownership, and
cleanup. Replace keeps the last authorized preview visible until the new bytes
are ready, refreshes only placements of that File, and releases the retired URL.
A Store-epoch or authorization-context change revokes the matching cache scope.

This cache is a presentation projection. It never grants access, supplies a
fallback File authority, changes a Page relationship, or turns a File ID into a
bearer capability.

### Presentation follows the authorized source

A body occurrence resolves through its containing Page and needs no ownership
badge. Page Files includes both explicit entries and body occurrences for that
Page, deduplicated by File ID. Direct, Page, Canvas, history, and recovery reads
carry distinct sources; metadata, bytes, saves, and native materialization use
the same source and never fall back to a broader grant.

## Consequences

- Structural Copy and Cut have one cross-window lifecycle without making an
  individual renderer or React mount the coordinator.
- Private clipboard data improves same-application routing without weakening
  standard clipboard interoperability or turning clipboard bytes into domain
  authority.
- Cut cannot appear movable before its durable source mutation is causally
  visible, and a failed move keeps either the source or a safe copy result.
- A waiting Paste retains user intent even when selection and focus continue to
  change.
- File replace, rename, authorization, and placement changes refresh only the
  affected File; unrelated images and attachments remain mounted and readable.
- Shared File occurrences stay useful across Pages without duplicating File
  identity or leaking inaccessible usage locations.

The user-visible clipboard contracts are defined in
[NFM Editor Copy Behavior](../product-specs/nfm-editor-copy-behavior.md) and
[NFM Editor Structural Editing Behavior](../product-specs/nfm-editor-structural-editing-behavior.md).
File identity, Page relationships, and presentation are defined in
[Library Files](../product-specs/library-files-behavior.md),
[Page Files Behavior](../product-specs/page-files-behavior.md), and
[ADR 0057](0057-library-files-and-page-relations.md).

## Rejected alternatives

### Put the ownership closure in private clipboard data

This duplicates Core's immutable bundle, increases clipboard size and exposure,
and creates a second versioned authority that can diverge from retention and
authorization state.

### Keep pending structural sessions in the renderer

Each window has an independent renderer runtime. A renderer coordinator cannot
support waiter-before-begin across windows and is lost when its view or process
ends.

### Persist Main clipboard lifecycle in Core

Native slot ownership, sender lifetime, and short waits are host concerns.
Persisting them would turn transient operating-system coordination into durable
domain state without improving bundle or cut recovery.

### Encode internal routing only in HTML

HTML must remain useful and safe outside Nodex. Making it the primary internal
protocol mixes portable presentation with application lifecycle and obscures
which fields are authority.

### Invalidate all Page media after any File or Document change

Page-wide epochs discard exact File identity, reload unrelated bytes, amplify
rendering work, and make stale authorization results difficult to repair
precisely.

### Reveal every related Page or duplicate the File locally

An unfiltered usage list can leak a Page the current access context cannot read.
Cloning whenever an occurrence moves changes stable identity and gives Move
unexpected Copy semantics. Source-scoped reads and Library-owned identity keep
relationships private without either behavior.
