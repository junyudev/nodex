import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { IpcMainInvokeEvent } from "electron";
import { vi } from "vite-plus/test";
import type { AvatarOverlayRendererEvent } from "../../../shared/avatar-overlay";
import { AvatarOverlayRuntime } from "../../avatar/AvatarOverlayRuntime";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./AvatarOverlayIpc";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, object>;

function eventFrom(
  webContentsId: number,
  options: { readonly route?: string; readonly subframe?: boolean } = {},
): IpcMainInvokeEvent {
  const url = new URL("http://localhost:5173/index.html");
  url.searchParams.set("initialRoute", options.route ?? "/avatar-overlay");
  const mainFrame = { url: url.toString() };
  const sender = {
    getType: () => "window",
    id: webContentsId,
    mainFrame,
  };
  return {
    sender,
    senderFrame: options.subframe ? { url: url.toString() } : mainFrame,
  } as unknown as IpcMainInvokeEvent;
}

it.effect("admits renderer events only from the Scope-owned avatar webContents", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler as Handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const received: AvatarOverlayRendererEvent[] = [];
    const avatar = AvatarOverlayRuntime.of({
      applyNativeLayoutState: () => Effect.void,
      close: Effect.void,
      handleRendererEvent: (_webContentsId, rendererEvent) =>
        Effect.sync(() => {
          received.push(rendererEvent);
          return true;
        }),
      hide: Effect.void,
      ownsWebContents: (webContentsId) => webContentsId === 777,
      setComputerUseCursor: () => Effect.void,
      toggle: Effect.void,
      wake: Effect.void,
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(AvatarOverlayRuntime, avatar),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer({ rendererUrl: "http://localhost:5173" }),
            Layer.succeed(
              WindowRuntime,
              WindowRuntime.of({ has: () => true } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );
    const handleEvent = handlers.get("avatar-overlay:event");
    assert.isDefined(handleEvent);

    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(handleEvent!(eventFrom(1), { type: "ready" }))),
    );
    assert.deepEqual(received, []);

    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(handleEvent!(eventFrom(777, { subframe: true }), { type: "ready" })),
      ),
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          handleEvent!(eventFrom(777, { route: "/local-conversation" }), { type: "ready" }),
        ),
      ),
    );
    assert.deepEqual(received, []);

    assert.isTrue(yield* handleEvent!(eventFrom(777), { type: "ready" }));
    assert.deepEqual(received, [{ type: "ready" }]);

    const tooManyRegions = Array.from({ length: 65 }, (_, index) => ({
      height: 1,
      width: 1,
      x: index,
      y: 0,
    }));
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          handleEvent!(eventFrom(777), {
            regions: tooManyRegions,
            type: "pointer-regions-changed",
          }),
        ),
      ),
    );
    assert.lengthOf(received, 1);
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          handleEvent!(eventFrom(777), {
            pointerScreenX: Number.NaN,
            pointerScreenY: 0,
            type: "drag-move",
          }),
        ),
      ),
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          handleEvent!(eventFrom(777), {
            mascot: { height: 20_000, width: 20 },
            tray: null,
            type: "element-size-changed",
          }),
        ),
      ),
    );
    assert.lengthOf(received, 1);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
