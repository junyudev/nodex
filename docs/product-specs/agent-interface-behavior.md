# Agent Interface Behavior

## CLI-first local interface

The packaged native `nodex` CLI and official Agent Skill are the default content
interface for local shell-capable Agents and scripts. Direct reads, stdin
writes, typed queries, property edits, and atomic Page creation share Core
semantics with the desktop. See [CLI Reference](../CLI.md) for command behavior.

Native CLI calls use the authenticated current Profile and optional Project
routing. Native application tools additionally carry the host-captured execution
identity. Both can access every resource in the current Profile Library.
Neither exposes SQL or private storage as a content-editing interface.

The host places a managed `nodex` command in the Agent shell PATH. Each eligible
Turn, including a resumed task, refreshes its own binding to the current CLI
build, Profile and Project. Agents use ordinary `nodex` commands without
repeating paths or connection flags, even after changing directories. The
directory comes from host configuration; the expected Profile identity comes
exclusively from the connected Core authority. The entrypoint pins `NODEX_HOME`,
`--expect-profile`, and `--project`; startup paths are never identities.

Bindings are task-local and replaced atomically. The runtime-provided task ID
selects the binding; subagents inherit the root session binding unless the host
has supplied an explicit child binding. Explicit unavailable child context does
not fall back to the parent. Runtime startup discards previous bindings, and the
shell policy and Agent-local Bash/Zsh startup adapters preserve the entrypoint
across login shells and snapshots, including when user startup files prepend
another installed CLI to PATH. The adapters load the original startup files
and then restore the managed command; they do not edit global shell files. The host
supplies the bundled official Skill without requiring a workspace-local copy.
The connection prompt is maintained in
[`NodexCliBootstrapPrompt.ts`](../../src/main/platform/node/NodexCliBootstrapPrompt.ts)
and filled with the selected Project and Skill path. It is imported as source text
without runtime file reads or separate packaged resources.

Automatic connection uses a local execution transport, the available CLI/Skill
build and an exact product Session execution binding. Projectless tasks have the
same current Profile content access; they supply no default Project presentation
target. Plan changes planning behavior without disabling the connection. A
remote transport without the local bridge or a missing executable build is
unavailable. Core validates Profile, Store and the captured execution identity
on every operation. Shell identity and PATH remain mutable; native shell access
is not a security sandbox.

## Native application MCP

Native application MCP uses the catalog attached to the Session's configured Runtime
Provider. Its captured connection can belong to Codex, Claude Code, OpenCode or ACP;
unsupported native capabilities fail explicitly. External endpoints without the private
application bridge receive no catalog. Remote execution integration, sharing and publishing
services, Cloud task destinations, realtime voice controls and `fire_confetti` remain
unsupported application-tool capabilities.
Voice-session screen capture and ending a realtime voice call are also unavailable.
These capabilities have no substitute tools or placeholder success responses.

`load_workspace_dependencies` reads the managed Node/Python executable paths, Python import
directory and installed document-library versions. It performs no package installation and
requires a live captured Session source, with a Run only when proven; Plan can inspect it. The Python closure supports Word,
PowerPoint, spreadsheet, PDF and image operations. Recommended `-I -B` arguments isolate imports
and avoid bytecode writes. Missing, invalid or unsupported distributions return an explicit
unavailable result without selecting a system runtime. See [workspace runtime distribution](../../resources/workspace-runtime/README.md).

Native tool discovery, capability reporting, and per-Thread tool visibility share one catalog.
Fresh Sessions, live resumes, forks, imported tasks, side chats, managed worktrees, and scheduled
runs refresh that catalog through the same configuration boundary. New local Threads register
no dynamic tools. Internal title generation has no application tools. An execution endpoint
without the native bridge receives no application catalog or private connection configuration.
Tool visibility never substitutes for the captured execution identity.

Native connections bind application calls to the authenticated Session and captured
native generation. When a Run identity is available, it stays bound to that Run
instead of following the latest foreground selection. Core validates the persisted
execution credential on every content operation. Child and background work remain
usable after foreground completion; cancellation, failed admission, native Scope
exit and generation retirement invalidate their exact credentials. An invocation
without evidence for a Run cannot silently acquire a later foreground identity.
Standard ACP tool calls without causal Run metadata report the authenticated
Session and `Run=null`. They retain that Session across ordinary Runs. Cancel
retires the physical native connection; the next message restores its history
through a fresh connection. A completed foreground Run does not retire it.
The catalog includes content operations, explicit SQL queries, Project and Session
metadata/history, messaging, scheduling, terminal observation and workspace
dependencies. Provider-specific operations report their actual capabilities.

