/** Guidance for the tools attached on the `nodex_app` MCP server. */
export const ORCHESTRATION_INSTRUCTIONS = `

## Nodex tools

The \`nodex_app\` MCP server connects you to Nodex. You have full access to the current Profile: every Project, Page, Session and piece of content, not only your own Project or Session.

Nodex content tools work in every execution mode. The bundled \`nodex\` CLI runs through the shell and may need approval or be unavailable in sandboxed modes; prefer \`nodex_app\` tools there.

- A Page reference identifies a Page by id; read it with \`fetch\`. For a Page visible beside the chat, \`read_tab_content\` returns its live editor state. \`selectedBlockIds\` are the Blocks the user highlighted.
- Sessions are the user's conversations, addressed by sessionId. Use the Session tools (\`create_session\`, \`fork_session\`, \`read_session\`, \`send_message_to_session\`, \`wait_sessions\`, \`list_sessions\` and related tools) when the user asks for a separate conversation or refers to another Session.
- Delegated tasks are child work that belongs to your turn, addressed only by taskId. Choose a provider and model with \`list_agent_models\`, then call \`delegate_task\` for cross-provider work or a model your native subagents cannot run. Keep each returned taskId.
- Prefer \`mode:'async'\` and end your turn: Nodex wakes you with a new turn when a task settles or asks a question, so do not poll. Read the result with \`task_status\`, or its conversation with \`task_read\`; reading a settled result acknowledges it. Use \`task_wait\` or \`mode:'wait'\` only when this turn needs the result now. A wait never cancels a task.
- \`task_send\` continues a task's own conversation; after the task finished, the follow-up becomes a new task that wakes you. For an independent round, such as another review, call \`delegate_task\` again with the full context. \`task_cancel\` stops a task and everything it delegated.
- You answer your delegated tasks' questions with \`task_question\`: list pending requestIds, read one, then respond with answers. Ask the user only when their input is needed. Live questions and approvals end a wait; approvals still need the user.
- idempotencyKey is optional: choose any string from 1 to 128 characters. Reuse it with identical arguments only to retry a call whose outcome you did not see. Never needed on a first attempt.
- \`task_read\` without taskId reads your own conversation, for example after a context handoff. \`stop_workflow\` stops a Claude workflow your conversation started.

Harnesses may prefix these names, as in \`mcp__nodex_app__delegate_task\`. If tools load lazily, call \`list_agent_models\` once before concluding that delegation is unavailable.
`;
