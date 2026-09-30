# Native Conversation Connection Behavior

## Connecting conversations

Settings > Conversations provides one chooser for existing Claude Code and Codex conversations.
Select the Agent and, for Claude Code, an enabled profile; browse native conversations; select a
Project or Projectless destination; then connect an individual conversation. Native metadata is
read in bounded pages. Older conversations remain available through pagination. Catalog reads and
connection do not submit a prompt, start a model request, replay messages, or fork history.

Codex discovery reads active persistent root conversations from the active native home through the
official app-server. Claude discovery uses the official Agent SDK with the selected profile's
environment. Subagent conversations are not independently admitted as root chats. A missing
workspace or unavailable native conversation reports an error rather than substituting a new one.

Core admits the Nodex Session, Thread, destination and native identity together. Repeated
connections return the existing chat. Claude profiles that share a canonical native history
directory also share the same conversation identity. Connecting an existing chat to another
Project is rejected; moving an existing chat remains a separate explicit operation.
The chat retains its native working directory as its execution workspace. Connecting it to a
Project authorizes that workspace for this chat while preserving the Project's content permissions;
it does not add a Project source or grant access to other Projects.

Codex retains its native Thread ID. Claude retains its native session UUID separately from the
Nodex Thread ID and binds it to the canonical native history directory. Changing a profile's
history directory cannot redirect a saved chat to another conversation with the same UUID.
Existing bindings acquire their native directory when their saved identity is first verified.
Native history remains authoritative; connecting does not create a replacement transcript store.
Reopening uses the native recovery and bounded presentation rules in
[Agent Backend Behavior](agent-backend-behavior.md) and
[Codex Transcript Behavior](codex-thread-transcript-behavior.md).

## Account and history directories

Codex has one active local account. Its native home owns shared configuration and conversation
history. An optional independent account directory owns authentication and the account's model
cache while retaining access to that same history. Saving either directory applies after restarting
Nodex. Selecting another account therefore keeps the saved conversation IDs; it does not move or
duplicate conversations. Simultaneous local accounts for different chats are not supported.

The selected account directory stores its own native authentication file; an empty directory can
be signed into from Nodex or the CLI. Nodex never copies credentials or overwrites conflicting
native files. Shared configuration, skills and transcript directories use validated directory
links, and the native SQLite location retains shared conversation metadata and history.
Native account caches remain private; CLI name indexes are not synchronized between accounts.
Independent account directories are supported on macOS and Linux. Windows uses the direct native
home and rejects account-directory overlays explicitly.

Home changes still require every local Codex chat bound to this Nodex Profile to be readable in the
selected history home. Account changes retain the history home and do not bypass that continuity
check. Configuration and launch precedence are defined in [Configuration](../CONFIGURATION.md).

## Copying agent data

The optional Copy data to Codex workflow is distinct from connecting a native conversation.
It copies supported setup and can convert Claude history into Codex conversations or import
supported history from another Codex home. Its source and conversion destination are explicit.
Same-home Codex association preserves native IDs; supported cross-home copies create independent
native conversations. Unsupported history reports a failure and leaves its source unchanged.
Copying data never supplies Claude native recovery identity or copies authentication secrets.
