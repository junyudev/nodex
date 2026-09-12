# Codex Thread Owner/Follower Streaming

Status: Active
Last Updated: 2026-09-16

## Intent

Every authenticated execution host has an ordinary conversation manager in Main and in each
window that uses it. A conversation has one effective owner peer. Other peers follow that
owner's canonical document and send mutations to its typed action interface. Main also owns
the native app-server connection and durable product authorization; those capabilities do
not make Main a second canonical writer for a conversation owned by a window.

Timeline-backed history is not part of the active transcript path.

## Manager and peer lifetimes

A manager belongs to one execution host, authenticated account context and Endpoint identity.
Main retains that manager across physical reconnects when these identities remain unchanged.
Replacing the account, execution-host key or Endpoint retires the manager and its subscriptions.
Physical request lifetimes capture the native generation separately; a late callback cannot
mutate a successor generation's document even when its manager object is retained.

Peer connection status and IPC reset events reach every registered host manager. They are service
events and do not require a conversation host field. Connection status names the affected peer
in its payload; the envelope sender may be the coordination service. Remote connection announces
existing follow intent to the new peer. Self reconnection announces follow intent to all peers;
owners respond with their current snapshots. Remote disconnection invalidates that peer's
ownership. IPC reset clears follower membership with reconnect grace while retaining stream roles.
Ordinary conversation events remain scoped to their named host.

A disconnection revokes native callers, Turn preparations, resume receipts, history loads, settings work and queued
native deltas. Resident history stays visible but becomes incomplete and requires resume.
Main resets stream roles on connection loss. Windows reset roles after a dedicated-process
restart or identity replacement. For a same-identity WebSocket reconnect, windows retain owner
and follower roles while invalidating native work, then restore eligible owned streams.
Refreshing an unchanged connected host preserves its context identity and pending work.

Native Turn admission captures its connection before input preparation. That identity remains
fixed through queue/delegation preparation, owner discovery, title scheduling, context injection
and native dispatch, including after the preparation has been consumed. Gateway admission checks
the captured host and generation again after waiting for readiness. A late native success cannot
bind presentation, Turn authority or canonical state to a recovered manager. Unused preparations
are released if their registration crossed a reconnect.

An owner steering action captures the native connection, its exact owner role and the conversation
lifetime. Reconnection, replacement of the conversation, or losing and reacquiring ownership
retires the old action. Pending Turn-ID waits, outcome timers and late native responses cannot
mutate the replacement document, bind submission presentation or report a successful steer.
Retirement settles through the normal error channel and releases its subscriptions.

Manual compaction waits for pending settings, then routes through the current stream owner.
A settings failure caused by an unavailable owner can be recovered only while the caller is
currently a follower. Peer timeouts and other errors do not authorize a second submission.
Only the executing owner adds the pending compaction marker and sends the native request.
That marker and request belong to the admitted connection, conversation and owner lifetime;
an old success cannot report completion and an old failure cannot remove a successor's marker.
Native item notifications consume the pending manual source once per admitted request.

Delegated messages read the latest meaningful Turn again after settings have settled. An older
resident in-progress Turn does not override a newer completed Turn. Preparation, forwarding,
inactive-Turn fallback and completion retain the original connection, conversation and owner
lifetime. The fallback starts a fresh Turn only for the delegated caller's confirmed inactive
steer, and all prepared submission identities are released when that operation settles.

WebSocket recovery runs at most two background resumes concurrently, using interactive request
priority. The retained primary route lets its mounted view resume immediately and reserves a
ten-second fallback; side chats and background details do not replace the foreground route.
Successful view or executor settlement cancels the fallback. Transient recovery errors back off
for 2, 4, 8, 16, 32 and then 60 seconds. A confirmed missing-thread error waits 60 seconds;
a second consecutive missing result stops recovery. Archive suppression, writer conflicts,
ownership loss and manager disposal also stop it. A new reconnect cancels prior timers and
prevents their settlements from consuming the new recovery's concurrency slots.

