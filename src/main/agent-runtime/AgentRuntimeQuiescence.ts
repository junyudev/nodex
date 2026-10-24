import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";

const Fingerprint = Schema.Struct({ size: Schema.String, modifiedAt: Schema.Number });
const Evidence = Schema.Struct({
  version: Schema.Literal(1),
  database: Fingerprint,
  wal: Schema.NullOr(Fingerprint),
});
const decodeEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(Evidence));
const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(Evidence));

/**
 * Durable evidence that the execution store held no live or pending work when its process last
 * stopped. Starting a process clears it first; it binds the exact database and WAL files, so a
 * crash, an external copy or a restore leaves no valid evidence and the next launch starts.
 */
export const make = Effect.fn("AgentRuntimeQuiescence.make")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const databasePath = join(home, "agent-runtime.sqlite");
  const evidencePath = join(home, "quiescent.json");
  const fingerprint = (path: string) =>
    fs.stat(path).pipe(
      Effect.map((info) => ({
        size: String(info.size),
        modifiedAt: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
      })),
    );
  const current = Effect.all({
    database: fingerprint(databasePath),
    wal: fingerprint(`${databasePath}-wal`).pipe(Effect.catch(() => Effect.succeed(null))),
  });
  return {
    record: Effect.gen(function* () {
      const encoded = yield* encodeEvidence({ version: 1, ...(yield* current) });
      const temporary = `${evidencePath}.tmp`;
      yield* fs.writeFileString(temporary, encoded, { mode: 0o600 });
      yield* fs.rename(temporary, evidencePath);
    }),
    clear: fs.remove(evidencePath, { force: true }),
    /** A launch starts execution unless valid evidence proves the store has nothing to resume. */
    startRequired: Effect.gen(function* () {
      if (!(yield* fs.exists(databasePath))) return false;
      const evidence = yield* fs.readFileString(evidencePath).pipe(Effect.flatMap(decodeEvidence));
      const now = yield* current;
      return (
        evidence.database.size !== now.database.size ||
        evidence.database.modifiedAt !== now.database.modifiedAt ||
        JSON.stringify(evidence.wal) !== JSON.stringify(now.wal)
      );
    }).pipe(Effect.catchCause(() => Effect.succeed(true))),
  };
});

/**
 * The process reports no live or pending work: no active Run, pending question, live delegated
 * or background task, delegated completion waiting to wake a root, or execution handoff hold.
 */
export const reportsNoWork = (connection: AgentRuntimeProcessConnection) =>
  Effect.gen(function* () {
    const activity = yield* connection.request("execution.activity", { limit: 1 });
    if (activity.items.length > 0) return false;
    const handoffs = yield* connection.request("execution.handoff.pending", {});
    if (handoffs.items.length > 0) return false;
    const management = yield* connection.request("acp.activity", {});
    return management.activeOperations === 0 && management.activeAuthentication === 0;
  });
