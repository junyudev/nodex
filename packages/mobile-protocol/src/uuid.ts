import { bytesToHex } from "@noble/hashes/utils.js";

const UUID_BYTES = 16;

/** Mints a canonical UUID-v7 for a new Nodex identity using the phone's clock and randomness. */
export const createUuidV7 = (
  randomBytes: (length: number) => Uint8Array,
  nowMs: number,
): string => {
  let timestamp = Math.trunc(nowMs);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error(`Invalid UUID-v7 timestamp: ${nowMs}`);
  }

  const bytes = new Uint8Array(randomBytes(UUID_BYTES));
  if (bytes.length !== UUID_BYTES) throw new Error("UUID-v7 requires 16 random bytes");

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
