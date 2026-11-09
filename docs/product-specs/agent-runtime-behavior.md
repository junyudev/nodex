# Agent Runtime behavior

## Session execution references

A Session may have one external execution reference identifying its runtime and root
Thread. Native Thread binding and external execution binding are mutually exclusive.
Moving a Session changes its product Project placement while retaining its runtime
and root Thread identity. The execution tree follows that placement for Project
activity and lifecycle; existing working directories remain attached.

Launching promotes an unstarted Session without changing its identity or existing
Page links. A default draft graduates from the default slot exactly as a native first
send does, so no unrequested draft appears; the next New Chat ensures a fresh one. A
fresh programmatic Session can be created by the same operation.
The transaction admits the execution reference, stable launch request identity and
requested Page Linked chats. The operation checks current
Project lifecycle, resource existence and captured execution identity. Repeating the
same stable command returns the original Session without launching duplicate work.

Core admits the Session before any execution or workspace effect exists, so a Session
Core refuses never gains a Thread or worktree, and invalid Agent configuration is refused
before either. The binding names a deterministic root Thread that each later step creates
idempotently. A checkout or projectless workspace is ready immediately. A new managed
worktree is prepared after the first message is durable: its Run waits as preparing,
shows worktree progress in the transcript and starts once the Thread records the new
location. A failed preparation leaves the Run failed with Retry, which prepares the
worktree again, and Work locally, which starts the Run in the source checkout. A
preparation interrupted by an application restart fails with that reason; Retry then
creates the worktree from the source checkout's current branch.

A chat a person starts is titled once from its opening prompt, at the lightest effort of the
model Settings → General names in **Title chats with**. Until one is chosen, a light model on the
chat's own Agent titles it, so the prompt goes nowhere new: GPT-6 Luna on Codex and Haiku or else
Sonnet on Claude Code. The chat's own model titles it when that light model is off or absent, on
other Agents, whose catalogs reach many vendors, and on Nodex credit, which only spends on a model the
person chose. Choosing a model sends each opening prompt to it, and lets it title chats whose own
Agent cannot generate text. A chosen model that cannot run is never replaced: Settings marks it `Off`
or `Unavailable` and those chats keep their provisional titles. Explicit remote native Codex chats keep
the title of their opening prompt. The generated title replaces only
the provisional title it was derived from, so a rename that lands first always wins; chats an
Agent starts keep the title it chose. Forks follow the same order and retain their source Session's title as
"Fork of …". A worktree fork that stopped before recording its new location completes
that move when retried; a same-directory fork never claims its source's managed worktree.

Page links and sidebar placement refer to Session identity. They do not own its Thread
history, title, model selection, queue, Run status or delegated tasks. Delegated Threads
remain within the bound root's lineage and do not implicitly create ordinary sidebar
Sessions.

## Imported Codex chats

Importing an existing Codex conversation creates a separate Runtime root and product Session.
Core admits its immutable execution binding before Runtime import effects. The Runtime owns the
copied visible transcript and all subsequent Runs; the original native conversation never becomes
the destination's execution identity. Imported history is historical content, not previously
executed Runtime Runs or pending work. The destination's next message continues through an
independent native conversation with the ordinary portable context handoff. The handoff remains
bounded, and omitted history stays available through Runtime history reads. Native hidden state,
live tools, queues, approvals and goals are not adopted or replayed.

Imported user images, local images in assistant Markdown, image-view files, generated images
and tool media use independent Runtime-owned attachments when their bytes are available. Inline
generated image bytes remain usable after the source's saved image file disappears. Imported audio
is retained as a file attachment. Opaque provider file identities and remote-only URLs without a
producer byte export report `resource_unavailable`; the original Native conversation stays intact
and does not change execution owner. Missing original image files remain explicit
unavailable-image records rather than readable attachments. They preserve the historical message
or activity, remain visible in history reads, and tell the continuing Agent that those image bytes
could not be recovered. A missing image does not block the rest of the import or resolve later
through the original source path.

Import source reads and history publication are bounded. A failed or interrupted capture cannot
silently become a complete import or an empty new conversation. Stable import requests retain
their source and destination across retries, including uncertain Core replies. A completed copy
has no dependency on the source's native history, ancestry or lifecycle: deleting the original
does not remove its Runtime transcript or prevent the next Run. The complete behavior and chooser
contract live in [Native Conversation Connection Behavior](native-conversation-connection-behavior.md).

## Machine admission and queue

Settings → Agents → **Automatic work at once** limits unattended new work across this
machine, from 1 to 16, initially 4. Saving applies to the running Runtime and future
launches. Lowering the limit lets existing work finish; nothing preempts an episode.
Your chats and the tasks they delegate never wait for capacity.

The unit is a work tree: a root Thread and all its delegated descendants, identified by
`lineage.rootThreadId`. Each activation has a trusted origin, never inferred from its words:

- Person: person-authored messages, person answers and explicit person queue actions.
- Continuation: all activations on delegated Threads; completion and question wakes;
  notifications; restart, recovery and retry attempts; Agent answers, steering, and
  follow-ups to delegated children.
- Automatic start: other root-Thread activations, including Host-launched Page work,
  Start automatically and `start_work`, scheduled and event-triggered Automations,
  Agent-created Sessions and messages or forks into another root, and Host input to
  the Profile Coordinator.

Only an automatic start into an idle tree waits for capacity. Person activations and
continuations proceed immediately, while execution holds and Pause still gate all work.
When a person activates a tree with a waiting automatic start, it becomes a person
episode. Its waiting start proceeds in the Thread's normal queue order without capacity.

An episode begins when an idle tree becomes active and retains its initiating class.
A continuation reactivating an idle tree inherits that tree's previous episode class.
Only automatic episodes count toward capacity. Delegated tasks share their root's
episode, so answers, child starts, recovery and completion delivery cannot deadlock
behind a capacity wait. Blocking task tools wait directly for their result; they do not
release or reacquire capacity and a Session-only `task_wait` does not need `parentRunId`.

A tree becomes quiescent only when it has no non-terminal Run, live native provider turn,
or pending start effect. Native background work keeps its episode active after the
foreground Run ends. A terminal shell left behind by a finished turn does not itself
keep an episode active. A fully retired Pause releases capacity while preserving its
queued recovery intent. Restart reconciles durable episodes, waiting starts, Run
projections, native-turn evidence and pending effects before execution resumes.

Waiting automatic starts are FIFO. A ready start enters when the number of active
automatic episodes is below the limit. No capacity wait occupies an effect worker,
managed-worktree preparation or native-start resource.

Session read details publish waiting automatic starts as `{runId, position, waitingSince}`.
Position is 1-based FIFO among waiting automatic starts on this machine and changes as
work starts or is cancelled. Main's managed-chat observation carries the same queue facts
for Page Turns. The Page Turn and chat header show `Queued · 2nd` and refresh rank even
without new events in that chat. Internal wakes stay outside the editable Composer outbox.

## Pause and Stop

Pause is a resumable execution fence backed by Core's person-owned Page, Project and
Space holds. Runtime persists the affected root Thread fence before it retires native
execution, including delegated descendants. The fence denies tool authority immediately
and gates provider starts, retries, queued input, answers and internal wakes. Core policy
is loaded before startup recovery activates execution.

Pause returns `requested` until every native retirement is acknowledged, then `stopped`.
A shared provider process retains unrelated Threads. Capacity is released through normal
admission reconciliation only after native execution is stopped. An unfinished reply
retains its Run with a queued continuation attempt; pending input and delegated completion
cohorts remain intact. A scheduled recovery keeps its intent and cannot run while held.
Resume removes the Runtime fence only after retirement and returns queued work to normal
Thread ordering as a continuation. A reply can be paused and resumed repeatedly;
retries of the same attempt remain idempotent.
Independent Stop queue holds remain in effect.

Stop interrupts the conversation and delegated work, holds its queue for an explicit
queue action, and disposes pending delegated completion wakes. It does not create or
clear a Core hold. Resume is therefore not an undo of Stop.

## Request recovery and continuation

A reply's outcome comes only from its Agent. When Nodex itself loses track of a reply,
for example because a local read failed while recording the Agent's output or because
its event stream broke, that is not a failed reply. Nodex retries recording the same
output in order, and otherwise reattaches to the Agent and reconciles the exact native
turn: a turn that is still running stays observed however long it has been quiet, and a
turn that already ended settles the reply with the Agent's own outcome, including the
output Nodex missed. Only when the Agent cannot be reached at all does Nodex stop the
native turn and report that it lost contact with the reply. A failure that originates in
Nodex says what happened instead of a generic provider error, and keeps a short redacted
diagnostic for Copy diagnostics.

Every running reply is backed either by a live native turn or by a scheduled recovery.
Nodex checks this periodically and whenever an Agent process or connection is lost: a
reply nobody is observing is reattached and reconciled, and a reply whose Agent never
confirmed a turn within two minutes is resolved instead of staying "running". A native
turn left running after its reply ended is stopped. If a message is accepted into a
native turn whose reply had already ended, the new reply adopts that turn; a turn that
belongs to a live reply is never silently reassigned.

Several chats can share one Agent process, so Nodex ends that process only when it has
exited, when its connection can no longer carry messages, or on an explicit lifecycle
action such as shutdown, idle release or a sign-in change. A problem in Nodex's own
handling of one chat's output, such as falling behind a burst of events, a message too
large to keep or a failed write, makes only that chat's reply reattach and reconcile; it
never stops the process serving the others. When a shared process does stop, every reply
it served recovers on its own as described below, and each failure keeps the reason the
process ended for Copy diagnostics. How much an Agent streams is never a failure by itself:
Nodex keeps only the streamed output it reads and limits what it holds by size, so a long
tool call cannot end a reply however many fragments it arrives in.

