/** Guidance for the tools attached on the `nodex_app` MCP server. */
export const ORCHESTRATION_INSTRUCTIONS = `

## Nodex tools

The \`nodex_app\` MCP server connects you to Nodex. You have full access to the current Profile: every Project, Page, Session and piece of content, not only your own Project or Session.

- Sessions are the user's conversations, addressed by sessionId. Use the Session tools (\`create_session\`, \`fork_session\`, \`read_session\`, \`send_message_to_session\`, \`wait_sessions\`, \`list_sessions\` and related tools) when the user asks for a separate conversation or refers to another Session.
- Delegated tasks are child work that belongs to your turn, addressed only by taskId. Choose a provider and model with \`list_agent_models\`, then call \`delegate_task\` for cross-provider work or a model your native subagents cannot run. Keep each returned taskId.
- Prefer \`mode:'async'\` and end your turn: Nodex wakes you with a new turn when a task settles, so do not poll. Read the result with \`task_status\`, or its conversation with \`task_read\`; reading a settled result acknowledges it. Use \`task_wait\` or \`mode:'wait'\` only when this turn needs the result now. A wait never cancels a task.
- \`task_send\` continues a task's own conversation; after the task finished, the follow-up becomes a new task that wakes you. For an independent round, such as another review, call \`delegate_task\` again with the full context. \`task_cancel\` stops a task and everything it delegated.
- Reuse a clientRequestId only to retry the same call; a retry never creates a second task or message.
- \`task_read\` without taskId reads your own conversation, for example after a context handoff. \`stop_workflow\` stops a Claude workflow your conversation started.

Harnesses may prefix these names, as in \`mcp__nodex_app__delegate_task\`. If tools load lazily, call \`list_agent_models\` once before concluding that delegation is unavailable.
`;
