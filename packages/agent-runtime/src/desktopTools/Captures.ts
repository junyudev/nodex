import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  OrchestrationV2TurnItem,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@nodex/runtime-contracts";
import { normalizeMcpToolCall } from "../orchestration-v2/McpToolCall.ts";

type DynamicTool = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

export function publicArguments(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const {
    __nodexExecutionCall: _call,
    __nodexNativeExecution: _execution,
    ...args
  } = input as Record<string, unknown>;
  return args;
}

interface Capture {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly tool: string;
  readonly arguments: unknown;
  readonly result: CallToolResult;
  readonly status: "completed" | "failed" | "cancelled";
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
}

const MAX_CALLS_PER_THREAD = 32;
const MAX_BYTES_PER_THREAD = 32 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;

export function makeCaptures() {
  const threads = new Map<ThreadId, Array<Capture & { bytes: number; claimedBy?: TurnItemId }>>();
  let retainedBytes = 0;
  const remove = (threadId: ThreadId) => {
    const entries = threads.get(threadId);
    threads.delete(threadId);
    return entries?.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;
  };
  const record = (capture: Capture) => {
    const bytes = Buffer.byteLength(JSON.stringify([capture.arguments, capture.result]));
    if (bytes > MAX_BYTES_PER_THREAD) return;
    const entries = threads.get(capture.threadId) ?? [];
    retainedBytes -= remove(capture.threadId);
    entries.push({ ...capture, bytes });
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (entries.length > MAX_CALLS_PER_THREAD || total > MAX_BYTES_PER_THREAD)
      total -= entries.shift()!.bytes;
    threads.set(capture.threadId, entries);
    retainedBytes += total;
    while (retainedBytes > MAX_BYTES) retainedBytes -= remove(threads.keys().next().value!);
  };
  const enrich = (item: DynamicTool, attemptId: RunAttemptId | null): DynamicTool => {
    if (
      item.mcpToolCall ||
      !attemptId ||
      !item.toolName ||
      !["completed", "failed", "cancelled", "interrupted"].includes(item.status)
    )
      return item;
    const entries = threads.get(item.threadId);
    if (!entries) return item;
    const toolName = item.toolName;
    const args = publicArguments(item.input) ?? {};
    const matches = (entry: Capture) =>
      entry.runId === item.runId &&
      entry.attemptId === attemptId &&
      (toolName === entry.tool ||
        (/^(?:mcp__)?node_repl(?:[-_:./])/u.test(toolName) &&
          [`_${entry.tool}`, `.${entry.tool}`, `/${entry.tool}`, `:${entry.tool}`].some((suffix) =>
            toolName.endsWith(suffix),
          ))) &&
      isDeepStrictEqual(entry.arguments, args);
    // Replayed updates for one provider item must not consume the next identical invocation.
    const capture =
      entries.find((entry) => entry.claimedBy === item.id && matches(entry)) ??
      entries.find((entry) => entry.claimedBy === undefined && matches(entry));
    if (!capture) return item;
    capture.claimedBy = item.id;
    return {
      ...item,
      mcpToolCall: normalizeMcpToolCall({
        server: "node_repl",
        tool: capture.tool,
        nativeItemId: item.nativeItemRef?.nativeId ?? item.id,
        arguments: capture.arguments,
        output: capture.result,
        status: capture.status,
        startedAtMs: capture.startedAtMs,
        updatedAtMs: capture.updatedAtMs,
      }),
    };
  };
  return {
    record,
    enrich,
    clear: (threadId: ThreadId) => {
      retainedBytes -= remove(threadId);
    },
    has: (threadId: ThreadId) => threads.has(threadId),
  };
}
