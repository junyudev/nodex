import { describe, vi, expect, test } from "vite-plus/test";
import { live as fileExportsLive } from "../../library-application/FileExportRuntime";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import osfilelocalimport from "node:os";
import { tmpdir } from "node:os";
import * as path from "node:path";
import pathfilelocalimport from "node:path";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { ReadFileBytesInput } from "../../../shared/library-files";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { LibraryModule } from "../../library-application/LibraryModule";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live, type FilesIpcError } from "./FilesIpc";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import * as fsfilelocalimport from "node:fs/promises";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { FileWatchHost } from "../../file-watch-host";
import { live as liveWorkspaceFileIpc } from "./WorkspaceFileIpc";
import { WorkspaceFileQueries } from "../../host-runtime/WorkspaceFileQueries";
import { WorkspaceFileUserError } from "../../workspace-files-service";
import { collectLocalFileCandidates, readLocalFile } from "./file-local-import";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: vi.fn(),
}));

describe("FilesIpc", () => {
  type Handler = (
    event: IpcMainInvokeEvent,
    ...args: readonly unknown[]
  ) => Effect.Effect<
    unknown,
    FilesIpcError | Effect.Error<ReturnType<LibraryModule["Service"]["readFileBlob"]>>
  >;

  it.effect("preserves exact File sources for save/read and distinct batch publication slots", () =>
    Effect.gen(function* () {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-file-io-"));
      const scope = yield* Scope.make();
      try {
        const destination = path.join(home, "saved.png");
        const selected = path.join(home, "selected.txt");
        fs.writeFileSync(selected, "selected");
        const handlers = new Map<string, Handler>();
        const etag = createHash("sha256").update("captured").digest("hex");
        const reads: ReadFileBytesInput[] = [];
        const slots: string[] = [];
        const ipc = makeTestElectronIpc({
          handle: (channel: string, handler: Handler) =>
            Effect.acquireRelease(
              Effect.sync(() => handlers.set(channel, handler)),
              () =>
                Effect.sync(() => {
                  handlers.delete(channel);
                }),
            ),
          on: () => Effect.die("unused"),
        });
        const library = {
          read: (_access, request) =>
            Effect.sync(() => {
              if (request.read.mode !== "file_presentation")
                throw new Error("Unexpected File read");
              return {
                ok: true as const,
                value: {
                  profileId: "profile",
                  libraryId: "library",
                  storeEpoch: "epoch",
                  commitSeq: 1,
                  authorization: null,
                  value: {
                    kind: "file_presentation" as const,
                    value: {
                      file_id: "file-a",
                      version: 2,
                      default_name: "old.png",
                      mime_type: "image/png",
                      byte_length: 8,
                      blob_etag: etag,
                    },
                  },
                },
              };
            }),
          readFileBlob: (_access, input) =>
            Effect.sync(() => {
              reads.push(input);
              return {
                bytes: new TextEncoder().encode("captured"),
                mimeType: "image/png",
                etag,
              };
            }),
          prepareFileBlob: (_access, _operation, slot, bytes) =>
            Effect.sync(() => {
              slots.push(slot);
              return {
                receipt_id: `receipt:${slot}`,
                blob_etag: "a".repeat(64),
                byte_length: bytes.length,
                expires_at_unix_ms: 1,
              };
            }),
        } satisfies Partial<LibraryModule["Service"]>;
        yield* Layer.buildWithScope(
          live.pipe(
            Layer.provideMerge(fileExportsLive),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ElectronIpc, ipc),
                mainConfigLayer({ nodexHome: home }),
                Layer.succeed(LibraryModule, library as unknown as LibraryModule["Service"]),
                Layer.succeed(ElectronDesktop, {
                  dialog: {
                    showOpenDialog: async () => ({
                      canceled: false,
                      filePaths: [selected],
                      bookmarks: [],
                    }),
                    showSaveDialog: async () => ({ canceled: false, filePath: destination }),
                  },
                } as unknown as ElectronDesktop["Service"]),
                Layer.succeed(WindowRuntime, {
                  has: () => true,
                  get: () => undefined,
                } as unknown as WindowRuntime["Service"]),
              ),
            ),
          ),
          scope,
        );
        const event = { sender: { id: 41 } } as IpcMainInvokeEvent;
        const access = { kind: "library" };
        const input = {
          fileId: "file-a",
          source: { kind: "document_revision", document_id: "doc-a", revision_id: "revision-old" },
          version: 2,
        } as const;
        yield* handlers.get("files:read")!(event, access, input);
        yield* handlers.get("files:save")!(event, access, { ...input, defaultName: "old.png" });
        assert.deepStrictEqual(reads, [input, input]);
        const name = "Édition One.PNG";
        const exportDirectory = path.join(home, "cache", "file-exports", etag);
        const materialize = (defaultName = name) =>
          handlers.get("files:materialize")!(event, access, { ...input, defaultName });
        const exported = path.join(exportDirectory, name);
        assert.strictEqual(yield* materialize(), exported);
        assert.strictEqual(fs.readFileSync(exported, "utf8"), "captured");
        if (process.platform !== "win32")
          assert.strictEqual(fs.statSync(exported).mode & 0o777, 0o444);
        assert.strictEqual(yield* materialize(), exported);
        assert.deepStrictEqual(reads, [input, input, input]);

        fs.chmodSync(exported, 0o600);
        fs.truncateSync(exported, 2);
        fs.chmodSync(exported, 0o444);
        const repaired = yield* Effect.all([materialize(), materialize()], { concurrency: 2 });
        assert.deepStrictEqual(repaired, [exported, exported]);
        assert.strictEqual(fs.readFileSync(exported, "utf8"), "captured");
        if (process.platform !== "win32")
          assert.strictEqual(fs.statSync(exported).mode & 0o777, 0o444);

        const sibling = path.join(exportDirectory, "Another Name.png");
        const fallback = path.join(exportDirectory, "File.PnG");
        assert.strictEqual(yield* materialize("Another Name.png"), sibling);
        assert.strictEqual(yield* materialize("../outside/unsafe.PnG"), fallback);
        for (const file of [exported, sibling, fallback])
          assert.strictEqual(fs.readFileSync(file, "utf8"), "captured");
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "captured");
        const readsBeforeInvalid = reads.length;
        const invalid = yield* Effect.exit(
          handlers.get("files:read")!(event, access, {
            ...input,
            source: { ...input.source, page_id: "page-b" },
          }),
        );
        assert.isTrue(Exit.isFailure(invalid));
        assert.strictEqual(reads.length, readsBeforeInvalid);
        const picked = (yield* handlers.get("files:pick-and-prepare")!(event, access, {
          operationId: "picked-operation",
          selection: "files",
        })) as { readonly cancelled: boolean; readonly files: readonly { logicalPath: string }[] };
        assert.isFalse(picked.cancelled);
        assert.deepStrictEqual(
          picked.files.map((file) => file.logicalPath),
          ["selected.txt"],
        );
        const dropped = (yield* handlers.get("files:prepare-local-drop")!(event, access, {
          operationId: "dropped-operation",
          localPaths: [selected],
        })) as { readonly files: readonly { logicalPath: string }[] };
        assert.deepStrictEqual(
          dropped.files.map((file) => file.logicalPath),
          ["selected.txt"],
        );
        for (const slot of ["selection:0", "selection:1"])
          yield* handlers.get("files:prepare")!(event, access, {
            operationId: "same-operation",
            idempotencySlot: slot,
            source: {
              kind: "bytes",
              logicalPath: "same.png",
              mimeType: "image/png",
              bytes: new Uint8Array([1, 2]),
            },
          });
        assert.deepStrictEqual(slots, ["selection:0", "selection:0", "selection:0", "selection:1"]);
      } finally {
        yield* Scope.close(scope, Exit.void);
        fs.rmSync(home, { recursive: true, force: true });
      }
    }),
  );
});

