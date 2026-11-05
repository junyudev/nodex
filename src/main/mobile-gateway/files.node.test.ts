import { createHash } from "node:crypto";
import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { it } from "@effect/vitest";
import { MOBILE_UPLOAD_MAX_BYTES } from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { fileSource, parseFileSource } from "../../shared/file-resources";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { testLayer as configLayer } from "../app/MainConfig";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { FileExportRuntime } from "../library-application/FileExportRuntime";
import { LibraryModule } from "../library-application/LibraryModule";
import { live as profileFiles } from "../platform/node/MobileProfileFiles";
import { attachmentRef, makeMobileFiles } from "./files";

const fixture = (library?: LibraryModule["Service"]) =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-mobile-files-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const attachmentPath = join(home, "attachment");
    const versionReads: number[] = [];
    let version = 1;
    let content = Buffer.from("abcdefgh");
    let inlineReads = 0;
    let staged: Uint8Array = new Uint8Array();
    const uploaded = new Map<string, { bytes: Uint8Array; mimeType: string; name: string }>();
    const files = yield* makeMobileFiles.pipe(
      Effect.provide(configLayer({ nodexHome: home })),
      Effect.provide(profileFiles),
      Effect.provide(NodeFileSystem.layer),
      Effect.provideService(AgentRuntimeApplication, {
        itemContent: () => Effect.sync(() => ({ contentVersion: String(version) })),
        attachment: ({ attachmentId }: { attachmentId: string }) =>
          Effect.sync(() => {
            if (attachmentId === "tool-result:0") {
              inlineReads++;
              return { dataUrl: `data:image/png;base64,${content.toString("base64")}` };
            }
            return {
              path: attachmentPath,
              attachment: { name: "example.png", mimeType: "image/png" },
            };
          }),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(FileExportRuntime, {} as FileExportRuntime["Service"]),
      Effect.provideService(CoreAuthority, {
        identity: { storeEpoch: "epoch" },
      } as CoreAuthority["Service"]),
      Effect.provideService(
        LibraryModule,
        library ??
          ({
            read: (_: unknown, { read }: { read: { mode: string; file_id: string } }) =>
              Effect.sync(() => {
                const file = uploaded.get(read.file_id);
                if (file)
                  return {
                    ok: true,
                    value: {
                      value: {
                        kind: read.mode,
                        value: {
                          version: 1,
                          head_version: 1,
                          revision: 1,
                          lifecycle: "live",
                          mime_type: file.mimeType,
                          default_name: file.name,
                          byte_length: file.bytes.length,
                          blob_etag: createHash("sha256").update(file.bytes).digest("hex"),
                        },
                      },
                    },
                  };
                if (read.file_id !== "example")
                  return { ok: false, error: { code: "resource_not_found" } };
                return {
                  ok: true,
                  value: {
                    value: {
                      kind: "file_presentation",
                      value: {
                        version,
                        mime_type: "text/plain",
                        default_name: "example.txt",
                      },
                    },
                  },
                };
              }),
            prepareFileBlob: (_: unknown, _operation: string, _slot: string, bytes: Uint8Array) =>
              Effect.sync(() => {
                staged = bytes;
                return { receipt_id: "prepared" };
              }),
            apply: (
              _: unknown,
              {
                operation,
              }: {
                operation: { change: { file_id: string; mime_type: string; default_name: string } };
              },
            ) =>
              Effect.sync(() => {
                const change = operation.change;
                if (uploaded.has(change.file_id)) return { ok: false };
                uploaded.set(change.file_id, {
                  bytes: staged,
                  mimeType: change.mime_type,
                  name: change.default_name,
                });
                return { ok: true };
              }),
            readFileBlob: (_: unknown, input: { version?: number }) =>
              Effect.sync(() => {
                versionReads.push(input.version!);
                return { bytes: content, mimeType: "text/plain", etag: String(version) };
              }),
          } as unknown as LibraryModule["Service"]),
      ),
    );
    return {
      home,
      files,
      attachmentPath,
      versionReads,
      inlineReads: () => inlineReads,
      replaceContent: () => {
        version++;
        content = Buffer.from("ABCDEFGH");
      },
    };
  });