Agents retry their own requests first. Nodex shows their reported cause, attempt, limit
and next attempt time in the shared
[request recovery states](codex-thread-transcript-behavior.md). Codex keeps a turn alive
through a network outage and says it is waiting for the network. A retry record is
historical evidence after its item completes, fails or stops; it does not keep an ended
request retrying. Unknown provider errors do not establish a network failure, and
retryability alone does not establish an active retry. A retry's message describes the
failed attempt in a sentence, such as "Claude API request failed."; its HTTP status
travels with the failure instead of being repeated in the message.

When an Agent gives up on a reply for a transient reason, Nodex recovers it
automatically inside the same reply. The failed attempt stays in the transcript as a
recovery row, the reply stays running, and after a delay Nodex continues the same native
conversation from where it stopped, without resending the original request; a request
the Agent never received is sent again unchanged, and a delivery Nodex cannot confirm is
never retried automatically. A reply woken by finished background work recovers the same
way: the turn it took over has ended, so the Agent is told to continue rather than the
reply ending as if it had finished. Lost connections, including gateway errors from a proxy
while offline, retry after 5, 10, 20 and 40 seconds and then every minute, every five
minutes after the first hour, for as long as it takes. A busy or overloaded service,
including a model at capacity, retries after 10 and 30 seconds and then 2, 5, 10, 15 and
30 minutes, outlasting an hour-long incident. A request rate limit waits for the reset
time the Agent reports, up to an hour, or retries after 1, 5, 15 and 30 minutes. An Agent
process that stopped mid-reply, or whose event stream closed, resumes after 5 seconds,
30 seconds, 2 minutes and 10 minutes. Sign-in, usage limits, context allowance, policy
refusals, invalid requests, configured turn or budget limits and a conversation the Agent
cannot reopen never retry automatically. Each recovery streak has its own budget and ends
when the Agent produces output again; a reply that runs out of budget fails with the last
cause. A failure no evidence explains ends the reply at once with its cause instead of
retrying blindly, so the user or the delegating Agent decides what to do next. One
classification of each failure's cause decides whether it retries and how the
transcript, task cards and `task_status` name it. The schedule survives restarting Nodex.

Stop ends a recovering reply immediately. A new message, a steer or a change of model or
Agent while a reply is recovering starts the next attempt at once with that input,
replacing the scheduled continuation. Archiving or deleting the chat ends recovery. A
delegated task that is recovering stays running for its delegating Agent: its card and
`task_status` say it is retrying, and the delegating Agent is woken only once the task
finally succeeds or fails. That ending always reaches the delegating Agent: Nodex settles
the task and offers its wake as soon as the task's reply ends, retries the handoff when a
local read or write fails, and rechecks unsettled tasks every minute and whenever an Agent
process stops, so a missed handoff is repaired while Nodex keeps running rather than at
the next launch.

Continue on the latest failed reply submits a new follow-up asking the Agent to
continue from where it left off, with the existing conversation context. It does not
rewind history or replay the original request. Only the current conversation owner
can admit it: the selected Run must still be the latest failed Run, with no active
or queued work and no pending information request. These conditions are checked
again after message preparation, before submission. A changed Session, Thread or
content source rejects the stale action. Repeated activation shares the pending
submission until its acceptance is observed, including across view reconstruction;
a preparation failure releases it for another attempt. Transport failures offer Retry and
preserve the native conversation identity, including after unloading or restarting the
provider process; a transport exit alone does not replace native history.

A context allowance refusal has the typed cause `context_budget_exhausted`, with
native occupancy, capacity, input cost, required allowance, reserved headroom and
supported recovery operations. Bounded history delivery reserves 16,000 tokens of
headroom independently of the larger future-work target. The target cannot deny a
small recovery envelope merely because a conversation exceeds 75% occupancy; the
current request is never truncated.

Compact and retry addresses the exact failed Run in its Session. One durable command
admits native compaction in that same conversation before delivering pending inline
history. Only successful compaction with a completed boundary and refreshed context
usage from the same maintenance attempt and native conversation can admit one retry
containing the retained request, attachments and context.
Failed or unconfirmed compaction never sends that request. Duplicate invocations reuse
the admission receipt, and a newer Run or changed native conversation fences stale
recovery. A completed maintenance boundary can resume its pending retry after Runtime
restart. Recovery retains prior Runs and transcript history; editing and branching
remain separate operations.

## Profile access and execution identity

Every Agent has full read and write access to the current Profile's Projects, Pages
and Library. Parent Agents, delegated children and background work use the same model
and may operate across Projects and Sessions. Plan changes planning interaction and
permits content writes. Native execution follows the Session's permission mode, and native
permission requests wait for the person as specified in
[Agent Permissions and Approvals](agent-permissions-behavior.md). Blocking information questions and optional message-capable questions remain open until answered or explicitly settled. Native nonblocking synchronous questions follow the host's inactivity and snooze policy.
Standard ACP information questions belong to the live Session, with Run left null;
they can arrive after foreground completion or while another Run executes.

A Claude Code chat can keep its shell working directory across calls within any of
the Session's current Project Sources. Before each prompted Turn, Nodex reads those
Sources from Core and confirms them on the running Claude Code process. Adding or
removing Sources, or moving the Session to another Project, takes effect before its
next prompt while background agents, shells and workflows keep running. A prompt is
not submitted until that synchronization succeeds. The Session's execution directory
or managed worktree and its attachments remain available independently of Project
Source membership. These directories govern shell working-directory persistence and form
the workspace boundary of narrower permission modes.

Host preparation creates and binds the product Session before its first Run executes. Every
application call carries exact runtime, Thread, native incarnation and connection
identity. Providers supplying causal tool metadata also carry the captured Run and
attempt. Standard ACP calls carry their real Session with Run and attempt left null. Model-authored metadata cannot mint that identity. A captured
request keeps its original Run when another Run starts, including after foreground
completion while its native process remains live. Cancelled or retired execution fails
instead of borrowing replacement credentials. Cancelling source-less native execution
retires its connection and credential before another prompt is admitted.

Stateless native MCP calls bind to the registered native call and its physical
incarnation. An explicit HTTP MCP session ID must identify that same live incarnation;
an unknown or retired ID cannot fall back to native call metadata.
MCP initialization may bind the credential's sole registered incarnation before the
first Run is prepared. It never assigns a Run or resolves an ambiguous connection.

Provider utility processes for titles, commit messages and change-request guides run read-only
with no approval prompts: Codex uses a read-only sandbox and Claude Code allows only reading and
searching tools. Their task prompts and output schemas remain specific to their purpose;
investigation can read the workspace but cannot change it or reach the network.
OpenCode utility requests run in temporary sessions that refuse every tool and answer in the JSON
their prompt asks for. They still load OpenCode's own configuration and project instructions, stop
at the caller's time limit, and are removed once they settle, so they never join OpenCode's history.

Ephemeral structured generations follow the requesting client's lifetime. Cancelling a pending
request interrupts its native utility process and releases temporary resources without stopping
the Runtime or other requests. Durable commands keep their receipt and recovery semantics when
their caller disconnects.

Native event intake bounds retained messages and UTF-8 bytes before decoding or
normalizing provider payloads. Overflow fails the affected physical source and
retires its credentials while other providers continue. Outgoing image-capable
frames retain their larger input budget. Continuation notifications use a shared
512-message, 8 MiB mailbox with nonblocking admission; overload preserves already
accepted notifications and returns an explicit failure. Durable pending deliveries
remain in SQL for restart recovery rather than spawning unbounded retry waiters.

Connection closure invalidates only its own calls. After a restart, new calls are proven
against the new process while old calls remain invalid. Profile/Store identity, resource existence and lifecycle, transaction
integrity and exact execution routing apply to every operation. Project membership,
working directories and list filters organize content and execution.

## Runtime settings

External edits to Runtime settings apply through symbolic links, including atomic file
replacement, a repointed link, or creation of a dangling link's destination. Runtime
readiness includes attachment of the settings and destination directory watchers. When
a link changes, settings reload after the new destination watcher is attached so edits
made during attachment are included without requiring another save.
Native change notifications are hints: the Runtime also compares the settings
document every 500 ms and reloads changed contents after the 100 ms save debounce.
Unchanged contents do not generate periodic settings-change notifications.

## Conversation interface

Page Chat and Workbench use one Session interface for Agent launch, follow-up messages,
steering, selected-Run stop, information answers, model selection and planning.
App-supplied data — interactive response changes or an app's model context — travels beside
the user's words as a context record rather than inside them. A message's text is only what the
user wrote, so the transcript, queue, editing, Session search and Session reads never see
machine syntax; the Agent receives each record as data in a `<nodex_context>` block after those
words, marked untrusted. A message may carry records and no words. A slash command with a record
attached is an ordinary prompt rather than a native command.
Editing a queued message rewrites only those words: the record it carried stays with it.
State the user leaves in a chat's interactive responses travels the same way, with their next
message that starts a Run and once per change; a steer, a queued message or a message that
already carries app data leaves it for later, and a response's private content never travels.
The Composer can send [Page references](composer-page-references-behavior.md) for Pages visible beside the chat and insert Library-wide Page links with `@`, without creating Linked chat relationships.
Page editor submissions use that same interface. New submissions promote the chosen
Session with its Page links, model options and workspace configuration; existing
sections resolve a bound Session before sending. Connected read-only native history does not
acquire an execution owner when a section is sent.
Every command resolves the Session's immutable root before accessing an engine Thread;
explicit targets resolve their own Session and Thread identity. Responses carry the exact pending request
and its original Run, or null when the source is a native Session. A stale card cannot
answer a newer request. Session-origin Dismiss answers that request without stopping
an unrelated foreground Run. Runtime questions use this Session interface. Optional replies carry a stable submission identity for each answer batch; retries replay that batch receipt, while later answers and revisions use another identity. Controls address the exact original request and Run without hydrating transcript bodies, including after the request is completed. Native nonblocking synchronous questions share the host-owned inactivity and snooze controls; blocking and optional message-capable questions do not auto-resolve.