The mounted conversation stage and standalone composer wait for their conversation's own host
to be connected before automatically resuming. Offline role invalidation must not leave the view
in a failed attachment state that prevents the subsequent connected transition from retrying.

Read-state sessions retain their authenticated namespace across physical reconnects. Canonical
connected-environment evidence is cleared and rebuilt from native notifications; repeated connects
are deduplicated and the managed environment is excluded. Metadata, history, settings and goal
hydration capture their physical generation before I/O and reject stale completion.

Window resume attempts retain their caller source. Concurrent requests from the same source
share an attempt; recovery callers also join any pending attempt. A different source waits for
settlement, then reevaluates its own inputs and current state, including after failure. Removing
or archiving the conversation, or disposing its manager, prevents a waiting caller from recreating it.

Registered window managers update acquisition activity on native focus and document visibility
changes. Ordinary windows may acquire a stream while hidden. An unowned hotkey-window conversation
requires a visible, focused window, including when the initial route identifies the hotkey window.
Existing owners and followers retain their roles when activity changes. Automatic execution reads
current window activity directly; view and recovery requests use the manager's registered activity.
Unowned acquisition is rechecked after preparation, and unused admission is released while cached
history remains resumable.

Main and window managers read readiness from their canonical conversation document. They reuse
an already resumed owner or follower without requesting another snapshot or keeping a competing
hydration flag. A follower whose owner is still recovering leaves that recovery to the owner;
Main starts, delegated messages and fork adoption must respect that not-ready result. A ready
canonical document does not require a presentation snapshot to exist.

Execution context and Side chat operations read resident canonical metadata without requiring a
presentation. Ephemeral parent links, Side chat identity and projectless intent survive replication;
an explicit null Project assignment does not inherit an ancestor's Project. Durable Core assignment
remains authoritative for durable conversations. Side chat preparation uses live workspace and
execution settings, rejects nested Side chats, and revalidates the parent generation across I/O.
An unaccepted native fork is cleaned up when subsequent validation or setup fails.

Owner actions route through the current established stream role. Discovery is used when no role
exists and is followed by another role check; a stale discovery advertisement cannot override an
owner the peer already follows. The executing peer still validates its own ownership and captured
native generation before admitting the action.

Ordinary Main preparation establishes follow intent before loading metadata and workspace
settings. Ownership is acquired only after preparation and a fresh lifetime check. An owner
snapshot received during ordinary preparation remains authoritative, and the follower skips its
own native resume. Preparing a cached document for ownership requires actual owner loss or native
retirement; calling resume again is not an ownership transfer.

After native history hydration, the window awaits durable acceptance before committing the final
canonical tail and stream role. It then assigns ownership, replays buffered native ingress and
publishes the completed snapshot without another asynchronous boundary. A peer snapshot received
while acceptance is pending cannot leave the completed local resume silently following that peer.
Native notifications arriving during acceptance stay in the resume buffer until this transition.

Main and window preparation share native resume request construction. An idle native Thread may
reuse its configuration and instructions only when there is no explicit permission or service-tier
override, no named permission profile being sent, and no nondefault configuration. Empty profiles
and null configuration entries do not force configuration reload; other configuration, including
MCP visibility, does. The resume request still carries the selected Thread identity, rollout path,
settings and history-page contract.

A native resume starts with a 120-second response deadline. Default timeouts allow two
retries, each after 750 ms, with 240- and 480-second deadlines. An explicit deadline,
including zero, is preserved and does not permit timeout retries. A closing-thread error
has a separate budget of four retries after 750, 1,500, 3,000 and 6,000 ms. Other native
errors propagate. Retiring the manager cancels scheduled waits and retires native callers;
late completion cannot start another attempt or install history in a successor.