it.effect("reserves upload slots and writes each offset once under concurrent requests", () =>
  Effect.gen(function* () {
    const { home, files } = yield* fixture();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handlers = yield* files.open;
        const begin = handlers["files.upload.begin"];
        const chunk = handlers["files.upload.chunk"];
        const commit = handlers["files.upload.commit"];
        const input = { name: "example.txt", mimeType: "text/plain", size: 2 };
        const attempts = yield* Effect.all(
          Array.from({ length: 6 }, () => begin(input).pipe(Effect.result)),
          { concurrency: "unbounded" },
        );
        const opened = attempts.filter(Result.isSuccess);
        expect(opened).toHaveLength(4);
        expect(attempts.filter(Result.isFailure).map(({ failure }) => failure.code)).toEqual([
          "unavailable",
          "unavailable",
        ]);
        const directories = yield* Effect.promise(() => readdir(home));
        expect(directories).toHaveLength(1);

        const { uploadId } = opened[0]!.success;
        const first = { uploadId, offset: 0, base64: "YQ==" };
        const duplicate = yield* Effect.all(
          [chunk(first).pipe(Effect.result), chunk(first).pipe(Effect.result)],
          { concurrency: 2 },
        );
        expect(duplicate.filter(Result.isSuccess)).toHaveLength(1);
        expect(duplicate.filter(Result.isFailure)[0]?.failure.code).toBe("invalid_params");
        yield* chunk({ uploadId, offset: 1, base64: "Yg==" });
        expect(yield* commit({ uploadId })).toMatchObject({ size: 2, name: input.name });

        const abandoned = opened[1]!.success.uploadId;
        yield* chunk({ uploadId: abandoned, offset: 0, base64: "YQ==" });
        yield* TestClock.adjust("150 seconds");
        expect(
          yield* chunk({ uploadId: abandoned, offset: 1, base64: "Yg==" }).pipe(Effect.flip),
        ).toMatchObject({ code: "not_found" });
        expect(yield* Effect.promise(() => readdir(join(home, directories[0]!)))).toEqual([]);
        yield* begin({ ...input, size: MOBILE_UPLOAD_MAX_BYTES });
      }),
    );
    expect(yield* Effect.promise(() => readdir(home))).toEqual([]);
  }),
);

it.effect("downloads many ranges with one Core blob fetch and rejects a replaced version", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const read = (yield* test.files.open)["files.read"];
        const ref = fileSource("example");
        const first = yield* read({ ref, offset: 0, length: 1 });
        const remaining = yield* Effect.forEach(
          [1, 2, 3, 4, 5, 6, 7],
          (offset) => read({ ref, offset, length: 1, version: first.version }),
          { concurrency: 4 },
        );
        expect(
          Buffer.concat(
            [first, ...remaining].map(({ base64 }) => Buffer.from(base64, "base64")),
          ).toString(),
        ).toBe("abcdefgh");
        expect(new Set([first, ...remaining].map(({ version }) => version))).toEqual(
          new Set(["1"]),
        );
        expect(test.versionReads).toEqual([1]);
        test.replaceContent();
        expect(
          yield* read({ ref, offset: 1, length: 1, version: first.version }).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" });
        expect(test.versionReads).toEqual([1]);
        expect(yield* read({ ref, offset: 0, length: 2 })).toMatchObject({
          version: "2",
          base64: "QUI=",
        });
        expect(test.versionReads).toEqual([1, 2]);
      }),
    );
    expect(yield* Effect.promise(() => readdir(test.home))).toEqual([]);
  }),
);

it.effect("pins path and inline chat attachments to their content versions", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const read = (yield* test.files.open)["files.read"];
    const ref = attachmentRef(["session", "source", "item", "file"]);
    yield* Effect.promise(() => writeFile(test.attachmentPath, "abcdef"));
    const first = yield* read({ ref, offset: 0, length: 2 });
    expect(yield* read({ ref, offset: 2, length: 2, version: first.version })).toMatchObject({
      base64: "Y2Q=",
      version: first.version,
    });
    yield* Effect.promise(async () => {
      const replacement = join(test.home, "replacement");
      await writeFile(replacement, "ABCDEF");
      await rename(replacement, test.attachmentPath);
    });
    expect(
      yield* read({ ref, offset: 2, length: 2, version: first.version }).pipe(Effect.flip),
    ).toMatchObject({ code: "conflict" });

    const inline = attachmentRef(["session", "source", "item", "tool-result:0"]);
    const image = yield* read({ ref: inline, offset: 0, length: 2 });
    expect(
      yield* read({ ref: inline, offset: 2, length: 2, version: image.version }),
    ).toMatchObject({ base64: "Y2Q=", version: image.version });
    test.replaceContent();
    expect(
      yield* read({ ref: inline, offset: 2, length: 2, version: image.version }).pipe(Effect.flip),
    ).toMatchObject({ code: "conflict" });
    expect(test.inlineReads()).toBe(1);
  }),
);

