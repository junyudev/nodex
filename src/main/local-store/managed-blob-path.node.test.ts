import { describe, afterEach, expect, test } from "vite-plus/test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import * as pathTemporaryAssets from "node:path";
import { join } from "node:path";
import { resolveManagedBlobPath } from "./managed-blob-path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import { testLayer, testLayer as mainConfigLayer } from "../app/MainConfig";
import { ProfilePersistedAtoms, live } from "./ProfilePersistedAtoms";
import { TemporaryAssets, live as liveTemporaryAssets } from "./TemporaryAssets";

describe("managed-blob-path", () => {
  const temporaryHomes: string[] = [];

  const createProfileHome = (): string => {
    const profileHome = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-managed-blob-path-"));
    temporaryHomes.push(profileHome);
    fs.mkdirSync(path.join(profileHome, "assets"));
    return profileHome;
  };

  afterEach(() => {
    for (const profileHome of temporaryHomes.splice(0)) {
      fs.rmSync(profileHome, { recursive: true, force: true });
    }
  });

  describe("resolveManagedBlobPath", () => {
    const contentHash = "a".repeat(64);

    test("resolves the current content-addressed blob filename", () => {
      const profileHome = createProfileHome();
      const blobPath = path.join(profileHome, "assets", `${contentHash}.blob`);
      fs.writeFileSync(blobPath, "bytes");

      expect(resolveManagedBlobPath(profileHome, contentHash)).toBe(blobPath);
    });

    test("does not interpret legacy prefixed names as current Blob identity", () => {
      const profileHome = createProfileHome();
      fs.writeFileSync(path.join(profileHome, "assets", `page-file-${contentHash}.blob`), "bytes");

      expect(resolveManagedBlobPath(profileHome, contentHash)).toBeNull();
    });

    test("rejects invalid hashes, missing files, and symbolic links", () => {
      const profileHome = createProfileHome();
      const target = path.join(profileHome, "target");
      fs.writeFileSync(target, "bytes");
      fs.symlinkSync(target, path.join(profileHome, "assets", `${contentHash}.blob`));

      expect(resolveManagedBlobPath(profileHome, "../nodex.db")).toBeNull();
      expect(resolveManagedBlobPath(profileHome, "b".repeat(64))).toBeNull();
      expect(resolveManagedBlobPath(profileHome, contentHash)).toBeNull();
    });
  });
});

describe("ProfilePersistedAtoms", () => {
  it.effect(
    "one Profile acquisition shares ordered durable atom state and a replacement starts a fresh revision",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-atom-owner-"))),
        (nodexHome) => {
          const profile = live.pipe(Layer.provide(testLayer({ nodexHome })));
          return Effect.gen(function* () {
            const first = yield* ProfilePersistedAtoms;
            first.commitMutation({ key: "draft", value: "first", mutationId: "draft" }, "one");
            const secondConsumer = yield* ProfilePersistedAtoms;
            secondConsumer.commitMutation(
              { key: "identity", value: "client", mutationId: "identity" },
              "two",
            );
            assert.deepEqual(first.readSnapshot(), {
              revision: 2,
              values: { draft: "first", identity: "client" },
            });
          }).pipe(
            Effect.provide(profile),
            Effect.andThen(
              Effect.gen(function* () {
                const replacement = yield* ProfilePersistedAtoms;
                assert.deepEqual(replacement.readSnapshot(), {
                  revision: 0,
                  values: { draft: "first", identity: "client" },
                });
              }).pipe(Effect.provide(profile)),
            ),
          );
        },
        (nodexHome) => Effect.sync(() => rmSync(nodexHome, { recursive: true, force: true })),
      ),
  );
});

describe("TemporaryAssets", () => {
  const path = pathTemporaryAssets;
  const live = liveTemporaryAssets;
  it.effect("keeps temporary media outside the Core Blob namespace", () =>
    Effect.gen(function* () {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-temporary-media-"));
      try {
        fs.mkdirSync(path.join(home, "assets"));
        fs.writeFileSync(path.join(home, "assets", "retained.png"), "Core-owned bytes");
        yield* Effect.gen(function* () {
          const media = yield* TemporaryAssets;
          assert.throws(() => media.resolveAssetPath("retained.png"));
          assert.throws(() => media.readManagedAssetImage("nodex://assets/retained.png"));
          const saved = yield* Effect.promise(() =>
            media.saveUploadedImage({
              name: "capture.png",
              mimeType: "image/png",
              bytes: new TextEncoder().encode("temporary capture"),
            }),
          );
          const resolved = media.resolveAssetPath(saved.fileName);
          assert.strictEqual(path.dirname(resolved), path.join(home, "cache", "media"));
          assert.strictEqual(fs.readFileSync(resolved, "utf8"), "temporary capture");
          assert.strictEqual(
            fs.readFileSync(path.join(home, "assets", "retained.png"), "utf8"),
            "Core-owned bytes",
          );
          if (process.platform !== "win32")
            assert.strictEqual(fs.statSync(resolved).mode & 0o777, 0o600);
        }).pipe(
          // this test owns the complete temporary-media application layer.
          Effect.provide(live.pipe(Layer.provide(mainConfigLayer({ nodexHome: home })))),
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }),
  );
});
