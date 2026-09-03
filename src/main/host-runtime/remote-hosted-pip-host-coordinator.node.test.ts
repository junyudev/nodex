import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BrowserWindow } from "electron";
import type { RemoteHostedPipTaskStateSnapshot } from "../../shared/remote-hosted-pip";
import type { RemoteHostedPipPreferencesAdapter } from "../remote-hosted-pip-preference-store";
import type { RemoteHostedPipNativePlatformService } from "../platform/electron/RemoteHostedPipNativePlatform";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import type { WindowRuntimeSnapshot } from "../window-runtime/window-runtime-lifecycle";
import { makeRemoteHostedPipHostCoordinator } from "./remote-hosted-pip-host-coordinator";

function fakeWindow(webContentsId: number): BrowserWindow {
  return {
    getContentBounds: () => ({ height: 700, width: 1_000, x: 10, y: 20 }),
    getNativeWindowHandle: () => Buffer.from([webContentsId]),
    getTitle: () => `Window ${webContentsId}`,
    isDestroyed: () => false,
    webContents: { id: webContentsId },
  } as unknown as BrowserWindow;
}

const hostLayout = {
  anchors: [{ alignment: "bottom-right" as const, point: { x: 980, y: 680 } }],
  anchorRect: { height: 120, width: 120, x: 850, y: 540 },
  animated: true,
  hostId: "renderer-supplied-id",
  presentationScope: "thread" as const,
};

