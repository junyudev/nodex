import type { ClipboardWriteImageResult } from "../../shared/ipc-api";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

const writeClipboardImageCommand = defineRendererCommand({
  key: "clipboard.image.write",
  channel: "clipboard:write-image",
  authority: "external",
  owner: "Clipboard",
  protocol: { kind: "returned_value" },
});

export type ClipboardImageWritePort = (source: string) => Promise<ClipboardWriteImageResult>;

export const writeImageToClipboard: ClipboardImageWritePort = async (source) =>
  await invokePlainCommand(writeClipboardImageCommand, { source });

export async function writeTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the DOM fallback below.
    }
  }

  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.setAttribute("aria-hidden", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "-9999px";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  try {
    return document.execCommand("copy");
  } finally {
    textArea.remove();
    activeElement?.focus();
  }
}

export async function writeTextToClipboardStrict(text: string): Promise<void> {
  const copied = await writeTextToClipboard(text);
  if (copied) return;
  throw new Error("Failed to copy to clipboard");
}
