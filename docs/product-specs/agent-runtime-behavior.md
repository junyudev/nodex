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

A chat a person starts is titled once from its opening prompt, using the chat's own model
at its lightest effort. The generated title replaces only the provisional title it was
derived from, so a rename that lands first always wins; chats an Agent starts keep the
title it chose. Forks follow the same order and retain their source Session's title as
"Fork of …". A worktree fork that stopped before recording its new location completes
that move when retried; a same-directory fork never claims its source's managed worktree.

Page links and sidebar placement refer to Session identity. They do not own its Thread
history, title, model selection, queue, Run status or delegated tasks. Delegated Threads
remain within the bound root's lineage and do not implicitly create ordinary sidebar
Sessions.

## Profile access and execution identity

Every Agent has full read and write access to the current Profile's Projects, Pages
and Library. Parent Agents, delegated children and background work use the same model
and may operate across Projects and Sessions. Plan changes planning interaction and
permits content writes. Native Providers run with full access and permission requests
are approved automatically. Questions requiring the user's information remain open.
Standard ACP information questions belong to the live Session, with Run left null;
they can arrive after foreground completion or while another Run executes.

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

Provider utility processes for titles, commit messages and change-request guides use the same
full-access, automatic-approval native execution policy. Their task prompts and output schemas
remain specific to their purpose; investigation instructions request observations without
installing a tool allowlist, denylist or separate permission boundary.

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

## Conversation interface

Page Chat and Workbench use one Session interface for Agent launch, follow-up messages,
steering, selected-Run stop, information answers, model selection and planning.
App-supplied data — interactive response changes or an app's model context — travels beside
the user's words as a context record rather than inside them. The transcript, queue and
editing show only what the user wrote; the Agent receives the record as data marked untrusted.
Editing a queued message rewrites only those words: the record it carried stays with it.
State the user leaves in a chat's interactive responses travels the same way, with their next
message that starts a Run and once per change; a steer, a queued message or a message that
already carries app data leaves it for later, and a response's private content never travels.
Page editor submissions use that same interface. New submissions promote the chosen
Session with its Page links, model options and workspace configuration; existing
sections resolve a bound Session before sending. Imported native history does not
acquire an execution owner when a section is sent.
Every command resolves the Session's immutable root before accessing an engine Thread;
explicit targets resolve their own Session and Thread identity. Responses carry the exact pending request
and its original Run, or null when the source is a native Session. A stale card cannot
answer a newer request. Session-origin Dismiss answers that request without stopping
an unrelated foreground Run. Runtime questions use this Session interface and remain
open for user input; native Codex inactivity controls belong to their own execution owner.

Launch returns execution identity without transcript bodies. Controls acquire only
execution metadata and observe control events. Activating a transcript reader opens
one bounded history window and publishes canonical items into the keyed
transcript cache. Text changes notify only the affected item. Older windows preserve
resident items. Releasing the last transcript reader clears body caches; retained
controls continue observing metadata until their last reader releases. Captured fork ancestry identifies the source of inherited history.

Read-only history loading, retry and child observations use the conversation's
current owner, including for archived chats and provider-spawned subagents. The
Agent kind selects presentation, not the history store. Runtime Thread identities
stay inside the bound Session's Runtime reads; opening their history never requires
a native Thread registration or acquires an execution writer.

Selected-text side chats create independent product Sessions and prefill a draft.
Explicit side-chat prompts submit immediately through the same launch owner. Neither
route copies parent history. Panel remounts resolve the Session's cached canonical
binding, and closing the panel keeps its product chat.
Local imported native conversations use the same independent side-chat route while
their history stays passive. Runtime forks retain the selected source Run and prepare
the chosen workspace and environment for the new Session; they do not
resume an imported native conversation or hydrate history to choose a workspace.
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

Slash commands expose supported Nodex actions across Agents rather than filtering
them by Agent name. Fork, Merge back, Side, Compact, Project and other shared actions
appear when their owning callbacks and conversation state permit them. Agent-native
commands supplement those actions without replacing an available Nodex action with
the same name. Status and MCP use the selected Agent's inspector; Codex-specific
controls remain scoped to their actual capabilities. Side opens an independent
chat and does not imply inherited fork history.

