import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import {
  BrowserLinkSaveInputSchema,
  NativeResourceReadInputSchema,
} from "../../../shared/native-resource";
import { MainConfig } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronNet } from "../../platform/electron/ElectronNet";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { startNativeLinkDownload } from "../../native-link-download";

export class NativeResourceIpcError extends Schema.TaggedError<NativeResourceIpcError>()(
  "NativeResourceIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const desktop = yield* ElectronDesktop;
    const ipc = yield* ElectronIpc;
    const net = yield* ElectronNet;
    const windows = yield* WindowRuntime;
    const destruction = yield* WebContentsDestructionSubscriptions;
    const attempt = <A>(operation: string, task: () => A) =>
      Effect.try({
        try: task,
        catch: (cause) => new NativeResourceIpcError({ operation, cause }),
      });
    const authorize = (event: IpcMainInvokeEvent) =>
      attempt("authorize-renderer", () => {
        requireTrustedAppRendererSender(event, "Native resource", config.rendererUrl);
        if (!windows.has(event.sender.id))
          throw new Error("Native resource access requires an active Nodex window");
      });
    const read = (url: string) =>
      Effect.gen(function* () {
        const response = yield* net.fetch(url, {});
        if (!response.ok)
          return yield* Effect.fail(
            new NativeResourceIpcError({
              operation: "read-resource",
              cause: new Error(`Resource request failed with status ${response.status}`),
            }),
          );
        const contentsBase64 = yield* net.readBase64(response);
        return {
          contentsBase64,
          mimeType:
            response.headers.get("content-type")?.split(";")[0]?.trim() ||
            "application/octet-stream",
        };
      });
    yield* ipc.handleQuery("native-resource:read", (event, input: unknown) =>
      authorize(event).pipe(
        Effect.andThen(attempt("parse-resource", () => NativeResourceReadInputSchema.parse(input))),
        Effect.flatMap(({ url }) => read(url)),
      ),
    );
    yield* ipc.handlePlainCommand("browser-link:save", (event, input: unknown) =>
      authorize(event).pipe(
        Effect.andThen(attempt("parse-link", () => BrowserLinkSaveInputSchema.parse(input))),
        Effect.flatMap(({ url }) =>
          startNativeLinkDownload({
            url,
            source: event.sender,
            destruction,
            isCurrent: () => windows.has(event.sender.id),
            createView: desktop.createDownloadView,
          }),
        ),
      ),
    );
  }),
).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
