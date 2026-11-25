import { describe, afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, type IpcMainInvokeEvent, type NativeImage, type WebContentsView } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./NativeShellIpc";
import { readFileOpenApplications, openFileWithApplication } from "../../file-link-opener";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { EventEmitter } from "node:events";
import { ElectronNet } from "../../platform/electron/ElectronNet";
import { live as liveNativeResourceIpc } from "./NativeResourceIpc";

vi.mock("electron", async (original) => ({
  ...(await original<typeof import("electron")>()),
  app: {
    getApplicationInfoForProtocol: vi.fn(),
    getApplicationNameForProtocol: vi.fn(),
  },
}));

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: vi.fn(),
}));

vi.mock("../../file-link-opener", async (original) => {
  const actual = await original<typeof import("../../file-link-opener")>();
  return {
    ...actual,
    readFileOpenApplications: vi.fn(actual.readFileOpenApplications),
    openFileWithApplication: vi.fn(),
  };
});

describe("NativeShellIpc", () => {
  afterEach(() => vi.restoreAllMocks());

  it.effect(
    "reads the HTTPS default browser with name-only and unknown fallbacks behind trusted ingress",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const iconDataUrl = "data:image/png;base64,fixture";
          const info = vi.spyOn(app, "getApplicationInfoForProtocol").mockResolvedValue({
            name: "Safari",
            path: "/Applications/Safari.app",
            icon: { isEmpty: () => false, toDataURL: () => iconDataUrl } as NativeImage,
          });
          const name = vi.spyOn(app, "getApplicationNameForProtocol").mockReturnValue("Firefox");
          const handlers = new Map<string, (event: IpcMainInvokeEvent) => Effect.Effect<unknown>>();
          let owned = true;
          const ipc = makeTestElectronIpc({
            handle: (channel, handler) =>
              Effect.sync(() => {
                handlers.set(channel, handler);
              }),
            on: () => Effect.die("unused"),
          });
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
          yield* Layer.buildWithScope(
            live.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ElectronIpc, ipc),
                  mainConfigLayer(),
                  Layer.succeed(ElectronDesktop, {} as ElectronDesktop["Service"]),
                  Layer.succeed(WindowRuntime, {
                    has: () => owned,
                  } as unknown as WindowRuntime["Service"]),
                ),
              ),
            ),
            scope,
          );
          const event = { sender: { id: 77 } } as unknown as IpcMainInvokeEvent;
          const query = handlers.get("shell:default-browser:get")!;
          assert.deepStrictEqual(yield* query(event), {
            name: "Safari",
            iconDataUrl,
            appPath: "/Applications/Safari.app",
          });
          assert.deepStrictEqual(info.mock.lastCall, ["https://"]);
          assert.strictEqual(name.mock.calls.length, 0);

          info.mockRejectedValue(new Error("Application information is unavailable"));
          assert.deepStrictEqual(yield* query(event), {
            name: "Firefox",
            iconDataUrl: null,
            appPath: null,
          });
          assert.deepStrictEqual(name.mock.lastCall, ["https://"]);
          name.mockReturnValue("");
          assert.strictEqual(yield* query(event), null);
          name.mockImplementation(() => {
            throw new Error("No protocol handler");
          });
          assert.strictEqual(yield* query(event), null);

          info.mockClear();
          name.mockClear();
          owned = false;
          assert.strictEqual((yield* Effect.result(query(event)))._tag, "Failure");
          owned = true;
          vi.mocked(requireTrustedAppRendererSender).mockImplementationOnce(() => {
            throw new Error("Untrusted frame");
          });
          assert.strictEqual((yield* Effect.result(query(event)))._tag, "Failure");
          assert.strictEqual(info.mock.calls.length, 0);
          assert.strictEqual(name.mock.calls.length, 0);
        }),
      ),
  );

  it.effect(
    "validates native application requests, preserves exact paths and rejects untrusted renderers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-native-shell-"))),
            (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
          );
          const filePath = path.join(root, "media.webm ");
          yield* Effect.promise(() => writeFile(filePath, "media"));
          const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
            Scope.close(scope, Exit.void),
          );
          const handlers = new Map<
            string,
            (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown>
          >();
          const shellOpen = vi.fn(async (_path: string) => "");
          let owned = true;
          const ipc = makeTestElectronIpc({
            handle: (channel, handler) =>
              Effect.sync(() => {
                handlers.set(channel, handler);
              }),
            on: () => Effect.die("unused"),
          });
          yield* Layer.buildWithScope(
            live.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ElectronIpc, ipc),
                  mainConfigLayer(),
                  Layer.succeed(ElectronDesktop, {
                    shell: { openPath: shellOpen },
                  } as unknown as ElectronDesktop["Service"]),
                  Layer.succeed(WindowRuntime, {
                    has: () => owned,
                  } as unknown as WindowRuntime["Service"]),
                ),
              ),
            ),
            scope,
          );
          const event = { sender: { id: 77 } } as unknown as IpcMainInvokeEvent;
          const query = handlers.get("file-open-applications")!;
          const specific = handlers.get("shell:open-file-with-application")!;
          const defaultOpen = handlers.get("shell:open-path-default")!;
          assert.strictEqual(
            (yield* Effect.result(query(event, { path: "relative" })))._tag,
            "Failure",
          );
          assert.strictEqual(
            (yield* Effect.result(query(event, { path: path.join(root, "missing") })))._tag,
            "Failure",
          );
          const result = {
            defaultApplication: {
              name: "Player",
              appPath: "/Applications/Player.app",
              iconDataUrl: null,
              isSystemDefault: true,
            },
            applications: [],
          };
          vi.mocked(readFileOpenApplications).mockResolvedValue(result);
          assert.deepStrictEqual(yield* query(event, { path: filePath }), result);
          assert.strictEqual(vi.mocked(readFileOpenApplications).mock.lastCall?.[0], filePath);
          vi.mocked(openFileWithApplication).mockResolvedValue(true);
          assert.strictEqual(
            yield* specific(event, { path: filePath, appPath: "/Applications/Player.app" }),
            true,
          );
          assert.strictEqual(yield* specific(event, { path: filePath, appPath: "Player" }), false);
          assert.strictEqual(yield* defaultOpen(event, "relative"), false);
          assert.strictEqual(yield* defaultOpen(event, path.join(root, "missing")), false);
          assert.strictEqual(yield* defaultOpen(event, filePath), true);
          assert.strictEqual(shellOpen.mock.lastCall?.[0], filePath);
          shellOpen.mockResolvedValue("Could not open the file");
          assert.strictEqual(yield* defaultOpen(event, filePath), false);
          vi.mocked(readFileOpenApplications).mockClear();
          owned = false;
          assert.strictEqual(
            (yield* Effect.result(query(event, { path: filePath })))._tag,
            "Failure",
          );
          owned = true;
          vi.mocked(requireTrustedAppRendererSender).mockImplementation(() => {
            throw new Error("Untrusted frame");
          });
          assert.strictEqual(
            (yield* Effect.result(query(event, { path: filePath })))._tag,
            "Failure",
          );
          assert.strictEqual(vi.mocked(readFileOpenApplications).mock.calls.length, 0);
          vi.mocked(requireTrustedAppRendererSender).mockReset();
        }),
      ),
  );
});

describe("NativeResourceIpc", () => {
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
            liveNativeResourceIpc.pipe(
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
});
