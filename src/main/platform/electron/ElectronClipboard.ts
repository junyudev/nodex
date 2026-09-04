import { createRequire } from "node:module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { NativeImage } from "electron";
import { loadNativeClipboardBridge, type NativeClipboardBridge } from "./native-clipboard";

import {
  inspectNodexClipboardHtml,
  type ClaimedClipboardPresentationWriteInput,
  type ClaimedClipboardPresentationWriteResult,
} from "../../../shared/clipboard-paste";

const require = createRequire(import.meta.url);

export interface ElectronClipboardTarget {
  availableFormats(): string[];
  read(format: string): string;
  readBuffer(format: string): Buffer;
  readHTML(): string;
  readText(): string;
  write(data: { readonly html?: string; readonly text?: string }): void;
  writeImage(image: NativeImage): void;
}

export interface ElectronNativeImageTarget {
  createFromBuffer(buffer: Buffer): NativeImage;
  createFromDataURL(dataUrl: string): NativeImage;
}

export interface ElectronClipboardPort {
  readonly availableFormats: () => readonly string[];
  readonly readFormat: (format: string) => string;
  readonly readHtml: () => string;
  readonly readText: () => string;
  readonly replaceClaimedPresentation: (
    input: ClaimedClipboardPresentationWriteInput & { readonly html?: string },
  ) => Effect.Effect<ClaimedClipboardPresentationWriteResult>;
  readonly writeImage: (image: NativeImage) => void;
  readonly createImageFromBuffer: (buffer: Buffer) => NativeImage;
  readonly createImageFromDataUrl: (dataUrl: string) => NativeImage;
}

export const makeElectronClipboardPort = (
  target: ElectronClipboardTarget,
  nativeImage: ElectronNativeImageTarget = {
    createFromBuffer: () => {
      throw new Error("Native image decoding is unavailable");
    },
    createFromDataURL: () => {
      throw new Error("Native image decoding is unavailable");
    },
  },
  native: NativeClipboardBridge,
): ElectronClipboardPort => {
  const readFormat = (format: string): string => {
    const text = target.read(format);
    if (text.length > 0) return text;
    return target.readBuffer(format).toString("utf8");
  };
  return {
    availableFormats: () => target.availableFormats(),
    readFormat,
    readHtml: () => target.readHTML(),
    readText: () => target.readText(),
    replaceClaimedPresentation: (input) =>
      Effect.sync(() => {
        if (
          !input ||
          typeof input.writeClaim !== "string" ||
          (input.html !== undefined && typeof input.html !== "string") ||
          typeof input.text !== "string"
        ) {
          return { ok: false, failure: "write_failed" };
        }
        try {
          const observed = native.read();
          if (inspectNodexClipboardHtml(observed.html ?? "").writeClaim !== input.writeClaim) {
            return { ok: false, failure: "superseded" };
          }
          const result = native.update(observed.generation, input.text, input.html);
          return result === "written" ? { ok: true } : { ok: false, failure: result };
        } catch {
          return { ok: false, failure: "write_failed" };
        }
      }),
    writeImage: (image) => target.writeImage(image),
    createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
    createImageFromDataUrl: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
  };
};

export class ElectronClipboard extends Context.Service<ElectronClipboard, ElectronClipboardPort>()(
  "nodex/main/platform/electron/ElectronClipboard",
) {}

export const live: Layer.Layer<ElectronClipboard> = Layer.sync(ElectronClipboard, () => {
  const electron = require("electron") as typeof import("electron");
  return ElectronClipboard.of(
    makeElectronClipboardPort(
      electron.clipboard,
      electron.nativeImage,
      loadNativeClipboardBridge({
        packaged: electron.app.isPackaged,
        appPath: electron.app.getAppPath(),
        resourcesPath: process.resourcesPath,
        architecture: process.arch,
      }),
    ),
  );
});
