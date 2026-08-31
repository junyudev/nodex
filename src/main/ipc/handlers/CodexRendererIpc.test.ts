import type { IpcMainEvent } from "electron";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  RENDERER_DELIVERY_ACK_CHANNEL,
  RENDERER_DELIVERY_WIRE_VERSION,
  type RendererDeliveryTransferAckEnvelope,
} from "../../../shared/renderer-delivery-transport";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexAppProtocolTools } from "../../codex-application/CodexAppProtocolTools";
import { CodexRendererConversationCoordinator } from "../../codex-application/CodexRendererConversationCoordinator";
import { CodexRendererConversationRegistry } from "../../codex-application/CodexRendererConversationRegistry";
import { CodexUserInputAutoResolution } from "../../codex-application/CodexUserInputAutoResolution";
import { ConversationEntityMap } from "../../codex-application/internal/ConversationEntityMap";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live, routeRendererDeliveryAcknowledgment } from "./CodexRendererIpc";

type OnHandler = (event: IpcMainEvent, input: unknown) => Effect.Effect<void>;

it.effect("registers ACK ingress and routes only validated renderer delivery envelopes", () =>
  Effect.gen(function* () {
    const onHandlers = new Map<string, OnHandler>();
    const register = (channel: string, handler?: OnHandler) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (handler) onHandlers.set(channel, handler);
        }),
        () => Effect.sync(() => onHandlers.delete(channel)),
      );
    const ipc = makeTestElectronIpc({
      handle: (channel: string) => register(channel),
      on: (channel: string, handler: OnHandler) => register(channel, handler),
    });
    const handled: RendererDeliveryTransferAckEnvelope[] = [];
    const rendererClients = RendererClientRuntime.of(
      {} as unknown as RendererClientRuntime["Service"],
    );
    const scope = yield* Scope.make();
    const empty = {} as never;
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              CodexAppProtocolTools,
              empty as unknown as CodexAppProtocolTools["Service"],
            ),
            Layer.succeed(
              CodexRendererConversationCoordinator,
              empty as unknown as CodexRendererConversationCoordinator["Service"],
            ),
            Layer.succeed(
              CodexRendererConversationRegistry,
              empty as unknown as CodexRendererConversationRegistry["Service"],
            ),
            Layer.succeed(
              CodexUserInputAutoResolution,
              empty as unknown as CodexUserInputAutoResolution["Service"],
            ),
            Layer.succeed(
              ConversationEntityMap,
              empty as unknown as ConversationEntityMap["Service"],
            ),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(RendererClientRuntime, rendererClients),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    const acknowledgment: RendererDeliveryTransferAckEnvelope = {
      version: RENDERER_DELIVERY_WIRE_VERSION,
      kind: "transferAck",
      targetId: "renderer:one",
      generation: 7,
      transferId: "transfer:one",
      sequence: 2,
    };

    assert.isDefined(onHandlers.get(RENDERER_DELIVERY_ACK_CHANNEL));
    const route = (input: unknown) =>
      routeRendererDeliveryAcknowledgment(input, (value) =>
        Effect.sync(() => {
          handled.push(value);
          return true;
        }),
      );
    yield* route(acknowledgment);
    yield* route({ ...acknowledgment, kind: "transferEnd" });

    assert.deepEqual(handled, [acknowledgment]);
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(onHandlers.has(RENDERER_DELIVERY_ACK_CHANNEL));
  }),
);