Retrying retains the admitted preparation and parameters but obtains a fresh physical
request identity. A response from an earlier attempt cannot authorize durable acceptance.
Receipt renewal is unavailable during or after acceptance; interrupted acceptance releases
that exclusion, and repeated successful acceptance returns the same result without another
commit. Main resume preparation, native dispatch, history acceptance, buffered replay and
publication share one cancellable lifetime bound to the exact native and conversation generations.
Cleanup finishes before a subsequent Main resume acquires the same serial lane. Detached replay
retains its own pending occurrences: failure or interruption settles every unfinished occurrence
without consuming a successor buffer. Synchronous race completion must cancel and finish the
losing work's cleanup before the enclosing operation settles.

A recovering conversation remains `resuming` until its canonical history tail is installed.
Queued messages load independently of transcript residency. A newly installed conversation
projects already loaded messages, their order and pause reasons immediately, even when queue
loading finished before the conversation existed. History hydration does not replace queue state.
Window shutdown drains accepted queue edits before retiring IPC, so an interruption immediately
followed by exit retains the queue's pause reasons on restart.

Queue ownership follows the execution host's admitted capability. When native Thread queues are
available, all six `thread/queue/*` operations are sent to the current native generation and the
app server is the durable queue authority. Renderer windows keep only a projection cache used by
the composer; owner changes do not create another queue copy. A manual send prepares the selected
row through the current conversation owner, keeps its stable client user-message identity, and
converges every window from the native queue after admission. When native Thread queues are not
available, the peer-owned persisted queue remains the authority.

Automatic queue delivery uses the latest execution Turn, skipping completed local markers and
ignoring display-only overlays. An attached conversation must end with a completed Turn containing
an assistant message or manual context compaction before its next queued message starts. A
conversation with no execution Turn or requiring resume may enter preparation, which rechecks the
current owner, queue identity and active Turn before sending. Unconfirmed native submissions and
unbound in-progress Turns prevent a second automatic start.

Window queue preparation resumes an unowned or resumable conversation before the execution owner
check. Automatic preparation uses the executor source; an explicit send uses the view source.
An owner still recovering or an inactive acquisition defers automatic work without removing the
captured message or assigning a failure pause. A newly discovered active native Turn also defers it.

Resuming an interrupted queue clears only interruption pauses. Other failures remain available for
explicit retry, and an interrupted or failed last Turn does not itself authorize automatic delivery.
An explicit queued send defers automatic sends while loading and refreshing the queue, then captures
the selected message. Edits or replacement during preparation invalidate that captured submission.

Physical peer identity comes from the coordination connection. A renderer cannot select its
own execution identity in an IPC payload. The native adapter preserves that physical caller and
captures the authenticated manager lifetime. Conversation managers enforce operation-specific
owner rules; native routing does not run a second owner election. Prepared mutations additionally
validate their admitted executing peer and immutable request capability.

Renderer controls resolve the manager for the target conversation or explicit execution host
before reading permissions or issuing actions. Archive, queue, goal, read-state, history,
Subagent, Turn, and background-process actions therefore cannot fall through to an unrelated
default host when multiple host managers are active in the same window.

Follow intent belongs to active conversation views. Independent view handles keep a count;
only the final release stops following. Presentation state, Review tabs and focus indicators
are separate from follow intent. A disposed old view cannot release a successor view's handle.

Main's ordinary peer may own a conversation used by an automation, follow a window owner, or
retain a dormant document. A dormant document is not permission to process live mutations.
Native event projection checks the actual manager role and connection generation.

## Canonical document and patches

The owner stores one canonical conversation document. For canonical history, ordered islands
reference Turn values directly in `entitiesByKey`; live overlay turns remain separate.
Presentation selectors merge resident history and overlay where required. History pagination
lives on the resident Turn and conversation, rather than in a parallel item-window authority.

A local mutation runs as an Immer draft recipe. The exact patches produced by that recipe
are the replication payload. UI snapshots are derived projections and are never diffed back
into canonical state. Owner-visible updates do not wait for Main publication acceptance.

