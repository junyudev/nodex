import { lstat } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { openRegularFile } from "../platform/node/open-regular-file";
import { missing, rpcError } from "./rpc";

export const downloadConflict = () => rpcError("conflict", "This file changed. Download it again.");

export const readMobileAttachment = (
  path: string,
  offset: number,
  length: number,
  expectedVersion: string | null | undefined,
  versionOf: (identity: string) => string,
) =>
  Effect.tryPromise({
    try: async () => {
      const file = await openRegularFile(path);
      try {
        const stat = await file.stat({ bigint: true });
        const identity = ({ dev, ino, size, mtimeNs, ctimeNs }: typeof stat) =>
          `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
        const version = versionOf(identity(stat));
        if (expectedVersion !== undefined && expectedVersion !== version) return null;
        const totalBytes = Number(stat.size);
        const target = Buffer.alloc(Math.max(0, Math.min(length, totalBytes - offset)));
        const { bytesRead } = target.length
          ? await file.read(target, 0, target.length, offset)
          : { bytesRead: 0 };
        const current = await lstat(path, { bigint: true });
        if (!current.isFile() || identity(current) !== identity(stat)) return null;
        return { base64: target.subarray(0, bytesRead).toString("base64"), totalBytes, version };
      } finally {
        await file.close();
      }
    },
    catch: () =>
      expectedVersion === undefined ? missing("This file is unavailable.") : downloadConflict(),
  }).pipe(
    Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.fail(downloadConflict()))),
  );
