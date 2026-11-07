// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";

import type { OrchestrationV2TurnItem } from "@nodex/runtime-contracts";

type CommandExecutionItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;

/** Clients read at most this much of one item, so a larger durable output could never be shown. */
export const MAX_STORED_COMMAND_OUTPUT_BYTES = 256 * 1024;
const TRUNCATION_MARKER = "\n… output truncated for storage …\n";
const COMPRESSION = {
  params: { [NodeZlib.constants.ZSTD_c_compressionLevel]: 3 },
};

/** Keeps both ends of an oversized output: the command's start and its final errors. */
export function boundStoredCommandOutput(output: string): string {
  // UTF-8 needs at most three bytes per UTF-16 code unit.
  if (output.length * 3 <= MAX_STORED_COMMAND_OUTPUT_BYTES) return output;
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_STORED_COMMAND_OUTPUT_BYTES) return output;
  const budget = MAX_STORED_COMMAND_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_MARKER);
  let headEnd = Math.ceil(budget / 2);
  let tailStart = bytes.length - Math.floor(budget / 2);
  // Move each cut back into budget so neither end splits a multi-byte character.
  while (headEnd > 0 && (bytes[headEnd]! & 0xc0) === 0x80) headEnd -= 1;
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart += 1;
  return `${bytes.toString("utf8", 0, headEnd)}${TRUNCATION_MARKER}${bytes.toString("utf8", tailStart)}`;
}

/** The bounded form every durable write stores. Other items pass through unchanged. */
export function boundStoredTurnItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "command_execution" || item.output === undefined) return item;
  const output = boundStoredCommandOutput(item.output);
  return output === item.output ? item : { ...item, output };
}

export interface CompressedCommandOutput {
  readonly zstd: Uint8Array;
  /** Decompressed UTF-8 size, so read budgets need not decompress. */
  readonly bytes: number;
}

export function compressCommandOutput(output: string): CompressedCommandOutput {
  const bytes = Buffer.from(output, "utf8");
  return { zstd: NodeZlib.zstdCompressSync(bytes, COMPRESSION), bytes: bytes.length };
}

/**
 * Separates a command's output from the JSON that SQL queries read field by field. It compresses
 * several times over and no query filters on it, so the output has its own column.
 */
export function splitCommandOutput(item: OrchestrationV2TurnItem): {
  readonly item: OrchestrationV2TurnItem;
  readonly output: CompressedCommandOutput | null;
} {
  if (item.type !== "command_execution" || item.output === undefined) return { item, output: null };
  const { output, ...rest } = item;
  return { item: rest satisfies CommandExecutionItem, output: compressCommandOutput(output) };
}

/** SQL for an item's complete JSON; `alias` names a row of the turn item projection. */
export const turnItemPayloadSql = (alias: string) =>
  `CASE WHEN ${alias}.output_zstd IS NULL THEN ${alias}.payload_json
    ELSE json_set(${alias}.payload_json, '$.output', zstd_text(${alias}.output_zstd)) END`;
