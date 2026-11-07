// Cold scans span tens of gigabytes; buffer streaming with a line gate is far cheaper than materializing files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import type { TranscriptFormat, TranscriptRecord } from "./UsageRecord.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Resume only if the bytes before `resumeOffset` still match; a rewritten file would corrupt totals. */
export interface TranscriptPosition {
  readonly resumeOffset: number;
  readonly guardLength: number;
  readonly guardHash: number;
  readonly state: unknown;
}

export interface TranscriptReadResult {
  readonly records: readonly TranscriptRecord[];
  readonly position: TranscriptPosition;
  readonly resumed: boolean;
  readonly session: { readonly sessionId: string; readonly subagent: boolean };
}

const GUARD_LENGTH = 64;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const STAT_CONCURRENCY = 32;
/** A larger line is a pasted payload, never a usage record, and parsing it would stall the Runtime. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Directories are walked, never followed: a transcript home holds no symlinked history. */
export async function listTranscriptFiles(root: string): Promise<{
  readonly files: readonly TranscriptFile[];
  readonly failedPaths: number;
}> {
  const candidates: string[] = [];
  let failedPaths = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) failedPaths += 1;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst")) {
        candidates.push(child);
      }
    }
  };
  await walk(root);

  const found: Array<TranscriptFile | undefined> = Array.from({ length: candidates.length });
  const queue = candidates.entries();
  const statQueued = async (): Promise<void> => {
    for (const [index, path] of queue) {
      try {
        const stats = await NodeFSP.stat(path);
        found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          failedPaths += 1;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued),
  );
  return { files: found.filter((file) => file !== undefined), failedPaths };
}

async function guardMatches(
  handle: NodeFSP.FileHandle,
  position: TranscriptPosition,
): Promise<boolean> {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH) return false;
  try {
    const window = Buffer.alloc(position.guardLength);
    const { bytesRead } = await handle.read(
      window,
      0,
      position.guardLength,
      position.resumeOffset - position.guardLength,
    );
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
  } catch {
    return false;
  }
}

// One latin1 alternation keeps exact ASCII matching without decoding each line as UTF-8.
function lineGate(markers: readonly [string, ...string[]]) {
  if (markers.length === 1) {
    const marker = Buffer.from(markers[0]);
    return (line: Buffer) => line.includes(marker);
  }
  const needles = markers.map((marker) => Buffer.from(marker));
  return (line: Buffer) => needles.some((needle) => line.includes(needle));
}

/**
 * Only whole lines count, so an unfinished tail is read again once it ends. A compressed file is a
 * finished snapshot and has no byte position to resume, so it always parses whole. Returns null on a
 * read failure: treating it as an empty transcript would hide usage until the file next changes.
 */
export async function readTranscript<State>(
  filePath: string,
  format: TranscriptFormat<State>,
  resumeFrom?: TranscriptPosition,
): Promise<TranscriptReadResult | null> {
  const compressed = filePath.endsWith(".jsonl.zst");
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }

  try {
    let state = format.initialState();
    let resumed = false;
    let start = 0;
    if (
      !compressed &&
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      format.isState(resumeFrom.state) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      state = resumeFrom.state;
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const mightMatter = lineGate(format.lineMarkers);
    const records: TranscriptRecord[] = [];
    const parse = (line: Buffer) => {
      if (!mightMatter(line)) return;
      const content =
        line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN ? line.subarray(0, -1) : line;
      for (const record of format.parseLine(content.toString("utf8"), state)) records.push(record);
    };

    let resumeOffset = start;
    let scanOffset = start;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let oversized = false;
    const input = handle.createReadStream({
      start,
      autoClose: compressed,
      highWaterMark: 256 * 1024,
    });
    const stream = compressed ? input.compose(NodeZlib.createZstdDecompress()) : input;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let lineStart = 0;
      while (lineStart < chunk.length) {
        const newlineIndex = chunk.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) {
          const segment = chunk.subarray(lineStart);
          pendingBytes += segment.length;
          if (pendingBytes > MAX_LINE_BYTES) {
            oversized = true;
            pending = [];
          } else pending.push(segment);
          break;
        }
        const segment = chunk.subarray(lineStart, newlineIndex);
        if (pendingBytes === 0) parse(segment);
        else if (!oversized && pendingBytes + segment.length <= MAX_LINE_BYTES) {
          parse(Buffer.concat([...pending, segment], pendingBytes + segment.length));
        }
        pending = [];
        pendingBytes = 0;
        oversized = false;
        lineStart = newlineIndex + 1;
        resumeOffset = scanOffset + lineStart;
      }
      scanOffset += chunk.length;
    }
    // A compressed snapshot is complete, so its last line counts even without a newline.
    if (compressed && pendingBytes > 0 && !oversized) parse(Buffer.concat(pending, pendingBytes));

    const guardLength = compressed ? 0 : Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      records,
      position: { resumeOffset: compressed ? 0 : resumeOffset, guardLength, guardHash, state },
      resumed,
      session: format.describeSession({ path: filePath, state }),
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
