import { createRequire } from "node:module";

import {
  attachNodexClipboardEnvelope,
  decodeNodexClipboardEnvelope,
  readNodexStructuralClipboardWriteClaim,
  type StructuralClipboardWriteInput,
  type StructuralClipboardWriteResult,
} from "../shared/clipboard-paste";

const require = createRequire(import.meta.url);

export interface StructuralClipboardTarget {
  write(data: { readonly html?: string; readonly text?: string }): void;
  readHTML(): string;
}

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
  try {
    if (readNodexStructuralClipboardWriteClaim(clipboard.readHTML()) !== input.writeClaim) {
      return { ok: false, failure: "superseded" };
    }
  } catch {
    return { ok: false, failure: "write_failed" };
  }
  try {
    clipboard.write({ html, text: input.text });
  } catch {
    return { ok: false, failure: "write_failed" };
  }

  let readback: ReturnType<typeof decodeNodexClipboardEnvelope>;
  let readbackWriteClaim: string | null;
  try {
    const readbackHtml = clipboard.readHTML();
    readback = decodeNodexClipboardEnvelope(readbackHtml);
    readbackWriteClaim = readNodexStructuralClipboardWriteClaim(readbackHtml);
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
