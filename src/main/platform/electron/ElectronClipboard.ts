/* @effect-diagnostics asyncFunction:off -- Native clipboard calls are asynchronous platform operations. */
import { MainConfig } from "../../app/MainConfig";
import { makeElectronClipboardFallback } from "./ElectronClipboardFallback";
import { createRequire } from "node:module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { NativeImage } from "electron";
import { loadNativeClipboardBridge, type NativeClipboardBridge } from "./native-clipboard";
import { readClipboardPastePayload } from "../../clipboard-paste-inspector";
import {
  decodeNodexStructuralClipboardDescriptor,
  inspectNodexClipboardHtml,
  type ClaimedClipboardPresentationWriteInput,
  type ClaimedClipboardPresentationWriteResult,
} from "../../../shared/clipboard-paste";
import type { ClipboardPastePayload } from "../../../shared/types";

const require = createRequire(import.meta.url);
const MAX_FORMAT_BYTES = 8 * 1024 * 1024;

export class ClipboardOperationError extends Schema.TaggedError<ClipboardOperationError>()(
  "ClipboardOperationError",
  {
    reason: Schema.Literals([
      "unavailable",
      "invalid_payload",
      "too_large",
      "inconsistent_read",
      "write_failed",
    ]),
  },
) {}

const nativeReadError = (cause: unknown): ClipboardOperationError => {
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
  return new ClipboardOperationError({
    reason:
      code === "too_large" || code === "invalid_payload" || code === "inconsistent_read"
        ? code
        : "unavailable",
  });
};

export interface ElectronNativeImageTarget {
  createFromBuffer(buffer: Buffer): NativeImage;
  createFromDataURL(dataUrl: string): NativeImage;
}

export interface ElectronClipboardPort {
  readonly readPaste: Effect.Effect<ClipboardPastePayload, ClipboardOperationError>;
  readonly replaceClaimedPresentation: (
    input: ClaimedClipboardPresentationWriteInput & { readonly html?: string },
  ) => Effect.Effect<ClaimedClipboardPresentationWriteResult>;
  readonly writeText: (text: string) => Effect.Effect<void, ClipboardOperationError>;
  readonly writeImage: (image: NativeImage) => Effect.Effect<void, ClipboardOperationError>;
  readonly createImageFromBuffer: (buffer: Buffer) => NativeImage;
  readonly createImageFromDataUrl: (dataUrl: string) => NativeImage;
}

export const makeElectronClipboardPort = (dependencies: {
  readonly native: {
    readonly read: () =>
      | ReturnType<NativeClipboardBridge["read"]>
      | Promise<ReturnType<NativeClipboardBridge["read"]>>;
    readonly update: (
      ...args: Parameters<NativeClipboardBridge["update"]>
    ) =>
      | ReturnType<NativeClipboardBridge["update"]>
      | Promise<ReturnType<NativeClipboardBridge["update"]>>;
  };
  readonly nativeImage: ElectronNativeImageTarget;
  readonly writeText: (text: string) => Promise<void>;
  readonly writePng: (bytes: Uint8Array) => Promise<void>;
}): ElectronClipboardPort => {
  const { native, nativeImage } = dependencies;
  return {
    readPaste: Effect.tryPromise({
      try: async () => readClipboardPastePayload(await native.read()),
      catch: nativeReadError,
    }),
    replaceClaimedPresentation: (input) =>
      Effect.promise(async () => {
        if (
          !input ||
          typeof input.writeClaim !== "string" ||
          typeof input.text !== "string" ||
          (input.html !== undefined && typeof input.html !== "string")
        ) {
          return { ok: false, failure: "write_failed" };
        }
        try {
          const observed = await native.read();
          const descriptor = observed.structuralDescriptor
            ? decodeNodexStructuralClipboardDescriptor(observed.structuralDescriptor)
            : null;
          if (
            (descriptor?.writeClaim ??
              inspectNodexClipboardHtml(observed.html ?? "").writeClaim) !== input.writeClaim
          ) {
            return { ok: false, failure: "superseded" };
          }
          const result = await native.update(observed.generation, input.text, input.html);
          return result === "written" ? { ok: true } : { ok: false, failure: result };
        } catch {
          return { ok: false, failure: "write_failed" };
        }
      }),
    writeText: (text) =>
      Effect.tryPromise({
        try: () => {
          if (Buffer.byteLength(text, "utf8") > MAX_FORMAT_BYTES)
            throw new ClipboardOperationError({ reason: "too_large" });
          return dependencies.writeText(text);
        },
        catch: (error) =>
          Schema.is(ClipboardOperationError)(error)
            ? error
            : new ClipboardOperationError({ reason: "write_failed" }),
      }).pipe(Effect.uninterruptible),
    writeImage: (image) =>
      Effect.tryPromise({
        try: () => {
          if (image.isEmpty()) throw new ClipboardOperationError({ reason: "invalid_payload" });
          const bytes = image.toPNG();
          if (bytes.length > MAX_FORMAT_BYTES)
            throw new ClipboardOperationError({ reason: "too_large" });
          return dependencies.writePng(bytes);
        },
        catch: (error) =>
          Schema.is(ClipboardOperationError)(error)
            ? error
            : new ClipboardOperationError({ reason: "write_failed" }),
      }).pipe(Effect.uninterruptible),
    createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
    createImageFromDataUrl: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
  };
};

export class ElectronClipboard extends Context.Service<ElectronClipboard, ElectronClipboardPort>()(
  "nodex/main/platform/electron/ElectronClipboard",
) {}

export const live: Layer.Layer<ElectronClipboard, never, MainConfig> = Layer.effect(
  ElectronClipboard,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const electron = require("electron") as typeof import("electron");
    return ElectronClipboard.of(
      makeElectronClipboardPort({
        native: config.capabilities.nativeClipboard
          ? loadNativeClipboardBridge({
              packaged: config.isPackaged,
              appPath: config.projectRootPath,
              resourcesPath: config.resourcesPath,
              architecture: config.arch,
            })
          : makeElectronClipboardFallback(
              electron.clipboard,
              (formats) => new electron.ClipboardItem(formats),
            ),
        nativeImage: electron.nativeImage,
        writeText: (text) => electron.clipboard.writeText(text),
        writePng: (bytes) =>
          electron.clipboard.write([
            new electron.ClipboardItem({
              "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }),
            }),
          ]),
      }),
    );
  }),
);