Snapshots contain the full canonical document and an owner revision. A snapshot replaces the
receiver's document and owner even when its revision is lower or the receiver was previously
an owner. Ordinary patches apply only when the receiver follows the source peer and its
revision equals `baseRevision`. The resulting revision need not equal `baseRevision + 1`.
Mismatched or failed patches are dropped and logged; they do not issue a hidden resync request.

New or reconnected followers receive the owner's current snapshot before ordinary patches.
The publisher is excluded from delivery. Empty target sets are no-ops, not a request to
broadcast to every window. Disconnect/reconnect handling preserves follow intent during the
bounded grace period and requires a fresh snapshot before patch delivery resumes.

Each manager may load resident history locally without acquiring execution ownership.
A follower's local history mutation does not publish patches to its owner or other followers.
An owner may perform a local draft mutation without broadcasting it. Complete history installation
uses that facility when one explicit snapshot must publish the completed operation. Command
output may update the local document before a later item lifecycle event publishes it.

## Native ingress and actions

Raw notifications and server requests enter the window manager with their native method,
parameters, host and generation intact. Metadata hydration cannot delay or reshape that raw
ingress. The production Inbox has no per-occurrence byte quota that rejects an otherwise
valid large notification before its owner can process it.

Owner action dispatch uses typed native method payloads. Followers forward the original
request fields and context; they do not convert them to composer text and ask Main to rebuild
an unrelated command. Settings, interrupt, start, steer, edit, compaction, complete history and
approval or user-input responses execute in the current owner. Every peer action requires the
addressed conversation's current owner and a supported method. There is no generic action fallback.

Option-picker and setup-tool replies use the receiving manager's native request occurrence
directly. They remove only the matching local request and do not acquire or change ownership.
Onboarding user input uses the ordinary owner-routed user-input method when sent by a follower.

Native start preflight captures the original request and context in an immutable capability.
Owner-time materialization resolves current defaults after owner selection. The executing
peer must match the current owner, and execution accepts only the finalized admitted request.
An account, generation or owner change invalidates the receipt. Attachments, comments,
permission-context flags and client user-message identity travel with the admitted operation.

Turn preparation resolves native permission overrides, retained Turn parameters and current
permission provenance together. Permission-selection context takes precedence over an explicit
server-default flag. Otherwise an explicit flag, including false, takes precedence over an
inherited flag from the latest assigned Turn. An optimistic Turn cannot supply that inherited
decision, and disabling settings inheritance also disables inherited default intent. A defined
null permission profile is an explicit choice; workspace roots alone are not a permission choice.
Custom Project permissions do not imply server-default intent.

Server-default preparation leaves policy, reviewer and profile selection to the native runtime
while retaining the effective policy and sandbox in the local Turn. A named profile never travels
with a non-null native sandbox override. An explicit sandbox clears inherited profile selection;
named profiles retain matching provenance from next-Turn settings or current permissions.
Permission selection requires complete next-Turn permission settings or current permission
context. Missing settings fail preparation with a specific error before native submission.

Live permission context distinguishes an unobserved profile or root list from an observed null
profile or empty list. History reconstruction can project concrete defaults for a historical Turn,
but must preserve the live context used by subsequent preparation. Workspace relocation preserves
the canonical workspace kind and browser root as well as its effective cwd.

Queued starts and steers retain their captured service tier, including an explicit null reset.
Turn preparation preserves native tier strings and checks current configuration requirements
before sending a non-null tier. The requirements request has critical priority and a 30-second
deadline. A disabled fast mode or failed requirements read selects the default tier consistently
in the native request, canonical Turn parameters and current settings.

Turn execution settings preserve explicit null values independently of omitted values. Next-Turn
settings fall back to the conversation's retained model and reasoning effort, while a retained
collaboration selection keeps its complete settings and developer instructions. An explicit
collaboration selection leaves top-level model and effort null. Native and resident Turn parameters
carry the same execution settings and the explicit-request multi-Agent mode.

