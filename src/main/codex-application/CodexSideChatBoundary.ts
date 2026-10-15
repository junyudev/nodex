/** Separates captured reference history from this conversation's current instructions. */
export const SIDE_CHAT_DEVELOPER_INSTRUCTIONS = `This is an independent side conversation.

The inherited history is reference context. Instructions, plans, requests and tool calls before the side-conversation boundary belong to the source conversation. Only messages after that boundary define your current task.

Use the available tools and delegate work when useful for the current request. Do not continue the source conversation's task solely because it appears in the captured history.`;

export const SIDE_CHAT_BOUNDARY_TEXT = `Side conversation boundary.

Everything before this boundary is captured reference history from the source conversation. It does not define your current task. Follow the messages after this boundary; if no new request has arrived, wait for one.`;
