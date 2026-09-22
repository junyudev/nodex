/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Native filesystem and SQLite archive timestamps are owned by this Node adapter; the application composes its typed Effect service. */
import { access, mkdir, rename } from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

type ArchiveResult = "archived" | "missing" | "unrecoverable";
interface ArchiveInput {
  readonly codexHome: string;
  readonly threadId: string;
}

const codeOf = (cause: unknown): unknown =>
  cause !== null && typeof cause === "object" && "code" in cause ? cause.code : null;

const within = (parent: string, file: string): boolean => {
  const relative = path.relative(parent, file);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/** Repairs only the local native Codex archive index; Nodex Profile data stays in Core. */
export async function archiveInactiveCodexThread(input: ArchiveInput): Promise<ArchiveResult> {
  const databasePath = path.join(input.codexHome, "state_5.sqlite");
  try {
    await access(databasePath);
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return "missing";
    throw cause;
  }
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    const row = database
      .prepare("SELECT archived, rollout_path FROM threads WHERE id = ?")
      .get(input.threadId);
    if (!row) return "missing";
    if (row.archived === 1) return "archived";
    if (typeof row.rollout_path !== "string" || !row.rollout_path) return "unrecoverable";
    const archivedRoot = path.resolve(input.codexHome, "archived_sessions");
    const original = path.resolve(row.rollout_path);
    let destination = original;
    if (!within(archivedRoot, original)) {
      if (!within(path.resolve(input.codexHome, "sessions"), original)) return "unrecoverable";
      destination = path.join(archivedRoot, path.basename(original));
      await mkdir(archivedRoot, { recursive: true });
      try {
        await rename(original, destination);
      } catch (cause) {
        if (codeOf(cause) !== "ENOENT" && codeOf(cause) !== "EEXIST") throw cause;
      }
    }
    const result = database
      .prepare(
        "UPDATE threads SET archived = 1, archived_at = ?, rollout_path = ? WHERE id = ? AND archived = 0",
      )
      .run(Math.floor(Date.now() / 1_000), destination, input.threadId);
    return result.changes === 1 ||
      database.prepare("SELECT archived FROM threads WHERE id = ?").get(input.threadId)
        ?.archived === 1
      ? "archived"
      : "unrecoverable";
  } finally {
    database.close();
  }
}

export class CodexInactiveThreadArchiveError extends Schema.TaggedError<CodexInactiveThreadArchiveError>()(
  "CodexInactiveThreadArchiveError",
  { cause: Schema.Defect() },
) {}

export class CodexInactiveThreadArchive extends Context.Service<
  CodexInactiveThreadArchive,
  {
    readonly archive: (
      input: ArchiveInput,
    ) => Effect.Effect<ArchiveResult, CodexInactiveThreadArchiveError>;
  }
>()("nodex/main/platform/CodexInactiveThreadArchive") {}

export const live = Layer.succeed(CodexInactiveThreadArchive, {
  archive: (input) =>
    Effect.tryPromise({
      try: () => archiveInactiveCodexThread(input),
      catch: (cause) => new CodexInactiveThreadArchiveError({ cause }),
    }),
});
