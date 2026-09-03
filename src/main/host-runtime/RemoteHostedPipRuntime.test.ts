import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { makeRemoteHostedPipPreferences } from "../remote-hosted-pip-preference-store";
import {
  RemoteHostedPipRuntime,
  RemoteHostedPipThreadHostResolutionError,
  testLayer,
  type RemoteHostedPipCodexOccurrence,
  type RemoteHostedPipNativePort,
} from "./RemoteHostedPipRuntime";
import { RemoteHostedPipNativePlatformError } from "../platform/electron/RemoteHostedPipNativePlatform";

const notification = (value: unknown): CodexServerNotification => value as CodexServerNotification;

const browserNotification = (
  threadId: string,
  browserId: string,
  surface: Record<string, unknown>,
): CodexServerNotification =>
  notification({
    method: "item/completed",
    params: {
      item: {
        id: `item-${browserId}`,
        result: {
          _meta: {
            "codex/toolSurface": {
              backend: "iab",
              browserId,
              kind: "browserUse",
              ...surface,
            },
          },
        },
        server: "node_repl",
        type: "mcpToolCall",
      },
      threadId,
      turnId: "turn-1",
    },
  });

const computerNotification = (
  method: "item/completed" | "item/started",
  threadId: string,
): CodexServerNotification =>
  notification({
    method,
    params: {
      item: { id: "computer-1", server: "computer-use", type: "mcpToolCall" },
      threadId,
      turnId: "turn-1",
    },
  });

const occurrence = (
  value: CodexServerNotification,
  overrides: Partial<RemoteHostedPipCodexOccurrence> = {},
): RemoteHostedPipCodexOccurrence => ({
  generation: 1,
  hostId: "physical-local",
  notification: value,
  occurrenceId: "occurrence-1",
  occurrenceToken: 1,
  ...overrides,
});

const pngDataUrl = (width = 1, height = 1): string => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};

const settleWorker = Effect.gen(function* () {
  for (let index = 0; index < 8; index += 1) yield* Effect.yieldNow;
});

const makeHarness = Effect.fn("RemoteHostedPipRuntimeTest.makeHarness")(function* (input?: {
  readonly isChromeExtensionConnected?: (
    browserFamily: string,
    extensionInstanceId: string,
  ) => boolean;
  readonly native?: Partial<RemoteHostedPipNativePort>;
  readonly resolveChromeBrowserIconPath?: (browserFamily: string) => string | null;
  readonly resolve?: (
    threadId: string,
  ) => Effect.Effect<string, RemoteHostedPipThreadHostResolutionError>;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-remote-pip-"));
  const preferences = makeRemoteHostedPipPreferences(path.join(root, "preferences.json"));
  const scope = yield* Scope.make();
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => fs.rmSync(root, { force: true, recursive: true })),
  );
  const context = yield* Layer.buildWithScope(
    testLayer({
      browserUseStateSignals: Stream.empty,
      legacy: {
        getAlwaysHide: preferences.readAlwaysHide,
        handleBrowserUseStateSnapshot: () => undefined,
        setAlwaysHide: (value) => {
          preferences.writeAlwaysHide(value);
        },
      },
      ...(input?.isChromeExtensionConnected
        ? { isChromeExtensionConnected: input.isChromeExtensionConnected }
        : {}),
      localHostId: "physical-local",
      preferences,
      ...(input?.native ? { native: input.native } : {}),
      ...(input?.resolveChromeBrowserIconPath
        ? { resolveChromeBrowserIconPath: input.resolveChromeBrowserIconPath }
        : {}),
      ...(input?.resolve ? { resolveThreadHost: input.resolve } : {}),
    }),
    scope,
  );
  return { runtime: Context.get(context, RemoteHostedPipRuntime), scope };
});

