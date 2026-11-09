import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import type { BrowserWindow } from "electron";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import { DeepLinkRuntime, DeepLinkRuntimeError, live } from "./DeepLinkRuntime";

it.effect("keeps the newest queued targets behind readiness and flushes resolved routes", () =>
  Effect.gen(function* () {
    let rendererReady = false;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        id: 1,
        isDestroyed: () => false,
        isLoadingMainFrame: () => false,
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    } as unknown as BrowserWindow;
    const windows = {
      getLastFocused: () => window,
      isRendererInitialized: () => rendererReady,
    } as unknown as WindowRuntimeService;
    const context = yield* Layer.build(live({ focusWindow: () => undefined, windows }));
    const runtime = Context.get(context, DeepLinkRuntime);
    yield* runtime.configureSpaces({
      personalSpaceId: "personal",
      resolve: (target) => Effect.succeed({ ...target, projectId: "project-1" }),
    });
    assert.isFalse(yield* runtime.handle("nodex://pages/ambiguous"));
    assert.isTrue(yield* runtime.handle("nodex://pages/old?spaceId=personal"));
    assert.isTrue(yield* runtime.handle("nodex://pages/new?spaceId=personal"));
    assert.strictEqual(sent.length, 0);

    yield* runtime.markReady;
    assert.strictEqual(sent.length, 0);
    rendererReady = true;
    yield* runtime.flush;
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0]?.channel, "deeplink:open-page");
    assert.deepStrictEqual(sent[0]?.payload, {
      spaceId: "personal",
      projectId: "project-1",
      pageId: "new",
    });
    assert.isNull(yield* runtime.extractFromArgv(["--flag"]));
  }),
);

it.effect("resolves a qualified link only in its Space and delivers to that Space's renderer", () =>
  Effect.gen(function* () {
    const sent: Array<{ window: string; payload: unknown }> = [];
    const windowFor = (spaceId: string, id: number) =>
      ({
        isDestroyed: () => false,
        webContents: {
          id,
          getURL: () => (spaceId === "personal" ? "app://-/" : `app://-/?spaceId=${spaceId}`),
          isDestroyed: () => false,
          isLoadingMainFrame: () => false,
          send: (_channel: string, payload: unknown) => sent.push({ window: spaceId, payload }),
        },
      }) as unknown as BrowserWindow;
    const personal = windowFor("personal", 1);
    const team = windowFor("team", 2);
    const context = yield* Layer.build(
      live({
        focusWindow: () => undefined,
        windows: {
          getLastFocused: () => personal,
          all: () => [personal, team],
          isRendererInitialized: () => true,
        } as unknown as WindowRuntimeService,
      }),
    );
    const links = Context.get(context, DeepLinkRuntime);
    yield* links.configureSpaces({
      personalSpaceId: "personal",
      resolve: (target) =>
        target.spaceId === "team"
          ? Effect.succeed({ ...target, projectId: "team-project" })
          : Effect.fail(
              new DeepLinkRuntimeError({
                operation: "unknown-space",
                cause: new Error("Unknown Space"),
              }),
            ),
    });
    yield* links.markReady;
    yield* links.handle("nodex://pages/same-page?spaceId=team");
    assert.deepStrictEqual(sent, [
      {
        window: "team",
        payload: { spaceId: "team", pageId: "same-page", projectId: "team-project" },
      },
    ]);
    assert.strictEqual(
      (yield* Effect.result(links.handle("nodex://views/same-view?spaceId=unknown")))._tag,
      "Failure",
    );
    assert.strictEqual(sent.length, 1);
    yield* links.handle("nodex://pages/another-page?spaceId=team");
    assert.strictEqual(sent.length, 2);
  }),
);