A fork can bring its work back into the chat it was forked from with Merge back (`/merge`)
or `merge_session_back`. The fork's newest finished Run is merged: a reply still working in
the fork holds the merge, and the source chat must not be running a reply. Merging starts
nothing and opens the source chat; its next message carries the fork's work since it
branched as a context handoff, on whichever Agent that message uses, and the transcript
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
Session and Thread share one read owner. Queue observation reads at most 25 metadata
rows per page with canonical Run and message identities. An open queue hydrates bounded
previews only for its visible page; editing explicitly reads that message. Collapsed
queues and controls do not load prompts. A held queue remains paused until an explicit queue command resumes it.
Sending a queued message while the chat is idle resumes the queue from that message; the
others follow in their order.

The initial window admits at most five user Turns and 500 distinct items. Its complete
public envelope, including metadata, stays within 1 MiB. Root windows retain visible
entities and a bounded set of live control dependencies; an admitted Run never implies
reading all of its tasks. Task prompts, results, workflow bodies and delivery records
stay out of public metadata snapshots and events. Child history and explicit item
details provide those bodies. Long text appears as a bounded preview with a truncation
marker; full copy and export use explicit full-item reads. A control envelope that
cannot fit fails explicitly rather than exceeding the transport budget.

Compaction admits one durable maintenance Run per request; compaction items recorded in
that Run are manual, and every other compaction is automatic. Editing any sent user
message first admits a conversation rewind to just before that message's Run and waits
for that exact Run to become rolled back before submitting replacement content; every
later Run leaves the conversation with it. The replacement keeps the original message's
images and app context, and is compiled before the rewind so a message the Agent cannot
accept discards nothing. Document Agent config is resolved during this preflight so
image admission uses the effective model before history changes. Queued or active
work and native background tasks block editing.
Only Providers that explicitly advertise native rollback to an earlier Turn offer
editing, including Codex, Claude and both native OpenCode versions. Resetting an ACP
session alone does not grant historical message editing. The capability belongs to
the Agent whose conversation is being rewound; the replacement message can select
another Agent.
Conversation rewind leaves workspace files intact and can proceed without a Git file
checkpoint. Repeated commands retain their original
Run and message identity; reusing an identity for another target fails.
Active proposed plans can be implemented in another Project. Recording a created
Session also works across Projects; the source plan, parent Run and target Session
retain their exact product identities and content owners.

Message delivery intent resolves inside the serialized command writer, after its
durable receipt lookup. An accepted steer or restart therefore replays after the
Run completes. A steer the Provider refuses while its Turn keeps running waits as the
next message instead of being lost; Codex steering that names a continued Turn is retried
once against it. Ordinary intake reads addressed control heads and input identities;
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
the admitted Thread and message before dispatch. Image URLs resolve on demand from that
exact visible item and attachment identity. Forked history resolves through its captured
source Run prefix; later source items are excluded. Resolution returns only the owned
path, and conversation metadata never hydrates image bytes. Workspace creation and environment
setup use the same scoped filesystem owner as other native capabilities. The workspace
is retained when remote creation may have committed without acknowledgement, and its
managed-worktree ownership is attached only after the durable execution is verified.

## Model choices

Effort and speed are written under each model's own option names: Codex reasoning effort
and service tier, Claude effort with its thinking, speed and context choices. A model,
effort and speed change from the composer is one choice, so concurrent choices never
overwrite each other, and options a newly chosen model does not offer fall back to its
defaults. A new Codex chat starts from the user's saved Codex model, effort and speed.
Fast in a Runtime chat changes that chat's own speed rather than the saved default. Goal
mode is not offered for Runtime chats.

Page and Scheduled actions that start a chat use its saved draft Agent, model, options
and interaction mode, scoped to that Session and Project. Without a draft choice they
use the saved Codex model when available, then another available Agent's default model.
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
with the configured Agent and model names it moved from and to. Its description says what
it carried — the conversation so far, only the turns that Agent missed, or a merged fork's
work — and a failed handoff says the Agent may lack the earlier conversation. An unavailable chosen
Agent fails the message explicitly; the chat never falls back to another Agent.

