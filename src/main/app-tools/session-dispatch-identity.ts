import { createHash } from "node:crypto";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";

/** Derive durable child identities solely from a validated, bounded operation identity. */
export const deriveSessionDispatchIdentity = (operationId: string, purpose: string): string => {
  const bytes = createHash("sha256").update(`${purpose}:${operationId}`).digest();
  return createUuidV7FromTimestamp(Number(operationId.split(":")[2]), bytes.readUInt32BE(0), bytes);
};
