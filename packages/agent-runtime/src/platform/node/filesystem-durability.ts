import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/** Node cannot flush Windows directory handles; completed files and SQLite commits own durability. */
export const syncDirectory = (fs: FileSystem.FileSystem, directory: string) => {
  if (process.platform === "win32") return Effect.void;
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(directory, { flag: "r" });
      yield* handle.sync;
    }),
  );
};
