# Codex Thread Owner/Follower Streaming

Status: Active
Last Updated: 2026-08-31

## Intent

Nodex supports multiple desktop windows viewing and operating on the same live Codex thread. One renderer window owns the live transcript projection for a thread; follower windows mirror that owner through ordered snapshots and patches, and route state-changing actions back to the owner instead of mutating local transcript state directly.

This contract keeps live streaming text, request cards, queued state, edit/rollback, and recovery behavior consistent across windows.

## Terms

- **Streaming thread**: a Codex app-server thread that is started, resumed, or attached to a live transport and may emit thread, turn, item, or server-request events.
- **Owner window**: the renderer window allowed to reduce live app-server events into visible conversation state for one thread.
- **Follower window**: a renderer window that displays the same thread from owner snapshots and patches.
- **Dormant conversation document**: a main recovery/hydration cache that is not a visible stream role. A renderer must adopt ownership or attach to an accepted owner baseline before showing live mutations.
- **Command-only run**: a main-owned automation execution that may issue app-server commands and broker JSON-RPC requests, but does not own or publish conversation state.
- **Stream revision**: a per-thread monotonically increasing revision attached to owner snapshots and patches.
- **Owner client id**: the stable renderer-client identity carried with stream updates so followers can reject stale owners.
- **Follow intent**: a renderer's explicit active-view request to receive a conversation's shared stream. It is independent from Review/presentation state and from app-server connection state.
- **Ready follower**: a followed renderer client that is connected, is not the owner, and has completed the current owner snapshot barrier. Only ready followers are patch targets.
- **Snapshot barrier**: the invariant that a newly followed or reconnected renderer receives the current accepted owner snapshot before any later ordinary state patch.
- **Accepted recovery cache**: main's last owner-accepted conversation document/revision. It is used for snapshot/adoption/repair only; the owner renderer remains the visible canonical reducer.
- **History-page barrier**: a follower asks the owner to reveal one exact boundary or search island, then waits for the owner-published revision before consuming it.

## Scope

This spec covers:

- owner/follower stream roles for active local Codex threads
- revisioned snapshot and patch application
- live assistant, plan, and reasoning prose streaming
- state-changing action routing from followers to owner
- request-plane ownership for approvals, user input, permissions, and MCP elicitations
- edit-last-user-turn rollback/replacement ordering
- sparse-history paging/search, resume, owner-loss, and inactive-owner cleanup

This spec does not cover:

- browser/HTTP Codex thread support
- realtime voice transcript UI
- first-run onboarding picker/setup UI
- visual styling unrelated to transcript ownership
- exact replay of hidden prompt-start params not stored in the conversation model

## Ownership Rules

At any moment, a streaming thread has one effective owner window for a given host.

Only the owner may:

- reduce visible thread mutation notifications
- run the assistant/plan/reasoning prose frame queue
- publish `threadStreamStateChanged` snapshots or patches
- own live request cards and request-response cleanup
- execute state-changing thread actions directly

Followers must:

- apply only matching owner snapshots and contiguous patches
- reject patches from missing, stale, or mismatched owners
- reject patches whose `baseRevision` does not equal the local revision
- route state-changing actions to the owner
- mark the conversation `needs_resume` when the owner disappears

Main process must:

- provide stable renderer client ids
- route owner/follower messages and validate response origins
- maintain followed intent, connected clients, snapshot-pending clients, membership epochs, and owner-detached recovery leases separately
- deliver ordinary state only to ready follower targets; an empty or unavailable target set fails closed rather than falling back to global stream broadcast
- send owner/follower control messages through the same targeted client boundary, while keeping status requests global so every renderer can reannounce its own follow intent
- host app-server transport and durable/recovery cache state
- keep no-owner hydration and command execution out of the visible stream plane
- compare-and-set renderer ownership after successful resume hydration and before returning the owner result
- hydrate the durable follow-up queue into the recovery replica during resume, even when the registry still names the initiating renderer as the prior owner; pre-adoption hydration never calls that transitioning renderer
- return an accepted owner document/revision to a competing renderer so it attaches as follower instead of starting a second resume implementation

## Stream State

Snapshots contain the full `conversationState` and a target `revision`.

