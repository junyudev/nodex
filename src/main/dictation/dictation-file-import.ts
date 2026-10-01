import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  DICTATION_HISTORY_MAX_AUDIO_BYTES,
  DictationRecordingFileNameSchema,
} from "../../shared/dictation-history";

interface EbmlInteger {
  readonly value: number;
  readonly next: number;
  readonly unknown: boolean;
}

function readEbmlInteger(bytes: Uint8Array, offset: number, preserveMarker: boolean): EbmlInteger {
  const first = bytes[offset];
  if (first === undefined || first === 0) throw new Error("The file has an invalid WebM header");
  let width = 1;
  let marker = 0x80;
  while (!(first & marker)) {
    width += 1;
    marker >>= 1;
  }
  if (width > (preserveMarker ? 4 : 8) || offset + width > bytes.byteLength) {
    throw new Error("The file has an invalid WebM header");
  }
  let value = BigInt(preserveMarker ? first : first & (marker - 1));
  for (let index = 1; index < width; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]!);
  }
  const unknown = !preserveMarker && value === (1n << BigInt(width * 7)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The file has an invalid WebM header");
  }
  return { value: unknown ? 0 : Number(value), next: offset + width, unknown };
}

/** Checks the container header without decoding, rewriting, or trusting the selected extension. */
export function validateDictationWebm(bytes: Uint8Array): void {
  const headerId = readEbmlInteger(bytes, 0, true);
  if (headerId.value !== 0x1a45dfa3) throw new Error("Choose a WebM file");
  const headerSize = readEbmlInteger(bytes, headerId.next, false);
  const headerEnd = headerSize.next + headerSize.value;
  if (headerSize.unknown || headerSize.value > 4096 || headerEnd > bytes.byteLength) {
    throw new Error("The file has an invalid WebM header");
  }
  let offset = headerSize.next;
  let foundDocType = false;
  while (offset < headerEnd) {
    const id = readEbmlInteger(bytes.subarray(0, headerEnd), offset, true);
    const size = readEbmlInteger(bytes.subarray(0, headerEnd), id.next, false);
    const end = size.next + size.value;
    if (size.unknown || end > headerEnd) throw new Error("The file has an invalid WebM header");
    if (id.value === 0x4282) {
      const docType = new TextDecoder().decode(bytes.subarray(size.next, end));
      if (foundDocType || docType !== "webm") throw new Error("Choose a WebM file");
      foundDocType = true;
    }
    offset = end;
  }
  if (!foundDocType) throw new Error("Choose a WebM file");
  const segmentId = readEbmlInteger(bytes, headerEnd, true);
  if (segmentId.value !== 0x18538067) throw new Error("The file has an invalid WebM segment");
  const segmentSize = readEbmlInteger(bytes, segmentId.next, false);
  const remainingBytes = bytes.byteLength - segmentSize.next;
  if (
    remainingBytes <= 0 ||
    (!segmentSize.unknown && (segmentSize.value === 0 || segmentSize.value > remainingBytes))
  ) {
    throw new Error("The WebM file is empty or incomplete");
  }
}

/** Reads only the user's native picker selection, bounded independently of filesystem growth. */
export async function readDictationWebmFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ readonly fileName: string; readonly bytes: Uint8Array }> {
  const fileName = DictationRecordingFileNameSchema.parse(basename(filePath));
  if (extname(fileName).toLowerCase() !== ".webm") throw new Error("Choose a WebM file");
  signal?.throwIfAborted();
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Choose a regular WebM file");
    if (stats.size === 0) throw new Error("The WebM file is empty");
    if (stats.size > DICTATION_HISTORY_MAX_AUDIO_BYTES)
      throw new Error("The WebM file exceeds 64 MiB");
    const bytes = new Uint8Array(stats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error("The WebM file changed while it was being read");
      offset += bytesRead;
    }
    const extra = new Uint8Array(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, bytes.byteLength);
    const latest = await handle.stat();
    if (extraBytes !== 0 || latest.size !== stats.size || latest.mtimeMs !== stats.mtimeMs) {
      throw new Error("The WebM file changed while it was being read");
    }
    signal?.throwIfAborted();
    validateDictationWebm(bytes);
    return { fileName, bytes };
  } finally {
    await handle.close();
  }
}
