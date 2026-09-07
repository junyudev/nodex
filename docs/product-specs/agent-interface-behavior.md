# Agent Interface Behavior

## CLI-first local interface

The packaged native `nodex` CLI and official Agent Skill are the default content
interface for local shell-capable Agents and scripts. Direct reads, stdin
writes, typed queries, property edits, and atomic Page creation share Core
semantics with the desktop. See [CLI Reference](../CLI.md) for command behavior.

Native CLI calls use the selected Profile and Project access context. They do
not carry a verified Codex Turn identity. Native application tools use trusted
host Turn authorization; the two authorization paths are not interchangeable.
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

Automatic connection is limited to local, Project-bound, non-Plan tasks using
the verified built-in Full access mode and an available CLI/Skill build. Missing
context, remote execution, or restricted modes replace both old connection
instructions and the task's executable binding with unavailable state. This is
connection availability, not an additional permission grant: shell identity and
PATH are mutable, and unrestricted shell access is not a security sandbox.
CLI access remains checked by Core for every operation.

## Native application MCP

Native application MCP currently supports local Codex execution. ACP and remote
execution integration, sharing and publishing services, Cloud task destinations,
realtime voice, and `fire_confetti` remain unsupported application-tool capabilities.
Voice-session screen capture and ending a realtime voice call are also unavailable.
These capabilities have no substitute tools or placeholder success responses.

`load_workspace_dependencies` reads the managed Node/Python executable paths, Python import
directory and installed document-library versions. It performs no package installation and
requires a current calling Turn; Plan Mode can inspect it. The Python closure supports Word,
PowerPoint, spreadsheet, PDF and image operations. Recommended `-I -B` arguments isolate imports
and avoid bytecode writes. Missing, invalid or unsupported distributions return an explicit
unavailable result without selecting a system runtime. See [workspace runtime distribution](../../resources/workspace-runtime/README.md).

Native tool discovery, capability reporting, and per-Thread tool visibility share one catalog.
Fresh Sessions, live resumes, forks, imported tasks, side chats, managed worktrees, and scheduled
runs refresh that catalog through the same configuration boundary. New local Threads register
no dynamic tools. Internal title generation has no application tools. An execution endpoint
without the native bridge receives no application catalog or private connection configuration.
Tool visibility never substitutes for the calling Turn's authority.

Historical dynamic tool results remain readable. Local `nodex_app` content calls and `codex_app`
application calls are rejected before renderer forwarding or pending request storage. Interactive setup
reports unavailable through application tools. Resuming an old task does not reactivate its
retired dynamic catalog or select an automatic fallback transport.

The native catalog includes `get_context`, `search`, `fetch`, `query_database_view`,
`query_data_source`, `create_pages`, `update_page`, `advanced_update_page`, `move_pages`,
and `duplicate_page`. These use the canonical Agent content contracts and semantic
execution owner. Calls bind the backend-observed Thread and Turn to frozen Core authority;
arguments cannot supply execution identity. Resource consent rechecks the same invocation
and authority before granting access. Mutations retain stable operation identities, and
results must satisfy their content contract and the complete-response byte budget.

Local Codex Sessions use the bundled `nodex_app` MCP server when the verified Node runtime
is available. `get_session_context` returns the calling Session, Thread, Turn, Project, Host,
and working directory. Execution identity cannot be supplied in arguments. Its default
`anchored` mode describes the submitting Window and Scene captured for the Turn;
`refresh` explicitly observes that Window's current Scene. Exact discovered targets
can be selected explicitly. Ambiguous windows return candidates instead of guessing.
Missing Session or presentation context is reported explicitly. This operation reads
metadata, not Page content.

`list_projects` discovers available Projects and their local workspace paths. Git inspection
distinguishes a repository, a non-repository directory, an unavailable inspection, and a Project
without a workspace. Project discovery does not grant Page or Database access.
`get_app_capabilities` reports the tools actually registered on this connection and distinguishes
execution identity, Project SQL reads, live Workbench access, and unavailable sharing
and cloud capabilities.

