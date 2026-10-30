import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import type { ReadFileBytesInput, LibraryFileVersion } from "../../shared/library-files";
import type { LibraryModuleReadRequest } from "../../shared/library-module";
import {
  AgentImageFitting,
  fitWithImageCodec,
  type EncodableImage,
  AGENT_IMAGE_LIMITS,
} from "../agent-backend/AgentImageFitting";
import {
  NativePromptImages,
  layer as nativePromptImagesLayer,
} from "../agent-backend/NativePromptImages";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { LibraryModule } from "../library-application/LibraryModule";
import { makeInboxImageLoader } from "./inbox-images";
import type { CoreInboxMessageImage } from "../core-client/inbox-adapter";

const bytes = new Uint8Array([137, 80, 78, 71]);
const hash = createHash("sha256").update(bytes).digest("hex");
const harness = (
  files: Readonly<
    Record<
      string,
      {
        readonly mimeType: string;
        readonly bytes: Uint8Array;
      }
    >
  >,
  native?: NativePromptImages["Service"],
  versions: Readonly<
    Record<string, readonly (readonly Pick<LibraryFileVersion, "version" | "blob_etag">[])[]>
  > = {},
) => {
  const list = vi.fn((_routing: unknown, request: LibraryModuleReadRequest) => {
    if (request.read.mode !== "file_versions") return Effect.die("Expected File versions");
    const file = files[request.read.file_id];
    const pages = versions[request.read.file_id] ?? [
      file
        ? [{ version: 1, blob_etag: createHash("sha256").update(file.bytes).digest("hex") }]
        : [],
    ];
    const index = Number(request.read.cursor ?? 0);
    return Effect.succeed({
      ok: true,
      value: {
        profileId: "profile",
        libraryId: "library",
        storeEpoch: "epoch",
        commitSeq: 1,
        value: {
          kind: "file_versions",
          value: {
            items: pages[index] ?? [],
            has_more: index + 1 < pages.length,
            next_cursor: index + 1 < pages.length ? String(index + 1) : null,
          },
        },
      },
    });
  });
  const read = vi.fn((_routing: unknown, request: ReadFileBytesInput) => {
    if (request.version === undefined)
      return Effect.die("Inbox images must read an exact File version");
    const file =
      files[`${request.fileId}@${request.version}`] ??
      (request.version === 1 ? files[request.fileId] : undefined);
    return file
      ? Effect.succeed({ ...file, etag: request.fileId })
      : Effect.fail(new Error("File unreadable"));
  });
  const fit = vi.fn<NativePromptImages["Service"]["fit"]>((images) =>
    Effect.succeed(
      images.map((image) => ({
        mediaType: image.mediaType,
        data: Buffer.from(image.bytes).toString("base64"),
      })),
    ),
  );
  const load = (references: readonly CoreInboxMessageImage[]) =>
    makeInboxImageLoader.pipe(
      Effect.flatMap((loadImages) => loadImages(references)),
      Effect.provideService(LibraryModule, {
        read: list,
        readFileBlob: read,
      } as unknown as LibraryModule["Service"]),
      Effect.provideService(NativePromptImages, {
        validate: () => Effect.void,
        fit,
        ...native,
      } as unknown as NativePromptImages["Service"]),
    );
  return { load, read, list, fit };
};

