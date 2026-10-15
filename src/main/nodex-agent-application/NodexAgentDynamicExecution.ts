import type { NodexAgentPageUpdateOutput, ToolFailure } from "../../shared/nodex-agent-tools";
import * as Effect from "effect/Effect";
import { type NodexAgentV3ToolInput } from "../codex/nodex-dynamic-tool-registry";
import { NodexAgentApplication, type NodexAgentApplicationFailure } from "./NodexAgentApplication";
import {
  fail,
  NodexAgentDynamicToolFailure,
  actorProject,
  toolFailure,
  withExecutionTimeout,
  type NodexAgentDynamicExecutionContext,
} from "./NodexAgentDynamicExecutionContext";

const NODEX_AGENT_EXECUTION_TIMEOUT_MS = 30_000;
type PageUpdateInput =
  | NodexAgentV3ToolInput<"update_page">
  | NodexAgentV3ToolInput<"advanced_update_page">;

function mapDocumentMutationFailure(error: {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}): ToolFailure {
  const conflict = error.code.includes("conflict");
  return toolFailure(
    conflict ? "conflict" : "internal_error",
    error.message,
    conflict ? "fetch_again" : "retry_same",
    error.retryable,
  );
}

const executePageUpdate = (
  tool: "update_page" | "advanced_update_page",
  input: PageUpdateInput,
  context: NodexAgentDynamicExecutionContext,
  application: NodexAgentApplication["Service"],
  executionTimeoutMs: number,
): Effect.Effect<
  NodexAgentPageUpdateOutput,
  NodexAgentApplicationFailure | NodexAgentDynamicToolFailure
> =>
  Effect.gen(function* () {
    const projectId = actorProject(context);
    const prepared = yield* Effect.gen(function* () {
      const identity = {
        threadId: context.threadId,
        callId: context.callId,
        operationId: context.operationId,
        projectId,
        authority: context.authority ?? undefined,
      };
      const request =
        tool === "update_page"
          ? {
              ...identity,
              tool,
              input: input as NodexAgentV3ToolInput<"update_page">,
            }
          : {
              ...identity,
              tool,
              input: input as NodexAgentV3ToolInput<"advanced_update_page">,
            };
      return yield* application.prepare({ kind: "page_update", request }).pipe(
        Effect.map((prepared) => {
          if (prepared.kind !== "page_update") throw new Error("Nodex preparation mismatch");
          const result = prepared.value.result;
          if (!result.ok) return fail({ error: result.error });
          return result.value;
        }),
      );
    });
    if (prepared.kind === "completed") return prepared.output;
    const mutationResult = yield* withExecutionTimeout(
      application.apply({ kind: "document_mutation", request: prepared.mutation }).pipe(
        Effect.map((result) => {
          if (result.kind !== "document_mutation") {
            throw new Error("Nodex application result mismatch");
          }
          return result.value;
        }),
      ),
      executionTimeoutMs,
    );
    if (!mutationResult.ok) return fail(mapDocumentMutationFailure(mutationResult.error));
    const completed = (yield* application.completePageUpdate({
      tool,
      threadId: context.threadId,
      callId: context.callId,
      operationId: context.operationId,
      projectId,
      authority: context.authority ?? undefined,

      pageId: input.pageId,
      result: mutationResult.value,
    })).result;
    if (!completed.ok) return fail({ error: completed.error });
    return completed.output;
  });

export const executeNodexAgentV3Tool = (
  tool: string,
  input: unknown,
  context: NodexAgentDynamicExecutionContext,
  options?: { readonly executionTimeoutMs?: number },
): Effect.Effect<
  unknown,
  NodexAgentApplicationFailure | NodexAgentDynamicToolFailure,
  NodexAgentApplication
