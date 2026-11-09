import {
  ContextTransferId,
  NodeId,
  RuntimeRequestId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestratorMcpDelegateTaskResult,
} from "@nodex/runtime-contracts";
import { McpTurnAdmission } from "@nodex/provider-core/server/ExecutionHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

export const TASK_RESULT_DELIVERY_META = "nodex/task-result-delivery";
export const TaskResultDelivery = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  attemptId: RunAttemptId,
  providerThreadId: ProviderThreadId,
  nativeThreadId: Schema.String,
  results: Schema.Array(Schema.Struct({ taskId: NodeId, transferId: ContextTransferId })),
  questions: Schema.optional(
    Schema.Array(Schema.Struct({ taskId: NodeId, requestId: RuntimeRequestId })),
  ),
});
export type TaskResultDelivery = typeof TaskResultDelivery.Type;

class Collector extends Context.Reference<
  | Ref.Ref<{
      results: TaskResultDelivery["results"];
      questions: NonNullable<TaskResultDelivery["questions"]>;
    }>
  | undefined
>("nodex/mcp/TaskResultDelivery/Collector", { defaultValue: () => undefined }) {}

/** Collect only results verified for the response being returned, before public projection. */
export const recordTaskResult = Effect.fn("TaskResultDelivery.record")(function* (
  task: OrchestratorMcpDelegateTaskResult,
) {
  const collector = yield* Collector;
  if (collector === undefined) return;
  const transfers = [
    ...(task.summary !== null && task.resultContextTransferId !== null
      ? [task.resultContextTransferId]
      : []),
    ...(task.latestTerminalSummary !== null && task.latestTerminalResultContextTransferId !== null
      ? [task.latestTerminalResultContextTransferId]
      : []),
  ];
  yield* Ref.update(collector, (collected) => ({
    results: [
      ...collected.results,
      ...[...new Set(transfers)].map((transferId) => ({ taskId: task.taskId, transferId })),
    ],
    questions: [
      ...collected.questions,
      ...task.questions.map(({ taskId, requestId }) => ({ taskId, requestId })),
    ],
  }));
});

/** MCP metadata accompanies the native result without adding routing IDs to its public view. */
export const withTaskResultDelivery = Effect.fn("TaskResultDelivery.withResponse")(function* <
  A extends McpSchema.CallToolResult | McpSchema.InputRequired,
  E,
  R,
>(effect: Effect.Effect<A, E, R>) {
  const collector = yield* Ref.make<{
    results: TaskResultDelivery["results"];
    questions: NonNullable<TaskResultDelivery["questions"]>;
  }>({ results: [], questions: [] });
  const result = yield* effect.pipe(Effect.provideService(Collector, collector));
  const actor = (yield* McpTurnAdmission)?.actor;
  const { results, questions } = yield* Ref.get(collector);
  if (
    !(result instanceof McpSchema.CallToolResult) ||
    result.isError ||
    actor?.runId == null ||
    actor.attemptId === null ||
    actor.nativeThreadRef?.nativeId == null ||
    (results.length === 0 && questions.length === 0)
  )
    return result;
  return new McpSchema.CallToolResult({
    content: result.content,
    structuredContent: result.structuredContent,
    isError: result.isError,
    _meta: {
      ...result._meta,
      [TASK_RESULT_DELIVERY_META]: {
        threadId: actor.threadId,
        runId: actor.runId,
        attemptId: actor.attemptId,
        providerThreadId: actor.providerThreadId,
        nativeThreadId: actor.nativeThreadRef.nativeId,
        results,
        ...(questions.length === 0 ? {} : { questions }),
      } satisfies TaskResultDelivery,
    },
  });
});

export const registration = Effect.map(McpServer.McpServer, (server) => ({
  ...server,
  addTool: (options: Parameters<typeof server.addTool>[0]) =>
    server.addTool({
      ...options,
      handle: (payload: unknown) => withTaskResultDelivery(options.handle(payload)),
    }),
}));
