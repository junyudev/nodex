import * as HostProcess from "@nodex/runtime-shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export interface ClaudeSessionHistoryInput {
  readonly sessionId: string;
  readonly configDirectory?: string;
  readonly cwd: string;
}
const decodeEntry = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);

/** Only confirmed missing/metadata-only history can replace a native conversation. Read failures propagate. */
export const available = Effect.fn("ClaudeSessionHistory.available")(function* (
  input: ClaudeSessionHistoryInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(input.sessionId))
    return yield* Effect.fail(new Error("Invalid native Claude session identity."));
  const home =
    input.configDirectory?.trim() || path.join(yield* HostProcess.HomeDirectory, ".claude");
  const projects = path.resolve(input.cwd, home, "projects");
  const directories = yield* fs
    .readDirectory(projects)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed([] as string[]) : Effect.fail(error),
      ),
    );
  for (const project of directories) {
    const projectPath = path.join(projects, project);
    const directory = yield* fs.stat(projectPath).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
    if (!directory) continue;
    const file = path.join(projectPath, `${input.sessionId}.jsonl`);
    const present = yield* fs.stat(file).pipe(
      Effect.map((stat) => stat.type === "File"),
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
    if (!present) continue;
    const message = yield* fs.stream(file).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.mapEffect((line) => decodeEntry(line)),
      Stream.filter((entry) => entry.type === "user" || entry.type === "assistant"),
      Stream.runHead,
    );
    if (Option.isSome(message)) return true;
  }
  return false;
});