Launch returns execution identity without transcript bodies. Controls acquire only
execution metadata and observe control events. Activating a transcript reader opens
one bounded history page and publishes canonical items into the keyed
transcript cache. Text changes notify only the affected item. Scrolling near an unloaded
history boundary automatically requests older pages through the current conversation
owner. Requests are serialized and reconsider viewport demand after each page; short or
hidden pages may continue until the gap moves out of reach or history is exhausted.
Older pages preserve resident items and the visible reading anchor, including when a page
adds earlier messages inside an already visible Turn. Page failures expose a retry at that gap while the loaded transcript and Composer remain usable. Missing or
repeated continuation cursors fail the page instead of looping. A transcript reader holds a bounded
window: past 1,000 resident items, the oldest settled history returns to 500, while a Run streams and
while nobody views the chat, under the viewport rules of the
[transcript contract](codex-thread-transcript-behavior.md). Anything the Runtime still reports as live
keeps its place. Released history continues from the first resident item it precedes and reads back in
order as the reader scrolls toward it or chooses **Show earlier work**; a later update to it waits for
that read rather than rejoining the tail. Older history a reader just asked for, including a jump's
target, stays resident for two seconds so they can reach it. Releasing the last transcript reader clears body caches; retained
controls continue observing metadata until their last reader releases. Captured fork ancestry identifies the source of inherited history.

File changes record every file a tool changed, whichever Agent made them: its operation
(create, edit, delete or move), its diff and the line counts measured from the complete diff.
Diffs travel with the transcript, so patch rows, their expanded diffs and Review need no
further read. A diff past the transport budget is withheld whole; its row keeps the measured
counts and says the change is too large to preview. A failed edit keeps the Agent's error in
place of a diff. A file whose counts were never measured shows no counts rather than `+0 -0`.

Prompt navigation indexes each of the chat's own Runs with bounded previews of its opening
prompt and latest reply, read without loading their history; the index lists the newest 1,000
Runs. Every loaded Turn of the chat's own Runs keeps that Run's identity, including Turns whose
Run records the bounded snapshot omitted. Selecting an unloaded Run loads older pages through its
opening message, then scrolls to it. Rewinding to an earlier message replaces the loaded history
topology, so the index reloads without the withdrawn Runs. Inherited fork history and imported
native history have no Run of this chat; their prompts join the rail as their pages load.

Read-only history loading, retry and child observations use the conversation's
current owner, including for archived chats and provider-spawned subagents. Viewport
pagination uses that same owner and validates its current history boundary; a released
reader cannot publish a late page into a replacement reader. The
Agent kind selects presentation, not the history store. Runtime Thread identities
stay inside the bound Session's Runtime reads; opening their history never requires
a native Thread registration or acquires an execution writer.

Side chats capture the source conversation when opened, including the portion of an
active reply already received. Later source messages, streaming updates and context changes
do not enter that capture. They inherit the source Agent, model options, interaction mode
and working directory, with independent execution and a transcript containing only their
own messages. An exact native fork retains provider context when available; other Agents,
provider changes and unavailable native forks receive the frozen portable Context Handoff.
A source context clear bounds what is captured, and clearing the side chat retires its capture.

Inherited instructions, plans, requests, approvals and tool activity are reference material.
Only new side-chat requests define its task. Exploration is lightweight and non-mutating;
changes require an explicit new request, and side chats do not use subagents.
Side-chat commands retain these constraints. When an Agent's native command path cannot
carry them, Nodex sends the command as an ordinary guarded request.

Selected text appends to the side composer without replacing prose or sending. An explicit
side-chat prompt sends immediately in the captured conversation. Opening and retrying never
starts the source task; retries retain the same child identity and context capture. Side
Sessions are persistent children of their source and stay out of ordinary chat catalogs.
Closing a tab only removes its placement; it does not confirm, stop or discard the side chat.
Quitting and restarting retain its Session, frozen capture, transcript and provider history.
Opening it again reads the existing binding, and a new Turn resumes its persistent provider
thread or uses the captured portable context when native recovery is unavailable.

Deleting a side chat retires its execution and deletes its own side chats.
The Agent Runtime owner commits ordinary Session deletion and cleans up native history where
the Agent supports deletion. Deleting its source also deletes attached
side chats; archiving the source keeps them attached. Existing side-chat bindings recover as
attached children after restart. Execution-root restore reconciliation excludes side chats
so it never adopts them as ordinary catalog Sessions. If a binding’s captured Runtime Thread
is missing, the side chat is unavailable; it is never recreated as an empty ordinary chat.

Native remote side chats attached directly to remote Codex conversations remain temporary.
Closing one discards it, with confirmation when it has messages and a saved Don’t ask again
choice. This lifetime does not apply to Agent Runtime side chats.

The first own turn can name a side Session when its request comes from the person,
without generating a title through an Agent or waiting for the reply. Inherited history and
requests still in the queue do not count as sent turns. A nonempty plain-text label replaces
only the default fallback title; an empty opening request, refused sends and later turns
leave it intact. Admission receipts expose the full `sideChatTitle` for the owning tab, while
durable Session metadata retains a prefix within ordinary title limits.

Connected local native conversations use the same captured side-chat route while their
history stays passive. Runtime forks retain the selected source Run and prepare
the chosen workspace and environment for the new Session; they do not
resume a connected read-only native conversation or hydrate history to choose a workspace.
Native forks use the source Run's captured native incarnation. If its provider binding
has since changed, the fork carries the bounded source prefix through portable history.

Started Runtime chats offer Fork from both the sidebar context menu and the header's
Chat actions menu, including Claude Code and OpenCode. Both menus use the same Session
fork command. Fork chat keeps the current directory; a managed worktree labels it
Fork chat in same worktree. Fork chat in new worktree appears only when the local
execution directory has a Git repository. A normal fork does not require Git.
The composer also offers `/fork`. These chat-level actions ask the Runtime for the
latest forkable Run, independently of which transcript page is loaded; the reply's
Fork chat from here action instead retains its explicit historical Run boundary.
The Runtime selects the newest completed, waiting, failed, interrupted or cancelled
Run, skipping active, queued and rolled-back Runs without requiring a file checkpoint.
The Host resolves that source before creating a destination Session and refuses a
chat with no eligible source without leaving an empty destination behind.
Claude forks and native subagent history lookups use the selected Agent instance's
history directory. Restored Profile history takes precedence when present, and
standalone history operations never change the process-wide account environment.

Slash command catalogs contain only actions with working handlers or content panels.
Slash commands expose supported Nodex actions across Agents rather than filtering
them by Agent name. Fork, Merge back, Clear context, Side, Compact, Project and other shared actions
appear when their owning callbacks and conversation state permit them. Agent-native
commands supplement those actions without replacing an available Nodex action with
the same name. Status and MCP use the selected Agent's inspector; Codex-specific
controls remain scoped to their actual capabilities. Side opens a temporary
chat with the current conversation captured as reference context.

A fork can bring its work back into the chat it was forked from with Merge back (`/merge`)
or `merge_session_back`. The fork's newest finished Run is merged: a reply still working in
the fork holds the merge, and the source chat must not be running a reply. Merging starts
nothing and opens the source chat; its next message carries only the fork's local work
through that Run as a context handoff, on whichever Agent that message uses, and the transcript
marks it as a merged fork. Merging again before that message replaces the earlier merge.

Workbench presentation is captured before asynchronous submission work. Main binds
the ticket to the exact engine Thread and stable client message, then attaches it to
the Run only through causal provider evidence. A later foreground Run does not change
an earlier background call's origin. Queued edits replace the origin only after the
accepted edit receipt and a point read proving that its exact Run is still unstarted;
retries retain that edit's origin. Same-Run steering retains the captured Run origin.
Actual native-source or runtime connection retirement releases these bounded anchors.
Workbench tools resolve this origin with the verified engine Thread and Run, independently
of Core's execution lease coordinates. Session-only calls have no Run anchor.

Effect cleanup releases subscriptions and bodies immediately; a render-held lease can
be retained again without reviving old callbacks. Concurrent readers of the same
Session and Thread share one read owner.

The Composer queue is the user's outbox: messages a person sent, or another conversation,
schedule or question answer sent on their behalf. Runtime deliveries addressed to the Agent —
delegated-task completion wakes, background notifications and automatic continuations — never
appear in the queue, its previews or counts, and do not make a conversation read as queued.
They run ahead of or among queued messages in delivery order and appear in the transcript when
delivered. Nobody can edit, remove, reorder or steer them; Stop keeps pending delegated-task
completion wakes from continuing the conversation.

