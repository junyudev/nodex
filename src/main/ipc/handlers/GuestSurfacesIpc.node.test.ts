import { describe, vi } from "vite-plus/test";
import { it, assert } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  testLayer as mainConfigLayer,
  testLayer,
  testLayer as configLayer,
} from "../../app/MainConfig";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { CoreAuthority } from "../../core-runtime/CoreAuthority";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { live as stateLive } from "../../codex-application/CodexVisualizationState";
import { ProfilePersistedAtoms } from "../../local-store/ProfilePersistedAtoms";
import { makePersistedAtomStore } from "../../local-store/persisted-atoms";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live as liveCodexVisualizationStateIpc } from "./CodexVisualizationStateIpc";
import { live as localStateIpcLive } from "./ApplicationLocalStateIpc";
import { PageFileHtmlRuntime } from "../../host-runtime/PageFileHtmlRuntime";
import { live as livePageFileHtmlIpc } from "./PageFileHtmlIpc";
import type { MiniContentLayout, MiniPreviewVisibility } from "../../../shared/mini";
import { MiniCompanion } from "../../mini/MiniCompanion";
import { MiniRuntime } from "../../mini/MiniRuntime";
import type { MiniWindowController } from "../../mini/mini-window-controller";
import { DeepLinkRuntime } from "../../host-runtime/DeepLinkRuntime";
import { RemoteHostedPipRuntime } from "../../host-runtime/RemoteHostedPipRuntime";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { live as miniIpcLive } from "./MiniIpc";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));

vi.mock("electron", () => ({
  shell: { openExternal },
  BrowserWindow: { fromWebContents: () => ({}) },
}));

describe("CodexVisualizationStateIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Effect.Effect<unknown, Error>;
  function event(kind = "window", url = "http://localhost:5173"): IpcMainInvokeEvent {
    const frame = { url };
    return {
      sender: { id: 42, getType: () => kind, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
  }

  it.effect(
    "admits fixed state only from the owning app window and broadcasts one committed revision",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-widget-state-ipc-"))),
        (home) => {
          const handlers = new Map<string, Handler>();
          const published: unknown[][] = [];
          let registered = true;
          const store = makePersistedAtomStore(home);
          const dependencies = Layer.mergeAll(
            Layer.succeed(CoreAuthority, {
              identity: { libraryId: "personal" },
            } as CoreAuthority["Service"]),
            Layer.succeed(ProfilePersistedAtoms, store),
            stateLive.pipe(Layer.provide(Layer.succeed(ProfilePersistedAtoms, store))),
            testLayer({ nodexHome: home, rendererUrl: "http://localhost:5173" }),
            Layer.succeed(
              ElectronIpc,
              makeTestElectronIpc({
                handle: (channel, handler) =>
                  Effect.sync(() => handlers.set(channel, handler as Handler)),
                on: () => Effect.void,
              }),
            ),
            Layer.succeed(WindowRuntime, {
              has: () => registered,
              hasAppRenderer: () => registered,
              appRenderers: () => [
                {
                  isDestroyed: () => false,
                  webContents: {
                    isDestroyed: () => false,
                    send: (...args: unknown[]) => published.push(args),
                  },
                },
              ],
            } as unknown as WindowRuntime["Service"]),
          );
          return Effect.gen(function* () {
            const identity = { hostId: "local", threadId: "display", path: "/plot.html" };
            const write = handlers.get("codex:visualization:state:write")!;
            const read = handlers.get("codex:visualization:state:read")!;
            const input = { identity, state: { selected: 7 }, mutationId: "widget-update" };
            for (const caller of [event("webview"), event("window", "https://untrusted.example")])
              assert.strictEqual((yield* Effect.result(write(caller, input)))._tag, "Failure");
            assert.strictEqual(store.readSnapshot().revision, 0);
            assert.deepEqual(yield* write(event(), input), {
              ok: true,
              revision: 1,
              value: { modelContent: null, privateContent: null, selected: 7 },
            });
            assert.deepEqual(yield* read(event(), identity), {
              modelContent: null,
              privateContent: null,
              selected: 7,
            });
            assert.strictEqual(published.length, 1);
            assert.strictEqual(published[0]?.[0], "persisted-atom:updated");
            assert.deepEqual(yield* write(event(), { ...input, state: { imageIds: ["image"] } }), {
              ok: false,
              code: "images_unsupported",
              retryable: false,
            });
            assert.strictEqual(published.length, 1);
            const interactionWrite = handlers.get("codex:visualization:interaction:write")!;
            assert.strictEqual(
              (yield* Effect.result(
                interactionWrite(event("webview"), {
                  identity,
                  state: { modelContent: { selected: 2 } },
                  mutationId: "guest-forgery",
                }),
              ))._tag,
              "Failure",
            );
            const interaction = yield* interactionWrite(event(), {
              identity,
              state: { modelContent: { selected: 2 } },
              mutationId: "host-adjustment",
            });
            assert.deepEqual(interaction, {
              ok: true,
              revision: 2,
              value: { modelContent: { selected: 2 } },
            });
            assert.strictEqual(published.length, 2);
            registered = false;
            assert.strictEqual((yield* Effect.result(read(event(), identity)))._tag, "Failure");
          }).pipe(
            Effect.provide(
              Layer.merge(liveCodexVisualizationStateIpc, localStateIpcLive).pipe(
                Layer.provide(dependencies),
              ),
            ),
            Effect.scoped,
          );
        },
        (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true })),
      ),
  );
});

