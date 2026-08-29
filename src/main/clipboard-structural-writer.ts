import { createRequire } from "node:module";

import {
  attachNodexClipboardEnvelope,
  decodeNodexClipboardEnvelope,
  readNodexClipboardWriteClaim,
  type StructuralClipboardWriteInput,
  type StructuralClipboardWriteResult,
} from "../shared/clipboard-paste";
import {
  writeClaimedClipboardPresentation,
  type ClaimedClipboardPresentationTarget,
} from "./clipboard-claimed-presentation-writer";

export type StructuralClipboardTarget = ClaimedClipboardPresentationTarget;

const require = createRequire(import.meta.url);

function resolveClipboardTarget(
  target: StructuralClipboardTarget | undefined,
): StructuralClipboardTarget {
  if (target) return target;
  const electron = require("electron") as typeof import("electron");
  return electron.clipboard;
}

export function writeStructuralClipboard(
  input: StructuralClipboardWriteInput,
  target?: StructuralClipboardTarget,
): StructuralClipboardWriteResult {
  let html: string;
  try {
    html = attachNodexClipboardEnvelope(input.html, input.envelope, input.writeClaim);
  } catch {
    return { ok: false, failure: "write_failed" };
  }

  const clipboard = resolveClipboardTarget(target);
  const clipboardWrite = writeClaimedClipboardPresentation(
    { writeClaim: input.writeClaim, html, text: input.text },
    clipboard,
  );
  if (!clipboardWrite.ok) return clipboardWrite;

  let readback: ReturnType<typeof decodeNodexClipboardEnvelope>;
  let readbackWriteClaim: string | null;
  try {
    const readbackHtml = clipboard.readHTML();
    readback = decodeNodexClipboardEnvelope(readbackHtml);
    readbackWriteClaim = readNodexClipboardWriteClaim(readbackHtml);
  } catch {
    return { ok: false, failure: "readback_mismatch" };
  }
  if (
    readback?.capability !== input.envelope.capability ||
    readbackWriteClaim !== input.writeClaim
  ) {
    return { ok: false, failure: "readback_mismatch" };
  }

  return { ok: true };
}
