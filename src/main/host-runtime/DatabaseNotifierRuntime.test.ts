import { assert, it } from "@effect/vitest";
import type { BrowserWindow } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { DatabaseChangeEvent } from "../../shared/database-events";
import { parseDatabaseViewId } from "../../shared/database-identities";
import { allProjectSessionInvalidation } from "../core-client/core-project-workspace-invalidation";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DatabaseNotifierRuntime } from "./DatabaseNotifierRuntime";
import { live } from "../platform/electron/DatabaseNotifications";

const emptyWindows = {
  all: () => [],
  count: () => 0,
} as unknown as WindowRuntime["Service"];

const layer = (windows: WindowRuntime["Service"] = emptyWindows) =>
  live.pipe(Layer.provide(Layer.succeed(WindowRuntime, windows)));

const databaseEvent = (overrides: Partial<DatabaseChangeEvent> = {}): DatabaseChangeEvent => ({
  version: 3,
  projectId: "project:test",
  libraryId: "library:test",
  storeEpoch: "epoch:test",
  operationId: "operation:test",
  sourceKind: "database_module",
  affectedDatabaseIds: [],
  affectedDataSourceIds: [],
  affectedPageIds: [],
  affectedViewIds: [],
  personalViewChanges: [],
  commitSeq: 4,
  ...overrides,
});

it.effect("closes typed observation with its owning Main Scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const runtime = Context.get(
      yield* Layer.buildWithScope(layer(), scope),
      DatabaseNotifierRuntime,
    );

    const completion = yield* Stream.runHead(runtime.projectSessionInvalidations).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(Option.isNone(yield* Fiber.join(completion)));
  }),
);

it.effect("broadcasts database projections and publishes session invalidations", () =>
  Effect.gen(function* () {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    } as unknown as BrowserWindow;
    const windows = {
      all: () => [window],
      count: () => 1,
    } as unknown as WindowRuntime["Service"];
    const scope = yield* Scope.make();
    const runtime = Context.get(
      yield* Layer.buildWithScope(layer(windows), scope),
      DatabaseNotifierRuntime,
    );

    yield* runtime.notifyDatabaseChanged(
      databaseEvent({
        personalViewChanges: [
          {
            kind: "occurrence_disclosure",
            viewId: parseDatabaseViewId("view:test"),
            target: { kind: "page", occurrenceKey: "ITEM_parent/child" },
            collapsed: true,
          },
        ],
      }),
    );
    assert.deepEqual(
      sent.map((entry) => entry.channel),
      ["database-changed"],
    );

    yield* runtime.notifyDatabaseChanged(databaseEvent({ affectedDataSourceIds: ["source:test"] }));
    assert.deepEqual(
      sent.slice(-2).map((entry) => entry.channel),
      ["database-changed", "library-navigation-changed"],
    );

    const sessionEvent = allProjectSessionInvalidation();
    const received = yield* Stream.runHead(runtime.projectSessionInvalidations).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* runtime.notifyProjectSessionInvalidation(sessionEvent);
    assert.deepEqual(yield* Fiber.join(received), Option.some(sessionEvent));
    assert.strictEqual(sent.at(-1)?.channel, "project-sessions-changed");
    yield* Scope.close(scope, Exit.void);
  }),
);