Queue observation reads at most 25 user-message metadata rows per page with canonical Run and
message identities. An open queue hydrates bounded previews only for its visible page; editing
explicitly reads that message. Collapsed queues and controls do not load prompts. A held queue
remains paused until an explicit queue command resumes it. Sending a queued message while the
chat is idle resumes the queue from that message; the others follow in their order.

The initial window admits at most five user Turns and 500 distinct items. Its complete
public envelope, including metadata, stays within 1 MiB. Root windows retain visible
entities and a bounded set of live control dependencies; an admitted Run never implies
reading all of its tasks. Task prompts, results, workflow bodies and delivery records
stay out of public metadata snapshots and events. Child history and explicit item
details provide those bodies. Long text appears as a bounded preview with a truncation
marker; full copy and export use explicit full-item reads. A control envelope that
cannot fit fails explicitly rather than exceeding the transport budget. History keeps at most
256 KiB of one command's output: its start and its end, with a marker where the middle was cut.
A window open long enough to fall behind the retained event tail reloads its conversation.

Agent Session and Task reads share one independent metadata-only timeline window and canonical
text or JSON slices, rather than the renderer's bounded initial window. Each content slice
carries its exact source identity, offset, total length and content version; item changes
invalidate a continuation. Message extraction is shared with delegated-task history. Latest
reply and activity queries use the same indexed visibility rules without loading whole Runs.
The Runtime also owns a rebuildable root-conversation catalog with message recency and a
bounded first-user prompt preview, and a rebuildable full-message search index. They are
queried through bounded owner windows; Core stores
Session membership and placement, without retaining a second copy of Runtime conversation facts.
File-backed WAL databases route read-only queries and complete read transactions through
a scoped SQLite worker connection. Existing write transactions retain their writer;
in-memory databases and unavailable readers use the writer path. Reader failure cannot
silently move an in-progress transaction to a replacement connection.

Compaction admits one durable maintenance Run per request; compaction items recorded in
that Run are manual, and every other compaction is automatic. Editing is offered only
on sent user messages whose immediately preceding visible conversation Run has a recorded
root checkpoint and a Provider Turn; the first local Run targets the conversation start.
Cancelled queue or delivery records that never entered the conversation do not count as
predecessors. Failed Runs do not record checkpoints, so the message immediately after a
failed Run cannot be edited. A rewind never reaches further back to an older recorded
point. Editing a sent user message is one operation: it prepares the replacement, which
compiles it and persists its images, then admits a conversation rewind to just before that
message's Run and waits for that exact Run to become rolled back before dispatching the
replacement; every later Run leaves the conversation with it. The replacement carries exactly
the images the edit names, reading only those from the original message, and keeps its app
context. Because preparation comes first, a message the Agent cannot accept or an image that
cannot be read discards nothing. Document Agent config is resolved during this preflight so
image admission uses the effective model before history changes. Queued or active
work and native background tasks block editing.
Only Providers that explicitly advertise native rollback to an earlier Turn offer
editing, including Codex, Claude and both native OpenCode versions. Resetting an ACP
session alone does not grant historical message editing. The capability belongs to
the Agent whose conversation is being rewound; the replacement message can select
another Agent.
Conversation rewind leaves workspace files intact and can proceed without a Git file
checkpoint. Its boundary belongs to the whole chat, including Runs from other Agents.
The active Agent retains its own native history only through that boundary; any remaining
retained context is delivered before the replacement message. Other native conversations
that have seen discarded Runs, directly or through a context handoff, are permanently
retired. Selecting those Agents again creates a conversation from retained history.
A fresh conversation in a fork also inherits the source history captured at every fork
boundary, even when no local Run survives. Messages withdrawn before the fork stay out;
withdrawing source messages after the fork does not remove that captured context. The
visible timeline and Agent context use the same captured history. Delivery and history
budgets apply to the combined conversation.
A failed rewind leaves the chat history intact; retrying or restarting never revives a
retired conversation or removes additional retained messages. Context delivery proofs for
rewound Runs leave with them, so retained context is delivered again when needed.
Repeated commands retain their original Run and message identity; reusing an identity
for another target fails.
Active proposed plans can be implemented in another Project. Recording a created
Session also works across Projects; the source plan, parent Run and target Session
retain their exact product identities and content owners.

Message delivery intent resolves inside the serialized command writer, after its
durable receipt lookup. An accepted steer or restart therefore replays after the
Run completes. Application messages bind their original request fingerprint before
dispatch. An authorized retry recovers the original message, Run and delivery before
reading mutable model settings or attachment sources; changed arguments cannot reuse
that identity. Run status is read from that exact Run, rather than copied into another
receipt. A steer the Provider refuses while its Turn keeps running waits as the
next message instead of being lost; Codex steering that names a continued Turn is retried
once against it. A draft's first message retains its prepared model, mode, context and
owned attachment bytes before Core binds the Session; execution still starts only after
Core admission. An interrupted launch resumes that retained intent under the current
caller's permission ceiling. Receipt queries never create a missing Thread from defaults,
and acceptance atomically releases the duplicate pending message context.
Ordinary intake reads addressed control heads and input identities;
historical prompts and tool bodies stay out of planning. Provider handoff, captured
ancestry and queue promotion select the required control identities before reading
history. Portable history admits intact items within its database read and delivery
budgets, prioritizing the latest request, partial answer and original constraints.
Oversized items remain available through explicit history reads. Coverage records the
complete source range and exact omitted count; omitted item IDs appear only when
the list is complete and bounded. Native context estimates and delivery proofs use
stored scalars rather than loading the old transcript.
An existing user-input item resolves through its message identity and follows
that message into its queued Run, including when a Provider assigned the item ID.

Images are materialized from explicit attachments, then persisted by the runtime under
the admitted Thread and message before dispatch. Inline media transfers through temporary
Host-owned files scoped to each send; completion, failure and interruption release those
sources. Retained draft intent references independent Runtime-owned copies. The existing
image and message byte limits apply. Image URLs resolve on demand from that
exact visible item and attachment identity. Each user message owns its attachments in the
transcript, including steering, queue promotion and image-only input. Collapsing Agent
activity keeps those complete messages visible, and reopening history preserves their
image previews. Forked history resolves through its captured source Run prefix; later source
items are excluded. Resolution returns only the owned path, and conversation metadata never
hydrates image bytes. When an Agent reads a picture file, views a picture or generates one,
that picture becomes the step's own attachment as the step completes, so every Device shows
what the Agent saw or made from the transcript rather than from the file's path. A step whose
file is already gone names the picture as unavailable instead. Workspace creation and
environment setup use the same scoped filesystem owner as other native capabilities. The workspace
is retained when remote creation may have committed without acknowledgement, and its
managed-worktree ownership is attached only after the durable execution is verified.

## Model choices

Effort and speed are written under each model's own option names: Codex reasoning effort
and service tier, Claude effort with its thinking, speed, Ultracode and context choices.
Every model choice uses one menu: the models, then effort as one track of the model's
levels, with Fast and Ultracode as icon toggles beside it whose tooltips say what each does.
A Claude model that can turn thinking off shows Off below its lowest level, and an effort
the user never chose rests on the model default, marked Default. The model button shows the
Fast and Ultracode icons while they are on, and `/fast` and `/ultracode` toggle them from the
composer.

Effort and mode choices appear immediately and stay interactive while a change is pending.
Consecutive choices apply in order, including a return to the previous choice while an earlier
change finishes.

Ultracode is Claude Code's workflow orchestration for the session. It runs at the chosen
effort, is offered only for models that support it, and never applies to titles or other
generated text. When dynamic workflows are off for the Claude account, the toggle stays
visible but disabled with that reason and no request is sent; if Claude Code still runs a
chat without Ultracode, the chat says so.

A Claude chat changes model, effort, Fast and Ultracode on its running Claude Code process
before the next message, so background agents, shells and workflows keep running. An
unconfirmed change prevents that message from being sent. The next attempt confirms the
entire model, effort and speed choice again before sending, including when returning to
the previous choice. Only turning thinking on or off starts a new process, which waits
until background work ends or the user stops it.

Message text reaches Claude unchanged. Claude chats highlight the words Claude Code reacts to
in a message, `ultrathink` and `ultracode`, and explain on hover what each does for that turn.

A model,
effort and speed change from the composer is one choice, so concurrent choices never
overwrite each other, and options a newly chosen model does not offer fall back to its
defaults. Goal mode is not offered for Runtime chats.

New chat remembers its own model. A new chat starts on the last choice made in the composer
of any unstarted chat, on any Agent, with that choice's effort and other options, in every
Project and window and across restart. Each Space remembers its own: a team Space's hosts offer
their own Agents and models, so a choice made in one of its windows is remembered for that
Space and Member only, and the personal Space keeps the choice it had. A choice made in a
started chat stays with that chat.
An unstarted chat keeps what was chosen in it, whatever is chosen elsewhere later. Native
Codex's speed always comes from the global Fast preference, which only Settings and an
unstarted chat's choice change.

Only another choice replaces the memory. Until the Agent catalog answers, the composer shows
the remembered choice as it is. A remembered model switched off in Settings → Models stays
selected and the composer says so. Otherwise, if its Agent no longer offers the model, the
chat starts on that Agent's default model; if the Agent cannot take messages, it starts on
Codex's default and then another available Agent's. Later new chats return to the remembered
choice once it can run again. With no memory, a new chat starts on Codex's default.

Each Thread retains its own speed, including a pending choice for its next message,
when another chat changes speed or starts concurrently. Returning to a chat restores
that choice across windows and restart. An explicit Standard tier takes precedence
over saved preferences and native model defaults; only an unspecified tier inherits.

