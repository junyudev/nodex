import { createHash } from "node:crypto";
import { createUuidV7FromTimestamp } from "../../shared/uuid-v7";

/** The scheduled date is displayed in the user's local time zone. */
export const scheduledFiringTitle = (
  name: string,
  scheduledFor: number,
  timeZone?: string,
): string => {
  const suffix = ` · ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(scheduledFor)}`;
  // Core's Inbox title bound counts Unicode scalar values, rather than UTF-16 units.
  const characters = Array.from(name);
  const available = 200 - Array.from(suffix).length;
  if (characters.length <= available) return `${name}${suffix}`;
  return `${characters.slice(0, available - 1).join("")}…${suffix}`;
};

/** Reclaiming a physical lease retains the same capture and operation identities. */
export const scheduledFiringCapture = (dispatchId: string) => {
  const id = (purpose: string) => {
    const bytes = createHash("sha256").update(`${purpose}:${dispatchId}`).digest();
    return createUuidV7FromTimestamp(bytes.readUIntBE(0, 6), bytes.readUInt32BE(6), bytes);
  };
  return {
    operationId: `inbox.hold-scheduled:${createHash("sha256").update(dispatchId).digest("hex")}`,
    pageId: id("page"),
    documentId: id("document"),
  };
};
