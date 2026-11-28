import { describe, vi } from "vite-plus/test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { pruneFileExports } from "../platform/node/file-export-cache";
import { LibraryModule, LibraryModuleError, live as liveLibraryModule } from "./LibraryModule";
import { FileExportRuntime, live } from "./FileExportRuntime";
import type { NodexClipboardEnvelopeV1 } from "../../shared/clipboard-paste";
import * as Scope from "effect/Scope";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import type { LibraryReadSnapshot } from "../core-client/types";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";

describe("FileExportRuntime", () => {
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
      blobBytes: bytes,
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
          return { bytes: state.blobBytes, etag, mimeType: "image/png" };
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

  it.effect("rejects an unverified replacement for a corrupt export", () =>
    Effect.gen(function* () {
      const { runtime, state } = yield* fixture();
      const target = yield* runtime.materialize(access, input);
      fs.chmodSync(target, 0o600);
      fs.writeFileSync(target, "corrupt!");
      const originalBytes = state.blobBytes;
      state.blobBytes = new TextEncoder().encode("bad Blob");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.materialize(access, input))));
      assert.strictEqual(fs.readFileSync(target, "utf8"), "corrupt!");
      assert.strictEqual(state.blobReads, 2);

      state.blobBytes = originalBytes;
      assert.strictEqual(yield* runtime.materialize(access, input), target);
      assert.strictEqual(fs.readFileSync(target, "utf8"), "captured");
    }),
  );

  it.effect("exports do not follow an existing cache symlink", () =>
    Effect.gen(function* () {
      const { runtime, home } = yield* fixture();
      const target = yield* runtime.materialize(access, input);
      const victim = path.join(home, "user-file");
      fs.writeFileSync(victim, "captured");
      fs.chmodSync(target, 0o600);
      fs.unlinkSync(target);
      fs.symlinkSync(victim, target);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.materialize(access, input))));
      assert.strictEqual(fs.readFileSync(victim, "utf8"), "captured");
    }),
  );

  it.effect("rejects a symlink in place of the export hash directory", () =>
    Effect.gen(function* () {
      const { runtime, home, state } = yield* fixture();
      const target = yield* runtime.materialize(access, input);
      const directory = path.dirname(target);
      const outside = path.join(home, "outside-cache");
      fs.renameSync(directory, outside);
      fs.symlinkSync(outside, directory, "junction");

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.materialize(access, input))));
      assert.strictEqual(state.blobReads, 1);
      assert.strictEqual(
        fs.readFileSync(path.join(outside, path.basename(target)), "utf8"),
        "captured",
      );
    }),
  );

  const day = 24 * 60 * 60 * 1000;
  const retention = (now: number) => ({
    now,
    maxIdleMs: 14 * day,
    maxBytes: 2 ** 31,
    minIdleMs: day,
  });
  const useAt = (target: string, at: number) => fs.utimesSync(target, new Date(at), new Date(at));

  it.effect("exports age from their last use, and nothing outside the layout stays", () =>
    Effect.gen(function* () {
      const { runtime } = yield* fixture();
      const target = yield* runtime.materialize(access, input);
      const directory = path.dirname(target);
      const root = path.dirname(directory);
      useAt(directory, 0);
      assert.strictEqual(yield* runtime.materialize(access, input), target);
      const now = fs.statSync(directory).mtimeMs;
      assert.isAbove(now, 0);

      const unused = path.join(root, "c".repeat(64));
      fs.mkdirSync(unused);
      fs.writeFileSync(path.join(unused, "image.png"), "unused");
      useAt(unused, now - 15 * day);
      const flat = path.join(root, `${"d".repeat(64)}.png`);
      fs.writeFileSync(flat, "flat");
      fs.chmodSync(flat, 0o444);
      const siblingStaging = `${root}.staging`;
      fs.mkdirSync(siblingStaging);
      fs.writeFileSync(path.join(siblingStaging, "left.tmp"), "");
      const abandoned = path.join(root, ".staging", "abandoned.tmp");
      fs.writeFileSync(abandoned, "");
      useAt(abandoned, now - 2 * day);
      fs.writeFileSync(path.join(root, ".staging", "publishing.tmp"), "");
      useAt(path.join(root, ".staging", "publishing.tmp"), now);

      yield* Effect.promise(() => pruneFileExports(root, retention(now)));
      assert.sameMembers(fs.readdirSync(root), [".staging", path.basename(directory)]);
      assert.deepEqual(fs.readdirSync(path.join(root, ".staging")), ["publishing.tmp"]);
      assert.isFalse(fs.existsSync(siblingStaging));
      assert.strictEqual(fs.readFileSync(target, "utf8"), "captured");
    }),
  );

  it.effect("past the size budget the least recently used go first, sparing recent ones", () =>
    Effect.gen(function* () {
      const { home } = yield* fixture();
      const root = path.join(home, "cache", "file-exports");
      const now = Date.UTC(2026, 10, 28);
      const exportUsedAt = (letter: string, at: number) => {
        const directory = path.join(root, letter.repeat(64));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "File.bin"), "abc");
        useAt(directory, at);
      };
      exportUsedAt("a", now - 5 * day);
      exportUsedAt("b", now - 3 * day);
      exportUsedAt("c", now - 2 * day);
      exportUsedAt("d", now - 60 * 60 * 1000);

      yield* Effect.promise(() => pruneFileExports(root, { ...retention(now), maxBytes: 6 }));
      assert.sameMembers(fs.readdirSync(root), ["c".repeat(64), "d".repeat(64)]);
      yield* Effect.promise(() => pruneFileExports(root, { ...retention(now), maxBytes: 0 }));
      assert.deepEqual(fs.readdirSync(root), ["d".repeat(64)]);
    }),
  );

  it.effect("the runtime prunes its cache once launch settles", () =>
    Effect.gen(function* () {
      const { runtime } = yield* fixture();
      const target = yield* runtime.materialize(access, input);
      const siblingStaging = `${path.dirname(path.dirname(target))}.staging`;
      fs.mkdirSync(siblingStaging);
      yield* TestClock.adjust("1 minute");
      yield* Effect.promise(() => vi.waitFor(() => assert.isFalse(fs.existsSync(siblingStaging))));
      assert.strictEqual(fs.readFileSync(target, "utf8"), "captured");
    }),
  );

  it.effect("clipboard export replaces complete locators once and rechecks source identity", () =>
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
});