it.effect("admits only the captured physical local host and durable local Codex owner", () =>
  Effect.gen(function* () {
    const upserts: string[] = [];
    const resolutions: string[] = [];
    const { runtime, scope } = yield* makeHarness({
      native: {
        upsertBrowserPresentation: (input) => {
          upserts.push(input.presentationId);
          return Effect.succeed(true);
        },
      },
      resolve: (threadId) =>
        Effect.sync(() => {
          resolutions.push(threadId);
          return threadId === "acp-thread" ? "remote-host" : "physical-local";
        }),
    });
    const image = { screenshot: { tabId: "1", url: pngDataUrl() } };

    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "browser-1", image), { hostId: "default" }),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("acp-thread", "browser-1", image)),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "browser-1", image), { generation: 2 }),
    );
    yield* settleWorker;
    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "browser-1", image), {
        generation: 2,
        occurrenceToken: 2,
      }),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "stale", image), { generation: 1 }),
    );
    yield* settleWorker;

    assert.deepEqual(resolutions, ["acp-thread", "thread-1"]);
    assert.deepEqual(upserts, [
      'browser:["thread-1","browser-1","1"]',
      'browser:["thread-1","browser-1","1"]',
    ]);
    assert.deepEqual(yield* runtime.resolveBrowserPresentation(upserts[0]!), {
      backend: "iab",
      browserFamily: null,
      browserId: "browser-1",
      extensionInstanceId: null,
      presentationId: upserts[0],
      tabId: "1",
      threadId: "thread-1",
    });
    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, ["thread-1"]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps Browser sessions and Computer Use as independent task sources", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeHarness();
    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "browser-1", { openTabIds: ["1"] })),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "browser-2", { openTabIds: ["2"] })),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(computerNotification("item/started", "thread-1")),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "browser-1", { sessionEnded: true })),
    );
    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, ["thread-1"]);

    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "browser-2", { sessionEnded: true })),
    );
    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, ["thread-1"]);
    yield* runtime.observeCodexOccurrence(
      occurrence(computerNotification("item/completed", "thread-1")),
    );
    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("retires a disconnected generation and never reactivates it from late occurrences", () =>
  Effect.gen(function* () {
    const invalidated: string[] = [];
    const { runtime, scope } = yield* makeHarness({
      native: {
        invalidateBrowserPresentation: (id) => {
          invalidated.push(id);
          return Effect.succeed(true);
        },
      },
    });
    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          screenshot: { tabId: "1", url: pngDataUrl() },
        }),
      ),
    );
    yield* settleWorker;
    yield* runtime.retireLocalCodexHost("connection-lost");
    yield* runtime.observeCodexOccurrence(
      occurrence(browserNotification("thread-1", "browser-2", { openTabIds: ["2"] })),
    );

    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, []);
    assert.deepEqual(invalidated, ['browser:["thread-1","browser-1","1"]']);
    assert.isNull(yield* runtime.resolveBrowserPresentation(invalidated[0]!));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("contains native image failures without failing the Codex consequence", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeHarness({
      native: {
        upsertBrowserPresentation: () =>
          Effect.fail(
            new RemoteHostedPipNativePlatformError({
              operation: "upsert",
              cause: new Error("native decode failed"),
            }),
          ),
      },
    });
    const result = yield* Effect.exit(
      runtime.observeCodexOccurrence(
        occurrence(
          browserNotification("thread-1", "browser-1", {
            screenshot: { tabId: "1", url: pngDataUrl() },
          }),
        ),
      ),
    );
    yield* settleWorker;

    assert.isTrue(Exit.isSuccess(result));
    assert.strictEqual((yield* runtime.snapshot).retainedPresentationCount, 0);
    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("records bounded content-free diagnostics for images rejected before native decode", () =>
  Effect.gen(function* () {
    let nativeUpsertCount = 0;
    const { runtime, scope } = yield* makeHarness({
      native: {
        upsertBrowserPresentation: () =>
          Effect.sync(() => {
            nativeUpsertCount += 1;
            return true;
          }),
      },
    });
    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-sensitive", "browser-1", {
          screenshot: { tabId: "1", url: "data:image/gif;base64,R0lGODlh" },
        }),
      ),
    );
    yield* settleWorker;

    assert.strictEqual(nativeUpsertCount, 0);
    const entries = yield* runtime.diagnosticSnapshot;
    assert.deepEqual(
      entries.map(({ operation, result, source }) => ({ operation, result, source })),
      [{ operation: "validate-image", result: "unsupported-mime", source: "browser-use" }],
    );
    assert.notProperty(entries[0] ?? {}, "taskId");
    assert.match(entries[0]?.taskHash ?? "", /^[a-f0-9]{16}$/u);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("does not hold the causal state lock while native image decode is pending", () =>
  Effect.gen(function* () {
    const nativeStarted = yield* Deferred.make<void>();
    const releaseNative = yield* Deferred.make<boolean>();
    const { runtime, scope } = yield* makeHarness({
      native: {
        upsertBrowserPresentation: () =>
          Deferred.succeed(nativeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseNative)),
          ),
      },
    });
    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          screenshot: { tabId: "1", url: pngDataUrl() },
        }),
      ),
    );
    yield* Deferred.await(nativeStarted);

    yield* runtime
      .observeCodexOccurrence(occurrence(computerNotification("item/started", "thread-2")))
      .pipe(Effect.timeout("1 second"));
    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, ["thread-1", "thread-2"]);

    yield* Deferred.succeed(releaseNative, false);
    yield* settleWorker;
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("routes and releases a presentation by its exact connected Chrome instance", () =>
  Effect.gen(function* () {
    const connectedChecks: Array<{ browserFamily: string; extensionInstanceId: string }> = [];
    const invalidated: string[] = [];
    const upserts: Array<{
      appIconPath: string | null;
      dataUrl: string;
      presentationId: string;
    }> = [];
    const { runtime, scope } = yield* makeHarness({
      isChromeExtensionConnected: (browserFamily, extensionInstanceId) => {
        connectedChecks.push({ browserFamily, extensionInstanceId });
        return browserFamily === "chrome" && extensionInstanceId === "profile-a";
      },
      native: {
        invalidateBrowserPresentation: (presentationId) => {
          invalidated.push(presentationId);
          return Effect.succeed(true);
        },
        upsertBrowserPresentation: ({ appIconPath, dataUrl, presentationId }) => {
          upserts.push({ appIconPath, dataUrl, presentationId });
          return Effect.succeed(true);
        },
      },
      resolveChromeBrowserIconPath: (browserFamily) =>
        browserFamily === "chrome" ? "/verified/chrome.png" : null,
    });
    const firstImage = pngDataUrl(1, 1);
    const latestImage = pngDataUrl(2, 1);
    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          backend: "chrome",
          browserFamily: "chrome",
          extensionInstanceId: "profile-a",
          screenshot: { tabId: "7", url: firstImage },
        }),
      ),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          backend: "chrome",
          browserFamily: "chrome",
          extensionInstanceId: "profile-a",
          screenshot: { tabId: "7", url: latestImage },
        }),
        { occurrenceToken: 2 },
      ),
    );
    yield* settleWorker;

    assert.strictEqual(upserts.at(-1)?.dataUrl, latestImage);
    assert.strictEqual(upserts.at(-1)?.appIconPath, "/verified/chrome.png");
    const target = yield* runtime.resolveBrowserPresentation(upserts.at(-1)!.presentationId);
    assert.deepEqual(target, {
      backend: "chrome",
      browserFamily: "chrome",
      browserId: "browser-1",
      extensionInstanceId: "profile-a",
      presentationId: upserts.at(-1)!.presentationId,
      tabId: "7",
      threadId: "thread-1",
    });
    assert.strictEqual((yield* runtime.snapshot).retainedPresentationCount, 1);

    yield* runtime.releaseChromeExtensionInstance({
      browserFamily: "edge",
      extensionInstanceId: "profile-a",
    });
    assert.deepEqual(
      yield* runtime.resolveBrowserPresentation(upserts.at(-1)!.presentationId),
      target,
    );
    yield* runtime.releaseChromeExtensionInstance({
      browserFamily: "chrome",
      extensionInstanceId: "profile-a",
    });
    assert.deepEqual(invalidated, [upserts.at(-1)!.presentationId]);
    assert.isNull(yield* runtime.resolveBrowserPresentation(upserts.at(-1)!.presentationId));
    assert.strictEqual((yield* runtime.snapshot).retainedPresentationCount, 0);
    assert.isAtLeast(connectedChecks.length, 4);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps CDP screenshots display-only without registering a click target", () =>
  Effect.gen(function* () {
    const upserts: string[] = [];
    const { runtime, scope } = yield* makeHarness({
      native: {
        upsertBrowserPresentation: ({ presentationId }) => {
          upserts.push(presentationId);
          return Effect.succeed(true);
        },
      },
    });

    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          backend: "cdp",
          screenshot: { tabId: "7", url: pngDataUrl() },
        }),
      ),
    );
    yield* settleWorker;

    assert.strictEqual(upserts.length, 1);
    assert.strictEqual((yield* runtime.snapshot).retainedPresentationCount, 1);
    assert.isNull(yield* runtime.resolveBrowserPresentation(upserts[0]!));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects Chrome surfaces without an exact connected family and instance", () =>
  Effect.gen(function* () {
    const upserts: string[] = [];
    const { runtime, scope } = yield* makeHarness({
      isChromeExtensionConnected: (browserFamily, extensionInstanceId) =>
        browserFamily === "chrome" && extensionInstanceId === "profile-a",
      native: {
        upsertBrowserPresentation: ({ presentationId }) => {
          upserts.push(presentationId);
          return Effect.succeed(true);
        },
      },
    });
    for (const [browserFamily, extensionInstanceId, browserId] of [
      ["edge", "profile-a", "wrong-family"],
      ["chrome", "profile-b", "wrong-instance"],
      ["chrome", "profile-a", "connected"],
    ] as const) {
      yield* runtime.observeCodexOccurrence(
        occurrence(
          browserNotification("thread-1", browserId, {
            backend: "chrome",
            browserFamily,
            extensionInstanceId,
            screenshot: { tabId: "7", url: pngDataUrl() },
          }),
        ),
      );
    }
    yield* settleWorker;

    assert.strictEqual(upserts.length, 1);
    assert.strictEqual(upserts[0], 'browser:["thread-1","connected","7"]');
    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, ["thread-1"]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("accepts terminal Chrome cleanup after the exact instance disconnects", () =>
  Effect.gen(function* () {
    let connected = true;
    const invalidated: string[] = [];
    const upserts: string[] = [];
    const { runtime, scope } = yield* makeHarness({
      isChromeExtensionConnected: () => connected,
      native: {
        invalidateBrowserPresentation: (presentationId) => {
          invalidated.push(presentationId);
          return Effect.succeed(true);
        },
        upsertBrowserPresentation: ({ presentationId }) => {
          upserts.push(presentationId);
          return Effect.succeed(true);
        },
      },
    });
    const chromeSurface = {
      backend: "chrome",
      browserFamily: "chrome",
      extensionInstanceId: "profile-a",
    } as const;
    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          ...chromeSurface,
          screenshot: { tabId: "7", url: pngDataUrl() },
        }),
      ),
    );
    yield* settleWorker;
    assert.strictEqual((yield* runtime.snapshot).retainedPresentationCount, 1);

    connected = false;
    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          ...chromeSurface,
          sessionEnded: true,
        }),
        { occurrenceToken: 2 },
      ),
    );

    assert.deepEqual(invalidated, [upserts[0]]);
    assert.isNull(yield* runtime.resolveBrowserPresentation(upserts[0]!));
    assert.deepEqual((yield* runtime.snapshot).activeTaskIds, []);
    assert.strictEqual((yield* runtime.snapshot).retainedPresentationCount, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("retires settled Codex cohorts without synthesizing native completion", () =>
  Effect.gen(function* () {
    const completed: string[] = [];
    const invalidated: string[] = [];
    const { runtime, scope } = yield* makeHarness({
      native: {
        completeThread: (threadId) => {
          completed.push(threadId);
          return Effect.succeed(true);
        },
        invalidateBrowserPresentation: (presentationId) => {
          invalidated.push(presentationId);
          return Effect.succeed(true);
        },
      },
    });
    yield* runtime.setTaskVisibility("thread-1", "hidden");
    yield* runtime.setTaskVisibility("thread-2", "hidden");
    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          screenshot: { tabId: "1", url: pngDataUrl() },
        }),
      ),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(computerNotification("item/started", "thread-2")),
    );
    yield* settleWorker;

    yield* runtime.retireCodexThreads({
      action: "archive",
      threadIds: ["thread-1", "thread-2"],
    });

    const archived = yield* runtime.snapshot;
    assert.deepEqual(archived.activeTaskIds, []);
    assert.strictEqual(archived.retainedPresentationCount, 0);
    assert.deepEqual(archived.taskVisibilities, {
      "thread-1": "hidden",
      "thread-2": "hidden",
    });
    assert.deepEqual(completed, []);
    assert.deepEqual(invalidated, ['browser:["thread-1","browser-1","1"]']);

    yield* runtime.observeCodexOccurrence(
      occurrence(
        browserNotification("thread-1", "browser-1", {
          screenshot: { tabId: "1", url: pngDataUrl() },
        }),
        { occurrenceToken: 2 },
      ),
    );
    yield* runtime.observeCodexOccurrence(
      occurrence(computerNotification("item/started", "thread-2"), { occurrenceToken: 2 }),
    );
    yield* settleWorker;
    yield* runtime.retireCodexThreads({
      action: "delete",
      threadIds: ["thread-1", "thread-2"],
    });

    const deleted = yield* runtime.snapshot;
    assert.deepEqual(deleted.activeTaskIds, []);
    assert.strictEqual(deleted.retainedPresentationCount, 0);
    assert.deepEqual(deleted.taskVisibilities, {});
    assert.deepEqual(completed, []);
    assert.deepEqual(invalidated, [
      'browser:["thread-1","browser-1","1"]',
      'browser:["thread-1","browser-1","1"]',
    ]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("persists one visibility batch with one monotonic, idempotent revision", () =>
  Effect.gen(function* () {
    const { runtime, scope } = yield* makeHarness();
    const initial = yield* runtime.snapshot;
    yield* runtime.setTaskVisibilities(["thread-1", "thread-2"], "hidden");
    const hidden = yield* runtime.snapshot;
    yield* runtime.setTaskVisibilities(["thread-1", "thread-2"], "hidden");
    const duplicate = yield* runtime.snapshot;
    yield* runtime.deleteTaskVisibility("thread-1");
    const deleted = yield* runtime.snapshot;

    assert.strictEqual(hidden.revision, initial.revision + 1);
    assert.deepEqual(hidden.taskVisibilities, {
      "thread-1": "hidden",
      "thread-2": "hidden",
    });
    assert.strictEqual(duplicate.revision, hidden.revision);
    assert.isAbove(deleted.revision, duplicate.revision);
    assert.deepEqual(deleted.taskVisibilities, { "thread-2": "hidden" });
    yield* Scope.close(scope, Exit.void);
  }),
);
