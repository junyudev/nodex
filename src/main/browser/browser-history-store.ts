import { syncEffectDirectory } from "../platform/node/filesystem-durability";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { BrowserHistoryRecord, BrowserHistorySnapshot } from "../../shared/browser-profile";

const MAX_HISTORY_ENTRIES = 10_000;
const MAX_HISTORY_BYTES = 8 * 1_024 * 1_024;

const BrowserHistoryRecordSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/u),
    url: z.string().min(1),
    title: z.string().max(2_048),
    lastVisitedAt: z.number().finite().nonnegative(),
    visitCount: z.number().int().positive(),
  })
  .strict();

const BrowserHistoryFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(BrowserHistoryRecordSchema).max(MAX_HISTORY_ENTRIES),
  })
  .strict();

type HistoryState = HashMap.HashMap<string, BrowserHistoryRecord>;

export class BrowserHistoryRuntimeError extends Schema.TaggedError<BrowserHistoryRuntimeError>()(
  "BrowserHistoryRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserHistoryRuntime {
  readonly record: (input: {
    readonly url: string;
    readonly title: string;
    readonly visitedAt?: number;
  }) => Effect.Effect<void, BrowserHistoryRuntimeError>;
  readonly list: (input?: {
    readonly query?: string;
    readonly limit?: number;
  }) => Effect.Effect<BrowserHistorySnapshot>;
  readonly delete: (id: string) => Effect.Effect<void, BrowserHistoryRuntimeError>;
  readonly clear: Effect.Effect<void, BrowserHistoryRuntimeError>;
}

const runtimeError = (operation: string, cause: unknown): BrowserHistoryRuntimeError =>
  new BrowserHistoryRuntimeError({ operation, cause });

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "NotFound";

export const makeBrowserHistoryRuntime = (
  filePath: string,
): Effect.Effect<BrowserHistoryRuntime, BrowserHistoryRuntimeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const quarantine = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* fs
        .rename(filePath, `${filePath}.corrupt-${now}-${randomUUID()}`)
        .pipe(Effect.catch((cause) => (isNotFound(cause) ? Effect.void : Effect.fail(cause))));
    }).pipe(Effect.mapError((cause) => runtimeError("quarantine", cause)));
    const load = fs.exists(filePath).pipe(
      Effect.mapError((cause) => runtimeError("check-exists", cause)),
      Effect.flatMap((exists) => {
        if (!exists) return Effect.succeed(HashMap.empty<string, BrowserHistoryRecord>());
        return fs.readFileString(filePath).pipe(
          Effect.mapError((cause) => runtimeError("read", cause)),
          Effect.flatMap((raw) =>
            Effect.try({
              try: () => decodeHistory(raw),
              catch: (cause) => runtimeError("parse", cause),
            }).pipe(
              Effect.catch(() =>
                quarantine.pipe(Effect.as(HashMap.empty<string, BrowserHistoryRecord>())),
              ),
            ),
          ),
        );
      }),
    );
    const persist = (state: HistoryState) => {
      const payload = encodeHistory(state);
      const directoryPath = dirname(filePath);
      const temporaryPath = join(directoryPath, `.${basename(filePath)}.${randomUUID()}.tmp`);
      return fs.makeDirectory(directoryPath, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(
          Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(new TextEncoder().encode(payload));
              yield* file.sync;
            }),
          ),
        ),
        Effect.andThen(fs.rename(temporaryPath, filePath)),
        Effect.andThen(syncEffectDirectory(fs, directoryPath)),
        Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
        Effect.mapError((cause) => runtimeError("persist", cause)),
      );
    };

    const state = yield* Ref.make(yield* load);
    const writes = yield* Semaphore.make(1);
    return {
      record: (input) => {
        const url = normalizeHistoryUrl(input.url);
        if (!url) return Effect.void;
        return writes.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const existing = Option.getOrUndefined(HashMap.get(current, historyRecordId(url)));
            const lastVisitedAt = input.visitedAt ?? (yield* Clock.currentTimeMillis);
            const record = yield* Effect.try({
              try: () =>
                BrowserHistoryRecordSchema.parse({
                  id: historyRecordId(url),
                  url,
                  title: input.title.slice(0, 2_048),
                  lastVisitedAt,
                  visitCount: (existing?.visitCount ?? 0) + 1,
                }),
              catch: (cause) => runtimeError("validate-record", cause),
            });
            const next = limitHistory(HashMap.set(current, record.id, record));
            yield* persist(next);
            yield* Ref.set(state, next);
          }),
        );
      },
      list: (input = {}) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const updatedAt = yield* Clock.currentTimeMillis;
          const query = input.query?.trim().toLocaleLowerCase() ?? "";
          const limit = Math.max(1, Math.min(1_000, input.limit ?? 200));
          return {
            entries: [...HashMap.values(current)]
              .filter(
                (entry) =>
                  query.length === 0 ||
                  entry.title.toLocaleLowerCase().includes(query) ||
                  entry.url.toLocaleLowerCase().includes(query),
              )
              .sort((left, right) => right.lastVisitedAt - left.lastVisitedAt)
              .slice(0, limit),
            updatedAt,
          };
        }),
      delete: (id) =>
        writes.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (Option.isNone(HashMap.get(current, id))) return;
            const next = HashMap.remove(current, id);
            yield* persist(next);
            yield* Ref.set(state, next);
          }),
        ),
      clear: writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (HashMap.isEmpty(current)) return;
          const next = HashMap.empty<string, BrowserHistoryRecord>();
          yield* persist(next);
          yield* Ref.set(state, next);
        }),
      ),
    } satisfies BrowserHistoryRuntime;
  });

const decodeHistory = (raw: string): HistoryState => {
  if (Buffer.byteLength(raw, "utf8") > MAX_HISTORY_BYTES) {
    throw new TypeError("Browser history exceeds its size limit");
  }
  const parsed = BrowserHistoryFileSchema.parse(JSON.parse(raw));
  return limitHistory(
    HashMap.fromIterable(
      parsed.entries
        .filter((entry) => historyRecordId(entry.url) === entry.id)
        .map((entry) => [entry.id, entry] as const),
    ),
  );
};

const limitHistory = (state: HistoryState): HistoryState => {
  const ordered = [...HashMap.values(state)].sort(
    (left, right) => right.lastVisitedAt - left.lastVisitedAt,
  );
  const entries: BrowserHistoryRecord[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, entries: [] }), "utf8") + 1;
  for (const entry of ordered.slice(0, MAX_HISTORY_ENTRIES)) {
    const entryBytes =
      Buffer.byteLength(JSON.stringify(entry), "utf8") + (entries.length > 0 ? 1 : 0);
    if (bytes + entryBytes > MAX_HISTORY_BYTES) break;
    entries.push(entry);
    bytes += entryBytes;
  }
  return HashMap.fromIterable(entries.map((entry) => [entry.id, entry] as const));
};

const encodeHistory = (state: HistoryState): string => {
  const payload = `${JSON.stringify({ schemaVersion: 1, entries: [...HashMap.values(state)] })}\n`;
  if (Buffer.byteLength(payload, "utf8") <= MAX_HISTORY_BYTES) return payload;
  throw new TypeError("Browser history exceeds its size limit");
};

const normalizeHistoryUrl = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.href === "about:blank") return null;
  return url.href;
};

const historyRecordId = (url: string): string => createHash("sha256").update(url).digest("hex");