`automation_update` lists, searches, reads, creates, replaces and deletes scheduled
Codex tasks. List results contain only currently authorized targets and use bounded
cursors. Cron tasks select an explicit Project and its folders, or a projectless
local run. Heartbeats target a stable Session; omitting the target selects the
caller’s Session. Notification preferences are separate from the task prompt.
Read the definition before editing or deleting and retain its `definitionRevision`
as `expectedRevision`. An update carries the complete replacement definition,
including values that should be preserved. The response returns the committed
definition and operation ID. Retry an uncertain write with the same operation ID,
revision and arguments; the same caller Thread can reconcile it across Turns and
restarts without creating or updating twice. Current writable Turn authority and
target access are checked again on every retry. See
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

`describe_content_schema` and `query_content` expose the same public SQL relations as the CLI,
using the calling Project's durable resource grants. Core verifies the exact frozen Turn before
querying within one read snapshot. Library scope and temporary call/task consent do not expand
this query universe. Results are complete or fail; SQL has no cursor, and oversized tool results
require a narrower query. The SQL argument schema is generated from the Rust contract.
Tasks without a Project cannot use these two SQL tools, including with Full access;
they return `project_context_required` because this query universe requires durable Project grants.

Workbench content descriptions resolve Page, Database View, and Canvas identities and current
titles in the same Core read snapshot that checks the frozen Turn and current resource access.
Project and Database defaults resolve to their current View, including its Data Source and layout.
The displayed Project or Library context identifies the surface; it grants no Agent access.
Page and View descriptions honor existing call/task consent. Embedded Canvas descriptions follow
their owning Page access; standalone Canvases require an existing Project Canvas grant or verified
Library scope. Restricted descriptions contain only a reason, with no content identity or title.
Description reads do not load Page bodies, Canvas documents, or database rows.

`list_session_tabs` and `list_tab_groups` enumerate a bounded, revisioned Workbench
observation, including preview surfaces. Restricted tabs remain redacted. Opaque tab
handles identify the observed occurrence, never whichever tab is selected later.
Expired observations and changed presentation require a new observation.

`open_in_nodex` opens an authorized file, Browser, Terminal, Review, Page, View or
Canvas in the calling Session's panel, or an explicitly selected Session. Its window
defaults to the Turn's submission window. Hidden Sessions retain their opened tabs
without navigation. Files can select a one-based line; relative paths resolve against
the target task's workspace, and Project-scoped requests stay within canonical workspace
roots. Existing Browser and Terminal identities must belong to the target Session.
Review supports last-turn, staged, unstaged and branch sources, including an explicit
base revision and file path. Source and file reveal requests are consumed once.

`navigate_to_session` selects an authorized Session in that same window. Both tools
accept an explicit current window reference and return a revision-fenced apply/persistence
receipt. They never select global focus or substitute another window after a reload.
Calls without a submission window return window candidates for explicit selection.
Exact retries preserve applied receipts; a stale preflight can observe a new revision
without replaying an applied command. Plan Mode rejects both presentation mutations.

`read_tab_content` synchronizes the exact mounted Page editor before returning
canonical content and write validators. Pending edits and presentation changes are
explicit outcomes. Reading an explicit Page with `fetch` makes no editor synchronization
claim. Markdown reads are complete or fail above 64 KiB; blocks support bounded reads.
Canvas reads provide metadata only.

For a Database View, `read_tab_content` returns the viewport, loaded, or selected
occurrences with explicit coverage and bounded property selection. `query_displayed_view`
instead executes captured effective rules, personal overrides, and search through Core.
Core checks View, schema, preference revisions and content authority in one read snapshot.
The result includes its rule fingerprint and separate display coverage; collapsed groups
remain included in the effective query. Results are complete within the requested limit
or fail their budget. Separate calls are independent observations, with no SQL cursor.

The bridge is scoped to the physical app-server connection. Restarting Nodex creates a new
private connection for restored Sessions; connection credentials are not saved in Thread
configuration. Native Turn and tool observations must match the MCP call before execution.
Turn completion, cancellation, and connection closure withdraw application work.
Content-tool consent uses the shared application authority policy. Resource planning, approval,
and task-grant extensions recheck the captured authority; an expired binding cannot become
usable again. Discovering a tool or Project never creates a resource grant.

Each accepted Turn freezes an execution policy alongside its resource authority. Plan Mode,
read-only permissions, and unverified external sandbox policies permit reads only. Resource
consent and Full access scope cannot override this constraint. Derived tasks inherit a parent's
read-only restriction. The Core checks this policy during resource planning and write admission.
Application organization commands carry this same frozen Turn provenance to Core. Core validates
the caller and writable policy inside the mutation transaction, including receipt replay.
The allowed organization commands cannot change Project permissions, Thread authority, or
Session content links; nested Agent commands are rejected. This boundary does not itself
register additional tools in the connection catalog.

