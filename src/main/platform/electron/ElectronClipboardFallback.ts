/* @effect-diagnostics asyncFunction:off -- Electron's cross-platform clipboard is an asynchronous native boundary. */
import { NODEX_STRUCTURAL_CLIPBOARD_MIME } from "../../../shared/clipboard-paste";
import { createHash } from "node:crypto";
import type { Clipboard, ClipboardItem } from "electron";
import type { NativeClipboardSnapshot } from "./native-clipboard";
import type { makeElectronClipboardPort } from "./ElectronClipboard";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FORMATS = 64;
interface ClipboardObservation {
  readonly fingerprint: string;
  readonly formats: Record<string, Blob>;
  readonly snapshot: NativeClipboardSnapshot;
}

/** Preserve private MIME formats when enhancing the text/HTML presentation on Windows. */
export const makeElectronClipboardFallback = (
  clipboard: Pick<Clipboard, "read" | "write">,
  makeItem: (formats: Record<string, Blob | string>) => ClipboardItem,
): Parameters<typeof makeElectronClipboardPort>[0]["native"] => {
  let generation = 0;
  let observed: ClipboardObservation | null = null;
  const read = async (): Promise<ClipboardObservation> => {
    const items = await clipboard.read();
    const formats: Record<string, Blob> = {};
    const digest = createHash("sha256");
    let total = 0;
    for (const item of items) {
      for (const type of [...item.types].sort()) {
        if (Object.keys(formats).length >= MAX_FORMATS)
          throw new Error("Too many clipboard formats");
        if (type === "electron application/bookmark") continue;
        const blob = await item.getType(type);
        if (!(blob instanceof Blob)) continue;
        total += blob.size;
        if (total > MAX_BYTES)
          throw Object.assign(new Error("Clipboard too large"), { code: "too_large" });
        const bytes = Buffer.from(await blob.arrayBuffer());
        digest.update(JSON.stringify([type, bytes.length])).update(bytes);
        formats[type] = blob;
      }
    }
    const fingerprint = digest.digest("hex");
    if (fingerprint !== observed?.fingerprint) generation++;
    const snapshot = {
      generation,
      ...(formats[NODEX_STRUCTURAL_CLIPBOARD_MIME]
        ? { structuralDescriptor: await formats[NODEX_STRUCTURAL_CLIPBOARD_MIME].text() }
        : {}),
      ...(formats["text/plain"] ? { text: await formats["text/plain"].text() } : {}),
      ...(formats["text/html"] ? { html: await formats["text/html"].text() } : {}),
      ...(formats["text/markdown"] ? { markdown: await formats["text/markdown"].text() } : {}),
      fileUrls: formats["text/uri-list"]
        ? (await formats["text/uri-list"].text()).split(/\r?\n/u)
        : [],
    };
    return { fingerprint, formats, snapshot };
  };
  return {
    read: async () => {
      observed = await read();
      return observed.snapshot;
    },
    update: async (expectedGeneration, text, html) => {
      const previous = observed;
      const current = await read();
      if (
        !previous ||
        expectedGeneration !== current.snapshot.generation ||
        previous.fingerprint !== current.fingerprint
      )
        return "superseded";
      const formats: Record<string, Blob | string> = { ...current.formats, "text/plain": text };
      if (html !== undefined) formats["text/html"] = html;
      await clipboard.write([makeItem(formats)]);
      observed = await read();
      if (
        observed.snapshot.text !== text ||
        (html !== undefined && observed.snapshot.html !== html)
      )
        return "readback_mismatch";
      return "written";
    },
  };
};