describe("LibraryModule", () => {
  const live = liveLibraryModule;
  const identity = {
    profileId: "profile:test",
    libraryId: "library:test",
    storeEpoch: "epoch:test",
  } as const;

  const metadata = (commitHead: number): LibraryReadSnapshot => ({
    contract_version: 6,
    commit_head: commitHead,
    store_epoch: identity.storeEpoch,
    value: {
      commit_seq: commitHead,
      kind: "metadata",
      library_id: identity.libraryId,
      profile_id: identity.profileId,
    },
  });

  it.effect("routes Library reads through the exact durable access boundary", () =>
    Effect.gen(function* () {
      const client = new FakeCoreClient();
      client.enqueueRead(metadata(1));
      client.enqueueRead(metadata(2));
      const projectScopes: Array<string | null | undefined> = [];
      const handshake = createFakeCoreHandshake(identity);
      const generationClient = Object.assign(client, {
        handshake,
        forProject: () => generationClient,
        health: () =>
          Promise.resolve({
            pid: 1,
            start_nonce: handshake.generation.start_nonce,
            status: "ready" as const,
          }),
        shutdown: () => Promise.resolve({ status: "draining" as const }),
      }) as unknown as CoreGenerationClient;
      const sessionAccess = CoreSessionAccess.of({
        use: (_operation, run, options) =>
          Effect.promise((signal) => {
            projectScopes.push(options?.projectId);
            return run(generationClient, signal);
          }),
        handshake: Effect.succeed(createFakeCoreHandshake(identity)),
      });
      const authority = CoreAuthority.of({
        identity,
      } as CoreAuthority["Service"]);
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(CoreAuthority, authority),
              Layer.succeed(CoreSessionAccess, sessionAccess),
            ),
          ),
        ),
        scope,
      );
      const library = Context.get(context, LibraryModule);

      const project = yield* library.read(
        { kind: "project", projectId: "project:test" },
        { read: { mode: "metadata" } },
      );
      const libraryWide = yield* library.read({ kind: "library" }, { read: { mode: "metadata" } });

      assert.deepEqual(projectScopes, ["project:test", undefined]);
      assert.deepEqual(project, {
        ok: true,
        value: {
          profileId: identity.profileId,
          libraryId: identity.libraryId,
          storeEpoch: identity.storeEpoch,
          commitSeq: 1,
          value: { kind: "metadata" },
        },
      });
      assert.isTrue(libraryWide.ok);
      if (libraryWide.ok) assert.strictEqual(libraryWide.value.commitSeq, 2);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("a remote Library never forwards a local editor owner or closes a host lease", () =>
    Effect.gen(function* () {
      const owners: Array<string | undefined> = [];
      const client = Object.assign(new FakeCoreClient(), {
        libraryApply: async (_input: unknown, options?: { editorHistoryOwnerId?: string }) => {
          owners.push(options?.editorHistoryOwnerId);
          throw new Error("Boundary capture");
        },
      }) as unknown as CoreGenerationClient;
      const context = yield* Layer.build(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CoreAuthority, {
                identity,
                initialLaunch: null,
              } as CoreAuthority["Service"]),
              Layer.succeed(CoreSessionAccess, {
                handshake: Effect.succeed(createFakeCoreHandshake(identity)),
                use: (_operation, run) => Effect.promise((signal) => run(client, signal)),
              }),
            ),
          ),
        ),
      );
      const library = Context.get(context, LibraryModule);
      yield* library.apply(
        { kind: "library" },
        {
          operationId: "create",
          storeEpoch: identity.storeEpoch,
          operation: {
            kind: "create_page",
            pageId: "page",
            documentId: "doc",
            title: "Page",
            parent: { kind: "library" },
          },
        },
        "local-editor-owner",
      );
      yield* library.closeEditorHistoryOwner("local-editor-owner", "close");
      assert.deepStrictEqual(owners, [undefined]);
    }),
  );
});
