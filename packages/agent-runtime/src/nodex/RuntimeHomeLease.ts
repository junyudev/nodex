// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class RuntimeHomeLeaseError extends Schema.TaggedError<RuntimeHomeLeaseError>()(
  "RuntimeHomeLeaseError",
  {
    message: Schema.String,
  },
) {}

interface Owner {
  readonly pid: number;
  readonly token: string;
}
const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
const readOwner = async (directory: string): Promise<Owner> => {
  const file = path.join(directory, "owner.json");
  const metadata = await fs.lstat(file);
  if (!(await fs.lstat(directory)).isDirectory() || !metadata.isFile() || metadata.size > 4096)
    throw new Error("Execution writer ownership is malformed.");
  const owner = JSON.parse(await fs.readFile(file, "utf8")) as Partial<Owner>;
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid! <= 0 ||
    typeof owner.token !== "string" ||
    owner.token.length === 0 ||
    owner.token.length > 256
  )
    throw new Error("Execution writer ownership is malformed.");
  return { pid: owner.pid!, token: owner.token };
};
const isDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
};
const writeOwner = (directory: string, owner: Owner) =>
  fs.writeFile(path.join(directory, "owner.json"), JSON.stringify(owner), {
    flag: "wx",
    mode: 0o600,
  });
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

async function acquireDirectory(
  home: string,
): Promise<{ readonly directory: string; readonly owner: Owner }> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const directory = path.join(home, ".writer.lock");
  const owner = { pid: process.pid, token: randomUUID() };
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const stale = await readOwner(directory);
    if (!isDead(stale.pid))
      throw new Error("Another execution writer owns this runtime home.", { cause: error });
    await recover(directory, stale);
    await fs.mkdir(directory, { mode: 0o700 });
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
        new RuntimeHomeLeaseError({
          message:
            cause instanceof Error
              ? cause.message
              : "Could not acquire execution writer ownership.",
        }),
    }),
    ({ directory, owner }) =>
      Effect.tryPromise(async () => {
        if (sameOwner(await readOwner(directory), owner))
          await fs.rm(directory, { recursive: true });
      }).pipe(Effect.catchCause(() => Effect.void)),
  ).pipe(Effect.asVoid);
