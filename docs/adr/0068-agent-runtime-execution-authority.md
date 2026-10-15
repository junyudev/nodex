# ADR 0068: One execution owner for each Agent conversation

- Status: Accepted
- Date: 2026-10-14
- Owners: Nodex maintainers
- Refines: [ADR 0066](0066-native-model-selection-and-opencode.md)
- Supersedes for Agent Runtime bound Sessions: conversation execution ownership in [ADR 0048](0048-effect-main-application-kernel.md), [ADR 0056](0056-native-codex-and-capability-negotiated-agent-backends.md), [ADR 0065](0065-native-claude-code-backend.md) and [ADR 0055](0055-acp-session-runtime-boundary.md)
- Supersedes: the Agent/resource permission distinctions in [ADR 0021](0021-local-user-library-workspace-authority.md), [ADR 0018](0018-full-access-turn-library-authority.md) and [ADR 0019](0019-project-agent-resource-consent.md)

Agents need to delegate across configured Backends and receive results after the
parent's foreground Turn ends. Child admission, cancellation, queued continuations,
result delivery and recovery must therefore share one execution transaction. Separate
conversation writers cannot independently determine whether the same task should run
or whether its result has already been delivered.

The Agent Runtime owns Thread and Run state, provider sessions, normalized history,
delegated work, command receipts and pending effects in its own SQLite database. It
runs in a separately supervised Node process so execution storage and native provider
work cannot block Electron Main. Codex and Claude retain their native protocols and
SDKs. An explicit Agent Instance remains the model's runtime owner; recovery cannot
substitute another configured instance.

The standalone execution library owns its native SDK, protocol and SQL platform
boundaries. Nodex process integration and Main Modules follow the application's
Effect lifecycle rules. Their public contracts carry serializable values; runtime
objects and execution storage never cross into renderer state. Native intake has
count and byte limits with explicit failure and physical connection retirement,
while durable event observers recover from persisted cursors.

Core owns Library content, Project placement and lifecycle, stable Session identities and
non-owning Page/sidebar relationships. It atomically admits a Session, its requested
Page links and an immutable execution reference with a stable launch request. An
authenticated preflight precedes idempotent, metadata-only Thread materialization;
Core then binds that identity before the first Run starts. A binding with an uncertain
commit outcome is retained and reconciled through its stable command receipt. Core does not become a second
writer for runtime history, Run status, queue or child lineage. Native and external
execution bindings are mutually exclusive for a Session.

Nodex is a single-user Profile with full content access. Every Agent can read and
write its Projects, Pages and Library, including work in other Projects or Sessions.
Parents, children and background work share this model. Plan selects planning behavior.
Native execution uses full access and automatically approves permission requests;
questions requiring user information remain interactive.

Desktop Host invocation identity belongs to an exact native connection of the current
engine process. Providers supplying causal call metadata also identify the original Run
and attempt. Standard ACP calls retain accurate Session identity with an unknown Run left
null. Host preparation completes before execution starts. Each tool use re-proves the
execution live with the engine and names its engine coordinates and bound Session; Core
validates that binding inside the same use and keeps no per-Run credential record.
Completion does not retire a live background process. Cancellation, native connection
close, process replacement, Session archive and deletion fail the next use of the
original calls, and replacement execution cannot revive them. Project placement
determines presentation, working directories and lifecycle, while Profile and Store
identity determine the physical resources a call addresses.

Conversation reads stay bounded before transcript bodies are decoded. The renderer
retains keyed item observations and incremental updates; metadata views do not attach
child transcripts. A control reply cannot wait for a slow event consumer. Dropped live
delivery is explicit and recovers from persisted event cursors.

The binding and execution contracts are specified in
[Agent Runtime behavior](../product-specs/agent-runtime-behavior.md). Native binding
consumers use the Session Interface. A Runtime-bound Session has no alternate local
execution writer.
