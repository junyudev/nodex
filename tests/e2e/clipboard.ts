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

export const writeTestClipboardImage = (application: ElectronApplication, dataUrl: string) =>
  application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, source) => {
    const bytes = nativeImage.createFromDataURL(source).toPNG();
    await clipboard.write([
      new ClipboardItem({ "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }) }),
    ]);
  }, dataUrl);
