import { createHash } from "node:crypto";
import {
  createBoundedOperationId,
  encodeBoundedOperationId,
  normalizeOperationIdScope,
  OPERATION_IDENTITY_WINDOW_MS,
} from "../../shared/operation-identity";

const MAX_DUE_WORK_IDENTITIES = 4_096;
const currentUnixMillis = (): number => Math.trunc(performance.timeOrigin + performance.now());

interface CachedDueWorkIdentity {
  readonly operationId: string;
  readonly expiresAt: number;
}

const dueWorkIdentities = new Map<string, CachedDueWorkIdentity>();

/** Creates a finite-window operation identity whose issue time Core can verify. */
export const createOperationId = (scope: string, issuedAt = currentUnixMillis()): string =>
  createBoundedOperationId(scope, issuedAt);

/** Derives one restart-stable bounded identity from a durable parent episode. */
export const createStableOperationId = (
  scope: string,
  issuedAt: number,
  semanticIdentity: unknown,
): string =>
  encodeBoundedOperationId(
    scope,
    issuedAt,
    createHash("sha256").update(JSON.stringify(semanticIdentity)).digest("hex"),
  );

/** Creates one stable identity for every retry of a Core-authored due-work token. */
export const createDueWorkOperationId = (
  scope: string,
  workToken: string,
  payload: unknown,
  issuedAt = currentUnixMillis(),
): string => {
  const identityKey = createHash("sha256")
    .update(JSON.stringify({ workToken, payload }))
    .digest("hex");
  const cacheKey = `${normalizeOperationIdScope(scope)}:${identityKey}`;
  const issued = Math.max(0, Math.trunc(issuedAt));
  const cached = dueWorkIdentities.get(cacheKey);
  if (cached && cached.expiresAt > issued) return cached.operationId;
  if (cached) dueWorkIdentities.delete(cacheKey);

  for (const [key, identity] of dueWorkIdentities) {
    if (identity.expiresAt > issued && dueWorkIdentities.size < MAX_DUE_WORK_IDENTITIES) break;
    dueWorkIdentities.delete(key);
  }
  const operationId = encodeBoundedOperationId(scope, issued, identityKey);
  dueWorkIdentities.set(cacheKey, {
    operationId,
    expiresAt: issued + OPERATION_IDENTITY_WINDOW_MS,
  });
  return operationId;
};
