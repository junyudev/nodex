import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { createUuidV7, isUuidV7 } from "../../../shared/uuid-v7";
import { AgentBackendApplication } from "../../agent-backend/AgentBackendApplication";
import { MainConfig } from "../../app/MainConfig";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { makeAgentDiscoveryRequests } from "./AgentDiscoveryRequests";

const id = z.string().trim().min(1).max(512);
const ClaudeModelsInput = z
  .object({
    projectId: id.nullable(),
    instanceConfigId: id,
    requestId: z.string().refine(isUuidV7).optional(),
    forceReload: z.boolean().optional(),
  })
  .strict();
const ClaudeDiscoveryInput = z
  .object({
    scope: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("project"), instanceConfigId: id, projectId: id.nullable() })
        .strict(),
      z.object({ kind: z.literal("thread"), threadId: id }).strict(),
    ]),
    requestId: z.string().refine(isUuidV7).optional(),
    forceReload: z.boolean().optional(),
  })
  .strict();
const CatalogInput = z
  .object({
    scope: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("project"),
          projectId: id.nullable(),
          binding: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("claude"), instanceConfigId: id }).strict(),
            z.object({ kind: z.literal("opencode"), instanceConfigId: id }).strict(),
            z
              .object({
                kind: z.literal("acp"),
                agentDefinitionId: id,
                instanceConfigId: id.nullable(),
              })
              .strict(),
          ]),
        })
        .strict(),
      z.object({ kind: z.literal("thread"), threadId: id }).strict(),
    ]),
    requestId: z.string().refine(isUuidV7).optional(),
    forceReload: z.boolean().optional(),
  })
  .strict();
const HistoryImageInput = z
  .object({
    threadId: id,
    expectedSessionId: id,
    nativeMessageId: id,
    index: z.number().int().min(0).max(9999),
  })
  .strict();
const ToolOutputInput = z
  .object({ threadId: id, expectedSessionId: id, nativeMessageId: id, toolUseId: id })
  .strict();
const CancelDiscoveryInput = z.object({ requestId: z.string().refine(isUuidV7) }).strict();
const HistoryInput = z
  .object({
    threadId: id,
    before: z.string().min(1).max(8192).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export class AgentBackendIpcError extends Schema.TaggedError<AgentBackendIpcError>()(
  "AgentBackendIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const failure = (operation: string, cause: unknown) =>
  new AgentBackendIpcError({ operation, cause });

export const live: Layer.Layer<
  never,
  never,
  AgentBackendApplication | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const rendererDestruction = yield* WebContentsDestructionSubscriptions;
    const application = yield* AgentBackendApplication;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const discoveryRequests = yield* makeAgentDiscoveryRequests;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          if (
            !isTrustedAppRendererIpcSender({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: windows.has(event.sender.id),
              senderType: event.sender.getType(),
              senderUrl: event.senderFrame?.url ?? "",
              isMainFrame: event.senderFrame === event.sender.mainFrame,
            })
          ) {
            throw new Error("Agent Backend access requires an active Nodex window");
          }
        },
        catch: (cause) => failure("authorize-renderer", cause),
      });
    const parse = <A>(operation: string, schema: z.ZodType<A>, value: unknown) =>
      Effect.try({ try: () => schema.parse(value), catch: (cause) => failure(operation, cause) });
    const handle = <A, B>(
      event: IpcMainInvokeEvent,
      operation: string,
      schema: z.ZodType<A>,
      value: unknown,
      evaluate: (input: A) => Effect.Effect<B, unknown>,
    ) =>
      authorize(event).pipe(
        Effect.andThen(parse(`parse-${operation}`, schema, value)),
        Effect.flatMap(evaluate),
        Effect.mapError((cause) =>
          cause instanceof AgentBackendIpcError ? cause : failure(operation, cause),
        ),
      );
    const threadId = (event: IpcMainInvokeEvent, operation: string, value: unknown) =>
      authorize(event).pipe(
        Effect.andThen(parse(`parse-${operation}`, id, value)),
        Effect.mapError((cause) =>
          cause instanceof AgentBackendIpcError ? cause : failure(operation, cause),
        ),
      );
    const interruptWhenRendererIsDestroyed = <A, E, R>(
      event: IpcMainInvokeEvent,
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.raceFirst(
        operation,
        rendererDestruction.wait(event.sender).pipe(Effect.andThen(Effect.interrupt)),
      );

    yield* ipc.handleQuery("agent-backend:model-catalog:read", (event, input) =>
      handle(event, "model-catalog.read", CatalogInput, input, (parsed) =>
        discoveryRequests.run(
          event.sender.id,
          parsed.requestId ?? createUuidV7(),
          interruptWhenRendererIsDestroyed(event, application.modelCatalog(parsed)),
        ),
      ),
    );
    yield* ipc.handleControl("agent-backend:model-catalog:cancel", (event, input) =>
      handle(event, "model-catalog.cancel", CancelDiscoveryInput, input, (parsed) =>
        discoveryRequests.cancel(event.sender.id, parsed.requestId),
      ),
    );
    yield* ipc.handleQuery("agent-backend:claude:models", (event, input) =>
      handle(event, "claude.models", ClaudeModelsInput, input, (parsed) =>
        discoveryRequests.run(
          event.sender.id,
          parsed.requestId ?? createUuidV7(),
          interruptWhenRendererIsDestroyed(event, application.claudeModels(parsed)),
        ),
      ),
    );
    yield* ipc.handleQuery("agent-backend:claude:discover", (event, input) =>
      handle(event, "claude.discover", ClaudeDiscoveryInput, input, (parsed) =>
        discoveryRequests.run(
          event.sender.id,
          parsed.requestId ?? createUuidV7(),
          interruptWhenRendererIsDestroyed(event, application.claudeDiscovery(parsed)),
        ),
      ),
    );
    yield* ipc.handleControl("agent-backend:claude:cancel-discovery", (event, input) =>
      handle(event, "claude.cancel-discovery", CancelDiscoveryInput, input, (parsed) =>
        discoveryRequests.cancel(event.sender.id, parsed.requestId),
      ),
    );
    yield* ipc.handleQuery("agent-backend:session:history-image", (event, value) =>
      handle(event, "history-image", HistoryImageInput, value, application.readAgentHistoryImage),
    );
    yield* ipc.handleQuery("agent-backend:session:tool-output", (event, value) =>
      handle(event, "tool-output", ToolOutputInput, value, application.readAgentToolOutput),
    );
    yield* ipc.handleQuery("agent-backend:session:inspect", (event, value) =>
      threadId(event, "session.inspect", value).pipe(
        Effect.flatMap(application.inspectAgentSession),
      ),
    );
    yield* ipc.handleQuery("agent-backend:session:history", (event, input) =>
      handle(event, "history.read", HistoryInput, input, application.readAgentHistory),
    );
  }),
).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