Both Main and window owners await their pending settings updates before materializing a Turn.
Optimistic admission updates the retained execution model, reasoning effort, collaboration
selection and current permission context. It does not create or overwrite next-Turn settings
or rewrite the hydration snapshot. Active execution readers use the canonical live fields.
The model-change notice compares the previous model with the collaboration model present at
admission, before applying the prepared execution selection.

A rejected ordinary start removes its matching empty optimistic Turn, including a Turn containing
only a model-change notice. Observed partial output stays visible in a failed Turn with the actual
error message. Rollback targets only an unassigned, in-progress Turn with the admitted client
message identity. A native-assigned or completed Turn, later settings updates and a newer native
runtime status survive rejection. Previous permission presence and value are restored separately
from Turn matching. Optimistic activity belongs to the canonical document; native notifications
project durable status, and accepting a response never forces a newer idle state back to active.

Personality resolves from the explicit request, defined next-Turn setting, latest assigned Turn,
then configuration for the prepared working directory. Configuration reads use critical priority;
an unavailable or unsupported configured personality falls back to the application preference.
An explicit null request or next-Turn setting suppresses that fallback. The selected personality
is shared by the native request and resident Turn. Reasoning summaries resolve
from the assigned Turn, next settings, the enabled capability override, then the explicit request;
an explicit null is preserved. Optimistic unassigned Turns cannot supply inherited settings.

Caller response metadata remains unchanged in the resident Turn, including absent versus null.
Native execution metadata additionally records the conversation's effective workspace kind.
Configuration I/O remains inside the admitted preparation's connection and ownership lifetime;
a reconnect during the read cannot dispatch the old Turn.

Main-originated user and Automation starts use the same prepared owner action. Peer dispatch
does not hold the Thread command lane while waiting for the selected owner, whose native
execution acquires that lane. Main retains durable authorization and submission presentation;
the current owner alone projects the optimistic Turn. An Automation's initial autonomous
Turn does not mark its inbox Run as user-accepted. A missing-owner response permits recovery;
a peer timeout does not authorize a duplicate start.

Public Main steering uses the same prepared owner action as window steering. Main follows the
selected window instead of writing a second optimistic row or sending a parallel native request.
The original message identity, attachments, restore context and service tier remain attached to
the preparation. Only a `no-client-found` peer failure permits owner recovery; timeouts and native
rejections propagate without another submission. The recovered owner executes the same preparation.

Preparation captures steering input without requiring Main to have a resident Turn or its native ID.
The executing owner selects the latest resident execution Turn, skips completed local markers and
display overlays, and waits for a pending Turn's native ID before dispatch. A native expected-Turn
mismatch corrects that Turn's identity and retries the same message
once. An ended-Turn error remains an inactive-steer failure; the direct command never starts a new
Turn implicitly. A terminal unknown-delivery failure preserves its pending row and submission
presentation for a later correlated server echo, and cannot reuse the admission for another send.

The retained original request and context use their JSON peer-wire values, including omission
of undefined object properties. Validation still rejects changed values and duplicate execution.
Window cleanup registrations do not determine whether an admitted Main preparation exists.
Execution rechecks manager lifetime and owner after asynchronous preparation and immediately
before dispatch. Late outcomes cannot overwrite the successor owner's canonical document.
A thread-not-found recovery retains the original submission presentation through its retry;
the enclosing caller releases that claim when the complete operation settles.

Native error information must survive IPC. Unsupported-method detection, expected-turn retry
and uncertain-delivery handling consume the actual native error code and message. An Electron
exception's generic message is insufficient. A timeout with unknown delivery keeps the
optimistic submission pending until later native evidence settles it.

