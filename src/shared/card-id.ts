import { validate as validateUuid, v7 as uuidv7, version as uuidVersion } from "uuid";

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DETERMINISTIC_RANDOM_BYTES = new Uint8Array(16);

interface MonotonicState {
  lastTimestampMs: number;
  sequence: number;
}

const deterministicState: MonotonicState = {
  lastTimestampMs: Number.NaN,
  sequence: 0,
};

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

function nextSequence(state: MonotonicState, timestampMs: number): number {
  if (state.lastTimestampMs !== timestampMs) {
    state.lastTimestampMs = timestampMs;
    state.sequence = 0;
    return state.sequence;
  }

  state.sequence = (state.sequence + 1) >>> 0;
  return state.sequence;
}

export function createUuidV7(): string {
  return uuidv7().toLowerCase();
}

export function createUuidV7FromTimestamp(timestampMs: number, sequence?: number): string {
  const normalizedTimestampMs = normalizeTimestampMs(timestampMs);
  const resolvedSequence = sequence ?? nextSequence(deterministicState, normalizedTimestampMs);
  return uuidv7({
    msecs: normalizedTimestampMs,
    seq: resolvedSequence,
    random: DETERMINISTIC_RANDOM_BYTES,
  }).toLowerCase();
}

export function isUuidV7(value: string): boolean {
  if (!CANONICAL_UUID_PATTERN.test(value)) return false;
  if (!validateUuid(value)) return false;
  return uuidVersion(value) === 7;
}

export function assertUuidV7(value: string, label = "card id"): string {
  if (!isUuidV7(value)) {
    throw new Error(`Invalid ${label}: expected canonical lowercase UUID-v7`);
  }

  return value;
}
