import type { ClipboardWriteImageResult } from "../../../../shared/ipc-api";
import { writeImageToClipboard, type ClipboardImageWritePort } from "@/lib/clipboard";

function isClipboardWriteImageResult(value: unknown): value is ClipboardWriteImageResult {
  if (!value || typeof value !== "object" || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return true;
  }

  const failedResult = value as { ok: false; message?: unknown };
  return failedResult.ok === false && typeof failedResult.message === "string";
}

export async function copyImageToClipboardWithPort(
  source: string,
  writeImage: ClipboardImageWritePort,
): Promise<ClipboardWriteImageResult> {
  try {
    const result = await writeImage(source);
    if (isClipboardWriteImageResult(result)) {
      return result;
    }
  } catch (error) {
    if (error instanceof Error && error.message.length > 0) {
      return { ok: false, message: error.message };
    }
  }

  return {
    ok: false,
    message: "Could not copy image.",
  };
}

export function copyImageToClipboard(source: string): Promise<ClipboardWriteImageResult> {
  return copyImageToClipboardWithPort(source, writeImageToClipboard);
}
