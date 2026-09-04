import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { IpcMainInvokeEvent } from "electron";
import type { ReadFileBytesInput } from "../../../shared/library-files";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { LibraryModule } from "../../library-application/LibraryModule";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live, type FilesIpcError } from "./FilesIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: vi.fn(),
}));
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
        readFileBlob: (_access, input) =>
          Effect.sync(() => {
            reads.push(input);
            return {
              bytes: new TextEncoder().encode("captured"),
              mimeType: "image/png",
              etag: createHash("sha256").update("captured").digest("hex"),
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
      const materialize = () =>
        handlers.get("files:materialize")!(event, access, { ...input, defaultName: "old.png" });
      const exported = String(yield* materialize());
      assert.isTrue(exported.startsWith(path.join(home, "cache", "file-exports")));
      assert.strictEqual(fs.readFileSync(exported, "utf8"), "captured");
      assert.strictEqual(String(yield* materialize()), exported);
      fs.unlinkSync(exported);
      assert.strictEqual(String(yield* materialize()), exported);
      assert.strictEqual(fs.readFileSync(exported, "utf8"), "captured");
      assert.deepStrictEqual(reads, [input, input, input, input, input]);
      assert.strictEqual(fs.readFileSync(destination, "utf8"), "captured");
      const invalid = yield* Effect.exit(
        handlers.get("files:read")!(event, access, {
          ...input,
          source: { ...input.source, page_id: "page-b" },
        }),
      );
      assert.isTrue(Exit.isFailure(invalid));
      assert.strictEqual(reads.length, 5);
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
