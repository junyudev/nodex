import path from "node:path";
import type { ElectronApplication } from "playwright";
import type { NativeClipboardBridge } from "../../src/main/platform/electron/native-clipboard";

/** Observe one native generation. These tests never restore an obsolete OS clipboard. */
export const readTestClipboard = (application: ElectronApplication) =>
  application.evaluate(
    (_, binary) =>
      (
        process.getBuiltinModule("module").createRequire(binary)(binary) as NativeClipboardBridge
      ).read(),
    path.join(process.cwd(), ".generated/clipboard-runtime", process.arch, "nodex-clipboard.node"),
  );

/** Copy rich text as a browser, Notes or mail does: HTML beside its plain text. */
export const writeTestClipboardRichText = (
  application: ElectronApplication,
  copy: { readonly html: string; readonly text: string },
) =>
  application.evaluate(async ({ clipboard, ClipboardItem }, value) => {
    await clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([value.html], { type: "text/html" }),
        "text/plain": new Blob([value.text], { type: "text/plain" }),
      }),
    ]);
  }, copy);

export const writeTestClipboardImage = (application: ElectronApplication, dataUrl: string) =>
  application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, source) => {
    const bytes = nativeImage.createFromDataURL(source).toPNG();
    await clipboard.write([
      new ClipboardItem({ "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }) }),
    ]);
  }, dataUrl);
