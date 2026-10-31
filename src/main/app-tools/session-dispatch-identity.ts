import { createHash } from "node:crypto";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";

/** Derive durable child identities from an admitted operation and its host-issued admission time. */
export const deriveSessionDispatchIdentity = (
  operationId: string,
  purpose: string,
  acceptedAtMs: number,
): string => {
  const bytes = createHash("sha256").update(`${purpose}:${operationId}`).digest();
  return createUuidV7FromTimestamp(acceptedAtMs, bytes.readUInt32BE(0), bytes);
};
