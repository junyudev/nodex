# Troubleshooting

## CLI or Core unavailable

Use the host-supplied executable path when present; an empty PATH does not mean
the bundled CLI is absent. Ordinary content operations start Core on demand and
do not require a desktop window. If the binary or selected Profile is actually
unavailable, explain that condition. A remote Agent cannot use a local Core
unless its command really runs on that machine. Installation and configuration
changes require the user's intent to make those changes.

## Command unavailable

Read the current binary’s parent-command `--help` to find supported operations,
then the relevant command’s help for its parameters. Use a supported operation
or explain the missing capability.

## Project missing or ambiguous

Use known task context, or run `nodex context` from the intended source/worktree.
Pass the selected Project's exact ID or unique name with `--project PROJECT_ID`.
Ask only if the intended context is unknown. Keep the selected Profile pinned
across directory changes. Neither a Page ID nor a filesystem path grants data
access; do not select another Project to work around a denial.

## Conflict or response loss

For an explicit ETag/revision conflict, reread the affected current state and
reassess the original intent before constructing a new mutation. For a lost
response, retry the original unchanged input with its saved idempotency key.
These are different recovery paths. A duplicate receipt confirms the original
operation. Without a saved key, inspect the result before repeating a write
that could create duplicate content.

A Page attachment conflict requires rereading `pages.file_manifest_revision`
and the matching `page_files` File/path identity. An empty use list does not
imply manifest revision zero. Removing an entry retains the File and its
body occurrences. Trashing/purging a shared File follows the separate File
retention and permission contract; do not expand a detach into file deletion.

SQL results are complete or fail their budget. Reduce selected columns or the
requested scope after a budget failure; repeated OFFSET queries do not share a
snapshot. Search top-K counts describe returned hits, not all matches. Terminal
convenience cursors retain their declared query/access context. Fetch complete
Page bodies before replacing them.

## Resource missing or content unsupported

Rediscover within the selected context. Do not use deleted rows or raw storage
as fallback. Preserve native Nested Markdown structure; a lossy or partial
projection is not a complete replacement baseline. Use explicit semantic
ownership commands for Page moves/deletion rather than editing owning shells.

## Skill managed elsewhere

Explain whether the Skill is a managed link or an external copy. Use its owning
installer for user-requested changes; do not overwrite a foreign installation
as a side effect of an ordinary content task.

`PROFILE_MISMATCH` means the connected home has a different identity from the
host's `--expect-profile` assertion. Stop and refresh the host connection
context; do not remove the assertion or switch Profiles to make the call pass.
`NODEX_HOME` selects the directory; `--expect-profile` accepts only an identity.
