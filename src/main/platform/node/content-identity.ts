import { createHash } from "node:crypto";

/** Lowercase SHA-256 of exact bytes, or of a structured request encoded by its owner. */
export const contentFingerprint = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

/** A UUID-shaped identity derived from its purpose and parts, so a retry names the same record. */
export const stableId = (purpose: string, ...parts: readonly (string | Uint8Array)[]): string => {
  const hash = createHash("sha256").update(purpose);
  for (const part of parts) {
    hash.update(`:${Buffer.byteLength(part)}:`).update(part);
  }
  const bytes = hash.digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
