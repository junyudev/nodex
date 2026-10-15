// @effect-diagnostics asyncFunction:off -- Bounded native filesystem reads are a Node platform boundary.
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { isClaudeHistoryPrompt } from "../../../shared/claude-history";

const MAX_PROJECTS = 10000;
const MAX_PAGE_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_PAGE_RECORDS = 2048;
const MAX_DETAIL_BYTES = 64 * 1024 * 1024;
const sessionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
interface Cursor {
  readonly version: 1;
  readonly file: string;
  readonly end: number;
}
const decodeCursor = (value: string): Cursor => {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("file" in parsed) ||
    typeof parsed.file !== "string" ||
    !("end" in parsed) ||
    !Number.isSafeInteger(parsed.end) ||
    Number(parsed.end) < 0
  )
    throw new Error("The native history cursor is invalid");
  return { version: 1, file: parsed.file, end: Number(parsed.end) };
};
const encodeCursor = (file: string, end: number) =>
  Buffer.from(JSON.stringify({ version: 1, file, end })).toString("base64url");

/** UUID lookup reads bounded folder metadata, independent of a relocated execution directory. */
async function locate(home: string, sessionId: string): Promise<string> {
  if (!isAbsolute(home) || !sessionIdPattern.test(sessionId))
    throw new Error("Invalid native history source");
  const projects = await opendir(join(home, "projects"));
  let count = 0;
  let selected: string | null = null;
  for await (const directory of projects) {
    if (++count > MAX_PROJECTS)
      throw new Error("Native history exceeds its project metadata bound");
    if (!directory.isDirectory()) continue;
    const candidate = join(home, "projects", directory.name, `${sessionId}.jsonl`);
    const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (cause: unknown) => {
        if (missing(cause)) return null;
        throw cause;
      },
    );
    if (file === null) continue;
    try {
      if (!(await file.stat()).isFile()) throw new Error("Native history is not a regular file");
      if (selected !== null) throw new Error("Native history has ambiguous Session ownership");
      selected = candidate;
    } finally {
      await file.close();
    }
  }
  if (selected === null)
    throw Object.assign(new Error("The native Session history is unavailable"), {
      code: "NODEX_NATIVE_SESSION_NOT_FOUND",
    });
  return selected;
}

const nativeRecord = (text: string, sessionId: string): SessionStoreEntry => {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    ("uuid" in value && value.uuid !== undefined && typeof value.uuid !== "string")
  )
    throw new Error("Native history contains an invalid record");
  if ("sessionId" in value && value.sessionId !== sessionId)
    throw new Error("Native history contains a foreign Session record");
  return value as SessionStoreEntry;
};
const prompt = (entry: SessionStoreEntry): boolean =>
  entry.isSidechain !== true &&
  isClaudeHistoryPrompt({
    type: entry.type,
    message: entry.message,
    isMeta: entry.isMeta === true,
    isSynthetic: entry.isSynthetic === true,
  });
const message = (entry: SessionStoreEntry) =>
  (entry.type === "user" || entry.type === "assistant" || entry.type === "system") &&
  typeof entry.uuid === "string";

/** Reads at most one byte window; the SDK later projects these unchanged native records. */
export async function readClaudeHistoryRecords(input: {
  readonly home: string;
  readonly sessionId: string;
  readonly before?: string;
  readonly limit?: number;
}) {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Native history page is invalid");
  const path = await locate(input.home, input.sessionId);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    const identity = `${stat.dev}:${stat.ino}`;
    const cursor = input.before ? decodeCursor(input.before) : null;
    const end = cursor?.end ?? stat.size;
    if (!stat.isFile() || (cursor && cursor.file !== identity) || end > stat.size)
      throw new Error("The native history file changed");
    const entries: SessionStoreEntry[] = [];
    let messages = 0;
    let boundary = end;
    let position = end;
    let pending: Buffer[] = [];
    let bytesRead = 0;
    let selected = false;
    while (position > 0 && !selected) {
      const size = Math.min(READ_CHUNK_BYTES, position, MAX_PAGE_BYTES - bytesRead);
      if (size === 0) throw new Error("The native history record exceeds its byte bound");
      position -= size;
      const chunk = Buffer.alloc(size);
      let count = 0;
      while (count < size) {
        const next = await file.read(chunk, count, size - count, position + count);
        if (next.bytesRead === 0) throw new Error("The native history file was truncated");
        count += next.bytesRead;
      }
      bytesRead += size;
      if (position > 0 && chunk.indexOf(10) < 0) {
        pending.unshift(chunk);
        continue;
      }
      const data = Buffer.concat([chunk, ...pending]);
      let lineEnd = data.length;
      if (data[lineEnd - 1] === 10) lineEnd -= 1;
      while (lineEnd > 0) {
        const newline = data.lastIndexOf(10, lineEnd - 1);
        if (newline < 0 && position > 0) break;
        const lineStart = newline + 1;
        const text = data.subarray(lineStart, lineEnd).toString("utf8");
        lineEnd = newline < 0 ? 0 : newline;
        if (text.trim().length === 0) continue;
        const entry = nativeRecord(text, input.sessionId);
        entries.unshift(entry);
        if (entries.length > MAX_PAGE_RECORDS)
          throw new Error("Native history exceeds its record bound");
        boundary = position + lineStart;
        if (message(entry)) messages += 1;
        if (messages >= limit && prompt(entry)) {
          selected = true;
          break;
        }
      }
      pending = lineEnd === 0 ? [] : [data.subarray(0, lineEnd)];
    }
    if (position > 0 && !entries.some(prompt))
      throw new Error("The native Turn exceeds its history page bound");
    const current = await lstat(path);
    if (`${current.dev}:${current.ino}` !== identity || current.size < end)
      throw new Error("The native history file changed");
    return {
      entries,
      before: boundary > 0 ? encodeCursor(identity, boundary) : null,
      hasMore: boundary > 0,
      bytesRead,
    };
  } finally {
    await file.close();
  }
}

/** Explicit detail reads scan bounded windows and never hydrate the complete transcript. */
export async function readClaudeHistoryRecord(input: {
  readonly home: string;
  readonly sessionId: string;
  readonly nativeMessageId: string;
}) {
  let before: string | undefined;
  let bytes = 0;
  while (bytes < MAX_DETAIL_BYTES) {
    const result = await readClaudeHistoryRecords({
      ...input,
      ...(before ? { before } : {}),
      limit: 200,
    });
    bytes += result.bytesRead;
    if (bytes > MAX_DETAIL_BYTES) break;
    const entry = result.entries.find((record) => record.uuid === input.nativeMessageId);
    if (entry) return [entry];
    if (result.before === null) throw new Error("The native message is unavailable");
    before = result.before;
  }
  throw new Error("The native detail exceeds its lookup byte bound");
}
