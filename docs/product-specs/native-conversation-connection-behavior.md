# Native Conversation Import Behavior

## Importing native conversations

Settings > Import imports Codex, Claude Code and Antigravity conversations as independent
Nodex copies. Antigravity's source is its own history on this computer, from the Antigravity app and
its command line, offered once an Antigravity profile is enabled; see
[Antigravity history](#antigravity-history).
Conversations saved by ACP Agents are bound to a chat instead of copied; see
[ACP Agent behavior](acp-agent-behavior.md#settings-and-composer).
Opening the page reads every configured native source to its end, newest first, showing rows as they
arrive; rows only append while older history is still being read. Leaving the page stops reading, and
each visit reads afresh. Refresh keeps the current rows until the new read replaces them.

The search field filters loaded conversations as the list grows. It applies
[chat search text matching](command-palette-behavior.md#text-matching) to titles
and folders and keeps the list in order. A native conversation ID or a `codex://threads/<id>` link instead looks up that exact conversation, whatever
the filters are; a raw ID searches enabled sources, and one that exists in several history directories is
listed once per directory. Agent, Folder and Status filters narrow the list further and intersect with the
search, and each counts what its choices would show given the others. A folder is that exact directory.
Conversations stay in recency order because that is the only order several sources can be merged in while
they are being read.

Profiles sharing the same canonical history directory identify the same source conversation.
Single selection and batch selection use the same import operation. Every selected conversation has
its own retry identity and completion result. Selecting all covers everything the filters show, not only
the rows currently mounted. A selection survives searching and filtering; the footer says how many
selected conversations are out of view, and shows them on request, so nothing is imported unseen. An
import that has not settled stays listed whatever is searched for. A completed copy is offered for opening
by default; an explicit new copy has a new request identity.

Each conversation goes to the active Project that owns its working folder. A Project owns the
folder when a directory source matches it, contains it, or belongs to the same Git repository,
including linked worktrees. For an eligible folder with no Project, import creates a Project at
the repository’s main checkout or at the working folder itself outside Git. A recognizable
repository remote supplies the Project name as `owner/name`. Chats from excluded folders or
folders owned only by archived Projects stay in Chats. Each row previews its placement, and the
selection shows how many Projects it will create.

A missing working folder requires an existing replacement before the copy can be imported.
The replacement determines placement. The imported chat keeps its selected execution folder,
including when that folder is inside a Project source or in a linked worktree.

Import creates a separate Nodex Session and Agent Runtime root Thread. It copies the source's
complete supported visible history into the Runtime's history store and opens an ordinary chat
with a composer and the source Agent selected. The existing model menu can change the Agent.
The next message starts new work through the Runtime and its own native
conversation. Earlier conversation context uses the same bounded portable handoff as changing
Agent; hidden model state, prompt caches, active execution, queued work, pending approvals and
authentication are not transferred. History capture does not replay tool calls or start a model
request. An unsupported item or exceeded capture budget reports a failure rather than claiming
that a partial import is complete.

Readable user images, local images in assistant Markdown, image-view files, generated images
and supported tool media are copied into Runtime-owned storage; audio is retained as a file
attachment. Relative image references use the source conversation's captured directory.
A file is an image when its bytes are a PNG, JPEG, GIF or WebP, whatever its name says. A reply's
Markdown may also show a video or another file: only an image of at most 10 MB is copied, and
anything else stays as the reply wrote it and never blocks import.
A historical image whose original file is missing retains an explicit unavailable-image record
in its message or activity. Missing image bytes do not block import; the transcript and
continuation context identify the gap, and Nodex does not claim to recover or display the original
image. An opaque provider file identity or remote-only URL without an authorized byte exporter
reports `resource_unavailable`; other unsupported media reports an import failure.

The source retains its identity, history, workspace and lifecycle. Importing, continuing, renaming,
archiving or deleting the Nodex copy does not mutate the source. The imported chat remains readable
and resumable when the source is archived or deleted; it holds no native history-base reference to
that source or its ancestors. A source that was forked from another conversation includes its
visible inherited history in the copy. Import does not connect the source to a Nodex Project.

An import request retains its selected source, directory and request identity for retry. When
Nodex admits the copy, it records the resolved Project or Chats placement with the Session.
Retrying an admitted request recovers that copy even if the folder would now resolve differently.
An uncertain result retains that request when the user changes selection or leaves Settings. Only
a confirmed rejection before destination admission releases it for corrected parameters; error
wording never determines whether a new attempt is safe.
An interrupted import cannot be recovered as an empty executable chat; it must finish importing
or report that the same request needs retrying. An unfinished import can also be deleted without
affecting its source. To start over after deleting an unfinished copy, reopen the Nodex window.
A changed active history home invalidates preview
and admission. Before creating the destination, Nodex verifies that the Runtime's physical
history home matches the previewed home. Claude capture uses the exact selected native directory
without launching or resuming the source session. On Windows, Claude's default history is under the
user profile. A configured Claude directory can use either `~/` or `~\` to refer to that profile.
A restored Profile using its captured Codex
history cannot import from a different active history home. Completed-import retries remain
independent of that source check. Codex conversations identified as Runtime-owned are not offered
as import sources. Catalog candidates are verified against current native conversation metadata
before they are offered; an incomplete or stale list index does not establish import eligibility.
Filtering a catalog page preserves its continuation cursor, even when no eligible sources remain.
Claude roots use the SDK's native history identity; SDK-created roots can also
be copied. Subagent histories are not independent import sources.

### Antigravity history

The Antigravity source is Antigravity's own history under `~/.gemini`: the Antigravity app's
conversations in `antigravity` and its command line's in `antigravity-cli`, listed together as one
Agent. A conversation belongs to the app that holds its transcript. The separately installed
Antigravity IDE and a profile's own history are not sources: profiles keep their native sessions
apart from agy's, even when they use agy's sign-in on this computer, and their chats are already
Nodex chats. The first enabled Antigravity profile reads
the history with its executable and continues each copy as its own account in a new native session;
with several profiles enabled, rows name it. Reading uses the command line's own sign-in on this
computer and never authenticates or prompts; when the command line isn't signed in, the source says
so and offers nothing.

The Agent writes its own state wherever it reads, so it reads a private copy-on-write snapshot of
the transcripts instead: neither app's history gains or changes a file. The source reads every
folder's conversations in one read and lists them newest first, since the Agent's own pages follow
no order. Conversations without a recorded working folder are not offered. Capture replays the
selected conversation with the Agent's own load request; it never creates, prompts, closes or
deletes a native session, and its logs and temporary files stay in Nodex's own directories.
Replayed messages, thoughts, plans, commands, file edits and tool calls become the copy's history. A
replay carries no times, so the copy dates its history at the conversation's last activity. Before
admitting the destination, Nodex has the Agent replay the conversation once: a conversation whose
transcript is gone, or whose replay is empty, is refused with that reason and creates no chat.

## Existing connected history

Previously connected local native conversations retain their saved identity and passive history
reader until an explicit Session message requests continuation. A settled source is imported through
the same history and media owners, then Core atomically adopts the existing Session into the Runtime.
Its placement, title and Page links remain intact. An active source reports `active_source_busy`
before import or execution; unreadable required media leaves the Native binding intact. Retrying the
same message resumes the same adoption, and later passive discovery cannot recreate that connection.
The Runtime is the sole local execution writer after adoption. Explicit remote connections continue
through their retained Native execution owner. The Session message contract is defined in
[Agent Interface Behavior](agent-interface-behavior.md).
New imports use the Runtime copy path; Settings no longer offers a separate read-only Connect action.
Reopening an existing connection follows the bounded presentation rules in
[Agent Backend Behavior](agent-backend-behavior.md) and
[Codex Transcript Behavior](codex-thread-transcript-behavior.md).

## Account and history directories

Codex has one active local account. Its native home defaults to the user's `~/.codex` and owns
shared configuration, hooks and conversation history. Sharing that directory does not add
conversations to the Nodex sidebar; importing a conversation remains an explicit action.
An optional independent account directory owns authentication and the account's model
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

Home changes select the destination's configuration and history without copying conversations.
Connected native conversations remain readable only when they exist in the active home.
Account changes retain the history home. Configuration and launch precedence are defined in
[Configuration](../CONFIGURATION.md).

## Copying Agent setup

Copy setup in Settings > Agents > Codex copies supported configuration, instructions, skills, hooks and related Agent
resources to Codex. It does not offer or import conversations. New conversation imports use the
shared independent-copy workflow.

Codex setup is the native configuration also used by the Codex app and CLI. Copying setup preserves
conflicting destination values and never copies authentication secrets. Setup scanning and applying
cannot acquire a conversation execution owner or add a native conversation to the sidebar.
