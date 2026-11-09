import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { contentFingerprint, stableId } from "./content-identity";
import { openRegularFile } from "./open-regular-file";

export class PhoneFileError extends Data.TaggedError("PhoneFileError")<{
  readonly message: string;
}> {}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () =>
      new PhoneFileError({ message: "The phone Host could not read or save its temporary files." }),
  });

const platform = {
  randomId: randomUUID,
  contentFingerprint,
  stableId,
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

export class PhoneFiles extends Context.Service<PhoneFiles, typeof platform>()(
  "nodex/main/platform/node/PhoneFiles",
) {}

export const live = Layer.succeed(PhoneFiles, platform);
