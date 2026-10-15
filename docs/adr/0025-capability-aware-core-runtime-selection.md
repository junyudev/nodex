# ADR 0025: Detached Core selection is capability-aware and selector-first

- Status: Accepted
- Date: 2026-07-22
- Owners: Nodex maintainers
- Extends: ADR 0023 and ADR 0024

## Context

Electron and native CLI clients share one detached Rust Core per Profile. A
healthy socket and an overlapping transport range do not prove that the process
implements the Module semantics expected by a newly built Host. This became
visible when the Project Workspace tab contract changed while transport version
2 remained valid: the new Host reused an old Core and a Terminal action failed
later as an `invalid_input` requiring `projectId`. Package version and
`CARGO_PKG_VERSION` were identical across development builds, so they could not
identify the executable either.

Several independent compatibility axes already existed: private HTTP/SSE
transport, committed event shape, semantic Module contracts, SQLite Store
format, and executable content. Treating any one of them as the whole protocol
made same-transport semantic drift invisible and made startup correctness depend
on which launcher happened to run first. The opposite failure mode also existed:
same-build Renderer intents, Main adapters, operations, receipts, and snapshots
each accumulated local contract numbers even though those values had no
independent producer, consumer, negotiation, or migration lifecycle.

## Decision

Transport version 3 publishes a strict `CoreCompatibilityManifest` in the
runtime descriptor and authenticated handshake. It declares a transport range,
an event-version range, one canonical range for each Module, and exact
readable/migratable/current Store identities. A Store identity contains the
Nodex Rust-Core lineage, Store revision, and SHA-256 of the normalized exact
SQLite schema inventory. Host requirements are generated from the Rust source
of truth with OpenAPI; no Host call site supplies a free-standing contract
number.

The version axes remain independent, but a version belongs only to the seam or
durable artifact that can actually outlive one build. Rust Module contracts,
transport frames, committed events, and Store formats retain their own
authoritative versions. Renderer-to-Main intents and same-build operation,
receipt, and snapshot DTOs are versionless; Main still performs strict shape,
identity, bound, and semantic validation, then `CoreClient` injects the exact
generated Module `contract_version`. Event envelopes use `transport_version`
and committed events use `event_version`. Durable Document, View, recipe, file,
and algorithm identities keep a root format or algorithm version beside their
decoder, migrator, or rejection boundary.

The executable version-surface inventory records every retained Rust and
TypeScript declaration with its owner, lifecycle category, and compatibility
strategy. The source gate rejects unclassified declarations and shadow
`*_CONTRACT_VERSION` constants outside the Rust Module-contract authority. The
standalone Agent execution library also owns independent native and external
service wire versions, including its usage summary protocol; these are registered
with their own compatibility strategy and never supplied as Core Module requirements.

Every launcher runs the candidate executable as a selector before connecting.
The selector serializes on the Profile lifetime lock, validates and authenticates
the incumbent, evaluates all compatibility axes, and returns a bounded
`started` or `reused` result naming one exact generation. Electron uses
`prefer_current_artifact`: a compatible incumbent is still replaced when its
executable SHA-256 differs from the packaged or development candidate. Native
CLI uses `compatible`, so independently installed but semantically compatible
clients do not continuously replace each other.

Replacement is an authenticated, exact-generation, drain-before-open handoff.
A transport-3 incumbent accepts a candidate only if its manifest digest is
valid, it can read or migrate the incumbent Store identity, and it does not
downgrade any incumbent transport, event, or Module maximum. The control-plane
request is strictly tagged; legacy fields cannot deserialize as an ordinary
shutdown. A transport-3 candidate may use the isolated transport-1/2 handoff
bridge to replace a known older incumbent. An older candidate cannot replace a
transport-3 incumbent. No failure path kills a PID, deletes unproved runtime
files, or opens a second Store writer.

The descriptor is only a hint. Clients validate its ownership, modes, canonical
manifest/digest, artifact digest, exact Store identity, and fixed socket path,
then require the authenticated handshake to echo the complete generation and
selected event/Module contracts. Event decoding starts only afterward and
rejects a wrong transport, event version, Store epoch, sequence, or noncanonical
Projection Impact before the Host router sees it. Compatibility mismatch is
fatal for that stream; ordinary disconnect and retention-gap recovery keep
their existing behavior.

Artifact identity means the bytes that actually execute. macOS distribution
signing changes Mach-O bytes, so the packaging signing boundary first signs all
nested binaries, recomputes the closed native manifest from those final bytes,
and then reseals only the outer app before notarization. Release verification
requires the manifest SHA-256, Core's authenticated self SHA-256, and the
selector candidate SHA-256 to agree; a staged or pre-sign digest is never
published as packaged identity.

## Consequences

Changing a Module contract necessarily changes generated Host requirements and
prevents reuse of an old same-transport Core. Development rebuilds and packaged
updates take effect before windows or background producers start. A user action
can no longer be the first place where a process-generation mismatch is
discovered.

The startup control plane is larger, but it has one evaluator and explicit
diagnostics instead of payload heuristics. Artifact freshness remains policy,
not semantic compatibility. Store compatibility is exact rather than inferred
from a revision number alone. `PRAGMA user_version` is the single revision
authority, while the published Store catalog binds every supported revision to
the normalized physical-schema fingerprint that Core validates.
`core_store_metadata` retains current ownership state and does not duplicate
the Store revision. Completed migration evidence lives in the separate
`core_store_migration_history` ledger described by ADR 0046.

Whole-Store restore rotates the Store incarnation. During that maintenance
transaction Core rebinds restored durable event and Module-receipt epochs to the
new incarnation, publishes a new runtime generation, and invalidates old
connections. A newly handshaken client can therefore replay the restored event
history without accepting an event from the prior epoch.

## Rejected alternatives

- Reuse any Core with an overlapping transport range. This cannot detect
  same-transport Module drift.
- Compare package or build version strings. They are diagnostics, not content
  identity or a compatibility declaration.
- Always replace on a different binary hash. That makes native clients from
  compatible installations fight; freshness belongs to launcher policy.
- Decode old and new tab payloads in the Host. This preserves the semantic hole
  and creates a second protocol authority.
- Kill the incumbent or remove its socket on timeout. That can violate the
  single-writer invariant and cannot prove PID generation.

## Acceptance

A Host reuses only a Core satisfying every generated requirement. Electron
replaces a different compatible artifact; native CLI reuses it. An older Module
contract, a wrong Store fingerprint, a future unreadable Store, or an older
downgrade candidate fails before Module work. Concurrent selectors choose one
generation, an active incumbent returns `busy`, and an accepted handoff
releases the Profile lock before the replacement opens SQLite.

A projectless Terminal create/read carries only `terminal_session_id` and
survives restart. Legacy transport envelopes and events without canonical
Projection Impact fail before delivery. Live and restart replay retain event
version 2 and equal impacts.
