import type { ClipboardPastePayload } from "../../../../shared/types";

// Native menu reads carry materialized resources beside their synthetic event.
// External clipboard MIME cannot manufacture this in-process metadata.
const nativePayloads = new WeakMap<ClipboardEvent, ClipboardPastePayload>();
export const attachNativePastePayload = (
  event: ClipboardEvent,
  payload: ClipboardPastePayload,
): void => {
  nativePayloads.set(event, payload);
};
export const readNativePastePayload = (event: ClipboardEvent): ClipboardPastePayload | undefined =>
  nativePayloads.get(event);
