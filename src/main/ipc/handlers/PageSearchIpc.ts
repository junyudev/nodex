import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcApi } from "../../../shared/ipc-api";
import { MainConfig } from "../../app/MainConfig";
import { LibraryModule } from "../../library-application/LibraryModule";
import { getLogger } from "../../logging/logger";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export interface PageSearchIpcOptions {
  readonly authorizeSender?: (event: IpcMainInvokeEvent) => boolean;
}

export class PageSearchIpcError extends Schema.TaggedError<PageSearchIpcError>()(
  "PageSearchIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const approximateJsonPayloadBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

export const live = (
  options: PageSearchIpcOptions,
): Layer.Layer<never, never, ElectronIpc | LibraryModule | MainConfig | WindowRuntime> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const ipc = yield* ElectronIpc;
      const library = yield* LibraryModule;
      const windows = yield* WindowRuntime;
      const logger = getLogger({ subsystem: "ipc", component: "page-search" });
      const authorize = (event: IpcMainInvokeEvent) =>
        Effect.try({
          try: () => {
            if (options.authorizeSender) {
              if (!options.authorizeSender(event)) throw new Error("Unauthorized page search");
              return;
            }
            requireTrustedAppRendererSender(event, "Page search", config.rendererUrl);
            if (!windows.has(event.sender.id)) {
              throw new Error("Page search requires an active Nodex window");
            }
          },
          catch: (cause) => new PageSearchIpcError({ operation: "authorize-renderer", cause }),
        });
      const run = <A, E, R>(operation: string, task: Effect.Effect<A, E, R>) =>
        task.pipe(Effect.mapError((cause) => new PageSearchIpcError({ operation, cause })));
      yield* ipc.handleQuery(
        "pages:search-metadata",
        (
          event,
          projectFilterIds: IpcApi["pages:search-metadata"]["args"][0],
          pageIds: IpcApi["pages:search-metadata"]["args"][1],
        ) =>
          authorize(event).pipe(
            Effect.andThen(
              run(
                "read-page-search-metadata",
                library.pageSearchMetadata(projectFilterIds, pageIds),
              ),
            ),
            Effect.tap((snapshot) =>
              Effect.sync(() => {
                logger.info("Page search metadata payload served", {
                  projectCount: projectFilterIds?.length ?? 0,
                  resultCount: snapshot.documents.length,
                  approxPayloadBytes: approximateJsonPayloadBytes(snapshot),
                });
              }),
            ),
          ),
      );
    }),
  );