Page and Scheduled actions that start a chat use its saved draft Agent, model, options
and interaction mode, scoped to that Session and Project. Without a draft choice they
start the way a new chat does, except that a remembered Nodex credit model never starts a
chat no composer shows; those fall back without spending credit.
An explicitly chosen unavailable Agent or model fails with a request to choose again;
it never silently redirects the message to another Agent.

Image input follows the selected model's reported input modalities. Native model
catalogs and ACP's negotiated prompt capability supply that knowledge. Missing
knowledge remains unknown, distinct from an explicit text-only model; neither admits
image input. The composer explains the difference when an image is added or sent,
and a refreshed catalog or a later handshake can enable or withdraw support without
losing model options. A pending model change checks the model that will receive the
next message. Text messages remain available while image capability is unknown.
Explicit Runtime controls override native presentation defaults.

Queue editing checks the queued Run's captured model rather than a later composer
choice. Its bounded control read includes that exact Run's metadata without loading
conversation bodies. The Host resolves document Agent config before checking image
support, so a document's model override is validated against the model that will
receive it. Launches, follow-ups and queue edits pass this check before image
materialization or message admission, including programmatic Page submissions.

In a started chat, the composer's choice applies from the next message the person sends
from it: sending, steering, queueing or editing the last message carries the choice with
that message, and the Run it starts uses it. Choosing alone changes nothing in the chat,
so a running reply is never interrupted by a choice. Once a Run has applied the choice the
chat's own selection shows again. Until then the choice stays with the chat's composer,
like its prompt draft, across windows and restart; an unstarted chat's Agent and mode
persist the same way until it starts. Choosing another Agent's model starts from the
options last chosen for that model, so a round trip between Agents keeps each model's
effort and speed.

### Agent readiness and failures around the composer

The composer's text field never carries status or error text. What keeps a chat from
sending is a standing condition, shown as one notice attached above the composer (inset at
the top of a floating composer): what is wrong in product words, then the Agent's own
explanation when it names a fix Nodex cannot offer, then the fixes Nodex can, such as
`Sign in`, `Check again`, `Settings`, `Retry` or `Work locally`. The notice leaves on its
own once the condition clears. When several hold, the most specific shows: the chat's
worktree could not be prepared, then the chat could not connect, then the Agents could not
be listed, then the selected Agent is turned off, signed out, missing or not ready. Sign-in,
missing and not-ready states come from the Agent's checked state, not from the wording of
its message, and only signed-out Codex signs in from the notice; completing that sign-in
checks the Agents again.

Only the Agent a chat runs on, or one the person chose, raises a readiness notice. While no
Agent is usable, the stand-in the composer offers stays quiet: the model picker asks for a
model and lists each turned-on Codex or Claude that cannot run yet with its next step
(`Sign in`, `Install` or `Unavailable`), and the account rail offers sign-in. A notice never
blocks sending, since an Agent that missed its check can still answer.

A one-off failure is a toast that says what failed with the reason underneath: a message
that did not go out keeps its draft and says `Message not sent`, and attachment, draft,
stop, resume, header, transcript, branch and Git actions name their own failure. A Run that
fails after it started is part of the transcript instead.

### Context window

The Composer ring shows the active Agent's current native conversation occupancy,
separate from billed tokens accumulated across requests or subagents. Codex, Claude
Code and OpenCode report the latest root execution measurement; ACP Agents can report
conversation usage directly through `usage_update`; completion token totals do not
replace that reading. Cached input counts toward occupancy. Compaction can
lower the reading, and finishing a Turn preserves its last measurement.

Only a measurement tied to that native conversation and its root execution can supply
the ring. Switching Agents selects the other conversation's reading; clearing context
or replacing a native conversation cannot revive the old reading. A model change uses
the window established for the new execution, not the previous model's capacity.
Usage restores on reopening even when its Turn is outside the loaded transcript window.

A known count without a reported capacity shows tokens without a percentage. Missing
usage is shown as unavailable, never as zero or 100% remaining. A measured zero remains
valid. Context observations travel with bounded control metadata and live events;
reading or updating the ring does not hydrate transcript bodies.

### Changing Agent in a chat

The model menu of a started chat lists every configured Agent. Choosing another Agent's
model continues the same chat, Session and transcript on that Agent from the next message.
The chat keeps one history: each Agent keeps its own native conversation, and the next Run
on a new Agent receives a context handoff of the chat's earlier Runs. Returning to an Agent
that already holds a native conversation resumes it and hands over only the Runs it missed.
Codex receives the handoff as earlier conversation history; other Agents receive it with
the message. The handoff uses the same bounded portable history as forks: it prioritizes the
latest request and reply and the opening request, never replays foreign tool calls,
reasoning or attachments, and tells the Agent how to read omitted history with `task_read`.
A finished, failed or stopped chat can change Agent the same way. Sending while a reply
runs follows the usual delivery: a queued message waits with its own choice, while
steering stops the running reply and continues that Run on the chosen Agent with the
conversation so far. Queued messages keep the Agent they were queued with.

Another Agent stays listed but cannot be chosen when the chat cannot hand over: while a
reply is starting before its Agent session exists, when the chat's Agent session cannot
hand off, or when a started chat has no native conversation to hand over. A model change
within an Agent that keeps one model per chat is refused the same way. The disabled
choice explains why. The Session interface applies the same rule to every message that
changes Agent, including an Agent's `send_message_to_session`, and refuses it with the same
reason. The transcript marks each handoff above the Turn that continued it
with the Agents it moved from and to, each as its mark and model. Its description says what
it carried — the conversation so far, only the turns that Agent missed, or a merged fork's
work — and a failed handoff says the Agent may lack the earlier conversation. An unavailable chosen
Agent fails the message explicitly; the chat never falls back to another Agent.

### Missing native conversations

A chat's transcript belongs to Nodex; each Agent's native conversation is its own working
memory. When the chat's Agent no longer has that native conversation, for example because
its history was removed from the Agent's home, the next message starts a fresh native
conversation on the same Agent and hands it the chat's earlier Runs with the same portable
context handoff as changing Agent. Codex and Claude Code behave alike. Only a confirmed
absence starts over: a native history Nodex cannot read is resumed as usual. A Profile
clone detaches every copied chat from its source's native conversations, so each copied
chat continues this way on its first message.

### Clearing context

A started chat can clear its context with Clear context in the header's Chat actions menu or
`/clear`, which replaces any Agent's own `/clear`. The next message starts a fresh native
conversation on whichever Agent it chooses and carries nothing from before the clear: no context
handoff, fork ancestry or imported history. The Session keeps its title, Project, working directory,
panels, Linked Pages and transcript, which shows Context cleared after the Run it followed. Clearing
needs no handoff, so any configured Agent can take the next message.

Clearing waits until no reply, queued message, background task or subagent can still add to the
conversation, and a chat with no finished Run has nothing to clear. Clearing an already clear
context changes nothing, and a merge waiting for the next message is dropped. Rewinding an earlier
message removes the clear with the Runs it followed, so the replacement continues with the retained
context; rewinding a message after the clear keeps it. Forks and merges carry the conversation as it
stood at their source Run, so a fork from before the clear keeps the earlier context.

## Delegated work in the conversation

Wherever a conversation shows another Agent's work, Nodex identifies that Agent the same way.
Its mark stands for the harness that runs it — Claude Code, Codex, OpenCode or an ACP Agent —
not for the model's maker, so an OpenCode Agent running a GPT model carries the OpenCode mark.
Rows, references and dividers show the mark beside the model, such as GPT-6.1 Sol; cards
and tooltips spell the configured Agent's name too, and assistive text always does. A
conversation's own header adds the effort it was given. A model already named after its Agent
stands alone. Names load with the Agents' catalogs and update in
place; before then a harness reads as itself.

Another conversation is named by its Agent's mark and its current title, as the sidebar
titles it, or by a subagent's own name. Names resolve live, so a renamed chat or one handed to
another Agent reads as it is now. A reference opens the conversation where it lives: a chat in
its own Session, a subagent in the Subagents tab beside its parent. Hovering or focusing it
shows the full Agent identity, and says when the conversation is archived, is a subagent, or
runs on an SSH execution host. An archived conversation stays named but no longer opens; one
Nodex cannot find, because it was deleted or never existed here, reads as another agent.

Product surfaces call delegated children subagents. Consecutive subagent items in the same
parent Run form a compact activity row: stable avatars, readable names and current status.
Messages and other raw items break groups, including hidden items; a group retains its first
anchor and first-seen task order when metadata changes. A task appears once within its group.
Up to three names appear; larger groups show the first two and an overflow count, with at
most four avatars. Long names truncate, with their full wording available in details. The
overflow opens the Subagents overview.

Names, avatars and overview entries share the same task identity. Provider-supplied names
and user titles retain their wording; a Codex-native agent path supplies a readable final
segment while the full path stays in details. Names never change merely because a task's
status changes. The row reports running, retrying, waiting, stopping, stopped, cancelled,
failed or done, with a compact count summary when states differ. Retrying means the task
is recovering from a transient Agent failure; its details name the cause and the next
attempt. Failure and stopping remain visible
without hover and are not presented as successful completion.

Hovering or focusing a task reveals its full name, current status, available task description
or progress, the Agent that runs it with its model, and original agent path. The floating surface can be
entered and dismissed without moving the transcript. Clicking an openable name goes directly
to its child conversation. Tasks without a child conversation remain inspectable without
offering a false navigation action. Openable tasks keep complete descriptions in their child
conversation; tasks without one retain their complete descriptions in the details surface.

