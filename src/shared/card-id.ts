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

const UUID_V7_TAIL_MASK = (1n << 74n) - 1n;

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

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function encodeUuidV7(timestampMs: number, tail: bigint): string {
  const bytes = new Uint8Array(16);
  let timestamp = BigInt(timestampMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  const normalizedTail = tail & UUID_V7_TAIL_MASK;
  const randomA = Number((normalizedTail >> 62n) & 0xfffn);
  const randomB = normalizedTail & ((1n << 62n) - 1n);

  bytes[6] = 0x70 | ((randomA >> 8) & 0x0f);
  bytes[7] = randomA & 0xff;
  bytes[8] = 0x80 | Number((randomB >> 56n) & 0x3fn);
  for (let index = 9; index < 16; index += 1) {
    const shift = BigInt((15 - index) * 8);
    bytes[index] = Number((randomB >> shift) & 0xffn);
  }

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function createUuidV7Tail(sequence: number, randomTailBytes: Uint8Array): bigint {
  const sequenceBits = BigInt(sequence >>> 0) << 42n;
  const randomBits = bytesToBigInt(randomTailBytes) & ((1n << 42n) - 1n);
  return sequenceBits | randomBits;
}

function fillRandomBytes(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) {
    throw new Error("Web Crypto is unavailable in this runtime");
  }

  return cryptoApi.getRandomValues(new Uint8Array(length));
}

export function createUuidV7(): string {
  const timestampMs = normalizeTimestampMs(Date.now());
  const sequence = nextSequence(deterministicState, timestampMs);
  const randomTailBytes = fillRandomBytes(6);
  return encodeUuidV7(timestampMs, createUuidV7Tail(sequence, randomTailBytes));
}

export function createUuidV7FromTimestamp(timestampMs: number, sequence?: number): string {
  const normalizedTimestampMs = normalizeTimestampMs(timestampMs);
  const resolvedSequence = sequence ?? nextSequence(deterministicState, normalizedTimestampMs);
  return encodeUuidV7(
    normalizedTimestampMs,
    createUuidV7Tail(resolvedSequence, DETERMINISTIC_RANDOM_BYTES.subarray(0, 6)),
  );
}

export function isUuidV7(value: string): boolean {
  return CANONICAL_UUID_PATTERN.test(value);
}

export function assertUuidV7(value: string, label = "card id"): string {
  if (!isUuidV7(value)) {
    throw new Error(`Invalid ${label}: expected canonical lowercase UUID-v7`);
  }

  return value;
}