Historical dynamic tool results remain readable. Legacy dynamic-tool envelopes for
`nodex_app` content calls and `codex_app` application calls are rejected before renderer
forwarding or pending request storage; they cannot bypass the authenticated MCP bridge. Interactive setup
reports unavailable through application tools. Resuming an old task does not reactivate its
retired dynamic catalog or select an automatic fallback transport.

The native catalog includes `get_context`, `search`, `fetch`, `query_database_view`,
`query_data_source`, `create_pages`, `update_page`, `advanced_update_page`, `move_pages`,
and `duplicate_page`. `get_context` describes the current Library, optional Project
routing and opt-in default Database or Markdown guide. These tools use the canonical
Agent content contracts and semantic execution owner. Calls bind the backend-observed Thread and Turn to persisted Core execution identity;
arguments cannot supply execution identity. Execution rechecks the captured invocation
and current native lifetime. Mutations retain stable operation identities, and
results must satisfy their content contract and the complete-response byte budget.

Local Codex Sessions use the bundled `nodex_app` MCP server when the verified Node runtime
is available. `get_session_context` returns the calling Session, Thread, Turn, Project, Host,
and working directory. Execution identity cannot be supplied in arguments. Its default
`anchored` mode describes the submitting Window and Scene captured for the latest accepted user submission, including an accepted steer;
`refresh` explicitly observes that Window's current Scene. Exact discovered targets
can be selected explicitly. Ambiguous windows return candidates instead of guessing.
Missing Session or presentation context is reported explicitly. This operation reads
bounded semantic metadata, including exact file paths, not Page content. Only visible selected surfaces accompany submission; partial coverage and unavailable optional context are explicit and do not prevent a valid message. Existing observation handles retain their original evidence after a later submission.

`list_projects` discovers available Projects and their local workspace paths. Git inspection
distinguishes a repository, a non-repository directory, an unavailable inspection, and a Project
without a workspace. Project discovery supplies execution and presentation coordinates.
`get_app_capabilities` reports the tools actually registered on this connection and distinguishes
execution identity, Profile SQL reads, live Workbench observations and resource lifecycle
and cloud capabilities.

`automation_update` lists, searches, reads, creates, replaces and deletes scheduled
Codex and Claude tasks. The definition retains an explicit backend/Profile binding.
An omitted cron binding selects the caller's native backend; an omitted Heartbeat
binding selects its resolved target's backend. List results span the current Profile
and use bounded cursors. Cron tasks select an explicit Project and its folders, or a projectless
local run. Heartbeats target a stable Session; omitting the target selects the
caller’s Session. Notification preferences are separate from the task prompt.
Read the definition before editing or deleting and retain its `definitionRevision`
as `expectedRevision`. An update carries the complete replacement definition,
including values that should be preserved. The response returns the committed
definition and operation ID. Retry an uncertain write with the same operation ID,
revision and arguments; the same caller Thread can reconcile it across Turns and
restarts without creating or updating twice. The captured execution identity and
target lifecycle are checked again on every retry. See
[Scheduled Route Behavior](scheduled-route-behavior.md) for execution and notification rules.

`suggested_create` and `suggested_update` produce editable review proposals. They do
not save a task until the user submits the editor. Suggested updates retain the
observed definition revision, so a concurrent edit cannot be silently overwritten.
Omitted notification policy preserves the saved preference; explicit null clears it.

`read_session_terminal` reads bounded output belonging to the calling Session or
Thread, including retained exited terminals. Multiple terminals return candidates
for explicit selection; global focus cannot select another task's terminal.
`get_usage_limits` reads the connected Codex account's shared usage windows without
redeeming credits. `consume_usage_reset` redeems an existing credit with explicit
user authorization and a stable idempotency key for uncertain retries.
`uninstall_plugin` resolves the current installed inventory by exact ID or name,
returns candidates for ambiguous names, and verifies removal by reading the inventory
again. Nodex-managed desktop plugins are protected.

