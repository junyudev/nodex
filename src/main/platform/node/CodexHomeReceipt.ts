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
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as Schema from "effect/Schema";

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

/** Publish the active native history home for Profile snapshots. */
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
