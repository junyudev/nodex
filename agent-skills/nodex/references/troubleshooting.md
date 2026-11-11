# Troubleshooting

## CLI or Core unavailable

Run `nodex context` in the current shell to verify Actor, Profile and Project.
Stop the batch on its first identity or connection error. In JSON mode a
connection refusal is available on stdout and stderr and exits nonzero.

- `AGENT_TURN_ENDED` means the captured execution ended. Invoke plain `nodex` from an active Turn.
- `AGENT_SESSION_UNAVAILABLE` means the Session cannot be attributed. Reopen it in Nodex or start a new one.
- `AGENT_GENERATION_CHANGED` means the captured connection retired. Run `nodex context` again from the active Turn.
- `AGENT_BINDING_MALFORMED` means the managed connection could not be read. Use plain `nodex` in the Agent shell.
- `PROFILE_MISMATCH` names the expected and connected Profiles. Inspect `nodex context` and verify the intended Profile before retrying.

Keep the managed connection. An independent local invocation acts as the local
Member and loses Agent authorship.

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
response within seven days, retry the unchanged input with its saved idempotency
key. A duplicate receipt confirms the original operation. Use a fresh key for
a new intent if Nodex returns `IDEMPOTENCY_KEY_REUSED`. After seven days or
without a saved key, inspect the affected state before repeating a write.

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
as fallback. Preserve native Nodex Markdown structure; a lossy or partial
projection is not a complete replacement baseline. Use explicit semantic
ownership commands for Page moves/deletion rather than editing owning shells.

## Skill managed elsewhere

Explain whether the Skill is a managed link or an external copy. Use its owning
installer for user-requested changes; do not overwrite a foreign installation
as a side effect of an ordinary content task.