Each Nodex Profile installs its Browser, Chrome, and Computer Use peers in a separate
marketplace namespace inside the selected native Codex home. These peers stay disabled in
the shared user configuration and are enabled only in Nodex Thread configuration, so other
Codex clients retain their existing desktop tools. Nodex Threads disable foreign copies of
these peers without changing their native installation or enablement. The local composer
shows the current Profile's peers as active and omits foreign desktop copies; unrelated user
plugins remain available. Signed runtime resources and overlay configuration remain in the
Nodex Profile, separate from native credentials, configuration, and sessions.

`describe_content_schema` and `query_content` expose the same public SQL relations
as the CLI across the current Profile Library. Core verifies exact captured
execution identity in the same read snapshot. Tasks without a Project can use
both tools. Project filters are explicit query selections. Results are complete
or fail their budgets; SQL has no cursor. The argument schema comes from the
Rust contract.

Workbench content descriptions resolve Page, Database View and Canvas identity
and current titles in a metadata-only Core observation. Defaults resolve the
current View, Data Source and layout. `ContentRoutingContext` selects presentation
routing and does not restrict content access. Descriptions are Available or
Unavailable according to physical owner lifecycle. Reads load no Page body,
Canvas Document or relational rows.

`list_session_tabs` and `list_tab_groups` enumerate a bounded, revisioned Workbench
observation, including preview surfaces. Unavailable resources retain their lifecycle state. Opaque tab
handles identify the observed occurrence, never whichever tab is selected later.
Expired observations and changed presentation require a new observation.

`open_in_nodex` opens an selected file, Browser, Terminal, Review, Page, View or
Canvas in the calling Session's panel, or an explicitly selected Session. Its window
defaults to the Turn's submission window. Hidden Sessions retain their opened tabs
without navigation. Files can select a one-based line; relative paths resolve against
the target task's workspace, and workspace requests resolve within canonical selected roots. Existing Browser and Terminal identities must belong to the target Session.
Review supports last-turn, staged, unstaged and branch sources, including an explicit
base revision and file path. Source and file reveal requests are consumed once.

`navigate_to_session` selects a Session in the current Profile in that same window. Both tools
accept an explicit current window reference and return a revision-fenced apply/persistence
receipt. They never select global focus or substitute another window after a reload.
Calls without a submission window return window candidates for explicit selection.
Exact retries preserve applied receipts; a stale preflight can observe a new revision
without replaying an applied command. Plan Mode remains a planning convention.

`read_tab_content` synchronizes the exact mounted Page editor before returning
canonical content and write validators. Pending edits and presentation changes are
explicit outcomes. Reading an explicit Page with `fetch` makes no editor synchronization
claim. Markdown reads are complete or fail above 64 KiB; blocks support bounded reads.
Canvas reads provide metadata only.

For a Database View, `read_tab_content` returns the viewport, loaded, or selected
occurrences with explicit coverage and bounded property selection. `query_displayed_view`
instead executes captured effective rules, personal overrides, and search through Core.
Core checks View, schema, preference revisions and resource lifecycle in one read snapshot.
The result includes its rule fingerprint and separate display coverage; collapsed groups
remain included in the effective query. Results are complete within the requested limit
or fail their budget. Separate calls are independent observations, with no SQL cursor.

The bridge is scoped to the physical app-server connection. Restarting Nodex creates a new
private connection for restored Sessions; connection credentials are not saved in Thread
configuration. Native Turn and tool observations must match the MCP call before execution.
Cancellation, native Scope exit and generation retirement invalidate the
captured execution lease. Completing a foreground Run or starting the next Run does not revoke
original child or background work. Each observed native call retains its exact Thread, Turn,
call identity and physical connection generation until call completion, cancellation or
connection retirement. Registration has count and byte budgets; exceeding either retires
the affected connection. A caller cannot borrow a later foreground Run's identity.

Application organization commands carry the same execution provenance to Core.
Core validates it within the transaction, including receipt replay. Parent and
Project relationships route execution; they do not confer or limit content access.
Nested Agent commands remain invalid envelopes.

Session launch admission creates the destination Session and an operation receipt in one
Core transaction. It requires a live captured execution identity. Project, other-Project
and projectless destinations use the same admission boundary. Stable launch, Session
and execution identities let retries reconcile the existing binding without launching
twice or recreating a deleted Session. If the Host stops before a backend binding is
recorded, the outcome remains unconfirmed; an admission receipt alone is not evidence
of a started task. Core validates the current execution identity again on receipt replay.

