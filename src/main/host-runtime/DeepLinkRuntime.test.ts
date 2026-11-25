import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import type { BrowserWindow } from "electron";
import { buildSessionDeepLink } from "../../shared/nodex-deeplink";
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
    assert.isFalse(yield* runtime.handle("nodex://sessions/chat"));
    const trayLink = buildSessionDeepLink({ sessionId: "chat", spaceId: "personal" });
    assert.isTrue(yield* runtime.handle(trayLink));
    assert.isTrue(yield* runtime.handle("nodex://pages/old?spaceId=personal"));
    assert.isTrue(yield* runtime.handle("nodex://pages/new?spaceId=personal"));
    assert.strictEqual(sent.length, 0);

    yield* runtime.markReady;
    assert.strictEqual(sent.length, 0);
    rendererReady = true;
    yield* runtime.flush;
    assert.deepStrictEqual(sent, [
      {
        channel: "deeplink:open-session",
        payload: { spaceId: "personal", projectId: "project-1", sessionId: "chat" },
      },
      {
        channel: "deeplink:open-page",
        payload: { spaceId: "personal", projectId: "project-1", pageId: "new" },
      },
    ]);
    assert.isNull(yield* runtime.extractFromArgv(["--flag"]));
  }),
);

it.effect("delivers projectless links with their coordinates to the addressed Space", () =>
  Effect.gen(function* () {
    const sent: Array<{ window: string; channel: string; payload: unknown }> = [];
    const windowFor = (spaceId: string, id: number) =>
      ({
        isDestroyed: () => false,
        webContents: {
          id,
          getURL: () => (spaceId === "personal" ? "app://-/" : `app://-/?spaceId=${spaceId}`),
          isDestroyed: () => false,
          isLoadingMainFrame: () => false,
          send: (channel: string, payload: unknown) =>
            sent.push({ window: spaceId, channel, payload }),
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
          ? Effect.succeed({ ...target, projectId: null })
          : Effect.fail(
              new DeepLinkRuntimeError({
                operation: "unknown-space",
                cause: new Error("Unknown Space"),
              }),
            ),
    });
    yield* links.markReady;
    const pageLink = "nodex://pages/same-page?spaceId=team#block%2Fone";
    assert.strictEqual(yield* links.extractFromArgv(["--flag", pageLink]), pageLink);
    assert.deepStrictEqual(sent, [
      {
        window: "team",
        channel: "deeplink:open-page",
        payload: { spaceId: "team", pageId: "same-page", projectId: null, blockId: "block/one" },
      },
    ]);
    assert.strictEqual(
      (yield* Effect.result(links.handle("nodex://views/same-view?spaceId=unknown")))._tag,
      "Failure",
    );
    assert.strictEqual(sent.length, 1);
    yield* links.handle("nodex://views/same-view?spaceId=team");
    assert.deepStrictEqual(sent[1], {
      window: "team",
      channel: "deeplink:open-view",
      payload: { spaceId: "team", viewId: "same-view", projectId: null },
    });
  }),
);
