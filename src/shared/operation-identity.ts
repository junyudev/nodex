import { createUuidV7 } from "./uuid-v7";

export const OPERATION_IDENTITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const OPERATION_IDENTITY_PREFIX = "nodexop:v1:";
const MAX_OPERATION_ID_BYTES = 512;

const currentUnixMillis = (): number => Math.trunc(performance.timeOrigin + performance.now());

export const normalizeOperationIdScope = (scope: string): string =>
  scope
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .slice(0, 96) || "operation";

/** Encodes one finite-window operation identity without depending on a Node-only entropy source. */
export const encodeBoundedOperationId = (
  scope: string,
  issuedAt: number,
  entropy: string,
): string => {
  const issued = Math.max(0, Math.trunc(issuedAt));
  return `${OPERATION_IDENTITY_PREFIX}${issued}:${issued + OPERATION_IDENTITY_WINDOW_MS}:${normalizeOperationIdScope(scope)}:${entropy}`;
};

/** Creates a random finite-window operation identity in both browser and Node runtimes. */
export const createBoundedOperationId = (scope: string, issuedAt = currentUnixMillis()): string =>
  encodeBoundedOperationId(scope, issuedAt, createUuidV7());

/** Validates the canonical bounded identity envelope; Core remains authoritative for expiry. */
export const isBoundedOperationId = (value: string): boolean => {
  if (!value.startsWith(OPERATION_IDENTITY_PREFIX) || value.length > MAX_OPERATION_ID_BYTES) {
    return false;
  }

  const [issuedRaw, expiresRaw, scope, entropy, ...extra] = value
    .slice(OPERATION_IDENTITY_PREFIX.length)
    .split(":");
  if (extra.length > 0 || !issuedRaw || !expiresRaw || !scope || !entropy) return false;

  const issuedAt = Number(issuedRaw);
  const expiresAt = Number(expiresRaw);
  return (
    Number.isSafeInteger(issuedAt) &&
    issuedAt >= 0 &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt === issuedAt + OPERATION_IDENTITY_WINDOW_MS &&
    normalizeOperationIdScope(scope) === scope
  );
};
