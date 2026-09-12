import { CodexApplicationRequestInbox } from "../../codex-runtime/CodexApplicationRequestInbox";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { CODEX_HOST_CHUNK_ACK_CHANNEL } from "../../../shared/codex-host-chunked-message";
import {
  parseCodexUserInputAutoResolutionActivityInput,
  parseCodexUserInputAutoResolutionTarget,
} from "../../../shared/codex-user-input-auto-resolution";
import { MainConfig } from "../../app/MainConfig";
import { CodexApplicationEventHub } from "../../codex-application/CodexApplicationEventHub";
import { CodexAppProtocolTools } from "../../codex-application/CodexAppProtocolTools";
import { CodexRendererPresentationRegistry } from "../../codex-application/CodexRendererPresentationRegistry";
import { CodexUserInputAutoResolution } from "../../codex-application/CodexUserInputAutoResolution";
import type { RendererClientWebContents } from "../../codex/renderer-client-runtime-contracts";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class CodexRendererIpcError extends Schema.TaggedError<CodexRendererIpcError>()(
  "CodexRendererIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const routeRendererDeliveryAcknowledgment = (
  transferId: unknown,
  sequence: unknown,
  handle: (transferId: string, sequence: number) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.try({
    try: () => {
      if (typeof transferId !== "string" || !Number.isSafeInteger(sequence)) {
        throw new Error(
          "Chunked-message acknowledgment requires a string transfer ID and integer sequence",
        );
      }
      return [transferId, sequence as number] as const;
    },
    catch: (cause) =>
      new CodexRendererIpcError({ operation: "parse-delivery-acknowledgment", cause }),
  }).pipe(
    Effect.flatMap(([parsedTransferId, parsedSequence]) =>
      handle(parsedTransferId, parsedSequence),
    ),
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

export const live: Layer.Layer<
  never,
  never,
  | CodexApplicationEventHub
  | CodexRendererPresentationRegistry
  | CodexApplicationRequestInbox
  | CodexAppProtocolTools
  | CodexUserInputAutoResolution
  | ElectronIpc
  | MainConfig
  | RendererClientRuntime
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const events = yield* CodexApplicationEventHub;
    const codexAppTools = yield* CodexAppProtocolTools;
    const requestInbox = yield* CodexApplicationRequestInbox;
    const rendererConversations = yield* CodexRendererPresentationRegistry;
    const userInputAutoResolution = yield* CodexUserInputAutoResolution;
    const windows = yield* WindowRuntime;
    const rendererClients = yield* RendererClientRuntime;
    const { handleControl, handlePlainCommand, handleQuery } = ipc;
    const authorize = (event: IpcMainEvent | IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Codex renderer coordination", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Codex renderer coordination requires an active Nodex window");
          }
          return rendererClients.ensureClient(event.sender as RendererClientWebContents).clientId;
        },
        catch: (cause) => new CodexRendererIpcError({ operation: "authorize-renderer", cause }),
      });
    yield* handleQuery("codex:renderer-client:id", (event) => authorize(event));
    yield* handleControl("codex:renderer-client:response", (event, response) =>
      authorize(event).pipe(
        Effect.flatMap(() =>
          rendererClients.handleResponse(event.sender as RendererClientWebContents, response),
        ),
      ),
    );
    yield* ipc.on(CODEX_HOST_CHUNK_ACK_CHANNEL, (event, transferId: unknown, sequence: unknown) =>
      authorize(event).pipe(
        Effect.andThen(
          routeRendererDeliveryAcknowledgment(
            transferId,
            sequence,
            (parsedTransferId, parsedSequence) =>
              rendererClients.handleDeliveryAcknowledgment(
                event.sender as RendererClientWebContents,
                parsedTransferId,
                parsedSequence,
              ),
          ),
        ),
        Effect.catch(() => Effect.void),
      ),
    );
    yield* handlePlainCommand("codex:thread:presentation:set", (event, input: unknown) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => {
          if (typeof input !== "object" || input === null) return Effect.succeed(false);
          const threadId =
            "threadId" in input && typeof input.threadId === "string" ? input.threadId.trim() : "";
          const surfaceId =
            "surfaceId" in input && typeof input.surfaceId === "string"
              ? input.surfaceId.trim()
              : "";
          if (!threadId || !surfaceId) return Effect.succeed(false);
          const result = rendererConversations.setPresented(
            threadId,
            clientId,
            surfaceId,
            "presented" in input && input.presented === true,
          );
          if (!result.accepted) return Effect.succeed(false);
          if (result.presentedInForeground) {
            events.publish({ kind: "rendererConversationPresentedInForeground", value: threadId });
          }
          return userInputAutoResolution.reevaluatePresentation(threadId).pipe(Effect.as(true));
        }),
      ),
    );
    yield* handleControl(
      "codex:dynamic-tool-call:respond",
      (event, conversationId, requestId, context) =>
        authorize(event).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              const identity = context.nativeOccurrence;
              if (!identity) return null;
              const occurrence = yield* requestInbox.resolveOccurrence({
                ...identity,
                requestId,
                method: "item/tool/call",
              });
              if (
                !occurrence ||
                occurrence.occurrenceId !== identity.occurrenceId ||
                occurrence.params === null ||
                typeof occurrence.params !== "object" ||
                Reflect.get(occurrence.params, "threadId") !== conversationId
              )
                return null;
              return yield* codexAppTools.respond(requestId, conversationId, context);
            }),
          ),
        ),
    );
    yield* handleQuery("codex:user-input:auto-resolution:snapshot", (event) =>
      authorize(event).pipe(Effect.andThen(userInputAutoResolution.snapshot)),
    );
    yield* handleControl("codex:user-input:auto-resolution:activity", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => {
          const conversationId = parseCodexUserInputAutoResolutionActivityInput(input);
          if (conversationId === null) return Effect.succeed(false);
          if (!rendererConversations.isClientPresenting(conversationId, clientId)) {
            return Effect.succeed(false);
          }
          return userInputAutoResolution.recordActivity(conversationId).pipe(Effect.as(true));
        }),
      ),
    );
    yield* handlePlainCommand("codex:user-input:auto-resolution:snooze", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => {
          const target = parseCodexUserInputAutoResolutionTarget(input);
          if (target === null) return Effect.succeed(false);
          if (!rendererConversations.isClientPresenting(target.conversationId, clientId)) {
            return Effect.succeed(false);
          }
          return userInputAutoResolution.snooze(target.conversationId, target.requestId);
        }),
      ),
    );
  }),
);
