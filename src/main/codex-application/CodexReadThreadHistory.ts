import type { Thread, ThreadItem, Turn, UserInput } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { parseCodexDelegationText } from "../../shared/codex-delegation";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexNativeThreadLookup } from "./CodexNativeThreadLookup";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CODEX_APP_READ_THREAD_DEFAULT_MAX_OUTPUT_CHARS, CODEX_APP_READ_THREAD_DEFAULT_TURN_LIMIT, CODEX_APP_READ_THREAD_MAX_OUTPUT_CHARS, CODEX_APP_READ_THREAD_MAX_TURN_LIMIT } from "../codex/codex-app-meta-thread-tools";

export interface CodexReadThreadHistoryInput {
  readonly threadId: string; readonly hostId?: string; readonly cursor?: string | null;
  readonly turnLimit?: number | null; readonly includeOutputs?: boolean; readonly maxOutputCharsPerItem?: number | null;
}
export interface CodexReadThreadHistoryResult {
  readonly schemaVersion: 1;
  readonly thread: { readonly id: string; readonly kind: "codex"; readonly hostId: string; readonly title: string | null; readonly preview: string; readonly status: Thread["status"]; readonly cwd: string; readonly createdAt: number; readonly updatedAt: number };
  readonly page: { readonly order: "newest_first"; readonly limit: number; readonly nextCursor: string | null; readonly hasMore: boolean };
  readonly turns: readonly Record<string, unknown>[];
}
export class CodexReadThreadHistoryError extends Data.TaggedError("CodexReadThreadHistoryError")<{ readonly threadId: string; readonly reason: "unknown-cursor" | "request-failed"; readonly cause: unknown }> {}
export class CodexReadThreadHistory extends Context.Service<CodexReadThreadHistory, {
  readonly read: (input: CodexReadThreadHistoryInput) => Effect.Effect<CodexReadThreadHistoryResult, CodexReadThreadHistoryError>;
}>()("nodex/main/codex-application/CodexReadThreadHistory") {}
const output = (text: string, limit: number) => text.length <= limit ? { text, truncated: false } : { text: text.slice(0, limit), truncated: true, originalChars: text.length };
function userInput(input: UserInput): Record<string, unknown> {
  switch (input.type) {
    case "text": { const delegation = parseCodexDelegationText(input.text); return { type: input.type, text: input.text, ...(delegation ? { codexDelegation: delegation } : {}) }; }
    case "image": case "audio": return { type: input.type, url: input.url };
    case "localImage": case "localAudio": return { type: input.type, path: input.path };
    case "skill": case "mention": return { type: input.type, name: input.name, path: input.path };
  }
}
/** Outputs alone are truncated; user and assistant text remain full native content. */
export function serializeCodexReadThreadProtocolItem(item: ThreadItem, includeOutputs: boolean, limit: number): Record<string, unknown> {
  const identity = { type: item.type, id: item.id };
  switch (item.type) {
    case "userMessage": return { ...identity, content: item.content.map(userInput) };
    case "agentMessage": return { ...identity, text: item.text, phase: item.phase };
    case "plan": return { ...identity, text: item.text };
    case "reasoning": return { ...identity, summary: item.summary, ...(includeOutputs ? { content: item.content.map((text) => output(text, limit)) } : {}) };
    case "commandExecution": return { ...identity, command: item.command, cwd: item.cwd, status: item.status, exitCode: item.exitCode, durationMs: item.durationMs, ...(includeOutputs && item.aggregatedOutput !== null ? { output: output(item.aggregatedOutput, limit) } : {}) };
    case "fileChange": return { ...identity, status: item.status, changes: item.changes.map((change) => ({ path: change.path, kind: change.kind, ...(includeOutputs ? { diff: output(change.diff, limit) } : {}) })) };
    case "mcpToolCall": return { ...identity, server: item.server, tool: item.tool, arguments: item.arguments, status: item.status, durationMs: item.durationMs };
    case "functionCallOutput": return { ...identity, name: item.name, namespace: item.namespace, ...(includeOutputs ? { output: output(typeof item.output === "string" ? item.output : JSON.stringify(item.output), limit) } : {}) };
    case "dynamicToolCall": return { ...identity, tool: item.tool, arguments: item.arguments, status: item.status, success: item.success, durationMs: item.durationMs };
    case "collabAgentToolCall": return { ...identity, tool: item.tool, status: item.status, senderThreadId: item.senderThreadId, receiverThreadIds: item.receiverThreadIds, prompt: item.prompt, model: item.model, reasoningEffort: item.reasoningEffort };
    case "subAgentActivity": return { ...identity, kind: item.kind, agentThreadId: item.agentThreadId, agentPath: item.agentPath };
    case "webSearch": return { ...identity, query: item.query, action: item.action };
    case "imageView": return { ...identity, path: item.path };
    case "sleep": return { ...identity, durationMs: item.durationMs };
    case "imageGeneration": return { ...identity, status: item.status, revisedPrompt: item.revisedPrompt, result: item.result, savedPath: item.savedPath ?? null };
    case "enteredReviewMode": case "exitedReviewMode": return { ...identity, review: item.review };
    case "hookPrompt": return { ...identity, fragmentCount: item.fragments.length };
    case "contextCompaction": return identity;
  }
}
export const make = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const lookup = yield* CodexNativeThreadLookup;
  const capabilities = yield* CodexAppServerCapabilities;
  return CodexReadThreadHistory.of({ read: (input) => Effect.gen(function* () {
    const limit = input.turnLimit ?? CODEX_APP_READ_THREAD_DEFAULT_TURN_LIMIT;
    const maxOutput = input.maxOutputCharsPerItem ?? CODEX_APP_READ_THREAD_DEFAULT_MAX_OUTPUT_CHARS;
    if (!Number.isInteger(limit) || limit < 1 || limit > CODEX_APP_READ_THREAD_MAX_TURN_LIMIT || !Number.isInteger(maxOutput) || maxOutput < 0 || maxOutput > CODEX_APP_READ_THREAD_MAX_OUTPUT_CHARS) return yield* new CodexReadThreadHistoryError({ threadId: input.threadId, reason: "request-failed", cause: new Error("read_thread received invalid arguments.") });
    const resolved = yield* lookup.resolve(input.threadId, input.hostId, { timeoutMs: 30000 });
    const { hostId, manager } = resolved;
    const assertCurrent = Effect.try({ try: manager.assertCurrent, catch: (cause) => new CodexReadThreadHistoryError({ threadId: input.threadId, reason: "request-failed", cause }) });
    const capability = yield* capabilities.forHost(hostId);
    yield* assertCurrent;
    const options = { expectedHostId: hostId, expectedGeneration: manager.generation, timeoutMs: 30000 };
    let thread = resolved.thread;
    let turns: readonly Turn[];
    let nextCursor: string | null;
    let hasMore: boolean;
    if (thread.historyMode === "paginated" || capability.flags.paginatedHistory) {
      const legacy = thread.historyMode !== "paginated";
      const cursor = legacy && input.cursor !== null && input.cursor !== undefined ? JSON.stringify({ turnId: input.cursor, includeAnchor: false }) : input.cursor;
      const page = yield* gateway.requestOnHost(hostId, "thread/turns/list", { threadId: input.threadId, cursor, itemsView: "full", limit }, options);
      turns = page.data as unknown as Turn[];
      hasMore = page.nextCursor != null;
      nextCursor = legacy && hasMore ? turns.at(-1)?.id ?? null : page.nextCursor ?? null;
    } else {
      thread = (yield* gateway.requestOnHost(hostId, "thread/read", { threadId: input.threadId, includeTurns: true }, options)).thread as unknown as Thread;
      const end = input.cursor === null || input.cursor === undefined ? thread.turns.length : thread.turns.findIndex((turn) => turn.id === input.cursor);
      if (end < 0) return yield* new CodexReadThreadHistoryError({ threadId: input.threadId, reason: "unknown-cursor", cause: new Error(`Unknown cursor for thread ${input.threadId}: ${input.cursor}`) });
      const preceding = thread.turns.slice(0, end);
      turns = preceding.slice(-limit).reverse(); hasMore = preceding.length > turns.length; nextCursor = hasMore ? turns.at(-1)?.id ?? null : null;
    }
    yield* assertCurrent;
    return { schemaVersion: 1, thread: { id: thread.id, kind: "codex", hostId, title: thread.name, preview: thread.preview, status: thread.status, cwd: thread.cwd, createdAt: thread.createdAt, updatedAt: thread.updatedAt }, page: { order: "newest_first", limit, nextCursor, hasMore }, turns: turns.map((turn) => ({ id: turn.id, status: turn.status, error: turn.error ? { message: turn.error.message, additionalDetails: turn.error.additionalDetails } : null, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs, items: turn.items.map((item) => serializeCodexReadThreadProtocolItem(item, input.includeOutputs === true, maxOutput)) })) } satisfies CodexReadThreadHistoryResult;
  }).pipe(Effect.mapError((cause) => cause instanceof CodexReadThreadHistoryError ? cause : new CodexReadThreadHistoryError({ threadId: input.threadId, reason: "request-failed", cause }))) });
});