Patches contain `baseRevision`, `revision`, and ordered Immer-compatible patches.

A follower applies a patch only when:

- local role is `follower`
- patch `sourceClientId` matches the recorded owner
- local revision equals patch `baseRevision`

On mismatch, the follower drops the patch and waits for a future owner snapshot, explicit resume, or owner-loss recovery. It does not request a main-authored transcript snapshot just because a stale patch was observed.

A renderer that is already owner ignores incoming stream-state messages, including publish echoes. Production `threadStreamStateChanged` messages always identify a renderer owner; main does not emit source-null conversation snapshots or patches.

## Follower Subscription Control Plane

The stream data plane and the follower subscription control plane are separate. The renderer's active conversation lifecycle calls `setThreadViewActive()`; main records that signal as follow intent through the subscription coordinator. Review tabs, `setThreadPresented()`, above-composer diff banners, and projectless output filtering do not create or remove follow membership.

The coordinator keeps these sets distinct:

- `followedClientIds`: renderer intent, including a client that is temporarily disconnected
- `connectedClientIds`: clients currently registered with the renderer router
- `snapshotPendingClientIds`: followed non-owner clients that have not adopted the current accepted owner snapshot
- ready follower targets: the intersection of followed and connected clients, excluding the owner and snapshot-pending clients

When a follower attaches, the coordinator marks it snapshot-pending. Main sends the accepted owner snapshot to that one target; only after delivery is accepted does the client become a ready patch target. The same barrier is re-established for a reconnect and for every owner replacement. A missing owner keeps the intent but cannot produce a visible snapshot; the next owner adoption flushes pending snapshots from the accepted recovery cache.

Targeted delivery is fail-closed. `threadStreamStateChanged` and follower control messages carry explicit client targets, exclude the source owner, treat an empty target list as a no-op, and never fall back to all-window broadcast. A missing/destroyed target is converted into an IPC reset, removes it from ready targets, preserves its follow intent during the five-second reconnect grace, and requires a fresh snapshot before patches resume. Following-status requests are the deliberate global exception: every renderer may receive the request, but only renderers with the matching local follow intent reannounce to the current owner.

Owner disposal sends a targeted transport reset to ready followers, preserves main's accepted document/revision, and lets each follower reannounce or enter `needs_resume`. Accidental disposal and IPC reset do not immediately evict the accepted cache; deliberate inactive cleanup may evict it only after there are no followers/pending reconnects and the normal retention gate passes. App-server connection status is not renderer-client status and must not be used as a substitute for this control plane.

App-server endpoint loss is a separate invalidation source. Main marks every loaded conversation `needs_resume` and targets a transport reset to each affected owner/follower surface before replacement. The visible attachment lifecycle then performs bounded resume/adoption or exposes its terminal failure with Retry; it never keeps a dead-generation role or an indefinite restore loader while the host reconnects.

## Prose Streaming

Assistant, plan, and reasoning text stream as live owner patches, not as completed-message animation.

Required behavior:

- `item/started` creates the canonical item and does not force prose flushes.
- Prose deltas append only to existing matching assistant/plan/reasoning items.
- Missing or kind-mismatched delta targets are dropped, ACKed, and logged.
- The owner batches visible prose through a frame queue.
- `item/completed` drains pending prose before applying the authoritative completed item.
- Terminal `turn/completed`, `turn/interrupted`, and `turn/failed` drain pending prose before final turn state applies.

Frame queue constants:

- visible renderer frames use `requestAnimationFrame`
- fallback timer is `16ms`
- normal prose flushes up to `24` characters per frame
- terminal drain uses at most `8` frames
- hidden/no-rAF/small terminal buffers flush synchronously

Streamdown remains the markdown renderer and in-progress visual animation layer. It is not the upstream transport mechanism for live text.

## Owner Actions

Follower-originated state-changing actions route to the owner:

- start turn / follow-up turn
- resume the latest interrupted turn
- steer active turn
- interrupt turn
- update thread settings
- compact thread
- edit last user turn
- set or clear thread goal
- set thread memory mode
- approval, permission, user-input, and MCP elicitation responses
- queued follow-up mutations
- plan-implementation request removal
- one-page history reveal and persisted-search hydration
- fork from turn