it.effect("omits unreadable, unsupported, empty, oversized and changed images before fitting", () =>
  Effect.gen(function* () {
    const { load, fit } = harness({
      vector: { mimeType: "image/svg+xml", bytes },
      empty: { mimeType: "image/png", bytes: new Uint8Array() },
      oversized: {
        mimeType: "image/png",
        bytes: new Uint8Array(AGENT_IMAGE_LIMITS.sourceBytes + 1),
      },
      changed: { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
      valid: { mimeType: "image/png", bytes },
    });
    const result = yield* load([
      { source: "https://example.com/image.png", file_id: "invalid", content_hash: hash },
      ...["unreadable", "vector", "empty", "oversized", "changed", "valid"].map((id) => ({
        source: `nodex://files/${id}`,
        file_id: id,
        content_hash: hash,
      })),
    ]);
    assert.deepEqual(result.attachedMarkers, [7]);
    assert.deepEqual(result.images, [
      { mediaType: "image/png", data: Buffer.from(bytes).toString("base64") },
    ]);
    assert.deepEqual(fit.mock.calls, [[[{ mediaType: "image/png", bytes }]]]);
  }),
);

it.effect(
  "bounds attachments at Agent limits without consuming a slot for an unavailable image",
  () =>
    Effect.gen(function* () {
      const { load, read, list, fit } = harness({ valid: { mimeType: "image/png", bytes } });
      const result = yield* load([
        { source: "nodex://files/missing", file_id: "missing", content_hash: hash },
        ...Array.from({ length: AGENT_IMAGE_LIMITS.count + 1 }, () => ({
          source: "nodex://files/valid",
          file_id: "valid",
          content_hash: hash,
        })),
      ]);
      assert.strictEqual(result.images.length, AGENT_IMAGE_LIMITS.count);
      assert.deepEqual(
        result.attachedMarkers,
        Array.from({ length: AGENT_IMAGE_LIMITS.count }, (_, index) => index + 2),
      );
      assert.strictEqual(fit.mock.calls[0]?.[0].length, AGENT_IMAGE_LIMITS.count);
      assert.strictEqual(read.mock.calls.length, AGENT_IMAGE_LIMITS.count);
      assert.strictEqual(list.mock.calls.length, AGENT_IMAGE_LIMITS.count + 1);
    }),
);

it.effect.each(["empty", "zero-width", "zero-height"] as const)(
  "decodes small images and omits an %s image without dropping the next marker",
  (failure) =>
    Effect.gen(function* () {
      const valid = new Uint8Array(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      const encode = vi.fn(() => {
        throw new Error("Small images must retain their bytes");
      });
      const decode = vi.fn((input: Uint8Array): EncodableImage => {
        const corrupt = input.byteLength === bytes.byteLength;
        return {
          isEmpty: () => corrupt && failure === "empty",
          getSize: () => ({
            width: corrupt && failure === "zero-width" ? 0 : 1,
            height: corrupt && failure === "zero-height" ? 0 : 1,
          }),
          resize: encode,
          toPNG: encode,
          toJPEG: encode,
        };
      });
      const native = yield* NativePromptImages.pipe(
        Effect.provide(nativePromptImagesLayer),
        Effect.provideService(AgentImageFitting, { fit: fitWithImageCodec(decode) }),
        Effect.provideService(TemporaryAssets, {} as TemporaryAssets["Service"]),
      );
      const { load } = harness(
        {
          corrupt: { mimeType: "image/png", bytes },
          valid: { mimeType: "image/png", bytes: valid },
        },
        native,
      );
      const loaded = yield* load([
        { source: "nodex://files/corrupt", file_id: "corrupt", content_hash: hash },
        {
          source: "nodex://files/valid",
          file_id: "valid",
          content_hash: createHash("sha256").update(valid).digest("hex"),
        },
      ]);
      assert.deepEqual(loaded.attachedMarkers, [2]);
      assert.deepEqual(loaded.images, [
        { mediaType: "image/png", data: Buffer.from(valid).toString("base64") },
      ]);
      assert.deepEqual(
        decode.mock.calls.map(([input]) => input.byteLength),
        [bytes.byteLength, valid.byteLength],
      );
      assert.strictEqual(encode.mock.calls.length, 0);
    }),
);

it.effect("finds reviewed bytes beyond the first version page after a File replacement", () =>
  Effect.gen(function* () {
    const replacement = new Uint8Array([255, 216, 255]);
    const { load, read, list } = harness(
      {
        picture: { mimeType: "image/jpeg", bytes: replacement },
        "picture@2": { mimeType: "image/jpeg", bytes: replacement },
        "picture@1": { mimeType: "image/png", bytes },
      },
      undefined,
      {
        picture: [
          [{ version: 2, blob_etag: createHash("sha256").update(replacement).digest("hex") }],
          [{ version: 1, blob_etag: hash }],
        ],
      },
    );
    const loaded = yield* load([
      { source: "nodex://files/picture", file_id: "picture", content_hash: hash },
    ]);
    assert.deepEqual(loaded.attachedMarkers, [1]);
    assert.deepEqual(loaded.images, [
      { mediaType: "image/png", data: Buffer.from(bytes).toString("base64") },
    ]);
    assert.deepEqual(
      list.mock.calls.map(([, request]) =>
        request.read.mode === "file_versions" ? request.read.cursor : undefined,
      ),
      [null, "1"],
    );
    assert.deepEqual(read.mock.calls, [
      [{ kind: "library" }, { fileId: "picture", source: { kind: "direct" }, version: 1 }],
    ]);
  }),
);

it.effect.each(["unreadable", "changed"] as const)(
  "keeps a marker unavailable when its matching version is %s",
  (failure) =>
    Effect.gen(function* () {
      const replacement = new Uint8Array([255, 216, 255]);
      const files: Parameters<typeof harness>[0] =
        failure === "unreadable"
          ? {}
          : { "picture@1": { mimeType: "image/png", bytes: replacement } };
      const { load, read } = harness(files, undefined, {
        picture: [[{ version: 1, blob_etag: hash }]],
      });
      const loaded = yield* load([
        { source: "nodex://files/picture", file_id: "picture", content_hash: hash },
      ]);
      assert.deepEqual(loaded, { images: [], attachedMarkers: [] });
      assert.strictEqual(read.mock.calls[0]?.[1].version, 1);
    }),
);

it.effect("tries another matching version when the first matching binding cannot be read", () =>
  Effect.gen(function* () {
    const { load, read } = harness({ "picture@1": { mimeType: "image/png", bytes } }, undefined, {
      picture: [
        [
          { version: 2, blob_etag: hash },
          { version: 1, blob_etag: hash },
        ],
      ],
    });
    const loaded = yield* load([
      { source: "nodex://files/picture", file_id: "picture", content_hash: hash },
    ]);
    assert.deepEqual(loaded.attachedMarkers, [1]);
    assert.deepEqual(
      read.mock.calls.map(([, input]) => input.version),
      [2, 1],
    );
  }),
);