Presentation updates in place from the task's own item and metadata events; neither grouping
nor hover reads child history. Stop is available from the task's information surface when
its owner permits it, shows Stopping immediately, and keeps that state until the subagent
reports how it ended. A provider-native subagent is stopped through its owning parent Run.
An application-owned subagent's own conversation ends with a Stopped marker.

Input the user did not type names its sender: Sent by, then the sending conversation's mark
and title, so a delegated task names the chat that sent it. Answers another Agent gave to a
question read Answered by the same way, and a fork names the chat it was forked from.
Messages Nodex sends itself say so. Queued input waits in the queue above the Composer; once
delivered it appears, like steering, as an ordinary user message without a delivery label.
Subagents reporting back read like the row that started them: the same avatars and names
with the same details on hover, then how they ended — finished, failed or stopped — and each
name opens its own subagent. A report whose subagents the parent no longer lists keeps the
Runtime's message and opens the one subagent it names. Other reported work — finished
background work or a restart continuation — appears as a compact row. When
a report starts an automatic Run, that row opens the Run's response, so the reason the
Agent continued is visible before its answer.

Background work an Agent leaves running, such as a Claude Code background shell or Monitor,
belongs to the Session: its Thread Summary lists every such task in the Session's
conversations under Background, by name, with its command, age and the end of its output.
The list is the same set of facts that keeps the chat's sidebar spinner turning. Stop ends
the named tasks through the conversation and Agent that own them: Claude Code stops the task
in its running process, and a task whose process has already exited leaves the list. Stop all
sends exactly the listed tasks and never interrupts the Agent's reply or its subagents. The
composer carries no background status; the sidebar's muted spinner and the summary action's
dot show that work is live. A delegated task's Stop cancels it the way its delegating Agent
would: its conversation stops, the tasks it delegated stop, and its pending result is no
longer delivered.

Completed image-file reads, including Claude Code `Read`, appear as image-view activity.
Consecutive reads share one collapsed `Viewed N images` row; expanding it loads thumbnails
from the recorded file paths through the owning execution host. Each mounted thumbnail
retains the resolved bytes and gives the same source to the shared image preview, so
opening a loaded image does not depend on its original file still existing. Successful
local reads remain fresh in a conversation- and host-scoped binary cache with a five-minute
unused lifetime; mounted thumbnails do not extend that cache lifetime. After collection,
reopening reads the recorded path again. Missing or unreadable files show `Failed` without
a retry button; folding and reopening starts another attempt. Ordinary image-file reads
do not create permanent Runtime attachments or recover historical files from provider
logs. Imported images and explicitly submitted attachments retain their separate owned
attachment behavior. Image-view activity remains available when history omits tool output.
Running, failed, interrupted and cancelled reads retain their tool status and details rather
than claiming the image was viewed. Ordinary file reads and tools that return image content
retain their own tool presentation.

Claude Code MCP calls retain their server, tool, arguments and native call identity in
live and saved history, including stopped and failed calls. Tool results preserve structured
content and metadata, so Browser and Computer Use activity can identify its source and
show returned screenshots. Inline image results use the same indexed attachment reads as
other MCP calls; local CLI image-path notes do not appear in the transcript. Application tools
keep their `nodex_app` presentation.

Lifecycle hooks, automatic reviews, cited memory and the files a command read are Turn
metadata: they reach the reply's hook indicator and footer details as in any chat, and a
hook that blocks a prompt explains itself beside that prompt. A hook appears once it has
finished and only if it has something to show: it failed, blocked, stopped, or reported a
warning, feedback or an error. One that succeeded quietly leaves no record. Context a hook
injected for the model never appears. Application tool calls show under the `nodex_app` presentation
whatever spelling the Provider reports. Execution plumbing — listing available Agent models, polling or waiting
for subagent status — never appears in the transcript, and delegating or cancelling a
subagent appears only as that subagent's row unless the call itself failed. Request
bookkeeping such as pending questions, approvals and interrupt requests stays out of the
transcript; pending questions remain answerable from their request card. Optional questions
the Agent asks while it keeps working are the exception: they read as the message that asked
them, open the question panel above the ordinary Composer without replacing it, and stay
answerable until explicitly settled, even after completion, Stop, provider loss or restart. Answering only part of a question batch retains its unanswered siblings. Non-secret authored drafts survive view release, reconnect and restart; private text remains memory-only. Answers and their attachments reach Codex in its question-reply envelope, steered into the running Turn or kept as the next message, and read as question/answer content even when they open a later Run.

Answer admission records cumulative per-question answers and a separate message identity for each submission batch. Delivery distinguishes pending, unknown and accepted. An uncertain transport result never blindly queues another copy. Exact native client-message receipts, including bounded resumed history evidence after process recovery, settle the original message without appending another row. Accepted delivery cannot be downgraded by a late unknown receipt. Missing evidence remains unconfirmed rather than guessed. Pending input in a failed or interrupted reply shows Not sent; it never remains Sending after settlement. An unknown native delivery remains unconfirmed.

Synchronous question projection preserves custom-answer eligibility, private intent, initial answers, required questions and native blocking policy. A nonblocking synchronous question in a focused presented chat waits for 60 seconds of inactivity before a 90-second countdown; a background question starts that countdown immediately. Card interaction snoozes it, and timeout returns an empty response without choosing a default option. One host-owned deadline follows the exact request and process generation across windows; equal Thread and request IDs on different hosts remain independent.

Answered synchronous questionnaires appear as a collapsed question-and-answer history item. Expanding it shows the submitted choices and text, with private answers replaced by `Hidden response`. Copied and exported Markdown uses the same private-answer presentation. The source response record retains its metadata and attachments independently of that private presentation.
Agent-supplied responses also retain the answering Thread and, when known, its Session.
The Runtime request and question answer carry the same responder; an absent responder means
the user. Asynchronous Agent answers retain Agent message provenance and their answering
conversation while continuing to project as question/answer content.

## Execution location and worktree handoff

A local Runtime Session keeps its Core product identity and immutable execution root when
moving between a checkout and managed worktree. Runtime Thread metadata owns the complete
execution location; Core owns Session placement and binding. Main coordinates Git effects and
the durable handoff journal.
Provider runtime observations cannot overwrite the canonical location.
Session archive, deletion and Project moves share the handoff's per-Session admission
lane. They wait for an in-progress move and reject a durable recovery hold before any
Core lifecycle mutation. Stop and cancellation remain available during that hold.

One durable execution hold seals the root and its delegated tree before filesystem preparation.
Quiescence stops native root, child and background work, retires its source and tool credentials,
and waits for native terminal acknowledgments and durable detach effects. Captured source Runs
remain tracked through restart even if their main turn has already completed. A timeout or lost
reply leaves the operation sealed for recovery; detached metadata alone does not prove that
native work stopped. An idle shared Provider process may remain resident.
Queued messages remain durable, and a queue explicitly held by the user remains held after
handoff. No replacement Provider starts during preparation.

Prepared source and destination roots drive bounded, metadata-only reconciliation of delegated
Threads that share the moved workspace. Independent workspaces keep their location. Child
locations move before the root commits, and rollback restores them even if the root never
committed. The root's final location commit stays with the canonical Runtime command writer.
Subsequent Provider execution resumes at that location through the same owner; handoff does
not start a second native writer or prewarm a provisional connection.

The journal retains source, preparation and commit boundaries across restart. Recovery rereads
the canonical location and finishes the destination or restores the source before releasing
execution. Startup protects unfinished journal operations before admitting work. Paged orphan
hold reconciliation runs in the background without making window readiness wait for the Runtime;
those durable holds continue to deny execution until reconciliation succeeds. A hold
without a journal entry can be released after its captured sources retire because Git
preparation had not started. Pending native retirement still blocks release. Completed
operation reads do not repeat Git work or follow-up
messages. Follow-up retries share one durable message identity.

