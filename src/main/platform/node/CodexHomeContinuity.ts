import { randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodexSessionTransport, type CodexSessionProcessConfig } from "./CodexSessionTransport";

const Receipt = Schema.Struct({ version: Schema.Literal(1), codexHome: Schema.String });
const decodeReceipt = Schema.decodeUnknownSync(Receipt);
const receiptPath = (profileHome: string) =>
  join(profileHome, "runtime", "agent", "codex-home.json");
const MAX_RECEIPT_BYTES = 16 * 1024;

const canonicalHome = (home: string): string => {
  if (!isAbsolute(home)) throw new Error("Codex home must be an absolute path.");
  if (!existsSync(home)) return resolve(home);
  if (!statSync(home).isDirectory()) throw new Error("Codex home must be a directory.");
  return realpathSync(home);
};

export function readCodexHomeReceipt(profileHome: string): string | null {
  const file = receiptPath(profileHome);
  let original: Stats;
  try {
    original = lstatSync(file);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  }
  if (!original.isFile() || original.isSymbolicLink())
    throw new Error("Codex home receipt must be a regular file.");
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== original.ino || opened.dev !== original.dev)
      throw new Error("Codex home receipt changed while it was opened.");
    if (opened.size > MAX_RECEIPT_BYTES) throw new Error("Codex home receipt is too large.");
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const size = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (size === 0) break;
      length += size;
    }
    if (length > MAX_RECEIPT_BYTES) throw new Error("Codex home receipt is too large.");
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    return canonicalHome(decodeReceipt(JSON.parse(contents)).codexHome);
  } finally {
    closeSync(descriptor);
  }
}

export function createCodexHomeDirectory(codexHome: string): void {
  canonicalHome(codexHome);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
}

/** Record only a home whose native history has passed the Profile continuity check. */
export function writeCodexHomeReceipt(input: {
  readonly profileHome: string;
  readonly codexHome: string;
}): void {
  const codexHome = canonicalHome(input.codexHome);
  if (readCodexHomeReceipt(input.profileHome) === codexHome) return;
  const directory = join(input.profileHome, "runtime", "agent");
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `codex-home-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, codexHome })}\n`, { mode: 0o600 });
    renameSync(temporary, receiptPath(input.profileHome));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function containsRollout(root: string): boolean {
  if (!existsSync(root)) return false;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) return false;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^rollout-.+\.jsonl(?:\.zst)?$/.test(entry.name)) return true;
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
  return false;
}

/** Bootstrap inspection is restricted to the old Profile-owned home and the pinned native index. */
function legacyHomeHasThreads(home: string): boolean {
  if (containsRollout(join(home, "sessions")) || containsRollout(join(home, "archived_sessions"))) {
    return true;
  }
  const file = join(home, "state_5.sqlite");
  if (!existsSync(file)) return false;
  const database = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    const columns = database.prepare("PRAGMA table_info(threads)").all();
    if (columns.length === 0) return false;
    const id = columns.find((column) => column.name === "id");
    const rollout = columns.find((column) => column.name === "rollout_path");
    if (id?.type !== "TEXT" || id.pk !== 1 || rollout?.type !== "TEXT") {
      throw new Error("Cannot inspect this Profile's existing Codex history format.");
    }
    return database.prepare("SELECT 1 AS present FROM threads LIMIT 1").get() !== undefined;
  } finally {
    database.close();
  }
}

/** Existing Profiles keep their native history; new Profiles use the selected account home. */
export function initializeCodexHomeContinuity(input: {
  readonly profileHome: string;
  readonly selectedHome: string;
  readonly hasConfiguredHome: boolean;
  readonly hasInheritedCodexHome: boolean;
}): {
  readonly codexHome: string;
  readonly pinLegacyHome: boolean;
  readonly previousHome: string | null;
} {
  const selectedHome = canonicalHome(input.selectedHome);
  const previousHome = readCodexHomeReceipt(input.profileHome);
  if (previousHome !== null) {
    return { codexHome: selectedHome, pinLegacyHome: false, previousHome };
  }
  const legacyHome = join(input.profileHome, "agent");
  if (!legacyHomeHasThreads(legacyHome)) {
    return { codexHome: selectedHome, pinLegacyHome: false, previousHome: null };
  }
  const codexHome = canonicalHome(legacyHome);
  if (input.hasConfiguredHome || input.hasInheritedCodexHome) {
    return { codexHome: selectedHome, pinLegacyHome: false, previousHome: codexHome };
  }
  return { codexHome, pinLegacyHome: true, previousHome: codexHome };
}

