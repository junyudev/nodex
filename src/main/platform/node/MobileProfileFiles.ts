import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, appendFile, rm } from "node:fs/promises";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { openRegularFile } from "./open-regular-file";
import { isMissingPathError, writeDurableJson } from "../../durable-json-file";

export class MobileFileError extends Data.TaggedError("MobileFileError")<{
  readonly message: string;
}> {}

const limit = 256 * 1024;
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new MobileFileError({ message: "Mobile Access could not read or save its private files." }),
  });

const platform = {
  hostName: hostname,
  networkInterfaces,
  randomBytes,
  randomId: randomUUID,
  keyId: (key: Uint8Array) =>
    createHash("sha256").update(key).digest().subarray(0, 16).toString("base64url"),
  /** Lowercase SHA-256 of exact bytes, or of a structured request encoded by its owner. */
  contentFingerprint: (content: string | Uint8Array) =>
    createHash("sha256").update(content).digest("hex"),
  stableId: (purpose: string, ...parts: readonly (string | Uint8Array)[]) => {
    const hash = createHash("sha256").update(purpose);
    for (const part of parts) {
      hash.update(`:${Buffer.byteLength(part)}:`).update(part);
    }
    const bytes = hash.digest();
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
  readAttachment: (path: string, offset: number, length: number) =>
    attempt(async () => {
      const file = await openRegularFile(path);
      try {
        const { size } = await file.stat();
        const target = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = target.length
          ? await file.read(target, 0, target.length, offset)
          : { bytesRead: 0 };
        return { base64: target.subarray(0, bytesRead).toString("base64"), totalBytes: size };
      } finally {
        await file.close();
      }
    }),
  read: (home: string) =>
    attempt(async () => {
      try {
        const file = await openRegularFile(join(home, "mobile-access.json"));
        try {
          const bytes = Buffer.alloc(limit + 1);
          const { bytesRead } = await file.read(bytes);
          if (bytesRead > limit) throw new Error("Mobile Access settings exceed their size limit");
          return bytes.toString("utf8", 0, bytesRead);
        } finally {
          await file.close();
        }
      } catch (error) {
        if (isMissingPathError(error)) return null;
        throw error;
      }
    }),
  write: (home: string, encrypted: string) =>
    attempt(() => writeDurableJson(join(home, "mobile-access.json"), { encrypted }, limit)),
  uploads: (home: string) =>
    Effect.acquireRelease(
      attempt(() => mkdtemp(join(home, ".mobile-uploads-"))),
      (path) => attempt(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore),
    ),
  append: (directory: string, id: string, bytes: Uint8Array) =>
    attempt(() => appendFile(join(directory, id), bytes, { mode: 0o600 })),
  readUpload: (directory: string, id: string) => attempt(() => readFile(join(directory, id))),
  removeUpload: (directory: string, id: string) =>
    attempt(() => rm(join(directory, id), { force: true })).pipe(Effect.ignore),
};

export class MobileProfileFiles extends Context.Service<MobileProfileFiles, typeof platform>()(
  "nodex/main/platform/node/MobileProfileFiles",
) {}

export const live = Layer.succeed(MobileProfileFiles, platform);