## Delegated work in the conversation

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
status changes. The row reports running, waiting, stopping, stopped, cancelled, failed or
done, with a compact count summary when states differ. Failure and stopping remain visible
without hover and are not presented as successful completion.

Hovering or focusing a task reveals its full name, current status, available task description
or progress, configured Agent/model and original agent path. The floating surface can be
entered and dismissed without moving the transcript. Clicking an openable name goes directly
to its child conversation. Tasks without a child conversation remain inspectable without
offering a false navigation action. Openable tasks keep complete descriptions in their child
conversation; tasks without one retain their complete descriptions in the details surface.

Presentation updates in place from the task's own item and metadata events; neither grouping
nor hover reads child history. Stop is available from the task's information surface when
its owner permits it, shows Stopping immediately, and keeps that state until the subagent
reports how it ended. A provider-native subagent is stopped through its owning parent Run.
An application-owned subagent's own conversation ends with a Stopped marker.

Input the user did not type names its sender: Sent by another agent links to the sending
conversation, and messages Nodex sends itself say so. Steered and queued input carries a
Steer or Queued marker. Reported work — a subagent's result, finished background work or a
restart continuation — appears as a compact row that opens the one subagent it names. When
a report starts an automatic Run, that row opens the Run's response, so the reason the
Agent continued is visible before its answer.

When a chat has no foreground Run but background work is still live, or a delegated result
will start the Agent again on its own, the composer says so in one line, such as "Waiting
for 2 background tasks · resumes automatically", with Stop for every live subagent. The line
belongs to the Session's root conversation; an opened subagent shows its own Runs.

Lifecycle hooks, automatic reviews, cited memory and the files a command read are Turn
metadata: they reach the reply's hook indicator and footer details as in any chat, and a
hook that blocks a prompt explains itself beside that prompt. Context a hook injected for
the model never appears. Application tool calls show under the `nodex_app` presentation
whatever spelling the Provider reports. Execution plumbing — listing available Agent models, polling or waiting
for subagent status — never appears in the transcript, and delegating or cancelling a
subagent appears only as that subagent's row unless the call itself failed. Request
bookkeeping such as pending questions, approvals and interrupt requests stays out of the
transcript; pending questions remain answerable from their request card. Optional questions
the Agent asks while it keeps working are the exception: they read as the message that asked
them, open the question panel above the ordinary Composer without replacing it, and stay
answerable until the Agent settles them. Answers reach Codex in its question-reply
envelope, steered into the running Turn or kept as the next message.

## Execution location and worktree handoff

A local Runtime Session keeps its Core product identity and immutable execution root when
moving between a checkout and managed worktree. Runtime Thread metadata owns the complete
execution location; Core owns Session placement and binding. Main coordinates Git effects and
the durable handoff journal, and holds the Profile snapshot writer lease throughout the move.
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
participate in ordinary Session residency and snapshot admission.

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

Every provider attaches the application tools as one MCP server named `nodex_app`. Session
tools address product Sessions by sessionId across Projects. The Runtime's task tools
(`list_agent_models`, `delegate_task`, `task_status`, `task_wait`, `task_send`, `task_read`,
`task_cancel` and `stop_workflow`) address delegated children by taskId only; no tool input or
result carries a Runtime conversation identity. A task resolves through its indexed owner to its
actual parent, so observation does not scan every Session. `task_read` without a taskId reads
the caller's own conversation. Ordinary Session creation goes through the Host's product binding
transaction before execution. Background tools retain their captured execution identity while
their native process remains live.

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
never read image bytes. Editing a queued or sent message resolves its own image paths
and preserves the images when submitting the edited prompt.