The owner performs visible mutations locally and publishes the resulting stream revision. Main validates ownership and executes allowlisted app-server requests through the owner-scoped request facade. Queue and steer semantic commands additionally commit through Main's durable queue Module; their owner requests are short, idempotent projection updates and never enclose the app-server transport.

### Start Turn

For active owned threads, the renderer owner creates the submitted-user bubble:

1. Compile the prompt once into app-server `UserInput[]`, attachments, review-comment context, and agent-config sidecars, then generate `clientUserMessageId`.
2. Synchronously append a nullable in-progress turn whose params retain that exact prepared input and client id; its raw item list contains no synthetic user message.
3. Queue the resulting owner patch in the renderer publication outbox. Publication does not gate owner-visible state or app-server dispatch.
4. Call app-server `turn/start` through the owner-scoped facade with the same prepared input and client id. Main validates the owner and resolves permission, workspace, model, and authority policy, but does not parse the prompt again.
5. Synchronously rebind the temporary turn to the returned app-server turn id and queue the rebind patch.

A visible local conversation with no stream role resumes and adopts renderer ownership before step 1. It never falls through to the main-owned `codex:turn:start` IPC. The owner-scoped main facade is transport-only for `turn/start`: it forwards the request and returns the raw `TurnStartResponse` without merging a turn, inserting a transcript row, or publishing a source-null stream update.

All ordinary state-changing conversation actions use one authority router: owners execute locally, followers forward to the current owner, and no-role renderers resume/adopt before executing locally. There is no per-action main/no-owner transcript fallback; local interrupt is the explicit idempotent control-plane recovery exception.

Ordinary owner mutations commit against the latest renderer document synchronously. The owner action boundary automatically materializes canonical mutations into the visible projection, so a local start or a Main-staged steer cannot update canonical input while forgetting the transcript view. The per-conversation publication cursor computes patches from its last accepted shared document, coalesces mutations that arrive while a publish is in flight, and repairs a rejected patch with a bounded recovery snapshot. Action receipts may wait for the outbox to reach the required revision, but local visibility and the app-server RPC never wait for publication. Full resident snapshots remain explicit barriers for resume, owner replacement, revert, and repair; exported complete history never enters this stream.

Direct new-thread creation prepares the same input and client identity before transport and adopts the actual app-server thread as the route identity. Main first hydrates the response into the canonical dormant snapshot, then owner adoption atomically turns that snapshot into the first accepted renderer replica and checkpoint. The renderer installs that owner checkpoint before publishing the first visible conversation snapshot, using the same attachment lifecycle as resume. The first adoption must not require an accepted replica as its own precondition; absence of a canonical snapshot fails closed. Main does not publish the dormant document as a visible source-null stream or add a separate transcript-only user row after the response.

Once Main admits `thread/start` or `thread/fork`, the application-scoped creation owner completes the physical operation even if the initiating renderer disappears. The app-server response's exact Thread id correlates the local commit with any earlier `thread/started` notification. Main must either finish the intended Session/Side Chat/import ownership transaction or run its compensating cleanup; losing an IPC waiter never leaves a normally visible orphan Thread or an indefinitely loading surface.

Interrupted-turn Resume uses the same authority router and optimistic transaction with an explicit userless intent. The owner requires the latest canonical turn to remain `interrupted`, requires idle runtime with no thread goal, pending request, or pending steer, and coalesces concurrent Resume attempts per thread. It appends a nullable in-progress turn whose canonical params contain `input: []`, then calls the owner-scoped `turn/resume-interrupted` facade. Main translates that product-private facade request into the standard app-server `turn/start` with empty input and inherited thread settings. No user bubble is projected. If transport fails, the owner removes only that nullable placeholder and restores the prior runtime status rather than terminalizing an empty failed turn.

Later app-server user-message echoes remain canonical raw turn items but never create a second initial-user bubble while the params-owned row is visible. When app-server supplies `clientId`, reconciliation requires the exact submitted `clientUserMessageId`; structural input comparison is only a compatibility fallback for echoes without a client id. If actual turn work precedes the server `userMessage`, normal local-thread projection treats the completion as a `steered` lifecycle marker even when the client id matches. Preserving a second server-owned user bubble is reserved for explicit server-message-preserving views. The same identity rule applies to incremental `item/completed` projection, full turn hydration, and pending-turn rebind.