Runtime handoff supports local checkout/worktree moves. Explicit remote native Codex Sessions
retain their own execution-host path and native location authority. Git transfer, staged and
untracked state, compensation and progress contracts belong to
[Managed worktree lifecycle](codex-managed-worktree-lifecycle-behavior.md#moving-a-chat).

## Native voice and prediction

Local voice and composer prediction use the bound Session's managed Codex connection.
Runtime owns native calls, source-bound observations and helper lifetimes; Main owns
account service eligibility, microphone/media admission and exact renderer routing.
Explicit remote native conversations retain their own Gateway source.

Voice input is admitted through the existing durable command writer after its real
native Turn and early frames have been captured within count and byte budgets. The
Run adopts those frames without starting that native Turn again. Cancellation and
failed admission discard the captured bodies; terminal frames release the pending
source even when the terminal frame itself crosses the budget. Runtime and native
generations fence persisted input across process replacement. Known settled Runs
continue receiving their own late background events.

Prediction sampling can return a cold cached empty result without acquiring a native
connection. Actual inference uses the latest Run's exact native boundary and a hidden
ephemeral helper on that source. Bounded output failure settles the request without
waiting for a delayed Turn acknowledgement, while an independent source-owned wait
still interrupts any late accepted Turn and releases its helper. These lifetimes
participate in ordinary Session residency.

See [Realtime voice](realtime-voice-behavior.md) and
[Composer prediction](composer-prediction-behavior.md) for their product contracts.

## Application tools

Application tools receive the product Session and exact engine Thread from the
verified Host invocation. A causal Run is included only when the provider transport
proves it; unknown Runs remain null and never focus another Turn. Core execution coordinates remain authority evidence; they
never stand in for a product Session or native Thread. Caller copies, cancelled calls,
and expired native generations cannot reuse that context. Each operation recaptures
Core execution identity before accessing content or changing application state.

Session observation uses bounded metadata and only loads conversation items for an
explicit history read. Session waits acquire their metadata subscription before the
initial inspection. Completed results repeat only when their observation cursor changes.
Workbench, sidebar, terminal, account, plugin and Automation commands use their existing
application owners with the same caller checks. Session messages, launches and forks
use the canonical Runtime writer and stable command identities.

Work tools follow [Coordinator behavior](coordinator-behavior.md#application-tools):
`report_work` lets a chat linked to a Page report its work there, and `start_work` lets
any Agent start a Page's work in a new managed chat, attributed to that Agent; neither
can grant a Page an unattended start, and Nodex starts only work a person let start on
its own. `inbox_suggest`, `write_turn_note` and `answer_inbox_question` belong to Nodex: Core refuses them
from any Session other than the Profile's Coordinator. Host input to the Coordinator
and managed-chat work updates are server-created messages, never the person's own, and
read `Sent by Nodex`. The Host attaches Nodex's standing instructions, and those of a
managed chat, on every turn through the same preparation hook as other Session
instructions, so compaction and model changes never lose them.

Every provider attaches the application tools as one MCP server named `nodex_app`. Session
tools address product Sessions by sessionId across Projects. The Runtime's task tools
(`list_agent_models`, `delegate_task`, `task_status`, `task_wait`, `task_send`, `task_read`,
`task_question`, `task_cancel` and `stop_workflow`) address delegated children by taskId only; canonical
history retains source Thread provenance and complete typed items without granting target
selection by those identities. A task resolves through its indexed owner to its
actual parent, so observation does not scan every Session. `task_read` without a taskId reads
the caller's own conversation. Ordinary Session creation goes through the Host's product binding
transaction before execution. Background tools retain their captured execution identity while
their native process remains live.

`delegate_task`, `task_send` and `task_cancel` accept optional `idempotencyKey`, an opaque
1–128-character string. Omit it for a first attempt; reuse it with identical arguments only
when the previous outcome was not observed. The execution store atomically binds the calling
conversation, tool and key to one host-issued operation for seven days. Provider credentials,
Runs and process restarts do not replace that identity. Changed arguments fail with
`idempotency_key_reused`; exact retries reuse execution receipts without another child or
message. After seven days, reusing the key admits a new operation independently of expired
receipt cleanup. Omitted keys retain native-call derivation.

The delegating Agent answers its delegated children's information questions through
`task_question`: `list` returns pending user-question requestIds, `read` returns the
question set for a requestId, and `respond` submits answers through the Runtime's
question-response command. Every action requires a taskId owned by the caller;
permissions and approvals cannot be answered through this tool. Live questions resume
the waiting provider, while asynchronous questions send answers into the child's conversation.
Answered or dismissed requests cannot be answered again through the tool. The answer is
attributed to the coordinating Thread, including its asynchronous answer message.

`session_question` provides the same question selection and response semantics for an
explicit product Session, including a selected Runtime child. Its Profile-wide access is
subject to current execution authority and the caller's runtime and Plan permissions.
Fresh responses require a pending user question under the command lock; exact retries
replay their accepted operation without answering twice. Informational elicitations
normalized to user questions are included, while approvals and permission elicitations
remain excluded. Partial asynchronous responses retain unanswered siblings.

Task status and wait results report `workState: "recovering"` and the recovery's kind,
attempt, limit, next attempt time and failure message while a task's reply is recovering;
a wait does not return for recovery alone. They report `hasPendingQuestion` for a live question that blocks
an unfinished task, and `pendingApproval` for its oldest live approval on an active task
Run (requestId, kind and runId), or null. A blocking delegation or `task_wait` returns
on a result, live question, approval or timeout; only a timeout sets `waitTimedOut`.
Returning an unfinished blocking delegation keeps later completion delivery armed.
An async child's live or asynchronous question wakes its coordinator with the taskId
and requestId. A live question already delivered by a blocking delegation does not
also queue a wake while that parent Run is active; if the Run settles first, the
pending question wakes it. Repeated question events do not create duplicate wakes,
and answering or dismissing a question cancels its queued wake. Approvals remain
user decisions and do not queue coordinator question wakes.

`task_read` shares Session history semantics: text messages or complete activity JSON,
newest-first or oldest-first order, independent page and content cursors, a reusable forward
tail, content-version and owner-binding fences, and 24 KiB complete MCP envelope admission.
Task-relative `itemId` point reads use opaque continuations. Its input and item envelope
do not publish Runtime Thread routing fields; private source locators still bind each cursor
and admitted read proof. Canonical activity JSON remains diagnostic data, preserving typed
provider fields and outputs without turning those fields into Task routing parameters.
Reading complete admitted coverage of a terminal child's current result acknowledges delivery;
missing fragments and omitted items do not acknowledge unseen results. Task authorization remains
with the delegation owner, independently of source identities retained in canonical history.

Completion wakes carry each task's title, terminal status and complete current result
within a shared 16,000-byte UTF-8 inline budget, including the task headers. A result
that is absent or does not fit is replaced by an instruction to read `task_status`;
results are never truncated. Queued wakes can batch newly settled siblings before
starting. Once dispatched, retries preserve the message's text and result coverage;
later siblings use a successor delivery. Agents can continue from inlined results
and need `task_status` only when the wake requests it.

Completion wakes can reach an active Codex, Claude Code or OpenCode Run at its next
native tool or sampling boundary without interrupting running tools. Agents without
boundary steering keep the wake queued until the current Run settles. Person steering
and question answers retain their prompt-steering behavior.

Claude Code accepts a boundary notice only when its native queue acknowledges the
message UUID, rather than when the host writes it. Native pickup and merged-result
UUIDs confirm processing without replacing the original prompt's ownership. If the
notice arrives too late to join that native turn, the Runtime captures the CLI's
follow-up as a separate wake Run without sending the notice again. Unconfirmed
delivery remains uncertain across a timeout or process exit.

A delegated result's handoff has one durable native delivery receipt, scoped to its
destination provider Thread and native conversation incarnation. A wake's complete
inlined results count as received and acknowledge the tasks once the Run it started
completes successfully, or once its native steer is accepted. A wake whose Run fails,
is interrupted or is cancelled leaves its results pending for later delivery. Starting
or accepting a queued wake's message does not settle its result receipts. Results
omitted from a wake remain pending until read or otherwise delivered in full.

Completed native task result responses, including synchronous delegation, status,
wait and complete history reads, also settle the receipt. Tool responses carry verified
delivery evidence in MCP metadata, separate from the public task view, fenced to the
admitting attempt and native conversation. A notice that only announces completion
does not prove that the result reached native history. Acknowledgment before a tool
response returns is not native acceptance. Received results do not become pending
context when their parent Run later fails, unloads or restarts. Unseen results remain
eligible until received; a receipt from an earlier native incarnation cannot suppress
delivery to a replacement.

Delegation attaches to the native call's exact source Run, including a completed
foreground Run that still has live native background work. A Session-only caller
chooses `parentRunId` explicitly; that target never becomes a claimed source Run.
Retries with the same command identity replay their durable receipt and create one
child. Child follow-ups use the sending Agent's captured Run for task ownership. A Session-only or human follow-up retains the
original task owner and does not infer the current foreground Run. Owner lookup reads
one addressed task and Run metadata, without task prompts, results or native workflow bodies.
Information questions can belong directly to a Session or to their original
Run. Their native lifetime closes them after cancellation; another foreground Run
does not own or dismiss them.

An independent fork creates a new execution root and keeps the captured conversation
prefix as read ancestry. Delegated forks retain their parent's root and task lineage.
Both have full access to the current Profile.

## Metadata catalogs

Conversation and queued-message images retain native attachment descriptors. A mounted
image resolves its exact item and captured read ancestry to the Runtime's stored file
path, then uses the desktop image reader. Metadata, cold history and closed queues
never read image bytes. Editing a queued message resolves its own image paths and
preserves the images when submitting the edited prompt; editing a sent message resolves
only the images the edit keeps.

Session titles, archive state and placement come from Core Session overview; Core is
their only writer. The engine keeps placement and archive only as execution gates (the
working Project, and no wakes for an archived chat). Main repairs both from Core after
each change, whenever an operation touches the Session, and for every live root when the
engine starts, so a missed update cannot leave an archived chat waking. Runtime status and
child metadata come from bounded engine readers. A task overview admits four active and ten
terminal tasks initially, with independent continuation cursors. It omits prompts,
results, item bodies and native workflow payloads. Native task observations without an
application-owned child Thread never acquire Thread navigation or command authority.
Visual identity follows the shared [subagent identity contract](codex-subagent-behavior.md#visual-identity).
The durable child Thread ID supplies the avatar seed across activity, summary,
overview, child navigation and mentions. A task with no child Thread shows the
generic subagent glyph; its task ID remains a row/control key, never an avatar seed.
The Subagents panel marks each subagent's Agent beside its model and can stop any live
subagent the same way its transcript row does. Task metadata events update the pages already
loaded in place, so later status changes never discard pages the user loaded; a newer report
always wins over an older one. When settling or reopening subagents leave a section with
fewer rows than it showed and more remain unread, the panel reads its next page. A selected
provider-spawned subagent opens read-only beside the overview, without a Composer; stopping
its parent stops it. Its detail header marks the child's Agent, and it and any interactive
child Composer show the child's own model, effort and Fast state from its persisted execution
selection. Parent choices,
new-chat defaults and model catalog defaults never replace an observed child choice.
Codex native children hydrate their complete selection through a metadata-only rejoin in
the owning provider session, without configuration overrides or starting a Turn. A newer
settings observation wins over an older lookup; an explicit Standard tier remains distinct
from an unknown tier. Opening read-only details reads stored Runtime history and never
performs that native rejoin itself.
A delivery gap or Runtime restart attaches the panel again,
and a failed read keeps the last pages visible with Retry, which also happens automatically
when the Runtime is ready again.

Project lifecycle checks read one metadata-only blocker for each category: an active
Run, a pending runtime request, and active provider-native background work. Descendant,
archived and deleted Threads remain relevant while their execution is active; terminal
foreground work does not hide a live native background task.
Closing an idle Project detaches its native provider bindings through durable Runtime
commands, which ends their tool calls. The close waits for provider cleanup to
finish and preserves Session and Thread history. An active execution blocks detaching;
an empty Project does not start an execution process just to close it.

Sidebar refreshes read stored Core metadata. They never scan native history, create or
link Sessions, or reconcile missing native Threads implicitly. Provider history and
imports remain explicit operations. Registering the local account/catalog endpoint
leaves its process cold; its first real request acquires one supervised connection.
A launch resumes an existing execution database under the supervised Host after application
tools are ready unless the process last stopped with no live or pending work (see
[Execution process supervision](#execution-process-supervision)); recovering interrupted
execution moves follows the same rule. Durable Session deletion
intents are reconciled after each connection;
their acknowledged tombstones prevent a deleted execution from being adopted again.

## Session activity

Main keeps one projection of live execution for Runtime-bound Sessions and serves it to every
window. Waiting takes precedence over running and background. The root's pending approvals
and live user-input requests wait immediately, including non-blocking live questions. Its
asynchronous questions wait only while it has no preparing, starting or running Run; a waiting
Run has ended its provider turn and only drains effects. A pending secret card waits only while
its own Run is live. Delegated conversations roll up only approvals, including MCP elicitation,
and only while their Run is live. Their questions belong to the delegating Agent. Provider-native
children ask on their parent, so none of their requests roll up. Tool calls and authentication
refreshes never count as user attention.

Side chats have independent execution roots and no catalog row. Their questions,
secret cards and approvals also reach their source Session whenever their own conversation
would wait; nested side chats follow the source chain. Their execution activity remains
independent. A Session is otherwise running while its root or a delegated conversation has a
live Run, and background while delegated or native background work is live or a delegated
result will wake it; idle Sessions are absent. Only requests that make the Session wait count
in its pending request count. Each activity names the root Thread, active Run, provider, model,
and up to 25 live background tasks with their owning conversation, name, command and start time.
Core never stores these facts.

Each Agent reports its own background tasks. Claude Code reports background shells, Monitors
and workflows as it starts and ends them. Codex background terminals appear as command tasks
with their exact command text (up to 2,000 characters); the Runtime reconciles the native
terminal list when commands start or a Turn finishes. Command completion and stop responses
update the list immediately. Safety refreshes run only for live terminal rosters, backing off
from 2 to 30 seconds while unchanged and resetting when command activity changes. A Turn that
is stopped or fails ends its unfinished commands as stopped, and they leave the list before the
Run ends, so the Session never reads as working in the background for a command its stopped
reply ran. Stopping one task ends only that task; a conversation's Stop ends all of its
background work. Output reads
return at most the last 8 KiB of a task's output: Claude Code supplies it, and Codex keeps a
bounded in-memory command output tail while the command runs, including after its Turn
finishes, with the matching item's projected aggregate as a fallback. Streamed deltas never
enter execution history; the live buffer is discarded when the command exits or the Agent
process restarts. Restarting an Agent's process ends the tasks it owned; they leave the list,
and the Agent learns of it with its next Turn instead of being woken for it. Resuming a native
Codex Thread replaces its stored roster with the current native list.

Each execution process generation is read once in bounded pages. One execution observation
then reports which roots changed, and only those roots are re-read and mapped to their Session
through the Core binding, so idle Sessions cost no execution or Core reads. Changes carry one
increasing sequence. A process replacement, missed observation, or slow observer overflowing
the bounded activity channel publishes a reset, after which windows read a fresh snapshot of
at most 500 Sessions. Reading activity never starts an idle
execution process; while none runs, the snapshot is empty and complete. Finished foreground
Runs and new questions mark unseen Sessions unread and raise
[desktop notifications](desktop-notification-behavior.md#agent-runtime-sessions).

The root chat displays Core Session unread state independently of execution history and uses
the shared [conversation read rules](codex-thread-transcript-behavior.md#conversation-read-state).
Accepted completion and new questions reach visible chat observers after their unread write, so reading the
current chat clears its indicator even when the Session projection arrives later. Viewing a
delegated child never clears its root Session's unread state.

## Execution process supervision

Main supervises one execution process per Profile and publishes its connection state to every
window: idle (not running; the next Agent action starts it), starting, ready with its process
generation, unresponsive with that same generation, restarting with the recovery attempt, or
failed with a readable reason. An
unexpected exit or failed start makes the next start a recovery. At most three recoveries
start within any five-minute window, whether automatic or requested by an Agent action, so a
crash loop cannot restart once per user action. When the budget is spent the state stays
failed until the window moves on; the next Agent action after that starts the process again.
A failed command is never resubmitted automatically; only reads may retry, as described below.

A slow process is not a failed one. A request to the process ends only with its answer or with
the process itself, however long that takes, so a busy computer delays a chat or the Subagents
panel instead of failing it, and a command is never reported as failed while it may still
commit. Work with its own deadline, such as generating structured text, enforces it inside the
process and answers with the outcome. At most 64 requests are in flight and later ones wait
their turn; only a backlog past 1,024 waiting requests is refused. A start, including the work
that follows readiness, fails after ten minutes and follows the failed-start path above.

Opening a chat or the Subagents panel stays in its loading state through a temporary failure, such
as Nodex Core being too busy to answer or the process being replaced. Nodex tries up to five times,
waiting 0.75, 1.5, 3 and 6 seconds between attempts, before showing the failure with its Retry.
A definite answer, such as a chat that no longer belongs to its Session, shows at once.

While a request waits, Main also checks that the process is still answering, every five seconds.
Its state becomes unresponsive after about 30 seconds with nothing heard from it, or when a read
that someone is waiting to see, such as opening a chat, has gone unanswered for about two minutes
even though the process keeps answering checks. Work that is slow by nature, such as generating
text or importing history, does not count. Hearing from the process again restores ready unless
such a read is still stuck; that read's answer, or nobody waiting for it anymore, clears it. Nodex counts checks rather than elapsed time, so a pause in Nodex itself or a
sleeping computer counts only once, and an idle process is never checked. While unresponsive,
other requests are still sent, passive reads such as Session rows pause, and surfaces read again and retry what failed once the
process answers. Silence alone never ends the process, because the Agents it serves may still be
working. Every window shows "Agent execution isn't responding" with a Restart action for as long
as this lasts. Restart is the person's explicit decision: it replaces the process, ends its
pending requests, lets its replies recover as they do when any shared process stops, and spends
none of the recovery budget.

The process runs only while needed. It stops after three quiet minutes once it reports no
active Run, pending question, live delegated or background task, delegated result waiting to
wake a root, or execution handoff hold, and while no request, Host call, Session or voice
observer or product write is using it. An idle stop is not a crash and the
next Agent action starts the process again. After such a stop, and after quitting while the
process reports no work and no product write is in flight (reads and observers do not count),
Main keeps durable evidence bound to the exact execution store files; a launch starts the
process at once whenever that evidence is missing or no longer matches, including after a
crash, restore or copy.

Listing providers and models starts the process only when nothing current is known. While it
is stopped, model pickers, launch defaults and provider checks see the catalog it last served,
as long as the execution build and the provider settings and installation it described are
unchanged; otherwise the listing starts the process. A running process always answers live,
and an explicit refresh always reaches it; a refresh that names Agents checks only those, from
scratch, so the usage they report is read again rather than reused from a recent check. Claude
usage meters never start the process on their own: their five-minute refresh is such a named
refresh made only while the process runs, and only opening a Claude usage card starts it to read
(see the rail foot in [Workbench shell](workbench-shell.md)). A provider check that ends without an answer, such
as when the provider's service cannot be reached, is retried on its own after 15 seconds,
doubling up to the provider health interval, until a check settles; a signed-out provider
waits for the user instead. Opening the model menu reads the catalog again without forcing a
check, so a provider that has recovered appears without a manual refresh. A listing may name the Agents it needs; it then waits
only for their first checks. A first message sent before any model is chosen takes Codex's
default as soon as Codex is checked, and reads the whole catalog only when Codex has none.

### Inbound routing identity

For active chats, Main records delivery evidence before sending and the Host binds
the admitted Run's inbound identity to Core. The trusted application-tool context
carries that identity. Queued edits are reconciled from Runtime's admitted message
before binding. Submitted question answers fence handback before Runtime can resume
the chat. `hand_back_message` requires this captured Run context; a native-session
invocation without causal inbound identity is refused. Runtime retains the original
text and attachment bytes; Core stores control evidence and publishes content only
when the message returns to intake. See [Inbox behavior](inbox-behavior.md).
