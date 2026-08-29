import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import { parseAssetSource } from "../../../shared/assets";
import { MainConfig } from "../../app/MainConfig";
import { readClipboardPastePayload } from "../../clipboard-paste-inspector";
import { writeImageToClipboard } from "../../clipboard-image-writer";
import { writeClaimedClipboardPresentation } from "../../clipboard-claimed-presentation-writer";
import { writeStructuralClipboard } from "../../clipboard-structural-writer";
import {
  COMPOSER_IMAGE_FILE_EXTENSIONS,
  prepareComposerPickedFiles,
} from "../../composer-picked-files";
import {
  materializeCanvasImage,
  materializeLocalResource,
  readManagedAssetImage,
  readManagedAssetPreview,
  resolveAssetPath,
  saveUploadedImage,
  saveUploadedResource,
} from "../../local-store/assets";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ManagedMediaIpcError extends Schema.TaggedError<ManagedMediaIpcError>()(
  "ManagedMediaIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type Handler<Channel extends keyof IpcApi> = (
  event: IpcMainInvokeEvent,
  ...args: IpcApi[Channel]["args"]
) => Effect.Effect<IpcApi[Channel]["result"], unknown>;

export const live: Layer.Layer<
  never,
  never,
  ElectronDesktop | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const desktop = yield* ElectronDesktop;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const handle = <Channel extends keyof IpcApi>(channel: Channel, handler: Handler<Channel>) =>
      ipc.handle(channel, handler);
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Managed media", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Managed media access requires an active Nodex window");
          }
        },
        catch: (cause) => new ManagedMediaIpcError({ operation: "authorize-renderer", cause }),
      });
    const run = <A>(operation: string, task: () => A | Promise<A>) =>
      Effect.tryPromise({
        try: () => Promise.resolve(task()),
        catch: (cause) => new ManagedMediaIpcError({ operation, cause }),
      });

    yield* handle("asset:resolve-path", (event, source) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const parsed = typeof source === "string" ? parseAssetSource(source) : null;
            if (!parsed) return null;
            try {
              return resolveAssetPath(parsed.fileName);
            } catch {
              return null;
            }
          }),
        ),
      ),
    );
    yield* handle("asset:image:save", (event, input) =>
      authorize(event).pipe(Effect.andThen(run("save-image", () => saveUploadedImage(input)))),
    );
    yield* handle("asset:canvas-image:materialize", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("materialize-canvas-image", () => materializeCanvasImage(input))),
      ),
    );
    yield* handle("asset:image:read", (event, source) =>
      authorize(event).pipe(Effect.andThen(run("read-image", () => readManagedAssetImage(source)))),
    );
    yield* handle("asset:resource:save", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("save-resource", () => saveUploadedResource(input))),
      ),
    );
    yield* handle("asset:resource:materialize", (event, path) =>
      authorize(event).pipe(
        Effect.andThen(
          run("materialize-resource", () => {
            if (typeof path !== "string") throw new Error("Local resource path is required");
            return materializeLocalResource(path);
          }),
        ),
      ),
    );
    yield* handle("asset:preview:read", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("read-preview", () => readManagedAssetPreview(input))),
      ),
    );
    yield* handle("clipboard:write-image", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          typeof input?.source === "string"
            ? run("write-clipboard-image", () => writeImageToClipboard(input.source!))
            : Effect.succeed({ ok: false, message: "Could not copy image." } as const),
        ),
      ),
    );
    yield* handle("clipboard:write-structural", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("write-structural-clipboard", () => writeStructuralClipboard(input))),
      ),
    );
    yield* handle("clipboard:write-claimed-presentation", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          run("write-claimed-clipboard-presentation", () =>
            writeClaimedClipboardPresentation(input),
          ),
        ),
      ),
    );
    yield* handle("clipboard:read-paste", (event) =>
      authorize(event).pipe(Effect.andThen(run("read-clipboard-paste", readClipboardPastePayload))),
    );
    yield* handle("composer:pick-files", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          run("pick-composer-files", async () => {
            const imagesOnly = input?.imagesOnly === true;
            const owner = windows.get(event.sender.id);
            const dialogOptions: OpenDialogOptions = {
              title:
                typeof input?.title === "string"
                  ? input.title
                  : imagesOnly
                    ? "Select photos"
                    : "Select files",
              properties: ["openFile", "multiSelections"],
              ...(imagesOnly
                ? {
                    filters: [{ name: "Images", extensions: [...COMPOSER_IMAGE_FILE_EXTENSIONS] }],
                  }
                : {}),
            };
            const result = owner
              ? await desktop.dialog.showOpenDialog(owner, dialogOptions)
              : await desktop.dialog.showOpenDialog(dialogOptions);
            if (result.canceled || result.filePaths.length === 0) return [];
            return prepareComposerPickedFiles(result.filePaths);
          }),
        ),
      ),
    );
  }),
);
