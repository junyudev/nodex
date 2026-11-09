import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { spacePathKey } from "./space-path-key";
import { SecretEncryption } from "../platform/SecretEncryption";

const CredentialSchema = z
  .object({
    spaceId: z.string().min(1).max(512),
    memberId: z.string().min(1),
    deviceId: z.string().min(1),
    name: z.string().min(1),
    url: z.url({ protocol: /^https$/u }),
    fingerprint: z.string().regex(/^[a-f\d]{64}$/iu),
    deviceCredential: z.string().min(1),
  })
  .strict();

export type SpaceCredential = z.infer<typeof CredentialSchema>;
export interface StoredSpaceConnections {
  readonly credentials: readonly SpaceCredential[];
  readonly unavailableSpaceIds: readonly string[];
}

export class SpaceStorageError extends Schema.TaggedError<SpaceStorageError>()(
  "SpaceStorageError",
  {
    message: Schema.String,
  },
) {}

export class SpaceConnectionStorage extends Context.Service<
  SpaceConnectionStorage,
  {
    readonly load: Effect.Effect<StoredSpaceConnections, SpaceStorageError>;
    readonly save: (credential: SpaceCredential) => Effect.Effect<void, SpaceStorageError>;
    readonly remove: (spaceId: string) => Effect.Effect<void, SpaceStorageError>;
  }
>()("nodex/main/space-connections/SpaceConnectionStorage") {}

/** Device credentials are independently encrypted and bound to this Desktop Profile. */
export const live = (home: string): Layer.Layer<SpaceConnectionStorage, never, SecretEncryption> =>
  Layer.effect(
    SpaceConnectionStorage,
    Effect.gen(function* () {
      const encryption = yield* SecretEncryption;
      const directory = join(home, "space-connections");
      const pathFor = (spaceId: string) => join(directory, `${spacePathKey(spaceId)}.enc`);
      const privateDirectory = async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (process.platform !== "win32" &&
            ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
        ) {
          throw new Error("Space credentials need a private directory");
        }
      };
      const attempt = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: () =>
            new SpaceStorageError({ message: "Could not access private Space credentials" }),
        });
      return SpaceConnectionStorage.of({
        load: attempt(async () => {
          await privateDirectory();
          const files = (await readdir(directory)).filter((name) => name.endsWith(".enc"));
          const credentials: SpaceCredential[] = [];
          const unavailableSpaceIds: string[] = [];
          for (const file of files) {
            if (!/^[a-f\d]{64}\.enc$/u.test(file)) continue;
            const path = join(directory, file);
            const info = await lstat(path);
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.size > 64 * 1024 ||
              (process.platform !== "win32" &&
                ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
            )
              continue;
            let outer: unknown;
            try {
              outer = JSON.parse(await readFile(path, "utf8"));
            } catch {
              continue;
            }
            const envelope = z
              .object({
                version: z.literal(1),
                spaceId: z.string().min(1).max(512),
                ciphertext: z.string().min(1),
              })
              .strict()
              .safeParse(outer);
            if (!envelope.success || file !== `${spacePathKey(envelope.data.spaceId)}.enc`)
              continue;
            try {
              if (!encryption.isAvailable()) throw new Error("Secure storage is unavailable");
              const decoded = z
                .object({
                  version: z.literal(1),
                  home: z.literal(resolve(home)),
                  credential: CredentialSchema,
                })
                .strict()
                .parse(
                  JSON.parse(
                    encryption.decryptString(Buffer.from(envelope.data.ciphertext, "base64")),
                  ),
                );
              if (decoded.credential.spaceId !== envelope.data.spaceId)
                throw new Error("Space credential identity mismatch");
              credentials.push(decoded.credential);
            } catch {
              // Public identity keeps a locked connection visible; its credential remains encrypted.
              unavailableSpaceIds.push(envelope.data.spaceId);
            }
          }
          return { credentials, unavailableSpaceIds };
        }),
        save: (credential) =>
          attempt(async () => {
            if (!encryption.isAvailable()) throw new Error("Secure storage is unavailable");
            const parsed = CredentialSchema.parse(credential);
            const ciphertext = encryption.encryptString(
              JSON.stringify({ version: 1, home: resolve(home), credential: parsed }),
            );
            await privateDirectory();
            const temporary = join(directory, `${randomUUID()}.tmp`);
            const file = await open(temporary, "wx", 0o600);
            try {
              await file.writeFile(
                JSON.stringify({
                  version: 1,
                  spaceId: parsed.spaceId,
                  ciphertext: ciphertext.toString("base64"),
                }),
              );
              await file.sync();
              await file.close();
              await rename(temporary, pathFor(parsed.spaceId));
            } finally {
              await file.close();
              await rm(temporary, { force: true });
            }
          }),
        remove: (spaceId) => attempt(() => rm(pathFor(spaceId), { force: true })),
      });
    }),
  );
