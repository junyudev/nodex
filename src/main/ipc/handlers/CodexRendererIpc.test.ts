import {
  CodexApplicationRequestInbox,
  make as makeRequestInbox,
} from "../../codex-runtime/CodexApplicationRequestInbox";
import type { IpcMainEvent } from "electron";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { CODEX_HOST_CHUNK_ACK_CHANNEL } from "../../../shared/codex-host-chunked-message";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexAppProtocolTools } from "../../codex-application/CodexAppProtocolTools";
import {
  CodexApplicationEventHub,
  make as makeApplicationEvents,
} from "../../codex-application/CodexApplicationEventHub";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "../../codex-application/CodexRendererPresentationRegistry";
import { CodexUserInputAutoResolution } from "../../codex-application/CodexUserInputAutoResolution";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live, routeRendererDeliveryAcknowledgment } from "./CodexRendererIpc";

type OnHandler = (event: IpcMainEvent, ...args: readonly unknown[]) => Effect.Effect<void>;

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
    const handled: Array<readonly [string, number]> = [];
    const rendererClients = RendererClientRuntime.of(
      {} as unknown as RendererClientRuntime["Service"],
    );
    const scope = yield* Scope.make();
    const empty = {} as never;
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.effect(CodexApplicationRequestInbox, makeRequestInbox),
            Layer.succeed(
              CodexAppProtocolTools,
              empty as unknown as CodexAppProtocolTools["Service"],
            ),
            Layer.effect(CodexApplicationEventHub, makeApplicationEvents),
            Layer.effect(CodexRendererPresentationRegistry, makePresentationRegistry),
            Layer.succeed(
              CodexUserInputAutoResolution,
              empty as unknown as CodexUserInputAutoResolution["Service"],
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

    assert.isDefined(onHandlers.get(CODEX_HOST_CHUNK_ACK_CHANNEL));
    const route = (transferId: unknown, sequence: unknown) =>
      routeRendererDeliveryAcknowledgment(
        transferId,
        sequence,
        (parsedTransferId, parsedSequence) =>
          Effect.sync(() => {
            handled.push([parsedTransferId, parsedSequence]);
          }),
      );
    yield* route("transfer:one", 2);
    yield* route("transfer:one", 2.5);
    yield* route(7, 2);

    assert.deepEqual(handled, [["transfer:one", 2]]);
    yield* Scope.close(scope, Exit.void);
    assert.isFalse(onHandlers.has(CODEX_HOST_CHUNK_ACK_CHANNEL));
  }),
);