`create_session` starts a Session through this admission boundary. A Runtime caller retains
its configured Provider instance unless a supported explicit model choice changes its model;
an explicit native caller uses the configured Codex default. It accepts a prompt,
optional title and model, and an explicit Project/local, Project/worktree, or projectless target.
Created Sessions are independently visible tasks; they are not hidden internal helper Threads.
Worktree starts may use the default branch, an existing branch, or the current working tree.
An explicit branch target can set `onMissing: "create-branch"` to create that exact name
from the repository's default branch when absent. Omitting this option rejects a missing
branch. Existing branches retain their history; failed worktree creation removes a newly
created branch only while it still points at the original commit.
Unspecified execution settings resolve through the destination's normal launch defaults.
The response identifies the Session, operation and accepted execution binding. Attachment
alone does not prove that the first Run completed. Use `wait_sessions` to observe completion. Failed launches retain their
Session and receipt so retries cannot silently create a second task.
The same caller Thread can reuse an operation ID and unchanged launch arguments in a later
Turn, including after restart. Every retry validates its captured execution identity;
cancelled or retired credentials cannot replay a write receipt.

`send_message_to_session` sends a follow-up to an existing unarchived Runtime Session,
including a configured ACP Session. It retains the destination's instance and settings unless
a supported model is explicitly supplied. The calling Session cannot message itself, and
an unstarted draft has no execution target. Core verifies the captured caller and exact
destination binding; the Runtime's stable message identity and durable receipt prevent a
retry from starting duplicate work. An accepted delivery identifies the Session, Thread and
operation with `deliveryState: "accepted"` without claiming completion or a replay flag.
Use `read_session` or `wait_sessions` to observe it. Explicit remote native Sessions use
their own supported execution route.

`send_to_inbox` leaves a self-contained message in the user's Inbox for work outside the
caller's task, such as a follow-up, an idea, or a question for later. The text becomes the
body of an Inbox Page, and an optional title names it. Core records the caller's chat
and Project from its verified execution source. A proven Run can send at most five
messages. A native source without causal Run evidence keeps its Run null and uses an
independent five-message budget for that native connection. A retry with the same
operation ID returns the original receipt without another message or quota charge.
The tool starts no work; Inbox triage and confirmation remain separate workflows.
The backing Page retains full Profile content access, including for planning, child
and background Agents. See [Inbox Behavior](./inbox-behavior.md).

`fork_session` captures a Runtime conversation prefix in a separate visible Session.
The selected Provider uses an exact native fork when possible and bounded portable history
otherwise; it does not borrow a rebound native incarnation.
Omitting the source selects the caller's Session. Both same-directory and worktree forks
finish workspace preparation and attach the new root to its stable product Session before
returning `forkState: "attached"` with the Session, Thread and operation identities.
Core verifies the captured caller and exact execution binding. A retry reconciles that
same destination and native workspace ownership instead of forking again. Forking does
not start a new Turn; an explicit follow-up starts work in the child, whose application
context uses its own Session identity.

`handoff_session` moves another active Session between its local checkout and managed
worktree while retaining the same Session, root Thread and conversation history. Runtime
Sessions use the durable handoff journal and the Runtime's execution hold. The move stops
active work and waits for native connection retirement before changing Git state or execution
location. Existing queued messages remain durable; queues explicitly held by the user stay
held. The next Provider execution resumes through the canonical Runtime owner at the committed
location. Runtime handoff supports the local host. An explicit remote native Codex Session
continues through its own supported local or cross-host coordinator.

Core checks the captured caller and exact Session binding. The calling Session cannot move
itself, including through a delegated child. Reusing the stable operation ID reads or resumes
the same journal operation across retries and restarts. Recovery retains the hold while native
retirement, location or Git restoration is uncertain. A Runtime follow-up uses a stable message
identity after verified completion, so retrying delivery cannot start duplicate work.

