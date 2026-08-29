# ADR 0053: Structural clipboard uses a private protocol and host-owned lifecycle

Status: Accepted

## Context

Copying complete Block roots is not equivalent to serializing editor HTML. The
selection may contain stable Block identities, owning Pages, Canvases,
Databases, history, and Page File placements. Core therefore captures an
immutable ownership closure and issues a capability for later paste. Capture,
native clipboard publication, source deletion for Cut, and target paste cross
the renderer, Electron Main, and Core runtimes.

The browser clipboard event must claim the native clipboard synchronously, while
Core capture and Cut deletion are asynchronous. A user may Paste in another
Nodex window before the source window finishes those operations. Renderer-local
pending state cannot coordinate that case, and using `text/html` simultaneously
as portable content, internal routing, and native-slot ownership makes fallback
and authority ambiguous.

Page File placements add a related coherence requirement. A placement may read
the current content of a File owned by another Page without acquiring owner
authority. Structural movement can preserve that File identity and may rehome it
only through Core's exclusive-placement rule. Page-wide cache invalidation loses
the affected File identity, reloads unrelated media, and makes authorization
changes difficult to reason about.

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
Blocks and sanitizes foreign-Profile Page File references instead of creating
dead `nodex://files/...` placements.

Every asynchronous clipboard publication compares an exact write claim with the
current native slot. A newer copy always supersedes older work, including a copy
performed by another application. The write claim is causal evidence only.

On Electron 43, Chromium transports web custom clipboard data through an opaque
platform representation. The destination renderer's native `ClipboardEvent`
can read the private descriptor, but Electron Main cannot portably decode that
same value with `clipboard.read()` or `readBuffer()`. The descriptor therefore
routes the destination to Main by exact claim, while Main performs native-slot
compare-and-swap against the matching claim in standard HTML. `begin` only
registers the session because it may arrive before the browser has committed the
clipboard event; the later asynchronous publication performs the authoritative
slot comparison. This platform projection is isolated in the Electron clipboard
Adapter so a future atomic multi-format API does not change the runtime contract.

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
while Core still serializes consumption of a single-use cut claim.

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
allocation, history recipe, authorization, retention, and File ownership
consequences.

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
insertion and predicts no File rehome.

### Page File coherence preserves exact identity

Core delivery retains the File identities already known by the committing
Module:

- File metadata, content, lifecycle, and ownership effects identify every
  affected File ID;
- Page Document effects identify the File IDs added to and removed from the
  canonical reference set;
- owner manifest revision and owner-body usage revision remain independent
  inventory authorities.

A placement-count change that leaves reference-set membership unchanged does
not invalidate File bytes. Ordinary Document typing and an unrelated File
mutation carry no invalidation for the current File.

The renderer owns one shared `PageFileReadCache` keyed by Store epoch, access
context, containing Page ID, and File ID. The Module hides in-flight metadata
and byte deduplication, negative authorization results, exact listener fan-out,
stale-while-revalidate, bounded retention, image object URL ownership, and
cleanup. Replace keeps the last authorized preview visible until the new bytes
are ready, refreshes only placements of that File, and releases the retired URL.
A Store-epoch or authorization-context change revokes the matching cache scope.

This cache is a presentation projection. It never grants access, supplies a
fallback File authority, mutates ownership, or turns a File ID into a bearer
capability.

### Foreign placement ownership is disclosed progressively

A placement owned by its containing Page needs no source label. A foreign
attachment popover or image File-details surface shows `From <Page title>` and
an open action only when the current access context can read the owner Page. If
the owner is unavailable or unreadable, it shows `From another Page` without a
raw Page ID or navigation action.

The body receives no persistent ownership badge, and the containing Page's Files
inventory remains a direct-owner inventory. Disclosure does not grant owner
manifest, history, mutation, or lifecycle authority. Ownership changes only as
a Core-derived consequence of an identity-preserving semantic move whose
complete post-state placements are exclusive to one target Page.

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
- Foreign placements stay useful and understandable without duplicating Files
  into the containing Page or leaking an inaccessible owner identity.

The user-visible clipboard contracts are defined in
[NFM Editor Copy Behavior](../product-specs/nfm-editor-copy-behavior.md) and
[NFM Editor Structural Editing Behavior](../product-specs/nfm-editor-structural-editing-behavior.md).
File ownership, placement, and presentation are defined in
[Page Files Behavior](../product-specs/page-files-behavior.md),
[ADR 0051](0051-page-owned-files-and-immutable-bytes.md), and
[ADR 0052](0052-file-placement-is-independent-of-ownership.md).

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

### Expose every foreign owner or duplicate the File locally

Always showing owner identity can leak a Page the current access context cannot
read. Cloning on placement changes stable identity and gives move unexpected
copy semantics. Progressive disclosure and Core-derived exclusive rehome keep
ownership explicit without adding either behavior.