Session launch admission creates the destination Session and a request-bound receipt in one
Core transaction. It requires a writable Turn with access to the destination Project;
projectless or other-Project launches require Library scope. The receipt binds a SHA-256
digest of the complete normalized launch request. Only a fresh receipt admits a backend
launch. Replays reconcile the existing Session binding and never repeat the launch or
recreate a deleted Session. If the Host stops before a backend binding is recorded, the
outcome remains unconfirmed; an admission receipt alone is not evidence of a started task.
Current caller authorization is checked again before returning a replayed receipt.

`create_session` starts a Codex Session through this admission boundary. It accepts a prompt,
optional title and model, and an explicit Project/local, Project/worktree, or projectless target.
Created Sessions are independently visible tasks; they are not hidden internal helper Threads.
Worktree starts may use the default branch, an existing branch, or the current working tree.
An explicit branch target can set `onMissing: "create-branch"` to create that exact name
from the repository's default branch when absent. Omitting this option rejects a missing
branch. Existing branches retain their history; failed worktree creation removes a newly
created branch only while it still points at the original commit.
Unspecified execution settings resolve through the destination's normal launch defaults.
The response always identifies the Session and operation; immediate starts include a Thread ID,
while queued worktrees include pending and client Thread identities. A replay reports `attached`
when a backend binding exists, otherwise `unconfirmed`; attachment alone does not prove that the
first Turn completed. Use `wait_sessions` to observe completion. Failed launches retain their
Session and receipt so retries cannot silently create a second task.
The same caller Thread can reuse an operation ID and unchanged launch arguments in a later
Turn, including after restart. Every retry revalidates the current Turn's authority; read-only
or out-of-scope callers cannot replay a write receipt.

`send_message_to_session` starts a follow-up Turn in an existing, unarchived Codex Session.
It retains the destination's settings unless a model is explicitly supplied. Threadless and
ACP Sessions are unavailable for this command, and a caller cannot message its own Session.
Core checks the caller's current writable authority, target Project access, and exact active
Session/Thread binding before reserving dispatch. The receipt binds the normalized message
and target; only a fresh receipt permits a send. The same caller Thread may retry across Turns
and restarts, but a retry never resends. A fresh successful response includes the accepted Turn
ID; failed dispatch and replay report unconfirmed delivery. Use `read_session` or `wait_sessions`
to inspect progress; a reservation alone does not establish that the message was delivered.

`fork_session` copies completed Codex conversation history into a separate visible Session.
Omitting the source selects the caller's Session. Same-directory forks attach immediately;
worktree forks return pending work and a client Thread identity. Core first reserves the
stable destination Session under current source-Project authorization and exact Thread binding.
The normal fork owner attaches its accepted Thread to that destination, including deferred
worktree execution. Retrying the same operation never forks again: it returns the destination's
attached Thread or unconfirmed state. Forking does not start a new Turn; a separately authorized
follow-up starts work in the child, whose application context uses its own Session identity.

`handoff_session` moves another active Codex Session through the existing local or cross-host
handoff coordinator. Omit the destination host for the current-host checkout/worktree toggle.
Core checks current writable authority and the exact Session binding before reserving the
normalized request. Only fresh admission starts the operation; retries across Turns and
restarts read its retained progress or report unconfirmed dispatch, never move again. The
calling Session cannot move itself. A follow-up prompt uses the coordinator's post-commit
at-most-once dispatch. Threadless and ACP Sessions are unavailable for this command.

An admitted native handoff shows live progress in its calling conversation. The activity binds
the returned operation ID to the calling thread, target thread, and requested host; Main owns
the progress projection even after the tool call completes.

`get_handoff_status` requires both Session and operation IDs. It checks current read access
and the operation's Thread binding before waiting and checks access again afterward. A wait
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
These tools change organization only and do not grant access to Session transcripts or content.
Core authorizes Session transcript reads separately: a Project-scoped Turn can read Sessions
in that Project, while a verified built-in Full access Turn can read Sessions across the same
Profile's Library. Read-only execution still permits these reads. Caller identity, current
Project ownership, frozen authority, and Store epoch are checked in the read transaction;
supplying a wider scope or discovering a Session in the sidebar does not grant that access.

