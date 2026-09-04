import { createRequire } from "node:module";
import path from "node:path";

/** A bounded, materialized observation. Generation never crosses the renderer bridge. */
export interface NativeClipboardSnapshot {
  readonly generation: number;
  readonly text?: string;
  readonly html?: string;
  readonly markdown?: string;
  readonly fileUrls: readonly string[];
}

export interface NativeClipboardBridge {
  readonly read: () => NativeClipboardSnapshot;
  /** Enhances existing formats without declaring a new clipboard owner or replacing other data. */
  readonly update: (
    generation: number,
    text: string,
    html?: string,
  ) => "written" | "superseded" | "write_failed" | "readback_mismatch";
}

const require = createRequire(import.meta.url);

export function loadNativeClipboardBridge(options: {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
  readonly architecture: string;
}): NativeClipboardBridge {
  const bindingPath = options.packaged
    ? path.join(options.resourcesPath, "native", "nodex-clipboard.node")
    : path.join(
        options.appPath,
        ".generated",
        "clipboard-runtime",
        options.architecture,
        "nodex-clipboard.node",
      );
  return require(bindingPath) as NativeClipboardBridge;
}
