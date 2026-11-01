export function getSourceContentVersion(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * Names text strongly enough to stand in for it as a cache identity: two
 * independent 32-bit hashes from one pass, so distinct texts practically never
 * share a digest the way they can share one 32-bit version. The first eight hex
 * digits are `getSourceContentVersion(value)`.
 */
export function getSourceContentDigest(value: string): string {
  let fnv = 2_166_136_261;
  let murmur = value.length ^ 0x9e37_79b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    fnv = Math.imul(fnv ^ code, 16_777_619);
    murmur = Math.imul(murmur ^ code, 0x5bd1_e995);
    murmur ^= murmur >>> 15;
  }
  return `${(fnv >>> 0).toString(16).padStart(8, "0")}${(murmur >>> 0).toString(16).padStart(8, "0")}`;
}

/** The `getSourceContentVersion` part of a digest, without hashing the text again. */
export function sourceContentVersionOfDigest(digest: string): number {
  return Number.parseInt(digest.slice(0, 8), 16);
}
