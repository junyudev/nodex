# CLI Reference

## Purpose

The packaged `nodex` binary is a native Adapter over the same private Core used
by the desktop app. It is the supported local interface for shell-capable
agents, scripts, inspection, and semantic mutations. Run `nodex --help` and
`nodex --json <command> --help` for the executable command catalog, validators,
result schema revision, error codes, and examples; those generated results are
authoritative when this overview and the binary disagree.

The CLI never exposes a database path, raw SQL, Core bearer capability, physical
rank, Yjs storage coordinate, or Desktop renderer state.

## Local Profile clones

`nodex profile clone --from <profile-home> --to <new-profile-home>` is the
offline provisioning command for production-shape local testing. It selects the
latest current evidence-backed, assets-inclusive published backup by default;
`--backup <id>` selects an exact current backup. Create a fresh backup when only
an older manifest exists. The target and its parent must be local real paths,
and the target must not already exist.

This command does not connect to or launch the source Profile's Core. The Core
Administration materializer verifies the published database SHA-256 and
deterministic asset-tree digest after copying through a private staging
directory. On macOS, regular-file copies prefer APFS copy-on-write and fall back
to ordinary copy when unavailable. The materializer preserves semantic
identities and the imported Store epoch, remints instance secrets, performs the
clone-specific semantic checks, then atomically publishes the target with a
`profile-snapshot.json` receipt. It copies neither Agent credentials nor
arbitrary files from the source Profile. The receipt records the evidence-backed
local-fork provenance and reports managed asset references that were already
missing from the source backup; formal restore continues to require a complete
asset closure and rotates the installed Store epoch.

## Installation and capabilities

The macOS app bundle distributes the CLI and Core as one update closure. The app
menu's `Install Command Line Tool…` action manages its user-local command link;
package-manager installation may link the same bundled binary. Neither path
copies a separately updatable executable or edits shell startup files.

`nodex capabilities --json` is a side-effect-free compatibility handshake. It
runs before Profile/Project discovery and reports the Agent API, Nested Markdown
revision, command capabilities, deep-link kinds, and packaged Skill identity.
An unpackaged development binary reports an unavailable bundle rather than
creating Profile state.

## Context and reads

Profile selection follows nonblank `NODEX_HOME`, the nearest project config,
the user config, then the default home. A command that needs Project authority
accepts explicit identity or resolves the longest containing managed-worktree
or source root; ambiguous matches fail with stable candidates.

The primary read families are:

- `context` and `tree` for bounded Project/Library orientation;
- `read` for canonical Page metadata and `body.nested.md`;
- `history` for a retained cursor timeline;
- `view query` for one saved View's persisted query and row order;
- `rg` for exact read-only search over a Core-issued immutable snapshot lease;
- `open page` and `open view` for validated Nodex deep links.

Page selectors resolve canonical `@pageId` first, then an authorized current or
historical Page key, then an explicitly unique supported title path. Key input
accepts documented case normalization, one optional leading `#`, and
no-hyphen shorthand; output reports canonical current `page_key` alongside
`page_id`. If compact input maps to more than one authorized Page, the command
reports ambiguity and asks for a canonical hyphenated key or `@pageId` rather
than choosing one. An explicit `#` miss does not fall back to a title path.
Core resolves the alias inside the selected Project before the CLI invokes the
UUID-based operation. Other selectors use stable typed
identities or an explicitly unique supported name or path. Unauthorized
alternatives are never returned as disambiguation evidence. All growing
collections are bounded and use opaque continuations.

## Drafts and mutations

`draft create` materializes one bounded Page editing workspace with immutable
base, editable work, a Page File relation inventory, and a private manifest. File
bytes remain lazy and are read through explicit semantic commands; a draft is
not a mounted checkout or authority.
`draft diff` is local. `draft apply` rereads current authority, semantically
merges the supported title/body changes when safe, and commits them atomically.
`draft discard` removes only a validated generated draft.