describe("PageFileHtmlIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, Error>;
  const event = (
    url = "http://localhost:5173",
    kind = "window",
    main = true,
  ): IpcMainInvokeEvent => {
    const frame = { url };
    return {
      sender: { id: 42, getType: () => kind, mainFrame: main ? frame : {} },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
  };

  it.effect("only the trusted owning application frame can admit and release a preview", () => {
    const handlers = new Map<string, Handler>();
    const calls: unknown[] = [];
    const dependencies = Layer.mergeAll(
      configLayer({ rendererUrl: "http://localhost:5173" }),
      Layer.succeed(
        ElectronIpc,
        makeTestElectronIpc({
          handle: (channel, handler) =>
            Effect.sync(() => {
              handlers.set(channel, handler as Handler);
            }),
          on: () => Effect.void,
        }),
      ),
      Layer.succeed(PageFileHtmlRuntime, {
        createHost: () => {
          throw new Error("Not used by IPC");
        },
        admit: (owner, input) =>
          Effect.sync(() => {
            calls.push([owner.id, input]);
            return { status: "refused", message: "File unavailable" } as const;
          }),
        release: (owner, grant) => {
          calls.push([owner.id, grant]);
          return true;
        },
      }),
    );
    return Effect.gen(function* () {
      const input = {
        routingContext: { kind: "library" },
        pageId: "page",
        fileId: "file",
        logicalPath: "report.html",
        colorScheme: "dark",
      };
      const admit = handlers.get("page-file-html:admit")!;
      const release = handlers.get("page-file-html:release")!;
      for (const sender of [
        event("https://untrusted.example"),
        event(undefined, "webview"),
        event(undefined, "window", false),
      ]) {
        assert.equal((yield* Effect.result(admit(sender, input)))._tag, "Failure");
        assert.equal(
          (yield* Effect.result(release(sender, { grant: "a".repeat(64) })))._tag,
          "Failure",
        );
      }
      assert.deepEqual(calls, []);
      assert.equal(
        (yield* Effect.result(
          admit(event(), { ...input, routingContext: { kind: "library", projectId: "forged" } }),
        ))._tag,
        "Failure",
      );
      // Only a light or dark scheme reaches the guest's media emulation.
      assert.equal(
        (yield* Effect.result(admit(event(), { ...input, colorScheme: "sepia" })))._tag,
        "Failure",
      );
      assert.equal((yield* Effect.result(release(event(), { grant: "invalid" })))._tag, "Failure");
      assert.deepEqual(yield* admit(event(), input), {
        status: "refused",
        message: "File unavailable",
      });
      assert.isTrue(yield* release(event(), { grant: "a".repeat(64) }));
      assert.deepEqual(calls, [
        [42, input],
        [42, "a".repeat(64)],
      ]);
    }).pipe(Effect.provide(livePageFileHtmlIpc.pipe(Layer.provide(dependencies))), Effect.scoped);
  });
});

it.effect("only the owned Mini document can submit bounded layout and preview visibility", () =>
  Effect.gen(function* () {
    type Handler = (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Effect.Effect<unknown, unknown>;
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.sync(() => void handlers.set(channel, handler)),
      on: () => Effect.void,
    });
    const layouts: Array<MiniContentLayout | null> = [];
    const choices: Array<[string, MiniPreviewVisibility]> = [];
    const mini = MiniRuntime.of({
      panel: {
        reportLayout: (layout: MiniContentLayout | null) => void layouts.push(layout),
      } as unknown as MiniWindowController,
    } as unknown as MiniRuntime["Service"]);
    const previews = RemoteHostedPipRuntime.of({
      setChatPreviewVisibility: (sessionId: string, visibility: MiniPreviewVisibility) =>
        Effect.sync(() => void choices.push([sessionId, visibility])),
    } as unknown as RemoteHostedPipRuntime["Service"]);
    const scope = yield* Scope.Scope;
    yield* Layer.buildWithScope(
      miniIpcLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            mainConfigLayer({ rendererUrl: "http://localhost:5173" }),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(MiniRuntime, mini),
            Layer.succeed(MiniCompanion, {} as MiniCompanion["Service"]),
            Layer.succeed(DeepLinkRuntime, {} as DeepLinkRuntime["Service"]),
            Layer.succeed(RendererClientRuntime, {} as RendererClientRuntime["Service"]),
            Layer.succeed(RemoteHostedPipRuntime, previews),
            Layer.succeed(WindowRuntime, {
              hasAuxiliaryRole: (id, role) => id === 42 && role === "mini",
            } as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    const frame = { url: "http://localhost:5173/?initialRoute=/mini" };
    const event = (id: number, senderFrame = frame) =>
      ({
        sender: { id, getType: () => "window", mainFrame: frame },
        senderFrame,
      }) as unknown as IpcMainInvokeEvent;
    const report = handlers.get("mini:layout")!;
    const setVisibility = handlers.get("mini:preview-visibility")!;
    const base = { x: 100, y: 600, width: 120, height: 45 };
    const layout = { content: { ...base, y: 500, height: 145 }, base };

    assert.isTrue(Exit.isFailure(yield* Effect.exit(report(event(41), layout))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(report(event(42, { ...frame }), layout))));
    for (const badBase of [
      { ...base, x: Infinity },
      { ...base, y: 100_000 },
      { ...base, width: 0 },
      { ...base, height: 721 },
    ]) {
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(report(event(42), { ...layout, base: badBase }))),
      );
    }
    assert.isTrue(Exit.isFailure(yield* Effect.exit(setVisibility(event(41), "chat", "hidden"))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(setVisibility(event(42), "chat", "always"))));
    assert.isEmpty(layouts);
    assert.isEmpty(choices);

    yield* report(event(42), layout);
    yield* report(event(42), null);
    yield* setVisibility(event(42), "chat", "hidden");
    assert.deepEqual(layouts, [layout, null]);
    assert.deepEqual(choices, [["chat", "hidden"]]);
  }),
);