describe("WorkspaceFileIpc", () => {
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
        liveWorkspaceFileIpc({
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
                pathStates: () =>
                  Effect.sync(() => {
                    existenceReads += 1;
                    return { states: [] };
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
      const exists = handlers.get("workspace-path-states");
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
});

describe("file-local-import", () => {
  const fs = fsfilelocalimport;
  const os = osfilelocalimport;
  const path = pathfilelocalimport;
  describe("local File import", () => {
    test("expands mixed files and folders into one deterministic logical-path batch", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-page-file-import-"));
      try {
        const looseFile = path.join(root, "notes.txt");
        const folder = path.join(root, "references");
        await fs.mkdir(path.join(folder, "nested"), { recursive: true });
        await Promise.all([
          fs.writeFile(looseFile, "notes"),
          fs.writeFile(path.join(folder, "api.md"), "api"),
          fs.writeFile(path.join(folder, "nested", "schema.json"), "{}"),
        ]);

        const candidates = await collectLocalFileCandidates([looseFile, folder, looseFile]);

        expect(candidates.map(({ logicalPath }) => logicalPath)).toEqual([
          "notes.txt",
          "references/api.md",
          "references/nested/schema.json",
        ]);
        expect(candidates.map(({ byteLength }) => byteLength)).toEqual([5, 3, 2]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    test("rejects a symlink before returning a partial directory batch", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-page-file-import-"));
      try {
        const folder = path.join(root, "references");
        await fs.mkdir(folder);
        await fs.writeFile(path.join(folder, "api.md"), "api");
        await fs.symlink(path.join(folder, "api.md"), path.join(folder, "alias.md"));

        await expect(collectLocalFileCandidates([folder])).rejects.toThrow(
          "references/alias.md is a symbolic link",
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    test("rejects a wide folder once its file budget is exceeded", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-file-budget-"));
      try {
        await Promise.all(
          Array.from({ length: 101 }, (_, index) =>
            fs.writeFile(path.join(root, `${index}.txt`), ""),
          ),
        );
        await expect(collectLocalFileCandidates([root])).rejects.toThrow("100 File batch limit");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    test("reads through one no-follow file handle and rejects direct symlinks", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-page-file-import-"));
      try {
        const filePath = path.join(root, "notes.txt");
        const aliasPath = path.join(root, "notes-alias.txt");
        await fs.writeFile(filePath, "stable bytes");
        await fs.symlink(filePath, aliasPath);

        await expect(readLocalFile(filePath)).resolves.toEqual(Buffer.from("stable bytes"));
        await expect(readLocalFile(aliasPath)).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});
