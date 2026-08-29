import { createRequire } from "node:module";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { NativeImage } from "electron";

import {
  decodeNodexStructuralClipboardDescriptor,
  inspectNodexClipboardHtml,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
  type ClaimedClipboardPresentationWriteInput,
  type ClaimedClipboardPresentationWriteResult,
  type NodexStructuralClipboardDescriptorV1,
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
  readonly readStructuralDescriptor: () => NodexStructuralClipboardDescriptorV1 | null;
  readonly readStructuralWriteClaim: () => string | null;
  readonly writePresentation: (presentation: {
    readonly html: string;
    readonly text: string;
  }) => void;
  readonly replaceClaimedPresentation: (
    input: ClaimedClipboardPresentationWriteInput,
  ) => ClaimedClipboardPresentationWriteResult;
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
): ElectronClipboardPort => {
  const readFormat = (format: string): string => {
    const text = target.read(format);
    if (text.length > 0) return text;
    return target.readBuffer(format).toString("utf8");
  };
  const readStructuralWriteClaim = (): string | null => {
    try {
      const descriptor = target.availableFormats().includes(NODEX_STRUCTURAL_CLIPBOARD_MIME)
        ? decodeNodexStructuralClipboardDescriptor(readFormat(NODEX_STRUCTURAL_CLIPBOARD_MIME))
        : null;
      return descriptor?.writeClaim ?? inspectNodexClipboardHtml(target.readHTML()).writeClaim;
    } catch {
      return null;
    }
  };
  return {
    availableFormats: () => target.availableFormats(),
    readFormat,
    readHtml: () => target.readHTML(),
    readText: () => target.readText(),
    readStructuralDescriptor: () => {
      try {
        if (!target.availableFormats().includes(NODEX_STRUCTURAL_CLIPBOARD_MIME)) return null;
        return decodeNodexStructuralClipboardDescriptor(
          readFormat(NODEX_STRUCTURAL_CLIPBOARD_MIME),
        );
      } catch {
        return null;
      }
    },
    readStructuralWriteClaim,
    writePresentation: ({ html, text }) => target.write({ html, text }),
    replaceClaimedPresentation: (input) => {
      if (
        !input ||
        typeof input.writeClaim !== "string" ||
        typeof input.html !== "string" ||
        typeof input.text !== "string"
      ) {
        return { ok: false, failure: "write_failed" };
      }
      if (readStructuralWriteClaim() !== input.writeClaim) {
        return { ok: false, failure: "superseded" };
      }
      try {
        target.write({ html: input.html, text: input.text });
      } catch {
        return { ok: false, failure: "write_failed" };
      }
      try {
        return target.readText() === input.text
          ? { ok: true }
          : { ok: false, failure: "readback_mismatch" };
      } catch {
        return { ok: false, failure: "readback_mismatch" };
      }
    },
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
  return ElectronClipboard.of(makeElectronClipboardPort(electron.clipboard, electron.nativeImage));
});
