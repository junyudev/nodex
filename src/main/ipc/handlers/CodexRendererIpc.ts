import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
  RENDERER_DELIVERY_ACK_CHANNEL,
  parseRendererDeliveryEnvelope,
  type RendererDeliveryTransferAckEnvelope,
} from "../../../shared/renderer-delivery-transport";
import {
  parseCodexUserInputAutoResolutionActivityInput,
  parseCodexUserInputAutoResolutionTarget,
} from "../../../shared/codex-user-input-auto-resolution";
import {
  parseCodexHistoryResidencyPinsInput,
  type CodexHistoryResidencyPinsInput,
  type CodexHistoryResidencyPinsResult,
} from "../../../shared/codex-history-residency-pins";
import { MainConfig } from "../../app/MainConfig";
import { CodexAppProtocolTools } from "../../codex-application/CodexAppProtocolTools";
import { CodexRendererConversationCoordinator } from "../../codex-application/CodexRendererConversationCoordinator";
import { CodexRendererConversationRegistry } from "../../codex-application/CodexRendererConversationRegistry";
import { CodexUserInputAutoResolution } from "../../codex-application/CodexUserInputAutoResolution";
import { ConversationEntityMap } from "../../codex-application/internal/ConversationEntityMap";
import type { RendererClientWebContents } from "../../codex/renderer-client-runtime-contracts";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class CodexRendererIpcError extends Schema.TaggedError<CodexRendererIpcError>()(
  "CodexRendererIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const parseRendererDeliveryAcknowledgment = (
  input: unknown,
): RendererDeliveryTransferAckEnvelope => {
  const envelope = parseRendererDeliveryEnvelope(input);
  if (envelope.kind !== "transferAck") {
    throw new Error("Renderer delivery acknowledgment channel requires an ACK");
  }
  return envelope;
};

export const routeRendererDeliveryAcknowledgment = (
  input: unknown,
  handle: (acknowledgment: RendererDeliveryTransferAckEnvelope) => Effect.Effect<boolean>,
): Effect.Effect<void> =>
  Effect.try({
    try: () => parseRendererDeliveryAcknowledgment(input),
    catch: (cause) =>
      new CodexRendererIpcError({ operation: "parse-delivery-acknowledgment", cause }),
  }).pipe(
    Effect.flatMap(handle),
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

export const applyCodexHistoryResidencyPins = (input: {
  readonly rawInput: unknown;
  readonly clientId: string;
  readonly conversations: ConversationEntityMap["Service"];
  readonly rendererConversations: CodexRendererConversationRegistry["Service"];
}): CodexHistoryResidencyPinsResult => {
  const pins = parseCodexHistoryResidencyPinsInput(input.rawInput);
  if (!pins) return { status: "invalid" };
  const isCleanup = pins.turnIds.length === 0 && pins.islandIds.length === 0;
  if (!isCleanup) {
    if (input.rendererConversations.getOwnerClientId(pins.threadId) !== input.clientId) {
      return { status: "notOwner" };
    }
    if (!input.rendererConversations.isClientPresenting(pins.threadId, input.clientId)) {
      return { status: "notPresenting" };
    }
  }
  const conversation = input.conversations.current(pins.threadId);
  if (!conversation) return { status: "notLoaded" };
  if (conversation.generation !== pins.expectedConversationGeneration) {
    return { status: "staleGeneration" };
  }
  return conversation.setHistoryResidencyPins({
    clientId: input.clientId,
    expectedTopologyGeneration: pins.expectedTopologyGeneration,
    expectedHistoryMutationRevision: pins.expectedHistoryMutationRevision,
    turnIds: pins.turnIds,
    islandIds: pins.islandIds,
  });
};

export const live: Layer.Layer<
  never,
  never,
  | CodexRendererConversationCoordinator
  | CodexRendererConversationRegistry
  | ConversationEntityMap
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
    const coordinator = yield* CodexRendererConversationCoordinator;
    const codexAppTools = yield* CodexAppProtocolTools;
    const rendererConversations = yield* CodexRendererConversationRegistry;
    const conversations = yield* ConversationEntityMap;
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
    yield* ipc.on(RENDERER_DELIVERY_ACK_CHANNEL, (event, input: unknown) =>
      authorize(event).pipe(
        Effect.andThen(
          routeRendererDeliveryAcknowledgment(input, (acknowledgment) =>
            rendererClients.handleDeliveryAcknowledgment(
              event.sender as RendererClientWebContents,
              acknowledgment,
            ),
          ),
        ),
        Effect.catch(() => Effect.void),
      ),
    );
    yield* handleControl("codex:thread:view-active:set", (event, input: unknown) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => {
          if (typeof input !== "object" || input === null) return Effect.succeed(false);
          const threadId =
            "threadId" in input && typeof input.threadId === "string" ? input.threadId.trim() : "";
          return threadId
            ? coordinator.setViewActive(
                threadId,
                clientId,
                "active" in input && input.active === true,
              )
            : Effect.succeed(false);
        }),
      ),
    );
    yield* handleControl("codex:thread:stream-following:set", (event, input: unknown) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => {
          if (typeof input !== "object" || input === null) return Effect.succeed(false);
          const threadId =
            "threadId" in input && typeof input.threadId === "string" ? input.threadId.trim() : "";
          return threadId
            ? coordinator.setFollowing(
                threadId,
                clientId,
                "following" in input && input.following === true,
                { forceSnapshot: "reannounce" in input && input.reannounce === true },
              )
            : Effect.succeed(false);
        }),
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
          return threadId && surfaceId
            ? coordinator.setPresented(
                threadId,
                clientId,
                surfaceId,
                "presented" in input && input.presented === true,
              )
            : Effect.succeed(false);
        }),
      ),
    );
    yield* handleControl(
      "codex:thread:history-residency-pins:set",
      (event, input: CodexHistoryResidencyPinsInput) =>
        authorize(event).pipe(
          Effect.map((clientId) =>
            applyCodexHistoryResidencyPins({
              rawInput: input,
              clientId,
              conversations,
              rendererConversations,
            }),
          ),
        ),
    );
    yield* handleControl("codex:thread-owner:stream-state:publish", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) =>
          Effect.sync(() => coordinator.publishOwnerStateChange(clientId, input)),
        ),
      ),
    );
    yield* handleControl("codex:thread-follower:snapshot-applied", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) =>
          coordinator.acknowledgeFollowerSnapshotApplied(clientId, input),
        ),
      ),
    );
    yield* handleControl("codex:thread:stream-resync:request", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => coordinator.requestStreamResync(clientId, input)),
      ),
    );
    yield* handleControl("codex:thread-owner:notification:ack", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) => coordinator.acknowledgeOwnerNotification(clientId, input)),
      ),
    );
    yield* handleControl("codex:thread-owner:pending-requests:replay", (event, threadId) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) =>
          Effect.sync(() => coordinator.replayPendingOwnerRequests(threadId, clientId)),
        ),
      ),
    );
    yield* handlePlainCommand("codex:thread-follower:action", (event, input) =>
      authorize(event).pipe(
        Effect.flatMap((clientId) =>
          coordinator
            .runFollowerAction(rendererClients, clientId, input)
            .pipe(
              Effect.mapError(
                (cause) => new CodexRendererIpcError({ operation: "run-follower-action", cause }),
              ),
            ),
        ),
      ),
    );
    yield* handleControl(
      "codex:dynamic-tool-call:respond",
      (event, conversationId, requestId, context) =>
        authorize(event).pipe(
          Effect.flatMap(() => codexAppTools.respond(requestId, conversationId, context)),
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