### Steer Turn

Steer enters Main as one complete typed intent containing the expected turn, prepared input, stable `clientUserMessageId`, distinct recovery-row identity, and comparison context. Main first sends the owner a closed staging directive for that same identity, then performs transport in the Thread causal lane. If app-server identifies a different active turn, Main retargets the same intent once; if the target ended before acceptance, it falls back to ordinary `turn/start` with the same wire identity. No retry creates a second optimistic item. The authoritative matching user-message completion accepts the pending item; terminal completion restores an unaccepted item exactly once through the durable queue transition.

### Queued Follow-ups

Core owns one exact-revision ordered ledger per Thread. Main's scoped `CodexQueuedFollowUps` Module hydrates that ledger, freezes and verifies payload manifests, serializes mutations through the Thread lane, and owns one bounded per-Thread delivery fiber. The renderer never runs a queue reducer or drain loop.

Dispatch wake-ups are level-triggered per Thread: while a delivery fiber is running, any additional wake-up coalesces into one replay after that fiber settles. A wake-up can never disappear merely because it arrived during transport completion, durable row removal, or fiber cleanup.

Main projects a complete queue snapshot with `threadGeneration`, `ownerEpoch`, `ledgerRevision`, and process-local `projectionRevision`. The active renderer owner accepts only newer coordinates, applies the snapshot atomically to its conversation document, and publishes the resulting owner revision. Followers therefore see queue state from the same visible writer as the transcript without gaining ledger or transport authority. Owner loss interrupts the scoped attempt but retains the durable row; a replacement owner receives the current projection before another attempt.

An in-flight row remains in the durable ledger and visible projection. Only successful transport followed by successful exact-revision removal may make it disappear. Failure updates that same row in place. Interruption recovery is driven by authoritative `turn/completed` and atomically pauses the existing queue even when there was no pending optimistic steer to restore.

### Edit Last User Turn

Editing the latest user turn is an owner-local ordered transaction:

1. Ensure the local conversation is owner; no-role local edits resume first.
2. Wait for the owner publish cursor and already-forwarded owner notifications to settle.
3. Read the current conversation and verify the target is still the latest completed editable user turn.
4. Send the stable target identity as `beforeTurnId` through the owner-scoped facade. Main calls generation-fenced `thread/revert`; a host without the identity-based revert contract fails closed instead of materializing complete history for deprecated count rollback.
5. Re-read local state, then project the returned bounded retained tail against that current owner conversation.
6. Tombstone removed turn/item ids so late notifications cannot recreate the old bubble.
7. Synchronously commit the rollback-only conversation to renderer subscribers and publish that snapshot.
8. Start the replacement turn through the same owner-local start-turn path only after the rollback publish succeeds.
9. Followers wait for the returned owner revision before the edit action resolves.

The synchronous rollback-only commit is part of the contract, not a rendering optimization. React must observe a state in which the original bubble is gone before the optimistic replacement is appended.

Current edit replacement input is reconstructed from visible user-message content. Text, images, mentions, skills, and text attachments represented in `rawItem.content` are preserved. Hidden start params such as structured comment attachments or agent config overrides are not replayed unless they are persisted in the conversation model.

## Request Plane

Live approval, permission, request-user-input, and MCP elicitation rows are visible request-plane state. When a renderer owner exists:

- main keeps JSON-RPC pending-response plumbing
- the owner stores and publishes visible request rows
- response UI routes by `conversationId` before local request lookup
- owner response cleanup removes the request and publishes completed request item state
- stale followers do not call direct response IPC when they missed the request row locally

Non-Nodex dynamic tool calls that do not create visible request state are
owner-gated and ACKed without ordinary stream patches. Every `nodex_app` call
executes directly in main with its frozen Turn authority; it never detours
through the conversation state owner.