Session titles, archive state and placement come from Core Session overview; Core is
their only writer. The engine keeps placement and archive only as execution gates (the
working Project, and no wakes for an archived chat). Main repairs both from Core after
each change, whenever an operation touches the Session, and for every live root when the
engine starts, so a missed update cannot leave an archived chat waking. Runtime status and
child metadata come from bounded engine readers. A task overview admits four active and ten
terminal tasks initially, with independent continuation cursors. It omits prompts,
results, item bodies and native workflow payloads. Native task observations without an
application-owned child Thread never acquire Thread navigation or command authority.
The Subagents panel shows each subagent's Agent label and model and can stop any live
subagent the same way its transcript row does. Task metadata events update the pages already
loaded in place, so later status changes never discard pages the user loaded; a newer report
always wins over an older one. When settling or reopening subagents leave a section with
fewer rows than it showed and more remain unread, the panel reads its next page. A selected
provider-spawned subagent opens read-only beside the overview, without a Composer; stopping
its parent stops it. A delivery gap or Runtime restart attaches the panel again,
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
imports remain explicit operations. Registering the local account/catalog endpoint or
Profile snapshot control leaves its process cold; its first real request acquires one
supervised connection. An unused endpoint snapshot does not start a provider.
A launch resumes an existing execution database under the supervised Host after application
tools are ready unless the process last stopped with no live or pending work (see
[Execution process supervision](#execution-process-supervision)); recovering interrupted
execution moves follows the same rule. Durable Session deletion
intents are reconciled after each connection;
their acknowledged tombstones prevent a deleted execution from being adopted again.

## Session activity

Main keeps one projection of live execution for Runtime-bound Sessions and serves it to every
window. A Session is running while its root has an active Run, waiting while an information
question awaits the user, and background while delegated or native background work is live
or a delegated result will wake it; idle Sessions are absent. Each activity names the root
Thread, active Run, pending question and live task counts, whether the Session resumes
automatically, and its provider and model. Core never stores these facts.

Each execution process generation is read once in bounded pages. One execution observation
then reports which roots changed, and only those roots are re-read and mapped to their Session
through the Core binding, so idle Sessions cost no execution or Core reads. Changes carry one
increasing sequence. A process replacement, missed observation, or slow observer overflowing
the bounded activity channel publishes a reset, after which windows read a fresh snapshot of
at most 500 Sessions. Reading activity never starts an idle
execution process; while none runs, the snapshot is empty and complete. Finished foreground
Runs and new questions mark unseen Sessions unread and raise
[desktop notifications](desktop-notification-behavior.md#agent-runtime-sessions).

## Execution process supervision

Main supervises one execution process per Profile and publishes its connection state to every
window: idle (not running; the next Agent action starts it), starting, ready with its process
generation, restarting with the recovery attempt, or failed with a readable reason. An
unexpected exit or failed start makes the next start a recovery. At most three recoveries
start within any five-minute window, whether automatic or requested by an Agent action, so a
crash loop cannot restart once per user action. When the budget is spent the state stays
failed until the window moves on; the next Agent action after that starts the process again.
Failed requests are never resubmitted automatically.

The process runs only while needed. It stops after three quiet minutes once it reports no
active Run, pending question, live delegated or background task, delegated result waiting to
wake a root, or execution handoff hold, and while no request, Host call, Session or voice
observer, product write or Profile snapshot is using it. An idle stop is not a crash and the
next Agent action starts the process again. After such a stop, and after quitting while the
process reports no work and no product write is in flight (reads and observers do not count),
Main keeps durable evidence bound to the exact execution store files; a launch starts the
process at once whenever that evidence is missing or no longer matches, including after a
crash, restore or copy.

Listing providers and models starts the process only when nothing current is known. While it
is stopped, model pickers, launch defaults and provider checks see the catalog it last served,
as long as the execution build and the provider settings and installation it described are
unchanged; otherwise the listing starts the process. A running process always answers live,
and an explicit refresh always reaches it. A provider check that ends without an answer, such
as when the provider's service cannot be reached, is retried on its own after 15 seconds,
doubling up to the provider health interval, until a check settles; a signed-out provider
waits for the user instead. Opening the model menu reads the catalog again without forcing a
check, so a provider that has recovered appears without a manual refresh. A listing may name the Agents it needs; it then waits
only for their first checks. A first message sent before any model is chosen takes Codex's
default as soon as Codex is checked, and reads the whole catalog only when Codex has none.