Window native results arrive as host-scoped `mcp-response` messages. The invoke acknowledgement
does not carry the result. Preload registers correlation before dispatch and owns one shared
chunk receiver, so multiple subscribers do not duplicate chunk acknowledgements. Native error
code, message, data and host timing remain intact across large-response delivery.

Request delivery updates arrive independently through critical, host-scoped
`mcp-request-delivery` messages addressed to the invoking window. Local timeout reporting and
host uncertainty share one per-request notification: the first clears the local timer while
preserving the eventual response. A failed delivery settles that request once. Correlation
preserves the native request identity without coercing numeric IDs into string IDs, and manager
disposal removes its delivery subscription.

For retained mutations, preparation and admission failures before the matching physical request
is sent report `not-sent`. Ancillary Main requests cannot mark the window's mutation as sent.
Native rejection retains its response error, while a known delivery failure retains its recorded
stage. A post-dispatch validation failure cannot be reclassified as a preparation failure.

An eligible mutation that times out after native dispatch releases scheduler admission exactly
once while retaining its result and host pending count. Work that has not been dispatched expires
without being sent. A read cannot request mutation-style outcome retention. Window closure or
host replacement rejects retained callers, and late completion cannot settle a reused request ID.
Transport chunk acknowledgements do not acknowledge conversation publication or snapshot readiness.

Ordinary start, context injection and steering use critical priority and a 30-second caller
deadline. The deadline covers queueing and readiness as well as response waiting; dispatch does
not grant a fresh timeout budget. Unspecified native requests have no default timeout, except
plugin listing, whose default is 30 seconds. Main steering uses the same physical scheduler
deadline and delivery identity as other Main requests.

Main retains a sent start or steer beyond its deadline, observes its eventual response and records
the actual request identity while the outcome is unknown. Windows can also retain a context
injection response and proceed to start after that injection succeeds. Direct Main injection has
no retained response: a timeout after sending records a terminal unknown injection, fails its
optimistic Turn and prevents the subsequent start. It leaves physical admission occupied until
the native request settles. A request that expired before sending is a definite rejection.
Confirmed native rejection clears the matching unknown record and performs ordinary rollback.
Delivery stage, identity and native error details survive structured cloning and nested errors.

## Settings

Settings updates serialize per conversation while independent conversations can proceed
concurrently. An optional effort/model condition is checked when the queued operation runs.
The owner sends `thread/settings/update` before committing a local patch. A native settings
notification that replaces the settings object during that request takes precedence.

If that method is unsupported, the manager remembers the result for its own lifetime and
applies later updates locally. Other failures propagate. Partial settings remain partial;
missing effort retains the previous value, while explicit null clears it. Collaboration mode
can supply model and effort. Sandbox/profile overrides clear stale named permission state.
Hydration context is not rewritten by a partial settings patch.

An explicit active-turn reviewer update follows the thread update only when the native
capability supports it. Capability state belongs to the physical host generation.

## Interrupt

An expected-turn interrupt is conditional: a different or inactive current turn returns null
without pausing the goal, declining requests or cleaning a successor turn. Its REPL cleanup
starts after native interruption succeeds. An unconditional interrupt starts cleanup before
the native request and may retry the actual active turn ID returned by the server.

System interruption pauses an active goal before interrupting. User stop attempts that pause
with critical priority and a 500 ms deadline, then interrupts even if the pause fails and
reports the pause error with the interrupted turn ID. Descendant cleanup pauses the goal
after interruption and treats a pause failure as a warning.

Unconditional interruption launches dismissal of pending command/file approvals, permission
requests, user input, option pickers and MCP elicitations without waiting for those replies.
Descendant interruption runs from the outer operation's cleanup; user stop schedules it in
the background. An expected-turn mismatch does not trigger descendant cleanup.

Local REPL cleanup reads active execution records for the matching session and turn. It
verifies that the recorded kernel is still a descendant of the recorded REPL before killing
kernel descendants deepest first. Invalid/stale records are removed; unrelated valid records
are retained. Cleanup is bounded, cancellable and best effort. Remote hosts do not use local
process records.