it.effect.each(["bytes", "type", "trashed"] as const)(
  "an upload leaves an existing File alone after its %s changed on the desktop",
  (change) =>
    Effect.gen(function* () {
      type Stored = { bytes: Uint8Array; mimeType: string; lifecycle: "live" | "trashed" };
      const stored = new Map<string, Stored>();
      let prepared: Uint8Array = new Uint8Array();
      const library = {
        read: (_: unknown, { read }: { read: { mode: string; file_id: string } }) =>
          Effect.sync(() => {
            const file = stored.get(read.file_id);
            if (!file) return { ok: false, error: { code: "resource_not_found" } };
            return {
              ok: true,
              value: {
                value: {
                  kind: read.mode,
                  value: {
                    lifecycle: file.lifecycle,
                    version: 1,
                    default_name: "photo.png",
                    mime_type: file.mimeType,
                    byte_length: file.bytes.length,
                    blob_etag: createHash("sha256").update(file.bytes).digest("hex"),
                  },
                },
              },
            };
          }),
        prepareFileBlob: (_: unknown, _operation: string, _slot: string, bytes: Uint8Array) =>
          Effect.sync(() => {
            prepared = bytes;
            return { receipt_id: "prepared" };
          }),
        apply: (
          _: unknown,
          {
            operation: { change },
          }: { operation: { change: { kind: string; file_id: string; mime_type: string } } },
        ) =>
          Effect.sync(() => {
            expect(change.kind).toBe("create");
            if (stored.has(change.file_id)) return { ok: false };
            stored.set(change.file_id, {
              bytes: prepared,
              mimeType: change.mime_type,
              lifecycle: "live",
            });
            return { ok: true };
          }),
      } as unknown as LibraryModule["Service"];
      const { files } = yield* fixture(library);
      const handlers = yield* files.open;
      const bytes = Buffer.from("original photo");
      const upload = Effect.gen(function* () {
        const { uploadId } = yield* handlers["files.upload.begin"]({
          name: "photo.png",
          mimeType: "image/png",
          size: bytes.length,
        });
        yield* handlers["files.upload.chunk"]({
          uploadId,
          offset: 0,
          base64: bytes.toString("base64"),
        });
        return { uploadId, ref: yield* handlers["files.upload.commit"]({ uploadId }) };
      });

      const first = yield* upload;
      expect((yield* upload).ref).toEqual(first.ref);
      const firstId = parseFileSource(first.ref.ref)!;
      const edited: Stored = {
        bytes: change === "bytes" ? Buffer.from("desktop edit") : bytes,
        mimeType: change === "type" ? "text/plain" : "image/png",
        lifecycle: change === "trashed" ? "trashed" : "live",
      };
      stored.set(firstId, edited);

      const second = yield* upload;
      expect(second.ref.ref).not.toBe(first.ref.ref);
      expect(stored.get(firstId)).toBe(edited);
      const secondFile = stored.get(parseFileSource(second.ref.ref)!)!;
      expect(Buffer.from(secondFile.bytes).toString()).toBe(bytes.toString());
      expect(secondFile.mimeType).toBe("image/png");

      expect((yield* upload).ref).toEqual(second.ref);
      expect(yield* handlers["files.upload.commit"]({ uploadId: second.uploadId })).toEqual(
        second.ref,
      );
      expect(stored.size).toBe(2);

      // However many copies have since been changed, the photo still lands.
      for (let copy = 0; copy < 12; copy++)
        stored.set(parseFileSource((yield* upload).ref.ref)!, edited);
      const latest = stored.get(parseFileSource((yield* upload).ref.ref)!)!;
      expect(Buffer.from(latest.bytes).toString()).toBe(bytes.toString());
      expect(stored.size).toBe(14);
    }),
);
