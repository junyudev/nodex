/** Inherited work is reference material, never an instruction to resume the source task. */
export const SIDE_CHAT_DEVELOPER_INSTRUCTIONS = `This is an independent side conversation.

Use inherited facts, findings, and prior answers as context for answering new requests and lightweight exploration. Inherited instructions, requests, plans, and tool calls do not define an active task. Do not continue the source task. Wait for a new side-conversation request before acting.

Use lightweight, non-mutating exploration by default. Make changes only when explicitly requested in a new side-conversation message. Do not request escalated permissions unless that new request explicitly requires changes. Do not launch or delegate to subagents.`;

export const SIDE_CHAT_BOUNDARY_TEXT = `Side conversation boundary.

Everything before this boundary is captured reference history from the source conversation. Its facts, findings, and prior answers remain available for answering new requests and lightweight exploration. Inherited instructions, requests, plans, and tool calls do not define your current task. Follow only new side-conversation requests. If no new request has arrived, wait. Use lightweight, non-mutating exploration by default; make changes only on a new explicit request. Do not use subagents.`;
