# ADR 0067: One execution owner for each Agent conversation

- Status: Accepted
- Date: 2026-10-14
- Owners: Nodex maintainers
- Refines: [ADR 0066](0066-native-model-selection-and-opencode.md)
- Supersedes for Agent Runtime bound Sessions: conversation execution ownership in [ADR 0048](0048-effect-main-application-kernel.md), [ADR 0056](0056-native-codex-and-capability-negotiated-agent-backends.md) and [ADR 0065](0065-native-claude-code-backend.md)

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

Core owns Library content, Project authorization, stable Session identities and
non-owning Page/sidebar relationships. It atomically admits a Session, its requested
Page links and an immutable execution reference with a stable launch request. Runtime
materialization is idempotent and follows that admission. Core does not become a second
writer for runtime history, Run status, queue or child lineage. Native and external
execution bindings are mutually exclusive for a Session.

Desktop Host content credentials belong to an exact Run and connection lease. Host
preparation completes before native execution starts. Every tool admission verifies
current runtime lineage and native request identity, then rechecks Core's frozen
authority. A reused native credential is not Turn authority. Closing a connection
revokes its leases; a replacement cannot revive them. Delegated work inherits the
parent's frozen restrictions even when the parent's lease is revoked or its foreground
Turn has ended.

Conversation reads stay bounded before transcript bodies are decoded. The renderer
retains keyed item observations and incremental updates; metadata views do not attach
child transcripts. A control reply cannot wait for a slow event consumer. Dropped live
delivery is explicit and recovers from persisted event cursors.

The binding and permission contracts are specified in
[Agent Runtime behavior](../product-specs/agent-runtime-behavior.md). Native binding
consumers move to the Session Interface as complete vertical slices; an old execution
writer is not a fallback for a runtime-bound Session.
