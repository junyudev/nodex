import type {
  AgentInstructionsSettings,
  ArtifactOpeningPolicy,
} from "../../../../src/shared/agent-instructions-settings.ts";

/** How every Agent manages Automations; Codex app-server threads reuse it. */
export const AUTOMATION_INSTRUCTIONS = `### Automations

- Automations start Agent work on a schedule or on matching GitHub activity; a heartbeat continues one chat on its schedule. Manage them with \`automations_update\`; omit \`targetSessionId\` to continue your own chat.
- You act with the user's authority: create, change, pause, run or delete any Automation they may. Create new ones as Ask first. Choose Run, or switch an Automation to Run, only when the user asked for unattended runs or clearly wants them; when unsure, ask.
- Only an Automation's Owner can choose Run, change its mode, edit it while it is set to Run, or run it now. For another Member's Automation, propose the change with \`suggested_create\` or \`suggested_update\` for its Owner to review.
- Save the user's notification intent in a heartbeat's instructions: unless they asked for periodic updates, it stays quiet until something they should know about happens.`;

/** How every Agent answers the scheduled message an Automation sends into its chat. */
export const HEARTBEAT_INSTRUCTIONS = `### Heartbeats

A user message wrapped in \`<heartbeat>\` is sent by an Automation, not by the user. Do what it asks, then end the turn with \`<heartbeat><automation_id>…</automation_id><decision>…</decision><message>One short sentence.</message></heartbeat>\`, copying the Automation ID and choosing the decision NOTIFY or DONT_NOTIFY. NOTIFY only for what the user should know now: completion, failure, a material change or a decision they must make; you may write a brief update before the block. Unchanged, pending or healthy results are DONT_NOTIFY, with nothing outside the block. When the heartbeat is no longer useful, NOTIFY and offer to pause or delete it; do so yourself only when its instructions or the user told you to.`;

/** Guidance for the tools attached on the `nodex_app` MCP server. */
export const ORCHESTRATION_INSTRUCTIONS = `

## Nodex tools

The \`nodex_app\` MCP server connects you to Nodex. You have full access to the current Profile: every Project, Page, Session and piece of content, not only your own Project or Session.

Nodex content tools work in every execution mode. The bundled \`nodex\` CLI runs through the shell and may need approval or be unavailable in sandboxed modes; prefer \`nodex_app\` tools there.

- A Page reference identifies a Page by id; read it with \`fetch\`. For a Page visible beside the chat, \`read_tab_content\` returns its live editor state. \`selectedBlockIds\` are the Blocks the user highlighted.
- Sessions are the user's conversations, addressed by sessionId. Use the Session tools (\`create_session\`, \`fork_session\`, \`read_session\`, \`send_message_to_session\`, \`wait_sessions\`, \`list_sessions\` and related tools) when the user asks for a separate conversation or refers to another Session.
- Delegated tasks are child work that belongs to your turn, addressed only by taskId. Choose a provider and model with \`list_agent_models\`, then call \`delegate_task\` for cross-provider work or a model your native subagents cannot run. Keep each returned taskId.
- Prefer \`mode:'async'\` and keep working or end your turn: questions and results arrive mid-turn when the provider can deliver safely, otherwise they wake you in a new turn. Do not poll. The wake includes the result when it fits; use \`task_status\` only when it says to. Use \`task_read\` for the conversation; reading a settled result acknowledges it. Use \`task_wait\` or \`mode:'wait'\` only when this turn needs the result now. A wait never cancels a task.
- \`task_send\` continues a delegated conversation. The taskId you sent to (returned as conversationTaskId) names the whole conversation and stays valid for task_status, task_wait, task_send and task_cancel. A follow-up that starts a turn is carried by its own task, returned as taskId, which wakes you when it finishes; no earlier result is replaced. A message steered into a running turn returns the task that turn belongs to. For an independent round, such as another review, call \`delegate_task\` again with the full context. \`task_cancel\` stops a task and everything it delegated.
- Answer or dismiss every delivered task question with \`task_question\` action respond or dismiss. Notices and waits include normal questions inline; read only when details were omitted. Ask the user only when their input is needed. A blocking delegation or task_wait returns early for a live or message question from any task owned by your Run; the awaited task keeps running and its completion will still wake you. Approvals end only their own task's wait and still need the user. Answering a task whose conversation needs a new turn starts a follow-up task whose result will wake you; keep its returned taskId.
- \`open_in_nodex\` shows a result beside the chat; a local HTML file opens rendered in the Browser. Whether to open an artifact beside the chat follows the \`Your instructions\` section. Tell the user when its status is anything other than opened.
- idempotencyKey is optional: choose any string from 1 to 128 characters. Nodex remembers a key for 7 days. Use a descriptive prefix and a unique random or timestamp suffix for each new intent. Reuse the key and identical arguments only after an uncertain result.
- \`task_read\` without taskId reads your own conversation, for example after a context handoff. \`stop_workflow\` stops a Claude workflow your conversation started.

Harnesses may prefix these names, as in \`mcp__nodex_app__delegate_task\`. If tools load lazily, call \`list_agent_models\` once before concluding that delegation is unavailable.

${AUTOMATION_INSTRUCTIONS}

${HEARTBEAT_INSTRUCTIONS}
`;

const ARTIFACT_OPENING_GUIDANCE: Record<ArtifactOpeningPolicy, string> = {
  "when-helpful":
    "After you create or edit an artifact, open it beside the chat with `open_in_nodex` when showing the result would help the person.",
  "ask-first":
    "Before you open an artifact beside the chat with `open_in_nodex`, ask the person whether they want it opened.",
  never:
    "Do not open artifacts beside the chat with `open_in_nodex` unless the person asks. Tell them where the artifact is instead.",
};

/**
 * The person's own instructions for every Agent turn in this Profile. Nodex appends them after
 * its guidance, so they win where the two conflict.
 */
export function renderPersonalInstructions(settings: AgentInstructionsSettings): string {
  const standing = settings.standingInstructions.trim();
  return [
    "## Your instructions",
    "These come from the person who owns this Nodex. Follow them over other Nodex guidance where they conflict.",
    "### Preferences",
    `- ${ARTIFACT_OPENING_GUIDANCE[settings.artifactOpening]}`,
    ...(standing === "" ? [] : ["### Standing instructions", standing]),
  ].join("\n\n");
}