> =>
  Effect.gen(function* () {
    const application = yield* NodexAgentApplication;
    const executionTimeoutMs = options?.executionTimeoutMs ?? NODEX_AGENT_EXECUTION_TIMEOUT_MS;
    switch (tool) {
      case "get_context": {
        const parsed = input as NodexAgentV3ToolInput<"get_context">;
        const result = (yield* application.read({
          tool,
          callId: context.callId,
          projectId: context.authority?.actorProjectId ?? null,
          authority: context.authority ?? undefined,

          input: parsed,
        })).result;
        if (!result.ok) return fail({ error: result.error });
        if (result.tool !== tool) throw new Error("Nodex v3 read tool mismatch");
        return result.output;
      }
      case "search": {
        const parsed = input as NodexAgentV3ToolInput<"search">;
        const result = (yield* application.read({
          tool,
          callId: context.callId,
          projectId: actorProject(context),
          authority: context.authority ?? undefined,

          input: parsed,
        })).result;
        if (!result.ok) return fail({ error: result.error });
        if (result.tool !== tool) throw new Error("Nodex v3 read tool mismatch");
        return result.output;
      }
      case "fetch": {
        const parsed = input as NodexAgentV3ToolInput<"fetch">;
        const result = (yield* application.read({
          tool,
          callId: context.callId,
          projectId: actorProject(context),
          authority: context.authority ?? undefined,

          input: parsed,
        })).result;
        if (!result.ok) return fail({ error: result.error });
        if (result.tool !== tool) throw new Error("Nodex v3 read tool mismatch");
        return result.output;
      }
      case "query_database_view":
      case "query_data_source": {
        const parsed = input as
          | NodexAgentV3ToolInput<"query_database_view">
          | NodexAgentV3ToolInput<"query_data_source">;
        const isView = tool === "query_database_view";
        const result = (yield* application.read({
          tool,
          callId: context.callId,
          projectId: actorProject(context),
          authority: context.authority ?? undefined,

          input: parsed as never,
        })).result;
        if (!result.ok) return fail({ error: result.error });
        if (result.tool !== tool) throw new Error("Nodex v3 read tool mismatch");
        return result.output;
      }
      case "create_pages": {
        const parsed = input as NodexAgentV3ToolInput<"create_pages">;
        const projectId = actorProject(context);
        const prepared = yield* application
          .prepare({
            kind: "create_pages",
            request: {
              threadId: context.threadId,
              callId: context.callId,
              operationId: context.operationId,
              projectId,
              authority: context.authority ?? undefined,

              input: parsed,
            },
          })
          .pipe(
            Effect.map((preparation) => {
              if (preparation.kind !== "create_pages")
                throw new Error("Nodex preparation mismatch");
              const result = preparation.value.result;
              if (!result.ok) return fail({ error: result.error });
              return result.value;
            }),
          );
        if (prepared.kind === "completed") return prepared.output;
        const applied = yield* withExecutionTimeout(
          application.apply({
            kind: "create_pages",
            command: prepared.command,
            documentHeads: prepared.documentHeads,
          }),
          executionTimeoutMs,
        );
        if (applied.kind !== "create_pages") throw new Error("Nodex application result mismatch");
        if (!applied.value.ok) return fail({ error: applied.value.error });
        return applied.value.value.output;
      }
      case "update_page":
        return yield* executePageUpdate(
          tool,
          input as NodexAgentV3ToolInput<"update_page">,
          context,
          application,
          executionTimeoutMs,
        );
      case "advanced_update_page":
        return yield* executePageUpdate(
          tool,
          input as NodexAgentV3ToolInput<"advanced_update_page">,
          context,
          application,
          executionTimeoutMs,
        );
      case "move_pages": {
        const parsed = input as NodexAgentV3ToolInput<"move_pages">;
        const projectId = actorProject(context);
        const prepared = yield* application
          .prepare({
            kind: "move_pages",
            request: {
              threadId: context.threadId,
              callId: context.callId,
              operationId: context.operationId,
              projectId,
              authority: context.authority ?? undefined,

              input: parsed,
            },
          })
          .pipe(
            Effect.map((preparation) => {
              if (preparation.kind !== "move_pages") throw new Error("Nodex preparation mismatch");
              const result = preparation.value.result;
              if (!result.ok) return fail({ error: result.error });
              return result.value;
            }),
          );
        if (prepared.kind === "completed") return prepared.output;
        const applied = yield* withExecutionTimeout(
          application.apply({ kind: "move_pages", command: prepared.command }),
          executionTimeoutMs,
        );
        if (applied.kind !== "move_pages") throw new Error("Nodex application result mismatch");
        if (!applied.value.ok) return fail({ error: applied.value.error });
        return applied.value.value.output;
      }
      case "duplicate_page": {
        const parsed = input as NodexAgentV3ToolInput<"duplicate_page">;
        const projectId = actorProject(context);
        const prepared = yield* application
          .prepare({
            kind: "duplicate_page",
            request: {
              threadId: context.threadId,
              callId: context.callId,
              operationId: context.operationId,
              projectId,
              authority: context.authority ?? undefined,

              input: parsed,
            },
          })
          .pipe(
            Effect.map((preparation) => {
              if (preparation.kind !== "duplicate_page")
                throw new Error("Nodex preparation mismatch");
              const result = preparation.value.result;
              if (!result.ok) return fail({ error: result.error });
              return result.value;
            }),
          );
        if (prepared.kind === "completed") return prepared.output;
        const applied = yield* withExecutionTimeout(
          application.apply({ kind: "duplicate_page", command: prepared.command }),
          executionTimeoutMs,
        );
        if (applied.kind !== "duplicate_page") throw new Error("Nodex application result mismatch");
        if (!applied.value.ok) return fail({ error: applied.value.error });
        return applied.value.value.output;
      }
      default:
        throw new Error(`Unsupported Nodex dynamic tool: ${tool}`);
    }
  });
