import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type { CoreResult } from "../../../shared/core-result";
import type { IpcApi } from "../../../shared/ipc-api";
import type { IpcQueryChannel } from "../../../shared/ipc-endpoint-policy";
import type { DatabasePage } from "../../../shared/types";
import { MainConfig } from "../../app/MainConfig";
import { CoreModuleResponseError } from "../../core-client/core-client";
import {
  DatabaseModule,
  type DatabaseModuleError,
} from "../../database-application/DatabaseModule";
import type {
  CoreMinimumCommitTimeout,
  CoreStoreEpochMismatch,
} from "../../core-runtime/CoreMinimumCommit";
import {
  approximateJsonPayloadBytes,
  getDevRuntimeMetricDurationMs,
  getDevRuntimeMetricStart,
  logDevRuntimeMetric,
} from "../../dev-runtime-metrics";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class DatabaseProjectionIpcError extends Schema.TaggedError<DatabaseProjectionIpcError>()(
  "DatabaseProjectionIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type CoreValue<Channel extends keyof IpcApi> =
  IpcApi[Channel]["result"] extends CoreResult<infer Value> ? Value : never;
type DatabaseProjectionReadError =
  | DatabaseModuleError
  | CoreMinimumCommitTimeout
  | CoreStoreEpochMismatch;

const findCoreModuleResponse = (cause: unknown): CoreModuleResponseError | null => {
  let current = cause;
  const visited = new Set<object>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof CoreModuleResponseError) return current;
    if (typeof current !== "object" || current === null || visited.has(current)) return null;
    visited.add(current);
    if (!("cause" in current)) return null;
    current = current.cause;
  }
  return null;
};

const coreFailure = (error: CoreModuleResponseError): CoreResult<never> => ({
  ok: false,
  error: {
    code: error.coreError.code,
    message: error.coreError.message,
    retryable: error.coreError.retryable,
    recovery: error.coreError.recovery,
  },
});

export const live: Layer.Layer<
  never,
  never,
  DatabaseModule | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const database = yield* DatabaseModule;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const { handleQuery } = ipc;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Database projection", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Database projection requires an active Nodex window");
          }
        },
        catch: (cause) =>
          new DatabaseProjectionIpcError({ operation: "authorize-renderer", cause }),
      });
    const core = <Channel extends IpcQueryChannel>(
      channel: Channel,
      read: (
        event: IpcMainInvokeEvent,
        ...args: IpcApi[Channel]["args"]
      ) => Effect.Effect<CoreValue<Channel>, DatabaseProjectionReadError>,
    ) =>
      handleQuery(channel, (event, ...args) =>
        authorize(event).pipe(
          Effect.andThen(
            read(event, ...args).pipe(
              Effect.map((value) => ({ ok: true as const, value })),
              Effect.catch((error) => {
                const response = findCoreModuleResponse(error);
                return response ? Effect.succeed(coreFailure(response)) : Effect.fail(error);
              }),
            ) as Effect.Effect<IpcApi[Channel]["result"], DatabaseProjectionReadError>,
          ),
        ),
      );
    const observeWindow = <
      A extends { readonly rows: readonly unknown[]; readonly nextCursor: unknown },
    >(
      metric: string,
      startedAt: number,
      window: A,
      projectId?: string,
    ): A => {
      logDevRuntimeMetric(metric, {
        ...(projectId ? { projectId } : {}),
        rowCount: window.rows.length,
        hasContinuation: window.nextCursor !== null,
        approxPayloadBytes: approximateJsonPayloadBytes(window),
        durationMs: getDevRuntimeMetricDurationMs(startedAt),
      });
      return window;
    };

    yield* core("database:view-window:get", (_, projectId, input) => {
      const startedAt = getDevRuntimeMetricStart();
      return database
        .viewWindow({ kind: "project", projectId }, input)
        .pipe(
          Effect.map((window) =>
            observeWindow("ipc.database_view_window_get", startedAt, window, projectId),
          ),
        );
    });
    yield* core("database:list-window:get", (_, projectId, input) => {
      const startedAt = getDevRuntimeMetricStart();
      return database
        .listWindow({ kind: "project", projectId }, input)
        .pipe(
          Effect.map((window) =>
            observeWindow("ipc.database_list_window_get", startedAt, window, projectId),
          ),
        );
    });
    yield* core("database:view-groups:get", (_, projectId, input) =>
      database.viewGroups({ kind: "project", projectId }, input),
    );
    yield* core("library-database:view-window:get", (_, input) => {
      const startedAt = getDevRuntimeMetricStart();
      return database
        .viewWindow({ kind: "library" }, input)
        .pipe(
          Effect.map((window) =>
            observeWindow("ipc.library_database_view_window_get", startedAt, window),
          ),
        );
    });
    yield* core("library-database:list-window:get", (_, input) => {
      const startedAt = getDevRuntimeMetricStart();
      return database
        .listWindow({ kind: "library" }, input)
        .pipe(
          Effect.map((window) =>
            observeWindow("ipc.library_database_list_window_get", startedAt, window),
          ),
        );
    });
    yield* core("library-database:view-groups:get", (_, input) =>
      database.viewGroups({ kind: "library" }, input),
    );
    yield* handleQuery(
      "database-row:get",
      (event, projectId, pageId, status, minimumCommitCursor) =>
        authorize(event).pipe(
          Effect.andThen(
            database.readRowPage({
              projectId,
              pageId,
              status: status as DatabasePage["status"] | undefined,
              minimumCommitCursor,
            }),
          ),
        ),
    );
  }),
);