Nodex Project-scope write consent is the deliberate exception to request-plane
ownership. Main targets the most recently activated renderer presenting the
direct task, or the root task for a background child. That renderer may be an
owner, follower, or not-yet-adopted viewer. It overlays the authorization card
locally, preserves it across incoming canonical snapshots, and removes it on a
response or terminal Turn; the occurrence is never published as canonical
conversation state and never causes the renderer to adopt ownership.

## History and Resume

History paging and persisted search are owner-visible sparse mutations. A follower sends one exact page or search-island action to the current owner and waits for the resulting revision. Edit and fork route their stable Turn identities directly and require no history barrier. Complete export is renderer-scoped, cancellable, and deliberately outside owner/follower resident-state publication.

Explicit resume returns a role-tagged result. With no owner, main hydrates the latest tail, silently seeds its accepted recovery document, compare-and-sets the invoking renderer as owner, and returns `{ role: "owner", conversation, revision, checkpoint }`. Before notifying transcript subscribers, the renderer installs the owner role and seeds its outbox from that checkpoint; it then applies the document, releases buffered same-thread events, publishes the next owner snapshot, and asks main to replay any transport-brokered pending requests. If another owner already exists, main performs no second resume; it returns `{ role: "follower", conversation, revision, ownerClientId, checkpoint }` from the accepted owner cache, and the renderer installs the follower baseline before applying the document. A subscriber must never observe a `resumed` document without the role from the same accepted attachment.

Renderer attachment is an explicit observable lifecycle independent from the app-server conversation's `resumeState`: `idle`, `attaching`, `attached`, or `failed`. Only `attaching` renders a restore loader. A settled failure stops automatic render-loop retries and exposes an explicit Retry action; if a valid cached transcript exists, the transcript remains visible with a failure notice instead of being replaced by a loader. Failure before adoption returns the conversation to `needs_resume`; activation failure after adoption also invalidates the unusable stream role while retaining the last truthful local transcript for recovery. Explicit retry or a subsequently accepted owner snapshot may attach the surface again.

Renderer ownership adoption is part of that resume transaction. Main resolves the invoking renderer's registered client ID from the resume IPC event and, after successful hydration but before returning the snapshot, adopts that client only when no different owner exists. A failed, archived, non-resumed, disposed-client, or competing-owner resume never installs or replaces an owner. The first resumed snapshot can therefore publish immediately while unknown and wrong-client publications remain fail-closed.

Buffer release can advance Main's accepted canonical checkpoint after the initial resume handshake. Owner activation therefore treats a rejected checkpoint with recovery data as a convergence boundary: it adopts the recovered checkpoint, preserves Main-owned standalone unread state, and retries the activation snapshot within the same bounded transaction. A stale handshake checkpoint must not require navigation or a second user action to become usable.

Background child-agent summaries are not active child-thread streams. Parent thread surfaces may show child memberships and multi-agent-derived row state, but a child thread receives a bounded tail only when a background-agent detail tab opens it. Multi-agent visible rows are derived from receiver thread display metadata and agent state keys; sparse receiver id lists remain available to membership/reference projection but do not create clickable visible row targets on their own. Receiver display metadata is lightweight catalog data, so friendly agent names and seed-based identicons must not depend on parent-driven child snapshot hydration. The background-agent opener hydrates only the selected child thread id and opens the tab; the detail tab content materializes/resumes the child body and then marks the child thread opened for routed deltas without requiring local parent metadata.

When the owner client disappears, followers reject revision waiters, clear the owner role, mark the conversation `needs_resume`, and recover through explicit resume. The last accepted document remains available for owner adoption or a new follower snapshot while that recovery lease is active.

## No-Owner and Automation Boundaries

No-owner state is dormant, not a visible stream role. Main may hydrate/cache protocol history for recovery and may update durable sidebar/read models, but only an identified renderer owner may publish `threadStreamStateChanged`. Opening a dormant task runs resume/adopt; opening a task with an existing owner attaches to that owner's accepted baseline.

