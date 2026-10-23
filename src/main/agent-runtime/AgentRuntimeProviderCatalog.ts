import { join } from "node:path";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

type Providers = AgentRuntimeOperations["providers.read"]["output"];

const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.String,
  providers: Schema.Array(Schema.Unknown),
});
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot));

interface Stored {
  readonly identity: string;
  readonly encoded: string;
  readonly providers: Providers;
}

/**
 * The provider catalog a live execution process last served. Model pickers, launch defaults and
 * provider checks read it while the process is stopped, so showing a chat never starts execution
 * just to list models. A running process always answers live, and an explicit refresh always
 * reaches the process. The snapshot is valid only for the identity it was recorded under: the
 * engine build that encoded its rows and the provider declaration it describes.
 */
export const make = Effect.fn("AgentRuntimeProviderCatalog.make")(function* (options: {
  readonly home: string;
  /** Changes whenever the engine build or the declared providers change. */
  readonly identity: Effect.Effect<string, unknown>;
  /** True while an execution process can answer with live provider state. */
  readonly running: Effect.Effect<boolean, unknown>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(options.home, "provider-catalog.json");
  const writes = yield* Semaphore.make(1);
  const memory = yield* Ref.make<Stored | null>(null);
  const stored = Effect.gen(function* () {
    const kept = yield* Ref.get(memory);
    if (kept) return kept;
    const encoded = yield* fs.readFileString(path);
    const snapshot = yield* decodeSnapshot(encoded);
    // The identity binds the engine build that encoded these rows.
    const loaded = {
      identity: snapshot.identity,
      encoded,
      providers: snapshot.providers as Providers,
    };
    yield* Ref.set(memory, loaded);
    return loaded;
  });
  /** The kept catalog when it still describes the current declaration, running or not. */
  const saved = Effect.gen(function* () {
    const identity = yield* options.identity;
    const snapshot = yield* stored;
    return snapshot.identity === identity ? snapshot.providers : null;
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));
  return {
    /** The catalog to serve without starting execution, or null when only a live read will do. */
    lastKnown: Effect.gen(function* () {
      if (yield* options.running) return null;
      return yield* saved;
    }).pipe(Effect.catchCause(() => Effect.succeed(null))),
    /**
     * The kept catalog even while a process runs, for observers that must not reach it, such
     * as usage meters that settle for the last reading rather than start execution.
     */
    saved,
    /** Keeps what a live process just served for the next stopped read. */
    record: (providers: Providers) =>
      writes
        .withPermits(1)(
          Effect.gen(function* () {
            const identity = yield* options.identity;
            const encoded = JSON.stringify({ version: 1, identity, providers });
            if ((yield* Ref.get(memory))?.encoded === encoded) return;
            const temporary = `${path}.tmp`;
            yield* fs.makeDirectory(options.home, { recursive: true });
            yield* fs.writeFileString(temporary, encoded, { mode: 0o600 });
            yield* fs.rename(temporary, path);
            yield* Ref.set(memory, { identity, encoded, providers });
          }),
        )
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("The provider catalog could not be kept for the next launch"),
          ),
        ),
  };
});
