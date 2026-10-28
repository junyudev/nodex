import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import { assert, it } from "@effect/vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IpcMainInvokeEvent } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import type { FileWatchHost } from "../../file-watch-host";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./WorkspaceFileIpc";
import { WorkspaceFileQueries } from "../../host-runtime/WorkspaceFileQueries";
import { WorkspaceFileUserError } from "../../workspace-files-service";

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

it.effect("releases active file watches and renderer listeners with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    let acquireCount = 0;
    let disposeCount = 0;
    let authorized = true;
    let existenceReads = 0;
    let readPath: string | undefined;
    let saveDestination: string | null = null;
    let exportReads = 0;
    let senderDestroyed = false;
    let retireDuringExport = false;
    const fileWatchHost: FileWatchHost = {
      watch: (input) =>
        Stream.callback((events) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              acquireCount += 1;
              Queue.offerUnsafe(events, {
                _tag: "Ready" as const,
                coverage: { recursive: input.recursive, typedPathChanges: false as const },
                path: input.path,
              });
            }),
            () =>
              Effect.sync(() => {
                disposeCount += 1;
              }),
          ),
        ),
    };
    const subscriptionIds = [
      "128cc777-30ab-4c91-8857-a2083e8349f1",
      "128cc777-30ab-4c91-8857-a2083e8349f2",
    ];
    const listeners = new Map<string, () => void>();
    const sender = {
      id: 77,
      isDestroyed: () => senderDestroyed,
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      removeListener: (event: string, listener: () => void) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
    };
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live({
        authorizeSender: () => authorized,
        fileWatchHost,
        makeSubscriptionId: () => subscriptionIds.shift() ?? "unexpected-subscription-id",
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(ElectronDesktop, {
              dialog: {
                showSaveDialog: async () => ({
                  canceled: saveDestination === null,
                  filePath: saveDestination ?? undefined,
                }),
              },
            } as unknown as ElectronDesktop["Service"]),
            Layer.succeed(WorkspaceFileQueries, {
              directory: () => Effect.die("unused"),
              pathsExist: () =>
                Effect.sync(() => {
                  existenceReads += 1;
                  return { existingPaths: [] };
                }),
              metadata: () => Effect.die("unused"),
              text: (input) =>
                Effect.sync(() => {
                  readPath = input.path;
                  return { contents: "exact" };
                }),
              binary: () => Effect.die("unused"),
              exportBytes: () =>
                Effect.sync(() => {
                  exportReads += 1;
                  if (retireDuringExport) senderDestroyed = true;
                  return Buffer.from("remote bytes");
                }),
              githubUrl: () => Effect.succeed(null),
            }),
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );
    assert.strictEqual(handlers.size, 11);

    const text = handlers.get("read-file");
    assert.isDefined(text);
    assert.deepStrictEqual(
      yield* text({ sender } as unknown as IpcMainInvokeEvent, {
        hostId: "ssh:build",
        path: "/workspace/report ",
        maxBytes: 100,
      }),
      { contents: "exact" },
    );
    assert.strictEqual(readPath, "/workspace/report ");

    const save = handlers.get("workspace-file:save-copy");
    assert.isDefined(save);
    assert.deepStrictEqual(
      yield* save({ sender } as unknown as IpcMainInvokeEvent, {
        hostId: "ssh:build",
        path: "/workspace/export.txt",
      }),
      { path: null },
    );
    assert.strictEqual(exportReads, 0);
    const exportDirectory = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "nodex-remote-export-")),
    );
    yield* Scope.addFinalizer(
      scope,
      Effect.promise(() => rm(exportDirectory, { recursive: true, force: true })),
    );
    saveDestination = join(exportDirectory, "saved.txt");
    assert.deepStrictEqual(
      yield* save({ sender } as unknown as IpcMainInvokeEvent, {
        hostId: "ssh:build",
        path: "/workspace/export.txt",
      }),
      { path: saveDestination },
    );
    assert.strictEqual(
      yield* Effect.promise(() => readFile(saveDestination!, "utf8")),
      "remote bytes",
    );
    saveDestination = join(exportDirectory, "retired.txt");
    retireDuringExport = true;
    assert.deepStrictEqual(
      yield* save({ sender } as unknown as IpcMainInvokeEvent, {
        hostId: "ssh:build",
        path: "/workspace/export.txt",
      }),
      { path: null },
    );
    assert.isNull(yield* Effect.promise(() => stat(saveDestination!).catch(() => null)));
    senderDestroyed = false;

    const start = handlers.get("workspace-file-watch:start");
    assert.isDefined(start);
    assert.deepStrictEqual(
      yield* start({ sender } as unknown as IpcMainInvokeEvent, { path: "/tmp/nodex-file" }),
      { subscriptionId: "128cc777-30ab-4c91-8857-a2083e8349f1" },
    );
    assert.deepStrictEqual(
      yield* start({ sender } as unknown as IpcMainInvokeEvent, { path: "/tmp/nodex-file" }),
      { subscriptionId: "128cc777-30ab-4c91-8857-a2083e8349f2" },
    );
    assert.strictEqual(acquireCount, 1);
    assert.isTrue(listeners.has("destroyed"));

    const metadata = handlers.get("read-file-metadata");
    assert.isDefined(metadata);
    const invalidInput = yield* Effect.result(
      metadata({ sender } as unknown as IpcMainInvokeEvent, { path: "" }),
    );
    assert.isTrue(Result.isFailure(invalidInput));
    if (Result.isFailure(invalidInput)) {
      assert.instanceOf(invalidInput.failure, WorkspaceFileUserError);
      assert.strictEqual((invalidInput.failure as WorkspaceFileUserError).code, "invalid_path");
    }
    authorized = false;
    const exists = handlers.get("workspace-paths-exist");
    assert.isDefined(exists);
    const denied = yield* Effect.result(
      exists({ sender } as unknown as IpcMainInvokeEvent, { paths: ["/tmp"] }),
    );
    assert.isTrue(Result.isFailure(denied));
    if (Result.isFailure(denied)) {
      assert.instanceOf(denied.failure, WorkspaceFileUserError);
      assert.strictEqual((denied.failure as WorkspaceFileUserError).code, "unauthorized_sender");
    }
    assert.strictEqual(existenceReads, 0);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(disposeCount, 1);
    assert.strictEqual(listeners.size, 0);
    assert.strictEqual(handlers.size, 0);
  }),
);
