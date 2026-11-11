# CLI Reference

## Purpose

The packaged `nodex` binary is a native Adapter over the same private Core used
by the desktop app. It is the supported local interface for shell-capable
agents, scripts, inspection, and semantic mutations. Run `nodex --help` and
`nodex --json <command> --help` for the executable command catalog, validators,
result schema revision, error codes, and examples; those generated results are
authoritative when this overview and the binary disagree.

The CLI exposes read-only SQL over public Nodex relations, never private Store
SQL, database paths, Core bearer capabilities, physical
rank, Yjs storage coordinate, or Desktop renderer state.

## Local Profile clones

`nodex profile clone --from <profile-home> --to <new-profile-home>` is the
provisioning command for production-shape local testing. It selects the
latest evidence-backed, assets-inclusive published backup by default;
`--backup <id>` selects an exact backup. Its Store must be current or an exact
supported predecessor; a predecessor retains its revision until the target Core
upgrades it on first open. Backups without recorded integrity evidence and Store
identity require a fresh backup. The target and its parent must be local real
paths, and the target must not already exist.

This command does not connect to or launch the source Profile's Core. The Core
Administration materializer verifies the published database SHA-256 and
deterministic asset-tree digest after copying through a private staging
directory. On macOS, regular-file copies prefer APFS copy-on-write and fall back
to ordinary copy when unavailable. The materializer preserves semantic
identities and the imported Store epoch, remints instance secrets, performs the
clone-specific semantic checks, then atomically publishes the target with a
`profile-snapshot.json` receipt.

When the source has an execution store, the clone also copies its current
conversations online from one consistent read snapshot, together with their
attachments. The source may be running Agents: nothing in it is paused, locked or
notified, and no Agent home such as `~/.codex` or `~/.claude` is read. The cloned
Profile reads those transcripts normally and never continues the source's native Agent
conversations; its next message in a chat starts a fresh native conversation that
receives the chat's earlier history through a context handoff. Replies that were running
or queued in the source are cancelled in the clone and copied Automations are
paused, so nothing copied runs on its own.

