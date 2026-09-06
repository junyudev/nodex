# Agent Interface Behavior

## CLI-first local interface

The packaged native `nodex` CLI and official Agent Skill are the default content
interface for local shell-capable Agents and scripts. Direct reads, stdin
writes, typed queries, property edits, and atomic Page creation share Core
semantics with the desktop. See [CLI Reference](../CLI.md) for command behavior.

Native CLI calls use the selected Profile and Project access context. They do
not carry a verified Codex Turn identity. Internal dynamic tools use trusted
host Turn authorization; the two authorization paths are not interchangeable.
Neither exposes SQL or private storage as a content-editing interface.

The host supplies an executable/Skill and pinned Profile/Project prefix for each
eligible Turn, including resumed tasks. Automatic connection is limited to
local, Project-bound, non-Plan tasks using the verified built-in Full access
mode and an available CLI/Skill build. Missing context, remote execution, or
restricted modes produce explicit unavailable context, replacing old connection
instructions. This is connection availability, not an additional permission
grant. CLI access remains checked by Core for every operation.

`nodex_app` is an experimental, default-off interface controlled by the
`nodex-dynamic-tools` development feature. The same startup setting gates new
catalog registration and execution before authority reads, approval UI, or
Core preparation. Historical calls remain readable. Restoring a task with an
old catalog cannot bypass the gate; disabled execution reports
`tool_catalog_stale` with domain code `NODEX_DYNAMIC_TOOLS_DISABLED`, without
suggesting that a new task or automatic CLI fallback will restore access.

## `nodex_app`

When the development feature is enabled, an eligible task keeps the catalog revision with which it started. A retired
catalog fails explicitly and asks the user to start a new task; resume never
silently changes the tool contract.

The current intent families let an agent:

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

Nested Markdown is the default bulk-content representation; stable Block
operations are the identity-sensitive path. Ownership never hides in Markdown:
create, move, duplicate, and protected deletion are typed semantic operations.
Exact syntax is documented in [Nested Markdown](../references/nested-markdown-spec.md).

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

Every write performs mutation-free preflight and revalidates the exact Turn,
authority, resource footprint, and semantic preconditions at execution. Consent
changes who may approve an operation; it never bypasses conflict, identity,
ownership, or content validation.

## Native CLI and Skill

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
