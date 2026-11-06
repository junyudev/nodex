# Agent Permissions and Approvals

An Agent's access has two independent parts.

- **Content access.** Every Agent can read and write the current Profile's Projects, Pages,
  Sessions and Library resources through Nodex tools, including parent Agents, delegated tasks
  and background work. No permission mode narrows it.
- **Native execution access.** What the Agent's own process may do on this computer: run
  commands, change files and reach the network. Each chat chooses a permission mode.

Agent execution behavior is specified in [Agent Runtime](agent-runtime-behavior.md).

## Permission modes

| Mode             | Behavior                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Ask for approval | Works inside its workspace and asks before going beyond it, such as using the network or changing other files.                |
| Approve for me   | Uses the same workspace boundary; the Agent's native reviewer approves routine requests and asks the person about risky ones. |
| Full access      | Runs commands and changes files anywhere on this computer without asking.                                                     |

Modes are ordered from narrowest to broadest. Settings > Agents > Default permissions selects
the mode for new chats; it starts as Full access. Changing the default does not change
existing chats. The composer's permission control changes the current chat; it shows only an
icon while the chat matches the default and names the mode when it differs. Turning on Full
access asks for confirmation first.

A chat's mode is stored with its execution and survives restart. A change never interrupts a
running turn: it applies from the next message.

Each Agent offers only the modes it enforces natively. Codex and Claude Code offer all three.
ACP Agents and OpenCode offer Ask for approval and Full access. When a chat's mode is not
available for its current Agent, the chat runs with the broadest available mode that is not
broader than the chosen one; the chosen mode is retained.

Native mappings:

- **Codex**: Ask for approval uses a workspace-write sandbox that covers the chat's working
  directory, its Project Sources and its attachments, with on-request approvals. Approve for me
  adds Codex automatic review. Full access disables the sandbox and approval prompts.
- **Claude Code**: Ask for approval accepts edits in its directories and asks before other
  actions; Approve for me uses Claude Code's automatic mode; Full access bypasses permission
  prompts. Managed settings that disallow a mode select the next narrower one.
- **ACP and OpenCode**: Ask for approval allows reading and searching and asks before edits,
  commands and other actions. Full access allows them.

On Windows, Codex must report a ready Windows sandbox before a turn in Ask for
approval or Approve for me can start. The Agent notice beside the composer offers
one-time setup that asks for administrator approval, with setup without it as an
explicit fallback, subject to organization policy. A setup acknowledgement alone does not make the Agent ready;
completion is checked through a fresh endpoint. Failed, canceled or timed-out setup
never widens the chat's permissions. Full access does not require sandbox setup.
See [Windows host behavior](windows-host-behavior.md#codex-sandbox).

Calls to the chat's own Nodex tools never ask, in any mode. Other tools and connected apps follow
the mode.

## Approvals

When the Agent needs permission, the chat shows the request where the Agent stopped: the exact
command, file changes, access or app action, the Agent's reason, and its choices. The request
stays visible until it is answered, even when earlier work is collapsed.

- **Approve** allows this request once.
- **Allow for this chat** allows similar requests for the rest of the chat, including after
  Stop, a model change, or restarting Nodex. Changing the permission mode ends it, and a forked
  chat starts without it.
- **Decline** refuses the request. The Agent continues and may try another approach.
- **Decline and stop** refuses the request and stops the turn.

An Agent may offer a narrower set of choices or its own labels; the chat shows exactly the
choices the Agent can honor. A request that still reaches the person in Full access explains
why: an ask rule in the Agent's own settings, or a native safety check that no setting can skip.

Network approvals show the requested destination, including its protocol and any supplied port;
the command remains context. An ACP command approval is consumed by one matching terminal
creation. When the Agent supplies no execution context to correlate, it covers the first terminal
creation only. A remembered approval keeps the scope described by the Agent's option.

The composer stays available while approvals wait. Sending a message declines the visible
requests and redirects the Agent. When exactly one request can carry feedback, the message is
delivered as the reason for declining; otherwise the requests are declined and the message
steers the waiting turn. A request that arrives while the person is typing is held, not shown
as answerable and not declined by that message, until typing pauses, the composer loses focus,
or the message is sent.

Declined requests remain in the transcript as a quiet record with any feedback. Approved
requests leave no extra row; the action itself shows the outcome.

### Lifecycle

An approval belongs to the exact Run and provider session that asked. Every window answers
through the same execution owner; the first accepted answer wins and later answers are refused.
A retried answer with the same identity returns the accepted result.

Stopping the turn cancels its pending approvals. Losing the Agent's process, restarting the
Runtime or ending the provider turn while a request is unanswered closes it; the chat shows that
the Agent stopped before it was answered. A replacement process never inherits an earlier
request. Decline and stop interrupts that exact owning Run even if its native denial response has
no stop variant, and closes the Run's sibling approvals. A completed or replaced Run is never
stopped by a late answer. An accepted answer that could not be delivered stays recorded and is
never reopened.

### Waiting signals

A chat waiting on an approval shows "Needs approval" in the sidebar, chat pickers, Page
activity, Inbox and the delegated task list, and sends an approval notification as specified in
[Desktop Notifications](desktop-notification-behavior.md). Information questions keep their own
signal.

## Delegation and Agent-started work

Delegated tasks and chats an Agent starts inherit the caller's mode. A caller may ask for a
narrower mode, never a broader one; an inherited mode the target Agent does not offer steps down
to the broadest available narrower mode. Every later message, steer, mode change or control is
checked again against the caller's mode when it is admitted, so a person widening a child's mode
does not widen what its parent may do to it. Queue edits, queue steering and Stop carry the
caller's captured ceiling to that command check. Workspace handoffs retain the admission ceiling
through restart and apply it again when dispatching their follow-up message.

Agents never answer execution approvals. A delegated wait returns when its task needs an
approval; the person answers it in the task's chat. Question tools answer information questions
only.

## Utilities

Titles, commit messages, change-request guides, selection rewrites and other structured
generations run read-only with no approval prompts. They can read the workspace but cannot run
commands that change it or reach the network.

## Information questions

Questions that need user information remain interactive in every mode: user-input questions,
MCP elicitation, option pickers and onboarding/context selection. Their cards retain the exact
request and owning conversation identity. An answer follows the live provider callback and
physical Session lifetime. Known Run provenance stays bound to its original Run; a
Session-sourced question with unknown Run provenance keeps a null Run identity.

An owner commits the answer against its canonical conversation request state. A follower
forwards the response to that owner. Delayed acknowledgments, resolved notifications and owner
replacement retain their lifecycle fences; a stale request cannot answer a replacement callback.
Stopping execution dismisses pending questions through the same owning response path.

Plan mode conveys planning intent. It is independent of the permission mode.

## Native history

Recorded approval metadata and automatic review rationale remain provider transcript
observations. Their item relationships and request identities are preserved when displaying
native history. Resuming or importing history restores working directories and model
preferences without replaying recorded permissions; an imported chat starts with the default
permission mode.