Cron automation is a command-only runner: main owns workspace setup, `thread/start`, `turn/start`, tool execution, run lifecycle, and terminal/inbox bookkeeping. It suppresses those notifications from the conversation pipeline while no renderer owns the run. Heartbeat automation requires a fresh lease published by the exact current renderer owner; main then issues transport commands without hydrating, merging, or claiming conversation ownership. Pending automation approvals/user-input remain transport-brokered and replay to a renderer after it adopts the task. Delivery is idempotent per semantic request occurrence (`requestId` plus method and call/item identity) and owner client, so re-resume cannot execute or surface the same pending occurrence twice; reused protocol ids do not collapse distinct dynamic calls, and owner replacement makes the same unresolved request eligible for replay to the new owner.

Owner patch publication is a follower-broadcast side effect, not the owner-visible state boundary. Main validates the owner client, requires the patch base to match its last accepted owner revision, and applies the patch to that accepted document before targeted delivery. A missing, mismatched, or unapplicable base is rejected without advancing revision or acknowledging the owner notification; the owner then publishes its current shared document as the repair snapshot. Main's dormant recovery cache is never an alternate visible writer and never replaces the accepted-owner patch base.

`item/fileChange/patchUpdated` is the Electron-compatible owner-local exception: the owner updates its visible canonical conversation immediately and submits a recovery-only snapshot with follower broadcast disabled. Main accepts that snapshot into the dormant cache and uses it to satisfy a pending follower barrier, but does not synthesize a second visible transcript writer or broadcast the high-frequency intermediate patch.

## Implementation Coverage

The current implementation covers these owner/follower contract areas:

| Area                                   | Status   | Contract                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single visible owner                   | complete | One renderer reduces active live transcript state; main owns transport, persistence, routing, and recovery caches.                                                                                                                                                         |
| Follower mirror semantics              | complete | Followers apply matching owner snapshots/patches and drop stale owner/base mismatches.                                                                                                                                                                                     |
| Follower mutation guard                | complete | State-changing follower actions route to the owner unless explicitly no-op, owner-local, or outside transcript ownership.                                                                                                                                                  |
| Action authority routing               | complete | One router implements owner-local, follower-forward, and no-role resume/adopt behavior for ordinary conversation actions.                                                                                                                                                  |
| Canonical/view commit boundary         | complete | Owner action mutations automatically materialize canonical changes before local notification and shared-document publication.                                                                                                                                              |
| Request ownership                      | complete | Approval, permission, user-input, and MCP elicitation request rows are owner-visible state.                                                                                                                                                                                |
| Notification ownership                 | complete | Owner-visible app-server notifications route to the renderer owner; command-only/no-owner notifications never enter the visible conversation pipeline.                                                                                                                     |
| Prose and output queues                | complete | Assistant, plan, reasoning, and command output use process-global count-and-byte-bounded queues. Owner ACK attribution is bounded and fails the owner generation closed under pressure; Main fallback pressure commits without losing deltas.                              |
| Resume/start/history lifecycle         | complete | Resume and fresh launch expose one renderer attachment lifecycle, install role/checkpoint before visible notification, terminate failures explicitly, release the resume buffer before the owner snapshot, and keep one-page/search-island revision waits owner-published. |
| Owner-loss recovery                    | complete | Owner disposal rejects waiters and marks followers `needs_resume`.                                                                                                                                                                                                         |
| No-owner discipline                    | complete | Main keeps dormant recovery/automation state off the visible stream plane; a renderer must adopt or attach before transcript updates are visible.                                                                                                                          |
| Late follower bootstrap                | complete | A competing resume receives the accepted owner document, revision, and owner client id without replacing the owner or issuing another app-server resume.                                                                                                                   |
| Automation boundary                    | complete | Cron is command-only; heartbeat requires a fresh exact-owner lease; protocol turns drive run/inbox bookkeeping without a main transcript.                                                                                                                                  |
| Follower subscription control plane    | complete | Active view lifecycle creates explicit follow intent; main separates followed/connected/pending state and emits membership epochs.                                                                                                                                         |
| Targeted relay and delivery failure    | complete | Ordinary state/control messages are target-before-delivery, source-excluding, empty-target no-op, and unavailable targets enter IPC reset/reannounce handling.                                                                                                             |
| Snapshot barrier and owner replacement | complete | New, reconnected, and replacement-owner followers receive the accepted snapshot before becoming patch targets.                                                                                                                                                             |
| Accepted-cache lease                   | complete | Accidental owner disposal preserves recovery state; deliberate cleanup evicts only after follower/reconnect eligibility checks.                                                                                                                                            |
| Empty in-progress file-change activity | complete | Empty active file changes retain stable identity and render `Editing files`; terminal empty policy remains separate.                                                                                                                                                       |
| Projectless Review affordance          | complete | Session-scoped Review is available when a valid turn target/diff exists; invalid targets hide the affordance without hiding live activity.                                                                                                                                 |
| Durable queued follow-ups              | complete | Core owns the ordered ledger; Main owns terminal recovery and scoped delivery; the renderer owner publishes fenced full projections and followers remain presentation-only.                                                                                                |

