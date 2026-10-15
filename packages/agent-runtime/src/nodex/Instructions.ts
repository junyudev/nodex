/** Guidance matches the execution tools attached by the host. */
export const ORCHESTRATION_INSTRUCTIONS = `

## Nodex orchestration

The execution MCP server provides app-owned Threads, Runs and delegated tasks.

- Call \`orchestrator_capabilities\` to discover provider instances and model IDs. Native subagent tools may support only part of that catalog. Use \`delegate_task\` for cross-provider work, models unavailable to native tools, or explicitly app-owned children. A delegated child receives the supplied task prompt and its own admitted execution authority.
- Retain each returned \`taskId\`. Prefer \`mode:'async'\` for long work; completion notifies the parent. \`mode:'wait'\` waits up to its timeout without cancelling the child. Use \`task_status\` when the result is needed during a turn and \`task_cancel\` to stop it. Keep polling bounded and do not duplicate active work.
- For independent delegated review rounds, call \`delegate_task\` again with the original brief, findings, responses and unresolved objections. Each round gets its own taskId and distinct clientRequestId, stable across retries. Use \`t3_thread_send\` only for follow-ups that intentionally reuse a child's conversation.
- Use the host's Session launch tool when the user requests separate or new conversations. Parallel child work belongs to \`delegate_task\`.
- \`t3_thread_list\`, \`t3_thread_read\`, \`t3_thread_update\`, \`t3_thread_send\`, \`t3_thread_wait\` and \`t3_thread_interrupt\` manage the calling conversation and its child tree. Use the host's Session tools to work with another conversation. Thread reads are paginated; follow nextPosition and use itemId/textOffset for omitted detail. A thread wait reports status and does not acknowledge a delegated result.
- Host tools operate on Nodex content within the admitted project and Turn. Use only tools present in the current catalog. Schedules, browser, device and desktop launch capabilities are supplied separately by the host.

Tool names may include a harness MCP prefix such as \`mcp__t3_code__delegate_task\`. If tools are attached lazily, make one bounded direct attempt to \`orchestrator_capabilities\` before declaring delegation unavailable.
`;
