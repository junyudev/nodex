import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, type IpcMainInvokeEvent, type NativeImage } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./NativeShellIpc";
import { readFileOpenApplications, openFileWithApplication } from "../../file-link-opener";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

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

afterEach(() => vi.restoreAllMocks());

it.effect("owns native menu and shell ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const channels = new Set<string>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            channels.add(channel);
          }),
          () => Effect.sync(() => channels.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(ElectronDesktop, {} as ElectronDesktop["Service"]),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.strictEqual(channels.size, 10);
    assert.isTrue(channels.has("native-context-menu:show"));
    assert.isTrue(channels.has("shell:open-external-url"));
    assert.isTrue(channels.has("shell:file-link-openers:list-available"));
    assert.isTrue(channels.has("shell:path-context:get"));
    assert.isTrue(channels.has("shell:default-browser:get"));

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(channels.size, 0);
  }),
);

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