Cleanup retains its admitted native connection generation through Endpoint/session acquisition
and process enumeration. A reconnect, manager disposal, native session termination or retirement
of the admitted conversation cancels pending cleanup, including the Node adapter's signal. An
owner request cannot adopt a replacement conversation or report a retired operation as successful.
Main interruption supplies its original native generation; cleanup failure remains best effort
and does not suppress the native interrupt.

Main and window interruption retain their admitted owner, conversation and native connection
through goal pausing, native responses and final cleanup. Retirement rejects late completion
without mutating or cleaning a successor. A failed REPL cleanup is a warning, not an interrupt
failure. Follower results preserve both the interrupted Turn identity and any goal-pause error.
Unlike steering and compaction, interruption may recover an unavailable owner after a timeout
or request-version mismatch as well as a missing client.

## Edit and rollback

Editing preserves the original turn's non-text inputs and context. Only its first text input
is rewritten, retaining the prefix before the last user-request marker and clearing that
text input's text elements. An edit waits for pending settings first.

The target must be the most recent user-input turn, but empty-input automatic turns may
follow it. None of the reverted suffix may be in progress. Paginated history uses
identity-based `thread/revert` when supported; legacy history uses `thread/rollback` with the
number of native turns in that suffix.

Identity-based revert deletes only reverted resident entities and advances history
generation. Retained entities are not refetched. An emptied tail receives the returned older
cursor, and the returned item cursor remains available for later native paging. Replacement
start uses the response working directory, the original input/context and an edit trigger.

## Requests and live rendering

Request identity includes host, physical generation, native occurrence, method and request ID.
A reused request ID cannot make a response capability valid for a different occurrence.
Decisions mutate the responding manager's canonical request/item state and route through the native Inbox
that owns the occurrence. Late response callbacks cannot resolve a replacement request.
Disconnect cleanup is scoped to the affected host and generation. Native responses settle only
duplicate occurrences from that same connection. User-input timeout delivery retains its source
connection through the command queue and rechecks the physical generation after acquiring the
Thread command lane, so an old countdown cannot answer a replacement request with the same ID.
Turn-completion notifications retain their originating host.

Assistant, plan and reasoning prose are frame-batched as canonical draft mutations. Terminal
item/turn events drain pending prose first. Command output uses its own bounded-time batching
schedule; lifecycle publication includes the latest locally accumulated output.

Async questions read merged resident and overlay turns. Hydrating or following an existing
question does not open it as a new live question. A newly received live item can open it;
answers, terminal outcomes and document retirement settle its local interaction state.

## History, archive and inactivity

Each actual manager owns its native history loaders. Boundary requests capture generation,
island, boundary, progress key, source and cursor. Replacing any identity during I/O retires
the result. Item pages additionally bind to the resident pagination object. A follower loads
ordinary boundary and item pages through its own native client, coalescing identical requests;
the resulting resident document stays local and cannot alter the owner's document. Complete-history
loads coalesce and publish one completed snapshot while retaining live changes made during I/O.

Prompt-rail indexing and hover previews read native pages without installing transcript
history. Navigation installs the selected history through the owner. Fetch budgets are not
resident-history byte quotas. Full native items remain intact even when an item exceeds a
preview-size budget.

Archive suppression uses a marker independent of the canonical document. Readonly archived
preview uses `thread/read`, followed by native pages when needed; it never resumes the thread
as a side effect. Replacing the archive marker or manager context invalidates an outstanding
preview.

Inactive history retention belongs to each manager. Active views, active runtime status,
unsent steers, followers and reconnecting followers prevent release. In-progress history is
kept when no interactive request explains its pause; ephemeral side conversations keep it
regardless of the request. Empty complete history without a rollout path remains loaded.
Eligible owned conversations expire after three hours; at most ten ordinary inactive owners
are retained, with oldest eligible owners released first. Failed unsubscribe retries after
15 seconds. A new keep-loaded interval resets the inactivity deadline when it ends.

