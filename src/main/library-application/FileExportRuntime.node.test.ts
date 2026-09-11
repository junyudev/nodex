import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { LibraryModule, LibraryModuleError } from "./LibraryModule";
import { FileExportRuntime, live } from "./FileExportRuntime";
import type { NodexClipboardEnvelopeV1 } from "../../shared/clipboard-paste";

const envelope: NodexClipboardEnvelopeV1 = {
  version: 1,
  profileId: "profile",
  libraryId: "library",
  storeEpoch: "epoch",
  bundleId: "bundle",
  capability: "a".repeat(64),
  manifestHash: "b".repeat(64),
  actionHint: "cut",
};
const access = { kind: "project", projectId: "project" } as const;
const input = { fileId: "image", source: { kind: "page", page_id: "page" } } as const;

const fixture = Effect.fn("FileExportTest.fixture")(function* () {
  const home = yield* Effect.acquireRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "nodex-export-"))),
    (home) => Effect.sync(() => fs.rmSync(home, { recursive: true, force: true })),
  );
  const bytes = new TextEncoder().encode("captured");
  const etag = createHash("sha256").update(bytes).digest("hex");
  const state = {
    authorized: true,
    blobReads: 0,
    metadataReads: 0,
    failFile: "",
    revokeAfterBlob: false,
  };
  const library = {
    read: (receivedAccess, request) =>
      Effect.gen(function* () {
        state.metadataReads++;
        assert.deepEqual(receivedAccess, access);
        if (
          !state.authorized ||
          request.read.mode !== "file_presentation" ||
          request.read.file_id === state.failFile
        )
          return yield* new LibraryModuleError({
            operation: "read",
            cause: new Error("not authorized"),
          });
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
                file_id: request.read.file_id,
                version: 1,
                default_name: "image.png",
                mime_type: "image/png",
                byte_length: bytes.length,
                blob_etag: etag,
              },
            },
          },
        };
      }),
    readFileBlob: (_access, read) =>
      Effect.sync(() => {
        assert.strictEqual(read.version, 1);
        state.blobReads++;
        if (state.revokeAfterBlob) state.authorized = false;
        return { bytes, etag, mimeType: "image/png" };
      }),
  } satisfies Partial<LibraryModule["Service"]>;
  const context = yield* Layer.build(
    live.pipe(
      Layer.provide(
        Layer.mergeAll(
          mainConfigLayer({ nodexHome: home }),
          Layer.succeed(LibraryModule, library as unknown as LibraryModule["Service"]),
        ),
      ),
    ),
  );
  return { runtime: Context.get(context, FileExportRuntime), state, home };
});

it.effect("warm exports reauthorize without downloading the same File again", () =>
  Effect.gen(function* () {
    const { runtime, state } = yield* fixture();
    const first = yield* runtime.materialize(access, input);
    assert.strictEqual(fs.readFileSync(first, "utf8"), "captured");
    assert.strictEqual(yield* runtime.materialize(access, input), first);
    assert.strictEqual(state.blobReads, 1);
    assert.strictEqual(state.metadataReads, 2);
    state.authorized = false;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.materialize(access, input))));
    assert.strictEqual(state.blobReads, 1);
  }),
);

it.effect("corrupt cache objects are rejected without overwriting them", () =>
  Effect.gen(function* () {
    const { runtime, state } = yield* fixture();
    const target = yield* runtime.materialize(access, input);
    fs.writeFileSync(target, "corrupt!");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.materialize(access, input))));
    assert.strictEqual(fs.readFileSync(target, "utf8"), "corrupt!");
    assert.strictEqual(state.blobReads, 1);
  }),
);

it.effect("exports do not follow an existing cache symlink", () =>
  Effect.gen(function* () {
    const { runtime, home } = yield* fixture();
    const target = yield* runtime.materialize(access, input);
    const victim = path.join(home, "user-file");
    fs.writeFileSync(victim, "captured");
    fs.unlinkSync(target);
    fs.symlinkSync(victim, target);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.materialize(access, input))));
    assert.strictEqual(fs.readFileSync(victim, "utf8"), "captured");
  }),
);

it.effect("clipboard export replaces complete locators once and rechecks authorization", () =>
  Effect.gen(function* () {
    const { runtime, state } = yield* fixture();
    const result = yield* runtime.clipboardText(
      access,
      envelope,
      "nodex://files/image nodex://files/image-long nodex://files/image",
    );
    const words = result.split(" ");
    assert.strictEqual(words.length, 3);
    assert.strictEqual(words[0], words[2]);
    assert.strictEqual(fs.readFileSync(words[1]!, "utf8"), "captured");
    assert.strictEqual(state.metadataReads, 4);
  }),
);

it.effect("revocation after bytes arrive prevents final clipboard enhancement", () =>
  Effect.gen(function* () {
    const { runtime, state } = yield* fixture();
    state.revokeAfterBlob = true;
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(runtime.clipboardText(access, envelope, "nodex://files/image")),
      ),
    );
    assert.strictEqual(state.blobReads, 1);
    assert.strictEqual(state.metadataReads, 2);
  }),
);

it.effect("one missing File rejects the entire enhancement", () =>
  Effect.gen(function* () {
    const { runtime, state } = yield* fixture();
    state.failFile = "missing";
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          runtime.clipboardText(access, envelope, "nodex://files/image nodex://files/missing"),
        ),
      ),
    );
  }),
);