it.effect(
  "starts only with active work and an eligible host, then follows canonical window focus",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const focusedSecond = yield* Deferred.make<void>();
      const windowsByWebContentsId = new Map([
        [11, fakeWindow(11)],
        [22, fakeWindow(22)],
      ]);
      let state: RemoteHostedPipTaskStateSnapshot = {
        activeTaskIds: [],
        alwaysHidden: false,
        retainedPresentationCount: 0,
        revision: 0,
        taskVisibilityActionAvailable: true,
        taskVisibilities: {},
      };
      let windowSnapshot: WindowRuntimeSnapshot = {
        revision: 1,
        windows: [
          {
            activeSessionId: "thread-a",
            focusSequence: 1,
            focused: true,
            kind: "primary",
            layoutRevision: 1,
            webContentsId: 11,
            windowId: 11,
            windowSessionId: "window-session-a",
          },
          {
            activeSessionId: "thread-b",
            focusSequence: null,
            focused: false,
            kind: "primary",
            layoutRevision: 1,
            webContentsId: 22,
            windowId: 22,
            windowSessionId: "window-session-b",
          },
        ],
      };
      const calls = {
        activeThreadIds: [] as Array<string | null>,
        registeredHosts: [] as Array<{
          id: string;
          interactionPassthroughRect: unknown;
          presentationScope: string;
        }>,
        startCount: 0,
        startTooltips: [] as Array<
          Parameters<RemoteHostedPipNativePlatformService["startHost"]>[0]
        >,
        stopCount: 0,
        suppressedThreadIds: [] as string[][],
        unregisteredHostIds: [] as string[],
        visibilityRefreshes: [] as Array<readonly string[] | undefined>,
      };
      let shouldShowTask: (taskId: string) => boolean = () => false;
      const native: RemoteHostedPipNativePlatformService = {
        availability: {
          capabilities: {
            computerUseService: true,
            hostLayout: true,
            interaction: true,
            presentation: true,
          },
          status: "available",
        },
        completeThread: () => Effect.succeed(true),
        connectHost: () => Effect.succeed(true),
        events: Stream.empty,
        hasAnyPresentation: Effect.succeed(false),
        invalidateBrowserContent: () => Effect.succeed(true),
        invalidateTurn: () => Effect.succeed(true),
        isPrivacySettingsTerminationRequest: Effect.succeed(false),
        readActiveTaskIds: Effect.succeed([]),
        readLayoutState: Effect.succeed(null),
        refreshVisibility: (threadIds) =>
          Effect.sync(() => {
            calls.visibilityRefreshes.push(threadIds ? [...threadIds] : undefined);
            return true;
          }),
        registerHost: (input) =>
          Effect.sync(() => {
            calls.registeredHosts.push({
              id: input.id,
              interactionPassthroughRect: input.interactionPassthroughRect,
              presentationScope: input.presentationScope,
            });
            return true;
          }),
        setActiveThreadId: (threadId) =>
          Effect.sync(() => {
            calls.activeThreadIds.push(threadId);
            return true;
          }).pipe(
            Effect.tap(() =>
              threadId === "thread-b" ? Deferred.succeed(focusedSecond, undefined) : Effect.void,
            ),
          ),
        setMaxDisplaySize: () => Effect.succeed(true),
        setShouldShowTask: (predicate) => void (shouldShowTask = predicate),
        setSuppressedThreadIds: (threadIds) =>
          Effect.sync(() => {
            calls.suppressedThreadIds.push([...threadIds]);
            return true;
          }),
        startHost: (tooltips) =>
          Effect.sync(() => {
            calls.startCount += 1;
            calls.startTooltips.push(tooltips);
            return true;
          }).pipe(Effect.tap(() => Deferred.succeed(started, undefined))),
        stopHost: Effect.sync(() => {
          calls.stopCount += 1;
          return true;
        }),
        unregisterHost: (hostId) =>
          Effect.sync(() => {
            calls.unregisteredHostIds.push(hostId);
            return true;
          }),
        upsertBrowserContent: () => Effect.succeed(true),
      };
      const windows = {
        events: Stream.never,
        getRegisteredWindow: (webContentsId: number) =>
          windowsByWebContentsId.get(webContentsId) ?? null,
        snapshot: () => windowSnapshot,
      } as unknown as WindowRuntimeService;
      const preferences = {
        readMaxDisplaySize: () => null,
      } as unknown as RemoteHostedPipPreferencesAdapter;
      const coordinator = yield* makeRemoteHostedPipHostCoordinator({
        isThreadSurfacePresented: (threadId) => threadId === "thread-a",
        native,
        preferences,
        readSnapshot: () => state,
        windows,
      }).pipe(Effect.provideService(Scope.Scope, scope));

      assert.isFalse(yield* coordinator.reportLayout(99, hostLayout));
      assert.isTrue(
        yield* coordinator.reportLayout(11, {
          ...hostLayout,
          hostId: "avatar-overlay",
          interactionPassthroughRect: { height: 50, width: 50, x: 0, y: 0 },
          presentationScope: "all",
        }),
      );
      assert.isTrue(yield* coordinator.reportLayout(22, hostLayout));
      yield* Effect.yieldNow;
      assert.strictEqual(calls.startCount, 0);

      state = {
        activeTaskIds: ["thread-a", "thread-b"],
        alwaysHidden: false,
        retainedPresentationCount: 1,
        revision: 1,
        taskVisibilityActionAvailable: true,
        taskVisibilities: { "thread-b": "hidden" },
      };
      yield* coordinator.refresh;
      yield* Deferred.await(started);
      yield* Effect.yieldNow;

      assert.strictEqual(calls.startCount, 1);
      assert.deepEqual(calls.startTooltips, [
        {
          closeTooltip: "Return Picture-in-Picture to Nodex",
          hide: "Hide",
          hideForAllActiveTasks: "Hide for all active tasks",
          hideForTask: "Hide for this task",
          placementTooltip: "Send Picture-in-Picture to Pet",
        },
      ]);
      assert.deepEqual(calls.registeredHosts, [
        {
          id: "codex-main-thread",
          interactionPassthroughRect: null,
          presentationScope: "thread",
        },
      ]);
      assert.deepEqual(calls.suppressedThreadIds.at(-1), ["thread-a", "thread-b"]);
      assert.isFalse(shouldShowTask("thread-b"));
      assert.isTrue(shouldShowTask("thread-a"));
      assert.strictEqual(calls.activeThreadIds.at(-1), null);
      assert.deepEqual(calls.visibilityRefreshes, [["thread-a", "thread-b"]]);

      windowSnapshot = {
        revision: 2,
        windows: windowSnapshot.windows.map((window) => ({
          ...window,
          focusSequence: window.webContentsId === 22 ? 2 : 1,
          focused: window.webContentsId === 22,
        })),
      };
      yield* coordinator.refresh;
      yield* Deferred.await(focusedSecond);
      assert.deepEqual(calls.unregisteredHostIds, ["codex-main-thread"]);
      assert.strictEqual(calls.registeredHosts.at(-1)?.id, "codex-main-thread");
      assert.strictEqual(calls.activeThreadIds.at(-1), "thread-b");
      assert.deepEqual(calls.visibilityRefreshes, [["thread-a", "thread-b"]]);

      state = {
        ...state,
        revision: 2,
        taskVisibilities: { "thread-b": "shown" },
      };
      yield* coordinator.refresh;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.deepEqual(calls.visibilityRefreshes.at(-1), ["thread-b"]);

      state = { ...state, alwaysHidden: true, revision: 3 };
      yield* coordinator.refresh;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(calls.visibilityRefreshes.length, 3);
      assert.isUndefined(calls.visibilityRefreshes.at(-1));

      state = { ...state, activeTaskIds: [], revision: 4 };
      yield* coordinator.refresh;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(calls.stopCount, 1);
      assert.isFalse(shouldShowTask("thread-a"));

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(calls.stopCount, 1);
    }),
);
