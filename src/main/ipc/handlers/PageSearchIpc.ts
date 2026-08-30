import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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
      const pending = yield* Ref.make(HashMap.empty<string, Deferred.Deferred<void>>());
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
      const validateRequestId = (requestId: string) =>
        Effect.try({
          try: () => {
            if (!requestId || requestId.length > 128 || requestId.trim() !== requestId) {
              throw new Error("Page search request identity is invalid");
            }
          },
          catch: (cause) => new PageSearchIpcError({ operation: "validate-request", cause }),
        });

      yield* ipc.handleQuery(
        "pages:search",
        (
          event,
          requestId: IpcApi["pages:search"]["args"][0],
          input: IpcApi["pages:search"]["args"][1],
        ) =>
          Effect.gen(function* () {
            yield* authorize(event);
            yield* validateRequestId(requestId);
            const key = `${event.sender.id}:${requestId}`;
            const cancelled = yield* Deferred.make<void>();
            const registered = yield* Ref.modify(pending, (requests) =>
              HashMap.has(requests, key)
                ? [false, requests]
                : [true, HashMap.set(requests, key, cancelled)],
            );
            if (!registered) {
              return yield* new PageSearchIpcError({
                operation: "register-request",
                cause: new Error("Page search request identity is already active"),
              });
            }

            const startedAt = performance.now();
            const search = run("search-pages", library.searchPages(input)).pipe(
              Effect.map((snapshot) => ({ status: "completed" as const, snapshot })),
              Effect.tap((result) =>
                Effect.sync(() => {
                  logger.info("Page search payload served", {
                    projectCount: input.projectIds.length,
                    resultCount: result.snapshot.results.length,
                    approxPayloadBytes: approximateJsonPayloadBytes(result.snapshot),
                    durationMs: Math.round(performance.now() - startedAt),
                  });
                }),
              ),
            );
            return yield* Effect.raceFirst(
              search,
              Deferred.await(cancelled).pipe(Effect.as({ status: "cancelled" as const })),
            ).pipe(
              Effect.ensuring(
                Ref.update(pending, (requests) =>
                  Option.match(HashMap.get(requests, key), {
                    onNone: () => requests,
                    onSome: (current) =>
                      current === cancelled ? HashMap.remove(requests, key) : requests,
                  }),
                ),
              ),
            );
          }),
      );

      yield* ipc.handleControl(
        "pages:search:cancel",
        (event, requestId: IpcApi["pages:search:cancel"]["args"][0]) =>
          authorize(event).pipe(
            Effect.andThen(Ref.get(pending)),
            Effect.flatMap((requests) =>
              Option.match(HashMap.get(requests, `${event.sender.id}:${requestId}`), {
                onNone: () => Effect.succeed(false),
                onSome: (cancelled) => Deferred.succeed(cancelled, undefined).pipe(Effect.as(true)),
              }),
            ),
          ),
      );

      yield* ipc.handleQuery(
        "pages:search-metadata",
        (
          event,
          projectIds: IpcApi["pages:search-metadata"]["args"][0],
          pageIds: IpcApi["pages:search-metadata"]["args"][1],
        ) =>
          authorize(event).pipe(
            Effect.andThen(
              run("read-page-search-metadata", library.pageSearchMetadata(projectIds, pageIds)),
            ),
            Effect.tap((snapshot) =>
              Effect.sync(() => {
                logger.info("Page search metadata payload served", {
                  projectCount: projectIds.length,
                  resultCount: snapshot.documents.length,
                  approxPayloadBytes: approximateJsonPayloadBytes(snapshot),
                });
              }),
            ),
          ),
      );
      yield* ipc.handleQuery(
        "pages:search-facets",
        (event, projectIds: IpcApi["pages:search-facets"]["args"][0]) =>
          authorize(event).pipe(
            Effect.andThen(run("read-page-search-facets", library.pageSearchFacets(projectIds))),
          ),
      );
    }),
  );
