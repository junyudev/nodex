import { createHash, randomUUID, type Hash } from "node:crypto";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const RECOVERY_EXPORT_CHUNK_BYTES = 256 * 1024;
export class RecoveryExportError extends Schema.TaggedError<RecoveryExportError>()(
  "RecoveryExportError",
  { cause: Schema.Defect() },
) {}
const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new RecoveryExportError({ cause }) });
const invalid = (message: string) =>
  Effect.fail(new RecoveryExportError({ cause: new Error(message) }));
interface Sink {
  readonly owner: number;
  readonly scope: string;
  readonly destination: string;
  readonly temporary: string;
  readonly handle: FileHandle;
  readonly length: number;
  readonly expectedHash: string;
  readonly hash: Hash;
  offset: number;
  touchedAt: number;
}

/** Scope owns output handles; serialized transitions fence admission against window release. */
export const makeDocumentRecoveryExportSink = Effect.gen(function* () {
  const sinks = new Map<string, Sink>();
  const closedOwners = new Set<number>();
  const lane = yield* Semaphore.make(1);
  const remove = (id: string, sink: Sink) =>
    Effect.gen(function* () {
      sinks.delete(id);
      yield* io(() => sink.handle.close());
      yield* io(async () => {
        try {
          await unlink(sink.temporary);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      });
    });
  const ordered = <T>(
    owner: number,
    scope: string,
    id: string,
    run: (sink: Sink) => Effect.Effect<T, RecoveryExportError>,
  ) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        const sink = sinks.get(id);
        if (!sink || sink.owner !== owner || sink.scope !== scope)
          return yield* invalid("Recovery export is no longer available in this window");
        sink.touchedAt = yield* Clock.currentTimeMillis;
        return yield* run(sink).pipe(Effect.onError(() => remove(id, sink).pipe(Effect.orDie)));
      }).pipe(Effect.uninterruptible),
    );
  const begin = (owner: number, scope: string, destination: string, length: number, hash: string) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        if (closedOwners.has(owner)) return yield* invalid("The recovery window closed");
        if (!Number.isSafeInteger(length) || length < 0 || !/^[a-f0-9]{64}$/.test(hash))
          return yield* invalid("Recovery export identity is invalid");
        if ([...sinks.values()].filter((sink) => sink.owner === owner).length >= 2)
          return yield* invalid("Finish or cancel the existing recovery export first");
        const id = randomUUID();
        const temporary = path.join(path.dirname(destination), `.nodex-recovery-${id}.tmp`);
        const handle = yield* io(() => open(temporary, "wx", 0o600));
        sinks.set(id, {
          owner,
          scope,
          destination,
          temporary,
          handle,
          length,
          expectedHash: hash,
          hash: createHash("sha256"),
          offset: 0,
          touchedAt: yield* Clock.currentTimeMillis,
        });
        return id;
      }).pipe(Effect.uninterruptible),
    );
  const append = (owner: number, scope: string, id: string, offset: number, bytes: Uint8Array) =>
    ordered(owner, scope, id, (sink) =>
      Effect.gen(function* () {
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.length === 0 ||
          bytes.length > RECOVERY_EXPORT_CHUNK_BYTES ||
          offset !== sink.offset ||
          bytes.length > sink.length - sink.offset
        )
          return yield* invalid("Recovery export chunk is out of order or exceeds its bound");
        yield* io(async () => {
          let written = 0;
          while (written < bytes.length) {
            const result = await sink.handle.write(
              bytes,
              written,
              bytes.length - written,
              sink.offset + written,
            );
            if (!result.bytesWritten) throw new Error("Recovery export could not write all bytes");
            written += result.bytesWritten;
          }
        });
        sink.hash.update(bytes);
        sink.offset += bytes.length;
      }),
    );
  const complete = (owner: number, scope: string, id: string) =>
    ordered(owner, scope, id, (sink) =>
      Effect.gen(function* () {
        if (sink.offset !== sink.length || sink.hash.digest("hex") !== sink.expectedHash)
          return yield* invalid("Recovery export failed its completeness check");
        yield* io(() => sink.handle.sync());
        yield* io(() => sink.handle.close());
        yield* io(() => rename(sink.temporary, sink.destination));
        sinks.delete(id);
      }),
    );
  const cancel = (owner: number, scope: string, id: string) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        const sink = sinks.get(id);
        if (sink?.owner === owner && sink.scope === scope) yield* remove(id, sink);
      }).pipe(Effect.uninterruptible),
    );
  const closeOwner = (owner: number) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        closedOwners.add(owner);
        yield* Effect.forEach(
          [...sinks.entries()].filter(([, sink]) => sink.owner === owner),
          ([id, sink]) => remove(id, sink),
          { discard: true },
        );
      }).pipe(Effect.uninterruptible),
    );
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() =>
      lane.withPermits(1)(
        Effect.forEach([...sinks.entries()], ([id, sink]) => remove(id, sink), { discard: true }),
      ),
    ).pipe(Effect.orDie),
  );
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("1 minute");
        yield* lane.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.forEach(
              [...sinks.entries()].filter(([, sink]) => now - sink.touchedAt >= 5 * 60_000),
              ([id, sink]) => remove(id, sink),
              { discard: true },
            );
          }).pipe(Effect.uninterruptible),
        );
      }),
    ),
  );
  return {
    begin,
    append,
    complete,
    cancel,
    closeOwner,
    close: () =>
      Effect.suspend(() =>
        lane.withPermits(1)(
          Effect.forEach([...sinks.entries()], ([id, sink]) => remove(id, sink), { discard: true }),
        ),
      ),
  };
});
