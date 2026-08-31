# ADR 0056: Codex stays native while external agents negotiate capabilities

- Status: Accepted
- Date: 2026-09-02
- Owners: Nodex maintainers

## Context

Nodex needs to upgrade its primary coding runtime at the cadence of Codex while also supporting
independently implemented agents. Those two needs have different protocol, release, security, and
product semantics. Treating every model service or agent executable as a Codex “provider” couples
runtime supply to unrelated credentials and forces rich Codex behavior through a lowest-common-
denominator interface.

Codex also participates in two distinct runtime roles. The primary app-server owns account, model,
Thread, Turn, item, approval, review, history, and native subagent semantics. The Browser closure
contains an independently signed Codex peer CLI only to preserve its reviewed sandbox process tree.
Version equality between those executables is not a protocol contract.

## Decision

Codex is Nodex's native primary Agent Backend. Electron Main launches the exact staged
`codex-app-server` executable directly with an isolated `CODEX_HOME`; it does not launch a wrapper
CLI or inject third-party model credentials. The runtime lock records the exact official
`openai/codex` tag and source commit, checksum manifest, per-architecture package, artifact, schema,
license, and launch identities. TypeScript and JSON protocol schemas come from the same release's
schema-authoring CLI with experimental definitions enabled.

Nodex consumes the unmodified official `codex-app-server-package-*` closure. It does not compile or
patch `codex-rs`, mirror the package into a private release, or silently construct a substitute when
an official target asset is absent. Digest-pinned staging makes upstream asset replacement fail
closed. Execution, mailbox, and transcript semantics remain upstream contracts; Nodex owns durable
Thread/subagent projections, reconnect reconciliation, and truthful renderer state. A reproducible
runtime defect should be fixed and tested upstream before a private fork is considered.

External agents use stable Agent Client Protocol v1 as a separate backend family. ACP process,
transport, session, permission, filesystem, terminal, authentication, elicitation, and negotiated
capabilities belong to an isolated Main Module. Unsupported capabilities fail closed and are never
inferred from an agent name. Experimental ACP versions require a separate protocol pin and feature
boundary.

The product vocabulary is:

- **Agent Backend** is the runtime/protocol family (`codex` or `acp`).
- **ACP Agent Definition** identifies one supported protocol package, compatibility pin, and
  launch policy. It does not by itself attest a user-configured local installation.
- **Model** and **mode** are backend-owned choices exposed by that backend.
- **Provider** is an implementation detail unless the backend protocol explicitly exposes it.
- **Backend Capability Profile** is the only shared feature-admission authority.

Core stores an explicit discriminated backend binding for every Thread and Scheduled Automation.
Null is not an implicit Codex default. An ACP binding names both a supported Agent Definition and an
enabled Profile instance; its durable protocol session identity is stored separately from that
configuration binding so Main can resume the right conversation after restart. Changing a Thread's
binding invalidates its previous backend session atomically. A narrow Main registry resolves
bindings for shared conversation lifecycle operations; Codex-only operations remain native
refinements with explicit capability guards. Renderer consumes canonical product events and
capability profiles, never raw Codex or ACP transport messages.

The durable binding is also an admission boundary, not presentation metadata. Codex directories and
catalogs exclude ACP Threads before hydration, every Codex-only application owner checks the binding
before side effects, and the shared Thread-to-host resolver rejects a non-Codex binding before any
`requestForThread` dispatch. Renderer routes shared lifecycle commands by the Sidebar item's durable
binding and fails closed when a non-Codex item lacks a Session identity. Thus stale renderer caches,
direct IPC, scheduled execution, and application-protocol tools cannot reinterpret an ACP Thread as
a local Codex Thread.

The first ACP slice does not implement scheduled execution. The Automation definition grammar keeps
its explicit backend binding so a future ACP executor can be added without another persistence
migration, but today's Codex-only Automation application rejects non-Codex bindings at mutation,
projection, preparation, and execution boundaries. It never interprets an unsupported binding as a
request to run through Codex.

The initial Claude Agent integration is a user-managed local-package distribution. Enabling an
instance explicitly authorizes its configured package and Node executable to run as the local user
with the selected credential and proxy policy. Main canonicalizes the package, entry, workspace,
credential home, and Node paths; checks the supported package and executable versions; and exposes
only the capabilities negotiated through the ACP owner. Those checks establish compatibility, not
artifact provenance or code integrity. The package directory and dependency closure remain inside
the user's local-code trust boundary and can be replaced by whoever can modify those paths.

A future Nodex-managed ACP distribution is a distinct supply-chain mode. It must download a locked
archive, verify its registry integrity and complete dependency closure before extraction, stage it
into a private immutable directory, bind release provenance to the packaged application, and launch
only that staged tree. A registry integrity string must never be attached to a mutable configured
directory or presented as evidence for the bytes actually executed.

Browser compatibility is a committed, exact conformance-tested artifact relation. It matches the
app-server executable/source/schema identity to the Browser manifest/peer identity. Integrity,
architecture, native-addon verification, and vendor-signature checks remain independent gates.
Neither semantic-version ordering nor equality substitutes for the pair test.

## Consequences

Codex can upgrade without carrying unrelated agent/provider code, while its native history,
Browser, review, approval, and subagent behavior remain full fidelity. Runtime reliability deltas
stay small, attributable, and removable when upstream behavior catches up.

ACP agents gain a bounded, capability-aware path into the product without direct Renderer, Core
database, ambient filesystem, or ambient terminal access. A newly registered Agent can expose only
the operations its negotiated profile and Nodex owner adapters actually support.

Adding a backend requires durable binding, deterministic scripted protocol coverage, recovery
semantics, renderer projection, and a real executable compatibility probe. Adding an agent does not
permit weakening Codex contracts or creating another global provider/credential model.

## Rejected alternatives

A universal provider adapter was rejected because it would erase Codex-specific semantics before a
second implementation existed. Translating ACP into private Codex wire methods was rejected because
it would disguise ownership and couple two independent protocols. Shipping a silent fallback
runtime was rejected because it makes data and reliability behavior depend on an unobservable
branch. Browser semver ranges and exact version equality were rejected because neither proves the
cross-runtime tool contract.