Covered owner-routed actions include start turn, edit last user turn, steer turn, interrupt turn, thread settings, goal changes, memory mode, compaction, one-page history reveal, persisted-search hydration, queued follow-ups, request responses, fork from turn, and plan-implementation request removal.

Covered owner-visible notification categories include thread metadata/status, turn lifecycle, item lifecycle, assistant/plan/reasoning deltas, command output, file-change patches, request resolution, and turn errors. Progress-only, deprecated, or unsupported rows are validated, ACKed when needed, and kept out of ordinary visible stream patches.

The remaining fidelity caveat is edit replacement input: Nodex reconstructs replacement prompt input from visible user-message content, preserving text/images/mentions/skills/text attachments represented in `rawItem.content`. Exact replay of hidden start params such as structured review comments or agent config overrides requires persisting those params in the conversation model. This is outside the apply-patch streaming/review control-plane gap closed by this implementation.

## Validation Expectations

Required regression coverage includes:

- live partial prose appears before completion in owner and follower windows
- terminal lifecycle waits for pending prose drain
- owner patch publish does not gate owner-visible state
- owner publish failure preserves partial text
- edit rollback removes the old turn before replacement starts
- follower actions wait for returned owner revisions
- request responses route through owner by conversation id
- stale patches are dropped without main-authored transcript resync
- rejected owner patches repair through an owner snapshot without exposing a split transcript
- late server user-message completions remain canonical but project as steering lifecycle after work instead of duplicating the params-owned user bubble
- owner-loss recovery marks followers `needs_resume`
- failed resume/start requests do not leave stale main-side renderer owner mappings
- renderer-owned resume seeds the owner cursor from the returned accepted revision, releases the resume buffer, publishes the hydrated owner snapshot, and then replays brokered pending requests
- competing renderer resume attaches as follower from the accepted owner baseline without a second app-server resume or owner publication
- a renderer that loses a concurrent resume race receives the winning owner's accepted baseline instead of an adoption error
- command-only automation emits no source-null conversation stream and protocol `turn/completed` drives run/inbox bookkeeping directly
- brokered pending requests replay once per owner, resolve without canonical transcript state, and can replay again only after owner replacement
- heartbeat dispatch is rejected when the renderer lease is missing, stale, or belongs to a non-owner window
- ordinary resume IPC adopts its invoking renderer before returning, so the first owner snapshot succeeds without test-only owner seeding
- resume failure releases the buffer and rolls local state back to `needs_resume`
- parent thread mounts do not mark background child agents opened; only background-agent detail tabs do
- an empty in-progress `fileChange` is visible from the first event, retains its item identity when changes arrive, and does not create a duplicate terminal row
- a follower cannot receive an ordinary patch before its targeted snapshot barrier completes
- owner replacement requeues snapshots for every followed follower and never sends the replacement owner's echo back to itself
- missing/destroyed targeted clients trigger reset/reannounce handling; no target falls back to global stream broadcast
- accidental owner disposal retains the accepted recovery cache while deliberate inactive cleanup can evict only after the lease gate
- Projectless Review hides an invalid/dead affordance while `Edited files, read files` and live file-change activity remain visible
- queue projections reject stale generation/epoch/revision coordinates, survive owner replacement, and never create a source-null competing visible writer
- interrupted terminal completion pauses an ordinary queue even when no pending steer recovery effect exists
- an in-flight row remains visible until transport and exact-revision removal both succeed; failure stays in place and blocks automatic FIFO