Semantic mutation families create, duplicate, move, rename, replace, patch,
insert, or delete Pages and stable Blocks. Nested Markdown is the normal bulk
content format; identity-sensitive structure uses the bounded JSON Block form.
Page deletion always uses the typed lifecycle path. For a nested Page, the
headless CLI resolves and fences the current canonical host Document inside the
same writer transaction; it never emits a generic Document deletion.
Move and View placement consume one exact validator and commit membership,
group value, position, ownership, Documents, projections, and receipt as one
semantic operation.

Every mutation accepts a stable idempotency key. Narrow ETags bind the current
resource and guard kind; they are not capabilities. An exact retry returns the
first immutable result. A stale or mismatched guard fails before mutation and
requires a fresh read.

## Library Files and Page relations

`nodex file` manages independently authorized Library Files in the selected
Project. A File has a stable identity, a default name, a metadata revision,
and an immutable version history. Page paths belong to Page relations.

```text
nodex file list [--trashed] [--query text] [--after cursor] [--limit 200]
nodex file info <file-id>
nodex file import --from ./api.md [--name api.md] [--mime text/markdown]
nodex file read <file-id> [--version 1] --output -
nodex file rename <file-id> --name reference.md --if-revision 1
nodex file replace <file-id> --from ./api.md --if-revision 1 --if-head 1
nodex file fork <file-id> --version 1 --name independent.md
nodex file versions <file-id> [--after cursor] [--limit 200]
nodex file restore <file-id> --version 1 --if-revision 2 --if-head 2
nodex file usages <file-id> [--after cursor] [--limit 200]
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

`nodex page file` manages Page relations and reads the Page's current uses:

```text
nodex page file list <page-selector> [--query text] [--after cursor] [--limit 200]
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

Page inventory combines explicit entries and body uses, deduplicated by File ID.
Body-only uses have no logical path. Reads require exactly one `--file-id` or
`--path`; Page access authorizes current bytes. Independent File history and
shared edits require direct File access. Adding a File requires direct access;
copying or moving an existing relation uses the source Page's authority.

`put` rejects path collisions by default. `--replace-entry` and `replace-entry`
create a new File and retarget only this Page relation; the original File,
other Pages, and body references remain unchanged. `remove` removes the relation
and retains the File and body uses. Path resolution for `put` occurs inside the
idempotent Core transaction, so retries return the original result even after
the Page namespace changes.

All writes accept `--idempotency-key`; it is required with `--json`. Repeat the
same key with the same arguments, revisions, and bytes. Existing File writes
require `--if-revision`; content writes also require `--if-head`. `file info`
returns these current coordinates for one File. Page relation
writes require `--if-manifest`, and transfers require both Page revisions.
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

`nodex rg` asks Core for a short-lived immutable projection of authorized Page
metadata and canonical content. The CLI validates the lease manifest, paths,
permissions, lengths, and hashes before running the bundled ripgrep with the
supported read-only flags. Physical lease paths are never writable inputs and
are released after success, failure, or interruption.

## Service and diagnostics

`nodex service status|enable|disable` controls optional packaged Core prewarming;
normal commands always retain authenticated on-demand startup. `nodex doctor`
and typed validation reports are the supported storage diagnostics.

The retired JavaScript HTTP launcher, direct-SQL commands, and storage
inspection interfaces are not supported. External automation uses this CLI;
desktop UI uses typed preload/Main Adapters.

## Agent Skill setup

`nodex setup` and `nodex skills status|install|remove|doctor` manage only the
official global Codex and Claude Code Skill targets. They verify the packaged
artifact and create/remove only an exact managed link. Existing foreign files,
directories, and links are reported as compatible or conflict and are never
adopted, overwritten, or force-repaired.

The product-level authority and consent contract is in
[Agent Interface Behavior](product-specs/agent-interface-behavior.md).
