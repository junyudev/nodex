import { createHash } from "node:crypto";
import { stableStringifyBlockPropertyJson } from "../../shared/block-property-mutations";
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

/** Exact arguments remain comparable after a response has settled its pending request. */
export const sessionDispatchFingerprint = (
  identity: Parameters<typeof stableStringifyBlockPropertyJson>[0],
): string => createHash("sha256").update(stableStringifyBlockPropertyJson(identity)).digest("hex");
