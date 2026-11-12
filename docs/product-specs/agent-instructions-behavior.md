# Agent Instructions

Every Agent turn starts with instructions from three owners. The person can read all of them,
and can change the part that belongs to them.

## What an Agent receives

| Layer                | Owner                 | Where it is shown                                     | Editable              |
| -------------------- | --------------------- | ----------------------------------------------------- | --------------------- |
| Nodex guidance       | Nodex                 | Settings > Agents > Full Nodex instructions           | No                    |
| Your instructions    | This Profile's person | Settings > Agents > Your instructions                 | Yes                   |
| Chat context         | Nodex, per chat       | Named in the same panel; generated when a chat starts | No                    |
| Native configuration | The Agent's own home  | Each provider's own settings                          | Through that provider |
| Codex desktop app    | Codex, per thread     | Full Nodex instructions, as a representative thread   | Through Codex         |

Codex desktop app instructions are the developer text Codex app threads receive. Nodex shows a
representative thread, because each thread's text depends on its tools and workspace.

Nodex guidance covers the `nodex_app` tools, Automations and heartbeats. It is attached to
chats that have Nodex tools. Chat context covers runtime details, the Nodex CLI and the
coordinator or managed-session role. It depends on the chat, so Nodex describes it rather than
showing a fixed text.

## Your instructions

Your instructions are a Profile setting, so they apply to every chat, Automation and delegated
task in that Profile. Nodex sends them last in each turn, after its guidance and chat context, so
they take precedence where the two conflict. Each change applies from the next turn; no restart
is needed.

Your instructions have two parts.

- **Artifact opening** is a preference Nodex turns into one sentence of guidance:
  - **When helpful** (default): open an artifact beside the chat when showing it would help.
  - **Ask first**: ask before opening anything beside the chat.
  - **Never**: only say where an artifact is.
- **Your instructions** is free text, up to 8,000 characters. It is written as standing
  guidance for every turn.

Nodex does not enforce either part. Each is guidance the Agent follows, the same as the rest of
its prompt. Permissions and data access stay in [Agent Permissions](agent-permissions-behavior.md).

Your instructions are stored in the Profile's `[server.agent_instructions]` table. They are not
written to Claude Code or Codex configuration, which the external terminal shares.

## Boundaries

- Nodex guidance that Nodex parses, such as the heartbeat reply format, is not editable.
- Your instructions do not change what an Agent is allowed to do. Native approvals and
  permission modes keep applying.
- The full text of a provider's built-in system prompt is owned by that provider. Nodex shows
  the instructions it sends, not the provider's own preset.
