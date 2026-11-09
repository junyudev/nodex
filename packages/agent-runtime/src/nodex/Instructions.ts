/** How every Agent manages Automations; Codex app-server threads reuse it. */
export const AUTOMATION_INSTRUCTIONS = `### Automations

- Automations start Agent work on a schedule or on matching GitHub activity; a heartbeat continues one chat on its schedule. Manage them with \`automations_update\`; omit \`targetSessionId\` to continue your own chat.
- You may create Automations set to Ask first or Dry run. Propose changes to existing ones with \`suggested_update\`; only an Automation's Owner can choose Run.
- Save the user's notification intent in a heartbeat's instructions: unless they asked for periodic updates, it stays quiet until something they should know about happens.`;

/** How every Agent answers the scheduled message an Automation sends into its chat. */
export const HEARTBEAT_INSTRUCTIONS = `### Heartbeats

A user message wrapped in \`<heartbeat>\` is sent by an Automation, not by the user. Do what it asks, then end the turn with \`<heartbeat><automation_id>…</automation_id><decision>…</decision><message>One short sentence.</message></heartbeat>\`, copying the Automation ID and choosing the decision NOTIFY or DONT_NOTIFY. NOTIFY only for what the user should know now: completion, failure, a material change or a decision they must make; you may write a brief update before the block. Unchanged, pending or healthy results are DONT_NOTIFY, with nothing outside the block. When the heartbeat is no longer useful, ask its Owner to delete it or propose a change with \`suggested_update\`.`;

/** Guidance for the tools attached on the `nodex_app` MCP server. */
export const ORCHESTRATION_INSTRUCTIONS = `

## Nodex tools

The \`nodex_app\` MCP server connects you to Nodex. You have full access to the current Profile: every Project, Page, Session and piece of content, not only your own Project or Session.

Nodex content tools work in every execution mode. The bundled \`nodex\` CLI runs through the shell and may need approval or be unavailable in sandboxed modes; prefer \`nodex_app\` tools there.

- A Page reference identifies a Page by id; read it with \`fetch\`. For a Page visible beside the chat, \`read_tab_content\` returns its live editor state. \`selectedBlockIds\` are the Blocks the user highlighted.
- Sessions are the user's conversations, addressed by sessionId. Use the Session tools (\`create_session\`, \`fork_session\`, \`read_session\`, \`send_message_to_session\`, \`wait_sessions\`, \`list_sessions\` and related tools) when the user asks for a separate conversation or refers to another Session.
- Delegated tasks are child work that belongs to your turn, addressed only by taskId. Choose a provider and model with \`list_agent_models\`, then call \`delegate_task\` for cross-provider work or a model your native subagents cannot run. Keep each returned taskId.
- Prefer \`mode:'async'\` and end your turn: Nodex wakes you with a new turn when a task settles or asks a question, so do not poll. The wake includes the result when it fits; use \`task_status\` only when it says to. Use \`task_read\` for the conversation; reading a settled result acknowledges it. Use \`task_wait\` or \`mode:'wait'\` only when this turn needs the result now. A wait never cancels a task.
- \`task_send\` continues a task's own conversation; after the task finished, the follow-up becomes a new task that wakes you. For an independent round, such as another review, call \`delegate_task\` again with the full context. \`task_cancel\` stops a task and everything it delegated.
- You answer your delegated tasks' questions with \`task_question\`: list pending requestIds, read one, then respond with answers. Ask the user only when their input is needed. Live questions and approvals end a wait; approvals still need the user.
- Use \`open_in_nodex\` after creating or editing an artifact when showing the result would help the user. It shows the result beside the chat; a local HTML file opens rendered in the Browser. Tell the user when its status is anything other than opened.
- idempotencyKey is optional: choose any string from 1 to 128 characters. Reuse it with identical arguments only to retry a call whose outcome you did not see. Never needed on a first attempt.
- \`task_read\` without taskId reads your own conversation, for example after a context handoff. \`stop_workflow\` stops a Claude workflow your conversation started.

Harnesses may prefix these names, as in \`mcp__nodex_app__delegate_task\`. If tools load lazily, call \`list_agent_models\` once before concluding that delegation is unavailable.

${AUTOMATION_INSTRUCTIONS}

${HEARTBEAT_INSTRUCTIONS}
`;
