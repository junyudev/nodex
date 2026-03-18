import { v7 as uuidV7, validate as validateUuid, version as uuidVersion } from "uuid";

const ZERO_RANDOM_BYTES = new Uint8Array(16);

function normalizeTimestampMs(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid UUID-v7 timestamp: ${value}`);
  }

  const truncated = Math.trunc(value);
  if (truncated < 0) {
    throw new Error(`UUID-v7 timestamp must be non-negative: ${value}`);
  }

  return truncated;
}

function normalizeRandomBytes(randomBytes: Uint8Array): Uint8Array {
  if (randomBytes.length >= 16) {
    return randomBytes;
  }

  const normalized = new Uint8Array(16);
  normalized.set(randomBytes);
  return normalized;
}

export function createUuidV7(): string {
  return uuidV7();
}

export function createUuidV7FromTimestamp(
  timestampMs: number,
  sequence = 0,
  randomBytes: Uint8Array = ZERO_RANDOM_BYTES,
): string {
  return uuidV7({
    msecs: normalizeTimestampMs(timestampMs),
    seq: sequence >>> 0,
    random: normalizeRandomBytes(randomBytes),
  });
}

export function isUuidV7(value: string): boolean {
  if (value !== value.toLowerCase()) {
    return false;
  }

  if (!validateUuid(value)) {
    return false;
  }

  return uuidVersion(value) === 7;
}

export function assertUuidV7(value: string, label = "card id"): string {
  if (!isUuidV7(value)) {
    throw new Error(`Invalid ${label}: expected canonical lowercase UUID-v7`);
  }

  return value;
}
