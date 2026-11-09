import { createHash } from "node:crypto";

/** Core identities are opaque; filesystem names must neither parse them as UUIDs nor use them as paths. */
export function spacePathKey(spaceId: string): string {
  if (!spaceId || spaceId.length > 512) throw new Error("Invalid Space identity");
  return createHash("sha256").update(spaceId).digest("hex");
}
