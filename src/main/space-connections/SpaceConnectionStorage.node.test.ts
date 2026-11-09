import { spacePathKey } from "./space-path-key";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { SecretEncryption } from "../platform/SecretEncryption";
import { live, SpaceConnectionStorage, type SpaceCredential } from "./SpaceConnectionStorage";

const credential: SpaceCredential = {
  spaceId: "library-team/opaque:identity",
  memberId: "alice",
  deviceId: "desktop",
  name: "Team",
  url: "https://team.example",
  fingerprint: "a".repeat(64),
  deviceCredential: "this-credential-must-never-be-plaintext",
};
const key = randomBytes(32);
const encryption = SecretEncryption.of({
  isAvailable: () => true,
  encryptString: (text) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  },
  decryptString: (bytes) => {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  },
});
const home = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-spaces-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

it.effect("persists encrypted credentials privately per Space and removes them on Leave", () =>
  Effect.gen(function* () {
    const directory = yield* home;
    yield* Effect.gen(function* () {
      const storage = yield* SpaceConnectionStorage;
      yield* storage.save(credential);
      assert.deepEqual(yield* storage.load, { credentials: [credential], unavailableSpaceIds: [] });
      const path = join(directory, "space-connections", `${spacePathKey(credential.spaceId)}.enc`);
      const bytes = yield* Effect.promise(() => readFile(path));
      assert.isFalse(bytes.includes(Buffer.from(credential.deviceCredential)));
      if (process.platform !== "win32")
        assert.strictEqual((yield* Effect.promise(() => stat(path))).mode & 0o077, 0);
      yield* storage.remove(credential.spaceId);
      assert.deepEqual(yield* storage.load, { credentials: [], unavailableSpaceIds: [] });
    }).pipe(Effect.provide(live(directory)), Effect.provideService(SecretEncryption, encryption));
  }),
);

it.effect("refuses to persist a device credential when secure storage is unavailable", () =>
  Effect.gen(function* () {
    const directory = yield* home;
    yield* Effect.gen(function* () {
      const storage = yield* SpaceConnectionStorage;
      assert.strictEqual((yield* Effect.result(storage.save(credential)))._tag, "Failure");
      assert.deepEqual(yield* Effect.promise(() => readdir(directory)), []);
    }).pipe(
      Effect.provide(live(directory)),
      Effect.provideService(SecretEncryption, { ...encryption, isAvailable: () => false }),
    );
  }),
);

it.effect(
  "keeps an unreadable team credential visible without unlocking or blocking personal startup",
  () =>
    Effect.gen(function* () {
      const directory = yield* home;
      yield* Effect.gen(function* () {
        yield* (yield* SpaceConnectionStorage).save(credential);
      }).pipe(Effect.provide(live(directory)), Effect.provideService(SecretEncryption, encryption));
      yield* Effect.gen(function* () {
        const storage = yield* SpaceConnectionStorage;
        assert.deepEqual(yield* storage.load, {
          credentials: [],
          unavailableSpaceIds: [credential.spaceId],
        });
        yield* storage.remove(credential.spaceId);
        assert.deepEqual(yield* storage.load, { credentials: [], unavailableSpaceIds: [] });
      }).pipe(
        Effect.provide(live(directory)),
        Effect.provideService(SecretEncryption, {
          ...encryption,
          isAvailable: () => false,
        }),
      );
    }),
);