`set_session_title` renames an exact Session, or the calling Session when `sessionId` is omitted.
It supports threadless drafts and ACP Sessions without creating a Thread. Core accepts the title
under the frozen Turn policy before any native Codex title synchronization. The result includes
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
placement, title, bounded preview, backend, and status. Discovery does not authorize
conversation reads. A page contains at most 50 Sessions and fits a 32 KiB tool response;
callers reduce the limit if unusually large metadata exceeds that budget.

`wait_sessions` observes up to eight unique authorized Sessions. A zero timeout returns a
snapshot; otherwise the first changed completion, request for attention, or per-target
error ends the wait. The maximum wait is two minutes. Each target returns an opaque cursor;
passing it as `afterCursor` suppresses unchanged completion/history. Timeouts return compact
status, and cancellation releases event subscriptions. Core and backend events drive bounded
status reads; the observer subscribes before its first read and does not poll full transcripts.
Only changed completed/attention targets receive a bounded latest-turn history read. Drafts
are complete with empty history; unloaded backends are explicitly unavailable. Conversation
permission is checked for each target and rechecked when history is read.

`read_session` returns an authorized Session's status and newest conversation turns without
opening a window. It defaults to the calling Session, three turns, and 300 characters per text
item, with tool outputs omitted. The complete response has a 24 KiB budget; a larger response
fails explicitly so the caller can narrow its limits. Core authorization is checked before and
after backend history access, and a changed Project or backend binding discards the result.
Codex history uses its existing history owner and cursor. Retained ACP history uses snapshot-bound
cursors that fail after the snapshot changes; an unloaded ACP backend reports unavailable history.
Threadless drafts report empty history and do not start a backend.

## Agent content operations

The content interfaces let an agent:

- inspect Project context and available Databases/Views;
- search and fetch authorized Pages or Blocks;
- execute saved Views or bounded temporary Data Source queries;
- create complete Pages;
- update Page title/body through Nested Markdown or stable Block operations;
- move or duplicate Page ownership roots;
- list, read, create/replace, rename, delete, inspect, and restore direct Page
  Files through bounded semantic operations.

Page results expose canonical `id`, nullable current `pageKey`, and bounded
matched-key evidence when an authorized historical alias led to the result.
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
instead executes one temporary query over an authorized Data Source. It accepts
a typed filter and at most four non-manual sort rules, and never inherits a saved
View's filter, grouping, completion policy, or positions. With no sort rules,
rows use stable Page-identity order.

Both tools may select up to 200 active canonical Property identities. Selection
controls both the returned Property descriptors and each row's values, including
Properties that are not displayed by a saved View. An omitted selection returns
all active Properties. Core validates filter and sort capabilities against the
current Data Source schema; Relation operands additionally require current read
access to the target Data Source and Page. Pagination cursors are bound to the
exact source or View, query rules, and selected Property set and cannot be reused
after changing those coordinates.

## Authorization

Reads follow current Project resource access. Direct `Read & write` authority
executes writable intent after semantic validation. `Read` or known ungranted
same-Library resources require resource-scoped consent for writes. The consent
choices cover one exact call, the root task lifetime, or a durable Project grant;
only the durable choice writes Project grants.

A Turn started with the built-in Full access preset receives temporary same-
Library authority for that exact Turn. It does not create grants, cross a
Profile/Library/store epoch, or transfer to later Turns merely because the UI
setting changed.

Tasks without a Project receive this authority only when their persisted permission
preset is Full access at Turn start. Core verifies their current root task and exact
Turn just as it does for Project tasks. Their actor Project remains null in receipts
and audit records; a content resource never supplies a substitute execution Project.
Explicit Library destinations allow content creation, and Workbench reads check each
resource independently. Plan Mode permits authorized reads but rejects content and
Automation mutations. Later Turns recapture authority from the persisted preset.

Every write performs mutation-free preflight and revalidates the exact Turn,
authority, resource footprint, and semantic preconditions at execution. Consent
changes who may approve an operation; it never bypasses conflict, identity,
ownership, or content validation.

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
The Page draft projection eagerly exposes only that Page's authorized relation
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
an authorized current or historical Page key, or an exact supported title path.
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
