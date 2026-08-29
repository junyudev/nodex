import { createRequire } from "node:module";

import {
  readNodexClipboardWriteClaim,
  type ClaimedClipboardPresentationWriteInput,
  type ClaimedClipboardPresentationWriteResult,
} from "../shared/clipboard-paste";

const require = createRequire(import.meta.url);

export interface ClaimedClipboardPresentationTarget {
  write(data: { readonly html?: string; readonly text?: string }): void;
  readHTML(): string;
  readText(): string;
}

function resolveClipboardTarget(
  target: ClaimedClipboardPresentationTarget | undefined,
): ClaimedClipboardPresentationTarget {
  if (target) return target;
  const electron = require("electron") as typeof import("electron");
  return electron.clipboard;
}

/** Replaces a claimed native clipboard value only while this copy still owns it. */
export function writeClaimedClipboardPresentation(
  input: ClaimedClipboardPresentationWriteInput,
  target?: ClaimedClipboardPresentationTarget,
): ClaimedClipboardPresentationWriteResult {
  if (
    !input ||
    typeof input.writeClaim !== "string" ||
    typeof input.html !== "string" ||
    typeof input.text !== "string"
  ) {
    return { ok: false, failure: "write_failed" };
  }

  const clipboard = resolveClipboardTarget(target);
  try {
    const currentClaim = readNodexClipboardWriteClaim(clipboard.readHTML());
    if (!currentClaim || currentClaim !== input.writeClaim) {
      return { ok: false, failure: "superseded" };
    }
  } catch {
    return { ok: false, failure: "write_failed" };
  }

  try {
    clipboard.write({ html: input.html, text: input.text });
  } catch {
    return { ok: false, failure: "write_failed" };
  }

  try {
    return clipboard.readText() === input.text
      ? { ok: true }
      : { ok: false, failure: "readback_mismatch" };
  } catch {
    return { ok: false, failure: "readback_mismatch" };
  }
}
