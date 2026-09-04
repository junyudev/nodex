import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { parseAssetSource } from "../../../shared/assets";
import { MainConfig } from "../../app/MainConfig";
import { writeImageToClipboard } from "../../clipboard-image-writer";
import {
  COMPOSER_IMAGE_FILE_EXTENSIONS,
  prepareComposerPickedFiles,
} from "../../composer-picked-files";
import { ProfileAssets } from "../../local-store/ProfileAssets";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronClipboard } from "../../platform/electron/ElectronClipboard";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ManagedMediaIpcError extends Schema.TaggedError<ManagedMediaIpcError>()(
  "ManagedMediaIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const live: Layer.Layer<
  never,
  never,
  ElectronDesktop | ElectronClipboard | ElectronIpc | MainConfig | ProfileAssets | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const assets = yield* ProfileAssets;
    const clipboard = yield* ElectronClipboard;
    const desktop = yield* ElectronDesktop;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const { handleControl, handlePlainCommand, handleQuery } = ipc;
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

    yield* handleQuery("asset:resolve-path", (event, source) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const parsed = typeof source === "string" ? parseAssetSource(source) : null;
            if (!parsed) return null;
            try {
              return assets.resolveAssetPath(parsed.fileName);
            } catch {
              return null;
            }
          }),
        ),
      ),
    );
    yield* handlePlainCommand("asset:image:save", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("save-image", () => assets.saveUploadedImage(input))),
      ),
    );
    yield* handlePlainCommand("asset:canvas-image:materialize", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("materialize-canvas-image", () => assets.materializeCanvasImage(input))),
      ),
    );
    yield* handleQuery("asset:image:read", (event, source) =>
      authorize(event).pipe(
        Effect.andThen(run("read-image", () => assets.readManagedAssetImage(source))),
      ),
    );
    yield* handlePlainCommand("asset:resource:save", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("save-resource", () => assets.saveUploadedResource(input))),
      ),
    );
    yield* handlePlainCommand("asset:resource:materialize", (event, path) =>
      authorize(event).pipe(
        Effect.andThen(
          run("materialize-resource", () => {
            if (typeof path !== "string") throw new Error("Local resource path is required");
            return assets.materializeLocalResource(path);
          }),
        ),
      ),
    );
    yield* handleQuery("asset:preview:read", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(run("read-preview", () => assets.readManagedAssetPreview(input))),
      ),
    );
    yield* handlePlainCommand("clipboard:write-image", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          typeof input?.source === "string"
            ? writeImageToClipboard(input.source, clipboard, {
                resolveAssetPath: assets.resolveAssetPath,
              })
            : Effect.succeed({ ok: false, message: "Could not copy image." } as const),
        ),
      ),
    );
    yield* handleControl("clipboard:write-claimed-presentation", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          clipboard.replaceClaimedPresentation({
            writeClaim: input?.writeClaim,
            text: input?.text,
          }),
        ),
      ),
    );
    yield* handleQuery("clipboard:read-paste", (event) =>
      authorize(event).pipe(Effect.andThen(clipboard.readPaste)),
    );
    yield* handlePlainCommand("composer:pick-files", (event, input) =>
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
