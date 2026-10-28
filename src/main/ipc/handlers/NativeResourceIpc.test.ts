import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent, WebContentsView } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronNet } from "../../platform/electron/ElectronNet";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./NativeResourceIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: vi.fn(),
}));

it.effect(
  "validates native resources and delegates link saves to Chromium without buffering bytes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handlers = new Map<
          string,
          (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown>
        >();
        const bytes = Buffer.from([0, 1, 255, 128]);
        const fetch = vi.fn(() =>
          Effect.succeed(
            new Response(bytes, { headers: { "content-type": "image/png; charset=binary" } }),
          ),
        );
        const session = new EventEmitter();
        const item = Object.assign(new EventEmitter(), {
          getFilename: () => "report.pdf",
          getURLChain: () => [
            "https://example.test/download?id=1",
            "https://cdn.example.test/report.pdf",
          ],
          setSaveDialogOptions: vi.fn(),
        });
        const close = vi.fn();
        const downloadURL = vi.fn(() =>
          session.emit("will-download", { preventDefault: vi.fn() }, item, { id: 88 }),
        );
        const createDownloadView = vi.fn(
          () =>
            ({
              webContents: { id: 88, downloadURL, close, isDestroyed: () => false },
            }) as unknown as WebContentsView,
        );
        let owned = true;
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        yield* Layer.buildWithScope(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                mainConfigLayer(),
                Layer.succeed(
                  ElectronIpc,
                  makeTestElectronIpc({
                    handle: (channel, handler) =>
                      Effect.sync(() => {
                        handlers.set(channel, handler);
                      }),
                    on: () => Effect.die("unused"),
                  }),
                ),
                Layer.succeed(ElectronDesktop, {
                  createDownloadView,
                } as unknown as ElectronDesktop["Service"]),
                Layer.succeed(ElectronNet, {
                  appVersion: "1",
                  fetch,
                  readBase64: (response) =>
                    Effect.promise(async () =>
                      Buffer.from(await response.arrayBuffer()).toString("base64"),
                    ),
                }),
                Layer.succeed(WindowRuntime, {
                  has: () => owned,
                } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
          scope,
        );
        const sender = Object.assign(new EventEmitter(), {
          id: 77,
          session,
          isDestroyed: () => false,
        });
        const event = { sender } as unknown as IpcMainInvokeEvent;
        const read = handlers.get("native-resource:read")!;
        const save = handlers.get("browser-link:save")!;
        assert.deepStrictEqual(yield* read(event, { url: "https://example.test/a.png" }), {
          contentsBase64: bytes.toString("base64"),
          mimeType: "image/png",
        });
        for (const url of [
          "file:///private/a.png",
          "app://fs/@fs/tmp/a.png",
          "data:image/png;base64,aA==",
        ]) {
          assert.strictEqual((yield* Effect.result(read(event, { url })))._tag, "Failure");
          assert.strictEqual((yield* Effect.result(save(event, { url })))._tag, "Failure");
        }
        assert.strictEqual(
          yield* save(event, { url: "https://example.test/download?id=1#fragment" }),
          true,
        );
        assert.strictEqual(fetch.mock.calls.length, 1);
        assert.deepStrictEqual(downloadURL.mock.calls[0], ["https://example.test/download?id=1"]);
        assert.deepStrictEqual(item.setSaveDialogOptions.mock.calls[0], [
          { defaultPath: "report.pdf" },
        ]);
        item.emit("done", {}, "cancelled");
        yield* Effect.promise(() => Promise.resolve());
        assert.strictEqual(close.mock.calls.length, 1);
        owned = false;
        assert.strictEqual(
          (yield* Effect.result(read(event, { url: "https://example.test/a.png" })))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* Effect.result(save(event, { url: "https://example.test/download?id=1" })))._tag,
          "Failure",
        );
        assert.strictEqual(fetch.mock.calls.length, 1);
        assert.strictEqual(createDownloadView.mock.calls.length, 1);
      }),
    ),
);
