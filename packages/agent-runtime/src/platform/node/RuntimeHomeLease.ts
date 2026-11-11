// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export class RuntimeHomeLeaseError extends Schema.TaggedError<RuntimeHomeLeaseError>()(
  "RuntimeHomeLeaseError",
  {
    message: Schema.String,
    conflict: Schema.optionalKey(
      Schema.Struct({
        pid: Schema.Number,
        alive: Schema.Boolean,
        startedAt: Schema.NullOr(Schema.String),
        executable: Schema.NullOr(Schema.String),
        heldMs: Schema.Number,
      }),
    ),
    retryable: Schema.Boolean,
  },
) {}

interface Owner {
  readonly pid: number;
  readonly token: string;
  readonly startedAt?: number;
  readonly acquiredAt?: number;
  readonly executable?: string;
}
const processStartedAt = Math.round(Date.now() - process.uptime() * 1_000);
const boundedExecutable = (value: string) => value.replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 1024);
const validTime = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
const readOwner = async (directory: string): Promise<Owner> => {
  const file = path.join(directory, "owner.json");
  const metadata = await fs.lstat(file);
  if (!(await fs.lstat(directory)).isDirectory() || !metadata.isFile() || metadata.size > 4096)
    throw new Error("Execution writer ownership is malformed.");
  const contents = await fs.readFile(file, "utf8");
  let owner: Partial<Owner> | null;
  try {
    owner = JSON.parse(contents) as Partial<Owner> | null;
  } catch {
    throw new Error("Execution writer ownership is malformed.");
  }
  if (
    !owner ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid! <= 0 ||
    typeof owner.token !== "string" ||
    owner.token.length === 0 ||
    owner.token.length > 256
  )
    throw new Error("Execution writer ownership is malformed.");
  return {
    pid: owner.pid!,
    token: owner.token,
    acquiredAt: validTime(owner.acquiredAt) ? owner.acquiredAt : metadata.mtimeMs,
    ...(validTime(owner.startedAt) ? { startedAt: owner.startedAt } : {}),
    ...(typeof owner.executable === "string" && path.isAbsolute(owner.executable)
      ? { executable: boundedExecutable(owner.executable) }
      : {}),
  };
};
const isDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
};
const runExecutable = promisify(execFile);

/** Older locks only recorded PID and token. Query executable metadata without fetching argv. */
async function describeLegacyOwner(pid: number): Promise<{
  readonly startedAt: string | null;
  readonly executable: string | null;
}> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { startedAt: null, executable: null };
  }
  const output = await runExecutable(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
    { env: { LC_ALL: "C", TZ: "UTC" }, timeout: 250, maxBuffer: 4096 },
  ).catch(() => null);
  const line = output?.stdout.trim() ?? "";
  const time = Date.parse(`${line.slice(0, 24)} UTC`);
  const executable = line.slice(24).trim();
  return {
    startedAt: Number.isFinite(time) ? new Date(time).toISOString() : null,
    executable: executable ? boundedExecutable(executable) : null,
  };
}

async function writeOwner(directory: string, owner: Owner): Promise<void> {
  const pending = path.join(directory, "owner.json.tmp");
  await fs.writeFile(pending, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  await fs.rename(pending, path.join(directory, "owner.json"));
}
const sameOwner = (left: Owner, right: Owner) =>
  left.pid === right.pid && left.token === right.token;

/** The nested exclusive claim prevents two stale recoverers from deleting a replacement writer. */
async function recover(directory: string, stale: Owner): Promise<void> {
  const recovery = path.join(directory, ".recovering");
  const claim = { pid: process.pid, token: randomUUID() };
  await fs.mkdir(recovery, { mode: 0o700 });
  try {
    await writeOwner(recovery, claim);
    if (!sameOwner(await readOwner(directory), stale) || !isDead(stale.pid))
      throw new Error("Execution writer ownership changed while checking its stale lease.");
    await fs.rm(directory, { recursive: true });
  } catch (error) {
    try {
      if (sameOwner(await readOwner(recovery), claim)) await fs.rm(recovery, { recursive: true });
    } catch {
      /* An unverified recovery claim remains closed. */
    }
    throw error;
  }
}

async function leaseConflict(
  home: string,
  owner: Owner,
  alive: boolean,
): Promise<RuntimeHomeLeaseError> {
  const legacy =
    alive && (owner.startedAt === undefined || !owner.executable)
      ? await describeLegacyOwner(owner.pid)
      : null;
  const startedAt =
    owner.startedAt === undefined
      ? (legacy?.startedAt ?? null)
      : new Date(owner.startedAt).toISOString();
  const executable = owner.executable ?? legacy?.executable ?? null;
  const heldMs = Math.max(0, Math.floor(Date.now() - (owner.acquiredAt ?? Date.now())));
  const reason = alive
    ? "Another execution writer owns runtime home"
    : "Could not recover a dead execution writer in runtime home";
  return new RuntimeHomeLeaseError({
    message:
      `${reason} ${JSON.stringify(home)} ` +
      `(pid ${owner.pid}, alive=${alive}, started ${startedAt ?? "unknown"}, ` +
      `executable: ${JSON.stringify(executable)} [Agent Runtime], held ${heldMs}ms).`,
    conflict: { pid: owner.pid, alive, startedAt, executable, heldMs },
    retryable: alive,
  });
}

async function acquireDirectory(
  home: string,
): Promise<{ readonly directory: string; readonly owner: Owner }> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const directory = path.join(home, ".writer.lock");
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: Date.now(),
    startedAt: processStartedAt,
    executable: boundedExecutable(process.execPath),
  };
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    try {
      const current = await readOwner(directory);
      if (!isDead(current.pid)) throw await leaseConflict(home, current, true);
      await recover(directory, current).catch(async (cause: unknown) => {
        // A concurrent recoverer may win. Retry after it publishes its owner.
        if (errorCode(cause) === "ENOENT" || errorCode(cause) === "EEXIST") throw cause;
        throw await leaseConflict(home, current, false);
      });
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT" && errorCode(cause) !== "EEXIST") throw cause;
      throw new RuntimeHomeLeaseError({
        message: `Execution writer ownership is changing in runtime home ${JSON.stringify(home)}.`,
        retryable: true,
      });
    }
  }
  try {
    await writeOwner(directory, owner);
  } catch (error) {
    await fs.rm(directory, { recursive: true });
    throw error;
  }
  return { directory, owner };
}

/** Acquired before SQLite opens; an offline Profile capture uses the same directory protocol. */
export const acquire = (home: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireDirectory(home),
      catch: (cause) =>
        cause instanceof RuntimeHomeLeaseError
          ? cause
          : new RuntimeHomeLeaseError({
              message:
                `Could not acquire execution writer ownership in ${JSON.stringify(home)}.` +
                (cause instanceof Error ? ` ${cause.message}` : ""),
              retryable: false,
            }),
    }),
    ({ directory, owner }) =>
      Effect.tryPromise(async () => {
        if (sameOwner(await readOwner(directory), owner))
          await fs.rm(directory, { recursive: true });
      }).pipe(Effect.catchCause(() => Effect.void)),
  ).pipe(
    // Retry contention in place before opening SQLite or starting any providers.
    Effect.retry(
      Schedule.max([Schedule.exponential("100 millis"), Schedule.recurs(5)]).pipe(
        Schedule.setInputType<RuntimeHomeLeaseError>(),
        Schedule.while(({ input }) => input.retryable),
      ),
    ),
    Effect.asVoid,
  );
