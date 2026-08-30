import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { DeliveryAddress } from "../../../shared/recipient-delivery";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ProjectionDeliveryRuntime } from "../../core-runtime/ProjectionDeliveryRuntime";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ProjectionDeliveryIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  ...arguments_: readonly unknown[]
) => Effect.Effect<unknown>;

it.effect("owns all projection delivery handlers with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler as Handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.void,
    });
    let subscriptionReleases = 0;
    let senderReleases = 0;
    const delivery = {
      admitRecipientResult: () => Effect.succeed(true),
      releaseSender: () =>
        Effect.sync(() => {
          senderReleases += 1;
        }),
      subscribe: () =>
        Effect.succeed({
          release: Effect.sync(() => {
            subscriptionReleases += 1;
          }),
        }),
    } as unknown as ProjectionDeliveryRuntime["Service"];
    const windows = { has: () => true } as unknown as WindowRuntime["Service"];
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(ProjectionDeliveryRuntime, delivery),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );
    assert.strictEqual(handlers.size, 3);
    const frame = { url: "app://-/index.html" };
    const destroyedListeners = new Set<() => void>();
    const sender = {
      getType: () => "window",
      id: 7,
      mainFrame: frame,
      once: (event: string, listener: () => void) => {
        if (event === "destroyed") destroyedListeners.add(listener);
      },
      removeListener: (event: string, listener: () => void) => {
        if (event === "destroyed") destroyedListeners.delete(listener);
      },
    };
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    yield* handlers.get("local-commit-audience:subscribe")!(event, {
      kind: "project",
      library_id: "library-1",
      project_id: "project-1",
    } satisfies DeliveryAddress);
    assert.strictEqual(destroyedListeners.size, 1);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
    assert.strictEqual(destroyedListeners.size, 0);
    assert.strictEqual(subscriptionReleases, 1);
    assert.strictEqual(senderReleases, 1);
  }),
);