Passive history release runs after thread start, runtime status changes, turn completion and
server request resolution, even when the notification leaves the canonical document unchanged.
A provisional stream role survives until its first document arrives. Explicit removal retires
that role. Releasing one inactive conversation must not retire other conversations on the same
peer. Loaders and revision waiters are cancelled with the released document's lifetime.

## Authenticated read state

Core stores unread membership by authentication identity and execution endpoint key. ChatGPT
identity uses account and user IDs; other modes use execution-storage identity. Tokens never
enter durable read-state storage.

Each manager opens an independent read-state RPC session. Initial state and buffered updates
establish its unread set. Unsubscribed sessions reject late writes; account/endpoint changes
retire the captured context. Same-account refresh preserves valid sessions. Context-bearing
peer updates apply externally without being echoed.

Accepted updates go directly to each session's observation or RPC boundary in order, without
an intermediate application event queue. Delivery backlog does not retire the authenticated
session or interrupt native conversation work. An actual identity or endpoint change still
invalidates its captured authority, including while the opening response is being delivered.

While authentication is unavailable, user and turn unread intent is retained against the
captured endpoint. Ready sessions replay compatible intent; identity retirement discards it.

## Validation

Behavioral coverage must exercise actual native ingress and actual manager streams, including
concurrent history/live writes, follower attachment, takeover, disposal, large payloads,
uncertain native delivery, request identity reuse, settings races and expected-turn interrupts.
Tests of removed ACK or projection envelopes are not evidence for the current peer protocol.

## Goals and manual compaction

Goal objectives require the owning manager and wait for pending settings before the native write.
Status changes use the native status request; reactivation waits for settings. Accepted objectives
append one params-owned goal row, while status-only changes clear the local resume confirmation.
Goal clear updates the document when its native notification arrives. Resume reads saved goals in
the background, accepting the result only if its hydration token, manager lifetime and captured
goal value remain current. An explicit resume-confirmation request waits for that read and offers
confirmation for paused, blocked or usage-limited goals.

Manual compaction waits for settings and forwards the typed compaction request to a follower's
owner. Its owner inserts a pending manual marker before the native request, removes it on failure,
and consumes the manual classification when the actual compaction starts. These counters belong
to each manager; native item lifecycle removes the placeholder. Background-terminal cleanup applies
to all resident command items locally without broadcasting a fabricated completion.

### Remote connection lifetime

SSH hosts keep a private remote app-server running independently of desktop connection lifetimes. Each desktop session reaches that server through an SSH-backed WebSocket proxy. Startup commands and proxy handshakes serialize for the same SSH destination; established connections remain independent. Reconnection first tries the existing server, and repeats bootstrap only when that attempt fails. A failed initialization resets that reuse decision. Closing a session closes its local proxy without terminating the persistent remote server.

Remote commands run through the user's login shell. Local shell environment discovery begins during connection; an unresolved SSH ProxyCommand executable waits for that discovery before connecting. Remote Codex lookup and version checks precede bootstrap. An explicit SSH port selects a direct destination so the configured override is honored.

Local hosts use the bundled full Codex CLI. With local-daemon use enabled, a compatible already-running daemon may be selected through its private Unix socket; Windows, launch overrides, explicit CLI selection, and bundled macOS Git retain a dedicated process. Failed daemon-version probes fall back to the dedicated process. Once a daemon is selected, connection errors surface through the normal session retry lifecycle rather than silently starting another server.

Connection provenance comes from the acquired transport handle. A configured daemon possibility
does not make a fallback child process a WebSocket connection. Before the first session is acquired
the physical transport is unknown; reconnect transitions retain the last acquired transport and
the Endpoint identity until a new handle is selected.