An admitted handoff shows live progress in its calling conversation. The activity binds the
operation ID to the caller, target root and requested host; Main owns the progress projection
after the tool call completes. See [Managed worktree lifecycle](codex-managed-worktree-lifecycle-behavior.md#moving-a-chat)
for Git preservation, compensation and restart recovery.

`get_handoff_status` requires both Session and operation IDs. It checks the captured
execution identity and the operation's Thread binding before and after waiting. A wait
uses revision notifications with a maximum 60-second deadline; terminal outcomes return
immediately, including retained journal outcomes after restart. Missing retained progress is
not evidence that another move is safe. Responses contain the Session/operation identity and
an `operation` progress object with revision, status and steps.

`list_sidebar_sections` returns bounded section metadata, canonical built-in identities,
revisions, and a continuation cursor. Agents can create, rename, delete, and reorder custom
sections, and move Projects or Sessions through `move_project_to_sidebar_section` and
`move_session_to_sidebar_section`. Session organization includes drafts without a Thread and
ACP Sessions. Pinned destinations use the pinning owner; default destinations clear custom
placement and pinning, returning Projects to Projects and Sessions to their ordinary Project
or Chats location. Deleting a section preserves its members and content.
Rename and delete require the observed section revision. Mutations return an operation identity
and Core receipt; retrying with that identity preserves the original command fingerprint.
`list_sidebar_section_items` pages through every direct Project and Session placement in a
custom Section, including archived items. It returns organization metadata and each placement's
identity, revision and rank; Project-inherited Sessions are not separate placements. `reorder_section`
accepts all direct placements exactly once in the requested mixed order, with their observed
revisions and ranks. Core rejects incomplete, duplicate, moved or stale placements atomically.
Unrelated Session activity does not invalidate the order. Replaying a committed operation returns
its receipt without reapplying the order.

`list_sidebar_order` reads a built-in order lane by canonical Section ID and item kind.
The Projects Section has a Project lane; Pinned has separate Project and Session lanes.
The Session lane includes all active root Session pins, including drafts and ACP Sessions,
across the Profile. Pages and Chats do not expose manual item ordering through these tools.
Each bounded page returns the same `orderRevision`; membership or position changes invalidate
its continuation. `reorder_sidebar_projects` moves the supplied Projects to the front of the
Projects or Pinned Project lane in the requested order; unlisted Projects retain their relative
order. An empty list leaves the order unchanged. Core requires unique current Project IDs and
the observed `expectedOrderRevision`, then expands the partial order inside the mutation
transaction. Exact retries retain the original request and never reorder again.
The Pinned form of `reorder_section` accepts every current `sessionId` exactly once and the
observed `expectedOrderRevision`. Stale or incomplete Session orders are rejected atomically.
Title and activity changes leave the order revision valid. Pinning, placement and lifecycle
changes update both windows through the same canonical Sidebar projections.
Organization and transcript reads use the same current Profile. Every admitted execution
can read Sessions across its Library; Project placement is a routing coordinate. Core
checks the captured execution identity, physical Library and Store epoch in the read
transaction. Cancellation or connection retirement invalidates the caller.

`set_session_title` renames an exact Session, or the calling Session when `sessionId` is omitted.
It supports threadless drafts and ACP Sessions without creating a Thread. Core accepts the title
under the captured execution identity policy before any native Codex title synchronization. The result includes
the Session identity, accepted title, and retryable operation receipt.
`set_session_archived` archives or restores a Session through the same Session owner; it preserves
native Codex descendant cleanup and ACP runtime shutdown. `set_session_pinned` sets its pin state
through Core, including the mutually exclusive custom Section placement. Both accept an exact
Session or default to the caller. A failed backend synchronization after a Session commit returns
`session_reconciliation_failed`, `committed: true`, and the operation identity to reuse for retry.

`list_sessions` and `list_archived_sessions` discover bounded Session metadata across the
current Profile, including projectless Sessions. Active discovery excludes archived
Projects. Results use pinned-first recency order with opaque continuation cursors bound
to the active or archived query. Each result identifies direct or Project-inherited sidebar
placement, title, bounded preview, backend, and status. Conversation reads use the same
Profile identity. A page contains at most 50 Sessions and fits a 32 KiB tool response;
callers reduce the limit if unusually large metadata exceeds that budget.

`wait_sessions` observes up to eight unique Sessions in the current Profile. A zero timeout returns a
snapshot; otherwise the first changed completion, request for attention, or per-target
error ends the wait. The maximum wait is two minutes. Each target returns an opaque cursor;
passing it as `afterCursor` suppresses unchanged completion/history. Timeouts return compact
status, and cancellation releases event subscriptions. Core and backend events drive bounded
status reads; the observer subscribes before its first read and does not poll full transcripts.
Only changed completed/attention targets receive a bounded latest-turn history read. Drafts
are complete with empty history; unloaded backends are explicitly unavailable. Conversation
identity is checked for each target and rechecked when history is read.

`read_session` returns a Session in the current Profile's status and newest conversation turns without
opening a window. It defaults to the calling Session, three turns, and 300 characters per text
item, with tool outputs omitted. The complete response has a 24 KiB budget; a larger response
fails explicitly so the caller can narrow its limits. Core validates the captured execution
identity before and after backend history reads. A changed backend binding discards the
result; Project movement changes routing without changing content access.
Runtime history uses bounded Run/item queries and exact ancestry without opening a native
Provider connection. Explicit native-history readers retain their own cursor and source
lifetime. Threadless drafts report empty history and do not start a backend.

## Agent content operations

The content interfaces let an agent:

- inspect Project context and available Databases/Views;
- search and fetch Pages or Blocks in the current Profile;
- execute saved Views or bounded temporary Data Source queries;
- create complete Pages;
- update Page title/body through Nested Markdown or stable Block operations;
- move or duplicate Page ownership roots;
- list, read, create/replace, rename, delete, inspect, and restore direct Page
  Files through bounded semantic operations.

Page results expose canonical `id`, nullable current `pageKey`, and bounded
matched-key evidence when a retained historical alias led to the result.
Agents may discover and discuss a Page through its key, but every structured
`pageId`/`pageIds` mutation input remains UUID-only: search resolves the key and
the write reuses the returned canonical identity.

Nested Markdown is the default bulk-content representation. Exact body patches
retain unchanged Blocks and their live collaborative nodes. One-to-one content
changes update the existing Block identity; repeated text is correlated by source
position within the matched patch, not by a document-wide content lookup.
Unchanged properties and child relationships omitted or normalized by NFM remain
with the original Block. A one-line edit therefore reports the edited Block as
updated, with no created or deleted Blocks.

An exact body patch can supply the body ETag from its observed Page as `ifMatch`.
That guard is checked during preparation and again at commit; reading a newer
Page head does not replace the caller's observation. Any intervening body change
requires a fresh read, even when the exact target text still matches. A title-only
change before preparation leaves the body guard valid and is preserved by the
patch. The prepared operation remains bound to its admitted Page head; a later
head change requires new preparation. Patches without `ifMatch` retain their
exact-match rebasing behavior before preparation.

Structural patches retain surviving positional matches and allocate identities
for new or ambiguous split/merge content. They never silently fall back to
whole-body replacement. A projection that cannot express a change without
ambiguously modifying existing Blocks fails before commit and requires explicit
Block operations. Alignment work and the compiled structural operation count are
bounded; large rewrites use smaller patches or explicit whole-body replacement.
Whole-body replacement has its own identity semantics and is not a substitute
for an unsuccessful precise edit.

Local draft apply has the same preservation contract. Its sealed baseline binds
the original Document generation and authoritative Block source locations. Edits
are inferred from base to work before current text is considered; matching text
in a newly created Block cannot substitute for the original target. Submission
uses the observed current Document head, so a change after planning rejects the
atomic title/body apply. Safe unrelated changes may merge; unsupported alignment,
structure and resource bounds never select whole-body replacement. Work files
survive rejection. Pending retries retain their exact operation and edit plan.

Stable Block operations remain the explicit identity-sensitive structural path.
Ownership never hides in Markdown: create, move, duplicate, and protected deletion
are typed semantic operations. Exact syntax is documented in
[Nested Markdown](../references/nested-markdown-spec.md).

Tool rows identify the visible intent and result and retain expandable exact
arguments/output plus raw app-server evidence. Historical calls remain readable
after their catalog becomes non-executable. Transcript presentation follows
[Codex Thread Transcript Behavior](codex-thread-transcript-behavior.md).

### Database queries

`query_database_view` executes one saved View's filter, presentation sort,
grouping, completion policy, and shared manual positions. `query_data_source`
instead executes one temporary query over a Data Source in the current Library. It accepts
a typed filter and at most four non-manual sort rules, and never inherits a saved
View's filter, grouping, completion policy, or positions. With no sort rules,
rows use stable Page-identity order.

Both tools may select up to 200 active canonical Property identities. Selection
controls both the returned Property descriptors and each row's values, including
Properties that are not displayed by a saved View. An omitted selection returns
all active Properties. Core validates filter and sort capabilities against the
current Data Source schema; Relation operands additionally require current target Data Source and Page
lifecycle. Pagination cursors are bound to the
exact source or View, query rules, and selected Property set and cannot be reused
after changing those coordinates.

## Profile access and execution lifecycle

One local user has full access to the current authenticated Profile Library.
There are no resource grants, consent overlays, inherited permission ceilings or
content read-only modes. Project is execution and presentation routing. Plan is
an Agent planning mode and does not block content, organization or Automation
writes.

Native tools retain the exact Profile, Store epoch, runtime generation, Session,
Thread and native incarnation supplied by the host. A captured Run is included only
when provider metadata proves it; otherwise Run remains null. Parent completion does
not change a child's access. Cancellation, native Scope closure, Session
lifecycle and generation retirement invalidate the affected execution lease.
Session movement changes the current Project route without replacing the exact
execution identity.

Prepared semantic writes preserve mutation-free preflight, a short-lived
connection-bound token, immutable operation identity, footprint equality,
resource lifecycle, ETag/CAS and transactional validation. These protect
correctness and exact retry; they do not implement a content permission policy.

## Native CLI and Skill

Compact discovery, public read-only SQL and atomic configuration follow
[Agent CLI queries and configuration](agent-cli-queries.md).

When the public commands and input schemas cannot express a content operation,
the bundled Skill directs the Agent to report the precise missing capability and
any completed work, without leaving a misleading partial result. Implementation
inspection and private interfaces are not fallback content routes. Another
interface requires explicit user direction; computer-use additionally requires
authorization for the current task and target instance.

The native CLI selects one Profile and, where required, one Project before
calling Core. It provides bounded context/tree/history reads, canonical Page
content, saved View queries, immutable snapshot search, explicit local drafts,
semantic Page/Block mutations, lazy Page File relation inventories, independent
Library File catalogs and exact byte
operations, backup/doctor operations, deep links, and optional Core prewarming.

Library Files are generic Agent outputs, not Artifacts or a Plan-specific channel.
Agents create Nodex-native plans and notes as ordinary child Pages; exact-format
images, scripts, PDFs, datasets, and references are independent Library Files.
An Agent adds a Page path only when the output should appear in that Page's
organized File list. File writes bind the exact Project, File identity and
revision, Store epoch, operation identity, and optional source Turn; Page entry
writes separately bind the Page manifest revision. Agents
never receive physical blob paths or read-by-hash access, and executable Files
must be materialized into the ordinary approved workspace before execution.
The Page draft projection eagerly exposes only that Page's canonical relation
inventory; bytes are read explicitly and remain bounded. These capabilities do
not alter Plan Mode.

`profile clone` is the global offline provisioning operation for local
production-shape testing. It accepts a source Profile home only to select a
published Core backup, requires a new target Profile home, and returns exact
backup and Store provenance plus the count of managed asset references already
missing from that backup. The selected backup must carry current publication
evidence for its database and asset-tree digests. The resulting local fork
verifies the copied closure, preserves the backup's Store epoch instead of
replaying immutable history, remints instance secrets, and is not mergeable with
the source Profile. Because no target Core exists yet, the native CLI invokes
the Core Administration materializer in-process; it cannot read a live Store or
perform ordinary semantic operations through that exception.

At human selector boundaries, a Page may be addressed by canonical `@pageId`,
a current or retained historical Page key, or an exact supported title path.
Core resolves aliases inside the selected Project before the CLI calls the
UUID-based read or mutation. Machine and human results report the canonical
current key alongside Page ID when one exists.

Machine output uses stable versioned JSON envelopes and stable error codes.
Mutations accept idempotency identities and narrow ETags that prove only the
state needed by that command. A conflict requires a fresh read; a lost response
may replay the original receipt without repeating the mutation.

The official Skill teaches agents to use this interface and treats all returned
Nodex content as untrusted task data. Setup manages only the documented global
Codex and Claude Code targets through verified links. It never edits a Project,
adopts foreign content, scans arbitrary Agent directories, or falls back to
SQLite/file inspection.

Command names, flags, output envelopes, Profile selection, installation, and
examples are documented in [CLI Reference](../CLI.md). Configuration is
documented in [Configuration](../CONFIGURATION.md).