export class CodexHomeContinuityError extends Schema.TaggedError<CodexHomeContinuityError>()(
  "CodexHomeContinuityError",
  { targetHome: Schema.String, threadId: Schema.NullOr(Schema.String), cause: Schema.Defect() },
) {}

/** A separate official metadata peer validates destination ownership without resuming or running a Turn. */
export const assertCodexHomeChangeSafe = Effect.fn("assertCodexHomeChangeSafe")(function* (input: {
  readonly currentHome: string;
  readonly targetHome: string;
  readonly requiredThreadIds: readonly string[];
  readonly processConfig: CodexSessionProcessConfig;
}) {
  const sameHome = yield* Effect.try({
    try: () => canonicalHome(input.currentHome) === canonicalHome(input.targetHome),
    catch: (cause) =>
      new CodexHomeContinuityError({ targetHome: input.targetHome, threadId: null, cause }),
  });
  const threadIds = [...new Set(input.requiredThreadIds)];
  if (sameHome || threadIds.length === 0) return;
  yield* Effect.try({
    try: () => {
      if (!existsSync(input.targetHome))
        throw new Error("The selected Codex home does not contain this Profile's existing chats.");
    },
    catch: (cause) =>
      new CodexHomeContinuityError({ targetHome: input.targetHome, threadId: null, cause }),
  });
  const transport = yield* CodexSessionTransport;
  const opened = yield* transport
    .open({
      ...input.processConfig,
      hostId: "local",
      ssh: undefined,
      localDaemon: undefined,
      resolveEnv: undefined,
      env: { ...input.processConfig.env, CODEX_HOME: input.targetHome },
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexHomeContinuityError({ targetHome: input.targetHome, threadId: null, cause }),
      ),
    );
  const initialized = yield* opened.client
    .request("initialize", {
      clientInfo: { name: "nodex-home-continuity", title: "Nodex", version: "1" },
      capabilities: { experimentalApi: true },
    })
    .pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(
        (cause) =>
          new CodexHomeContinuityError({ targetHome: input.targetHome, threadId: null, cause }),
      ),
    );
  const resolvedHome = yield* Effect.try({
    try: () => canonicalHome(initialized.codexHome) === canonicalHome(input.targetHome),
    catch: (cause) =>
      new CodexHomeContinuityError({ targetHome: input.targetHome, threadId: null, cause }),
  });
  if (!resolvedHome) {
    return yield* new CodexHomeContinuityError({
      targetHome: input.targetHome,
      threadId: null,
      cause: new Error("Codex opened a different home than the selected destination."),
    });
  }
  yield* opened.client
    .notify("initialized", undefined)
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexHomeContinuityError({ targetHome: input.targetHome, threadId: null, cause }),
      ),
    );
  const readHistory = Effect.fn("assertCodexHomeChangeSafe.readHistory")(function* (
    threadId: string,
  ) {
    const onError = (cause: unknown) =>
      new CodexHomeContinuityError({ targetHome: input.targetHome, threadId, cause });
    const response = yield* opened.client
      .request("thread/read", { threadId, includeTurns: false })
      .pipe(Effect.timeout("10 seconds"), Effect.mapError(onError));
    if (response.thread.id !== threadId)
      return yield* onError(new Error("Codex returned a different Thread than requested."));
    yield* opened.client
      .request("thread/turns/list", { threadId, limit: 1, itemsView: "summary" })
      .pipe(Effect.timeout("10 seconds"), Effect.mapError(onError));
  });
  yield* Effect.forEach(threadIds, readHistory);
}, Effect.scoped);