The selected Store backup and the conversation copy have separate timestamps:
`--backup` does not rewind conversations. Historical workspace and external file paths
remain unchanged. See [development snapshots](development.md#real-profile-snapshots)
for the precise scope. It copies neither Agent credentials nor arbitrary files from
the source Profile. The receipt records the evidence-backed local-fork provenance,
execution capture evidence, and managed asset references that were already
missing from the source backup; formal restore continues to require a complete
asset closure and rotates the installed Store epoch.

`nodex backup create` creates the same Store and managed-asset snapshot as Settings →
Backups. It runs while Agents work and never pauses them.

## Profile Store checks

`nodex profile check --home <profile-home>` reports, without starting Core or
writing anything, whether this build can open a Profile's Store: `new` when
there is none yet, `current`, `upgradable` from a published predecessor, or
`incompatible` with Core's reason, such as a Store written by a newer Nodex or
by another build's unpublished revision. It decides from the Store's revision,
exact schema and Core ownership alone, so a Store that passes can still fail
the deep validation performed when Core opens it.

## Installation and capabilities

The macOS app bundle distributes the CLI and Core as one update closure. The app
menu's `Install Command Line Tool…` action manages its user-local command link;
package-manager installation may link the same bundled binary. Neither path
copies a separately updatable executable or edits shell startup files.

`nodex capabilities` is an optional, side-effect-free compatibility report used
by packaged Skill verification. It reports the Agent API, Nodex Markdown
revision, command capabilities, deep-link kinds, and packaged Skill identity
without discovering or creating Profile/Project state. An unpackaged development
binary reports an unavailable bundle. Ordinary Agent tasks use familiar commands
directly, consult command help when needed, and read `nodex context` when their
current context is unknown; a capabilities report is not a prerequisite.

## Direct input, output, and help

Structured results default to text on a terminal and JSON when captured or piped.
`--output-format auto|json|text` overrides this choice; `--json` is shorthand for
explicit JSON and conflicts with `--output-format`. Raw Page text, line windows,
diffs, and stdout File bytes keep their native representation.
Errors go to stderr; captured errors are structured even for a raw success
stream. Redirected input/output never enables prompts or pagers, including with
explicit text output. Skill installation still requires its explicit confirmation.

`nodex --help` opens with task-specific default routes, then groups commands
by task and describes each entry. SQL is the first read entry for filtering,
joins and aggregation; `read` remains the direct route for one known Page.
`nodex page show <page>` shows Page metadata and its Core-derived Turn, including
actor, reason, start time and episode. Work briefs include the
current Turn and name any blocking Prerequisite.

Related multi-Page or multi-field writes favor atomic operations, and SQL-selected
Property edits use prepare/apply to retain observed targets and versions. These
preferences guide task selection without requiring discovery before every call.
Group help lists its direct operations and explains related entrypoints: `page properties`
changes Page values, `data-source configure` changes Property definitions and
saved Views, and `page file` manages Page attachment entries.

`nodex --json <command> --help` returns the same purpose, parameter descriptions,
examples and key behavior as a structured guide without connecting to Core.
Root and group JSON directories list direct children with `purpose`, `category`
and `hasSubcommands`; follow a child’s command path for the next level. Root
JSON help also describes global arguments. Leaf entries include their effect
and result schema revision.

Command help explains scope, input/output, concurrency conditions and retry
semantics where relevant. Complex writes include complete stdin examples;
replace example resource IDs and revisions with actual observations. Ordinary
help and machine help share command definitions, behavior and examples.
`--help-schema input|result|error|all` retrieves only the requested schemas as
JSON. `nodex docs markdown` reads the same format reference bundled with
the official Skill. Read only the help needed for the current task.

Short Page content and patches accept stdin. Block JSON file flags accept `-`
for stdin. New structured operations accept bounded `--input FILE|-`; unknown
fields and invalid types are rejected. Use regular files when materializing
large results, reviewable drafts, real attachments, or persistent retry inputs.

## Agent shell routing

Desktop composes each Agent shell with its own task-bound CLI dispatcher. Its
executable and Profile take precedence over configured shell policy, inherited
Nodex routing, and working-directory changes. Configured user startup paths take
precedence over inherited user paths.

Bash chains the user's `BASH_ENV` before restoring Desktop routing. Nested Nodex
instances use the outer wrapper's recorded `NODEX_USER_BASH_ENV`, including an
empty value when no user file existed, rather than sourcing the outer wrapper.
Zsh similarly unwraps `NODEX_USER_ZDOTDIR` and restores routing after each user
startup file. Inherited exported Bash `nodex` functions are neutralized before
shell startup. Other POSIX shells use the PATH dispatcher without startup-file
chaining; Windows does not install these shell wrappers.

## Context and reads

Profile selection follows nonblank `NODEX_HOME`, the nearest project config,
the user config, then the default home. `--expect-profile ID` asserts that the
connected Core has that identity; it does not select a directory or resolve
a Profile name. A mismatch returns `PROFILE_MISMATCH` with the expected ID,
actual ID, and selected home before content operations. Refresh the host
connection context before retrying. A command that needs a Project execution context
accepts explicit identity or resolves the longest containing managed-worktree
or source root; ambiguous matches fail with stable candidates.

The primary Agent read interface is `sql schema` and `sql query`: public Page
metadata and bodies, Source values, saved View occurrences, ranked search hits,
File metadata and domain catalogs. `read PAGE` and `search QUERY --limit K`
remain convenient single-Page and ranked-search entries. Search spans the current
Library without an implicit Project filter. Search returns Page
identity, current key, title, location, and up to three merged body/Property
fragments, each bounded to 240 Unicode characters. Fragments retain Block or
Property identity; historical-key matches report the matched key separately.
UI highlighting and unrelated Properties are omitted. Use `read` for full
content and SQL for additional metadata. `context`, `ls`, `tree`,
`sed`, `history` and `rg` retain their focused terminal workflows. `open page`
and `open view` produce validated Nodex deep links.

`inbox send [TEXT]` appends one message to an Inbox from TEXT or redirected
stdin and starts no work. The text is read as message text and becomes the Page
body whole: GitHub Flavored Markdown becomes structure, a single newline is a
line break and a blank line starts the next paragraph, text that forms no markup
stays literal, and images written as `![](nodex://files/FILE_ID)` follow the
text. `--title` names it, otherwise Nodex labels it and names
it later. Inside a Project's
source or managed worktree, or with `--project`, the message lands in that
Project's Inbox as a Page on its Board. Anywhere else it lands in the Library
Inbox. The command cannot read or triage either Inbox. `--idempotency-key` makes a retry return the
original receipt.

Resource selectors accept bare IDs directly; no `@` prefix is required.
Page selectors resolve a stable `pageId` first, then a current or
historical Page key, then an explicitly unique supported title path. Key input
accepts documented case normalization, one optional leading `#`, and
no-hyphen shorthand; output reports canonical current `page_key` alongside
`page_id`. If compact input maps to more than one active Page, the command
reports ambiguity and asks for a canonical hyphenated key or `pageId` rather
than choosing one. An explicit `#` miss does not fall back to a title path.
Core resolves the alias inside the current Library before the CLI invokes the
UUID-based operation. Other selectors use stable typed
identities or an explicitly unique supported name or path. Missing or deleted alternatives remain unavailable. Terminal collection
windows retain opaque continuations; SQL queries are complete or fail their
budget and do not provide a cursor session.

## SQL reads and configuration

```text
nodex sql schema [RELATION] [--bind ALIAS=SOURCE_ID ...]
nodex sql query SQL [--param NAME=JSON ...] [--bind ALIAS=SOURCE_ID ...] [--raw]
nodex sql query --file FILE|- [--param NAME=JSON ...] [--bind ALIAS=SOURCE_ID ...] [--raw]
```

`pages` always means every active Page in the current Profile Library,
including standalone Pages. Source Property columns require an explicit binding
such as `--bind tasks=SOURCE_ID`. `--database` hints schema discovery only and
does not narrow `pages`. Start with the compact catalog, then describe a relation
or bound Source for exact columns, identities, types, options and examples.

```sh
nodex sql query 'SELECT page_id,markdown,body_etag FROM page_documents WHERE page_id=:id' --param 'id="PAGE_ID"'
nodex sql schema tasks --bind tasks=SOURCE_ID
nodex sql query 'SELECT t.page_id,t.title,d.markdown FROM tasks t JOIN page_documents d USING(page_id) WHERE t."Status"=:status LIMIT 10' --bind tasks=SOURCE_ID --param 'status="OPTION_ID"'
```

Structured SQL results contain `columns`, `rows`, `returned_count` and `snapshot`.
The snapshot identifies one observation; it is neither a write guard nor a
resumable session. `--raw` returns exactly one non-null text cell unchanged,
without a newline, and rejects explicit JSON. Ordinary queries fail rather than
silently truncate on budget exhaustion. Separate queries do not share a snapshot.

`view_rows(VIEW_ID)` preserves saved filters, hierarchy, grouping and ordering.
One Page can have multiple occurrences; count distinct Page IDs for Page totals.
Use `ORDER BY ordinal` for View/search order. `search_hits(QUERY,K)` returns top-K
Page hits before outer SQL filtering. Its count is not a total match count.

Read `data_sources.schema_revision` and `views.revision` for configuration
conditions. `data-source configure [SOURCE] --input FILE|-` atomically configures
Properties, options and Views, including complete saved filters through the
shared clause/group grammar. Updating `filter` replaces all saved filters;
omission preserves them and `null` clears them. Public catalogs and Source bindings replace the
separate Source/View read command families.

`members list` reads the Library's Members; `members me` reads the local Profile's
Member. Both include stable identity, display name, lifecycle and revision.

`page properties set PAGE --assignee me --if-revision REVISION` assigns a Page to
the local Member. Assignee accepts `member:<id>`, `me`,
`agent:<instanceId>/<model>[/<effort>]`, or `none`. Owner accepts
`--owner member:<id>` or `--owner me`. Owner and Assignee use the observed Page
work revision and can be changed together. They belong to the Page, including
standalone Pages; no Data Source selector or Property ID is needed. `--auto-start true|false`
sets whether an Agent Assignee starts on its own once its prerequisites are Done; the consent
records the Member the command acts for. Changing the Assignee revokes its consent to start
automatically, so set `--auto-start true` in a separate command after reassigning.
For Owner and Assignee, omitting `--if-revision` uses the revision observed by the
command's Page read; a concurrent edit still fails the revision precondition.

`page properties set` performs a narrow select/text/number replacement with
`--option`, `--text` or `--number` and observed `--if-revision`. Read versions from
`property_values`, or query a Source's `value_revisions` and `membership_revision`
for a batch. `page properties prepare-batch --selection FILE|- --set NAME=JSON`
preserves those original observations in typed edits accepted by
`page properties apply --input FILE|-`. It does not refresh them before writing;
conflicts reject the atomic apply. Conditions protect membership and edited
fields, not arbitrary WHERE/JOIN dependencies.

`page create-batch --input -` atomically creates 1–16 Pages at one destination,
with at most 2 MiB of combined body text. Drafts use `title_markdown`, `markdown`, and typed `values`. Separate commands are
separate transactions.
See [Agent CLI queries and configuration](product-specs/agent-cli-queries.md)
for the complete relation, execution identity, lifecycle and observation contracts.

## Drafts and mutations

`draft create` materializes one bounded Page editing workspace with immutable
base, editable work, a Page File relation inventory, and a private manifest. File
bytes remain lazy and are read through explicit semantic commands; a draft is
not a mounted checkout or authority.
The immutable baseline includes the original Document identity and the exact
mapping from Nodex Markdown byte ranges to Block identities. `draft diff` is
local and does not promise current applicability. `draft apply` derives edits
from that baseline, verifies original target identities against current authority,
and commits supported title/body changes atomically. Unrelated concurrent changes
may merge when the original targets still correspond safely. Same-text replacement
Blocks are different targets and cause a conflict.

Ordinary draft plans cannot contain whole-body replacement. Ambiguous baseline
edits (`DRAFT_AMBIGUOUS_EDIT`), changed targets (`DRAFT_CONFLICT`) and edit/request
limits (`DRAFT_EDIT_LIMIT`) reject the entire apply and preserve work files. Invalid
or unsupported Markdown changes also fail before commit. Use explicit Block
operations for structure that cannot be represented safely; `page replace` remains
a separate, intentional whole-body operation with its own identity semantics.
Pending retries replay the exact saved edit plan and operation identity.
`draft discard` removes only a validated generated draft.

`page insert PAGE` defaults to the end; explicit anchors select another position.
`page accept PAGE` accepts work in In Review and moves it to Done, for the person or for
the Member an Agent acts for. Agents accept their own work only when the person told them
to. Other stages stay unchanged. A prerequisite waits for Done, including when its chat has
reported ready.

`page rename PAGE TITLE --if-match ETAG` changes only the title. Structured
`read` and SQL provide title/body validators from the observed state. Use
`page prepare PAGE --operation move|delete [--view VIEW_ID]` for operation-specific
conditions; View scope is valid only for move. Reuse these conditions without
silently refreshing them before a write.

Semantic mutation families create, duplicate, move, rename, replace, patch,
insert, or delete Pages and stable Blocks. Bodies use Nodex Markdown in one
`markdown` field. Fetches, exact patches and drafts use the same language;
`nodex docs markdown` teaches GFM and its directives. Exact patches preserve
unchanged Block identities and live nodes;
one-to-one edits update the existing Block. Explicit identity-sensitive structure
uses the bounded JSON Block form. Patches never fall back to whole-body replacement
when correspondence is ambiguous; see [Agent content behavior](product-specs/agent-interface-behavior.md).
Page deletion always uses the typed lifecycle path. For a nested Page, the
headless CLI resolves and fences the current canonical host Document inside the
same writer transaction; it never emits a generic Document deletion.
Move and View placement consume one exact validator and commit membership,
group value, position, ownership, Documents, projections, and receipt as one
semantic operation.

For a Data Source destination, `page create`, `page create-batch`,
`page move`, and `page duplicate` return a compact `status` object with
`option_id` and the destination's current `label`. Omit the group to keep a
valid carried value or use the destination default. `--unassigned` explicitly
selects the empty group. Clearing Status that way or with an explicit null
value returns `INVALID_INPUT` with the valid IDs and current names.

Ordinary mutations accept an optional stable idempotency key; drafts manage their own apply identity. Narrow ETags bind the current
resource and guard kind; they are not capabilities. An exact retry returns the
first immutable result, including a body patch whose original text is no longer present. Core resolves the receipt before checking current patch matches. A stale or mismatched guard fails before mutation and
requires a fresh read.

Native application MCP tools use the parameter `idempotencyKey` for their optional retry
key: an opaque string of 1–128 characters, omitted on first attempts and reused with identical
arguments after an unseen outcome. Their host-issued `operationId` values are returned
receipt or progress handles. CLI content mutations continue to expose their existing
`--idempotency-key` flag and draft apply identities.

## Automations

`nodex automations list` lists Automations with bounded search and cursors; `automations show <id>`
reads one. `automations create --file <path|->` accepts a Core Automation JSON definition.
`automations update <id> --if-revision <revision> --status active|paused --file <path|->`
replaces it. `automations pause|resume|delete <id> --if-revision <revision>` retains the
observed revision. Every write accepts `--idempotency-key` for an uncertain retry.

`automations run <id>` records a manual dispatch, confirms a waiting Ask first decision or
retries its frozen action, for the Owner or an Agent acting for them. Agents confirm a waiting
decision only when the person asked. Repeating its operation key retains the same dispatch.
Dry run records only; Ask first waits in the Inbox; Run starts under the Automation Owner's
grant. Only that Owner can change mode, edit an Automation set to Run or run it now. An
Agent's calls carry its Member's authority under the same rules; for a change only another
Member may make, it proposes the change through `automations_update` for that Owner to review.
See [Automations behavior](product-specs/automations-behavior.md).

## Pause Agent work

`nodex work pause --page <selector>`, `--project <selector>`, or `--space` creates a
durable hold owned by the person, or by the Member an Agent acts for. `nodex work resume`
with the same scope clears only that hold; parent holds continue to apply. `nodex work holds`
lists scope, person, revision and pause time. Use `--idempotency-key <key>` to retry the
same pause or resume. Agents resume work the person paused only when asked.

## Library Files and Page relations

`nodex file` manages Library Files in the current authenticated Profile.
Project is an optional presentation and workspace coordinate. A File has a stable identity, a default name, a metadata revision,
and an immutable version history. Page paths belong to Page relations.

```text
nodex file import --from ./api.md [--name api.md] [--mime text/markdown]
nodex file read <file-id> [--version 1] --output -
nodex file rename <file-id> --name reference.md --if-revision 1
nodex file replace <file-id> --from ./api.md --if-revision 1 --if-head 1
nodex file fork <file-id> --version 1 --name independent.md
nodex file restore <file-id> --version 1 --if-revision 2 --if-head 2
nodex file trash <file-id> --if-revision 3
nodex file untrash <file-id> --if-revision 4
nodex file purge <file-id> --if-revision 5
```

`replace` changes the shared content seen by all current uses. `restore`
publishes retained bytes as a new content head; `fork` creates an independent
File. Rename changes the default name without rewriting Page paths. Trash
requires no current or recoverable Page uses. Purge requires a trashed File
with no history, draft, or other File retention roots. An unused live File is
retained until explicitly trashed and purged.

`nodex page file list` reports the deduplicated explicit entries and body-only
uses, including current File metadata, Page paths, body counts, and attachment
provenance. JSON includes `attachment: { attached_by, attached_at }` for explicit
entries and `attachment: null` for body-only uses. The actor is `person`,
`agent` (with its product `session_id` and `backend` family: `codex`, `claude`,
`opencode` or `acp`), `external`, or `unknown`. Unknown historical origins have
no attachment time; other entries have a Core-authored RFC3339 time. Human output
uses one compact row per File. JSON download receipts from `page file read` also
include `attachment`.

Agents that Nodex runs receive `NODEX_AGENT_ATTRIBUTION` with their CLI command
or shell binding: a credential Core issued for that chat. The CLI presents it, and
Core records the chat as the actor of the content it changes. A missing or
unverifiable credential attributes nothing; those changes are `external`.

Renaming paths, transferring entries, and copying or structurally restoring
Pages preserve attachment evidence. Replacing an entry or removing and later
reattaching it records a new actor and time. File creation/version evidence and
shared File updates are independent of Page attachment provenance. The
`page_files` SQL relation exposes `attached_by_json` and `attached_at` alongside
the existing entry and body-use columns.

`nodex page file` manages Page relations and reads their current bytes:

```text
nodex page file list <page-selector> [--query report] [--limit 50] [--cursor <cursor>]
nodex page file read <page-selector> --file-id <file-id> --output -
nodex page file read <page-selector> --path references/api.md --output ./api.md
nodex page file put <page-selector> --path references/api.md --from ./api.md --if-manifest 0 [--replace-entry]
nodex page file add <page-selector> --file-id <file-id> --path api.md --if-manifest 0
nodex page file rename-path <page-selector> --file-id <file-id> --path references/api.md --if-manifest 1
nodex page file remove <page-selector> --file-id <file-id> --if-manifest 2
nodex page file replace-entry <page-selector> --file-id <file-id> --from ./api.md --if-manifest 2
nodex page file move <page-selector> --file-id <file-id> --to <target-page> --path api.md --if-source-manifest 2 --if-target-manifest 0
nodex page file copy <page-selector> --file-id <file-id> --to <target-page> --path api.md --if-source-manifest 2 --if-target-manifest 0
```

The SQL `page_files` relation combines explicit entries and body uses, deduplicated by File ID.
Body-only uses have no logical path. Reads require exactly one `--file-id` or
`--path`. Core validates the exact File source, version and current lifecycle.
Independent File history and shared edits use the same Profile identity. Copying
or moving a relation binds both Page manifests atomically.

`put` rejects path collisions by default. `--replace-entry` and `replace-entry`
create a new File and retarget only this Page relation; the original File,
other Pages, and body references remain unchanged. `remove` removes the relation
and retains the File and body uses. Path resolution for `put` occurs inside the
idempotent Core transaction, so retries return the original result even after
the Page namespace changes.

File writes accept optional `--idempotency-key`, independently of output format. Omission creates a new operation; save an explicit key before a retryable operation. Repeat the
same key with the same arguments, revisions, and bytes. Existing File writes
require `--if-revision`; content writes also require `--if-head`. Read these
conditions from `files.revision` and `files.head_version`; `file_versions` and
`file_usages` expose retained history and visible usage. Page relation writes
require `--if-manifest`, and transfers require both Page revisions. Observe
`pages.file_manifest_revision`, including on Pages with no current File uses.
The CLI never silently refreshes a write fence. Mutation results contain the
operation ID, duplicate flag, commit cursor, `file_mutation`, and `page_file_entries`.

Source files and outputs must be regular files; final symlinks and special files
are rejected. Inputs are bounded to 64 MiB. Import from stdin requires `--name`;
replacement from stdin requires `--mime`. Page `put` can infer MIME from its
explicit virtual path. Exact stdout bytes use `--output -` without `--json`;
JSON downloads require an output path and return a download receipt. Portable
Page paths use `/`, reject traversal and case-folded conflicts, and never expose
Profile paths or Blob-hash read capabilities.

## Search leases

`nodex rg` asks Core for a short-lived immutable projection of current Profile Page
metadata and canonical content. The CLI validates the lease manifest, paths,
permissions, lengths, and hashes before running the bundled ripgrep with the
supported read-only flags. Physical lease paths are never writable inputs and
are released after success, failure, or interruption.

## Service and diagnostics

`nodex service status|enable|disable` controls optional packaged Core prewarming;
normal commands always retain authenticated on-demand startup. `nodex doctor`
and typed validation reports are the supported storage diagnostics.

The retired JavaScript HTTP launcher and private storage inspection interfaces
are not supported. External automation uses this CLI;
desktop UI uses typed preload/Main Adapters.

## Agent Skill setup

`nodex setup` and `nodex skills status|install|remove|doctor` manage only the
official global Codex and Claude Code Skill targets. They verify the packaged
artifact and create/remove only an exact managed link. Existing foreign files,
directories, and links are reported as compatible or conflict and are never
adopted, overwritten, or force-repaired.

The product-level execution identity contract is in
[Agent Interface Behavior](product-specs/agent-interface-behavior.md).

## Agent task evaluation

See [CLI Agent evaluation](CLI_AGENT_EVALUATION.md) for the optional paid, isolated task suite and evidence-driven improvement workflow.

## Space remote access

`nodex space remote-access on|off|status` controls the local private-peer
listener. `space link-device` enrolls another Device of your own Member through
a five-minute one-time offer. `space devices` and `space revoke-device ID`
manage your Devices, and `space display-name NAME` sets the name other Members
see for you; an Owner may administer all Devices, invite and remove
Members, list Members and rename the Space. These share `serve` administration.

To administer a remote Space, use
`nodex --remote-connection /absolute/private.json space ...`. The owned mode-0600
file selects an HTTPS origin, full leaf-certificate fingerprint, Space ID and
Device credential. Verification fails without local fallback. See
[Team Spaces](product-specs/team-space-behavior.md#administration-surfaces) for
the file contract. Listener, certificates, backups and shutdown stay local.
