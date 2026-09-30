import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { NativeSessionCatalog } from "../../agent-backend/NativeSessionCatalog";
import { MainConfig } from "../../app/MainConfig";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

const identity = z.string().trim().min(1).max(512);
const backend = z.enum(["claude", "codex"]);
const ListInput = z
  .object({
    backendKind: backend,
    instanceConfigId: identity.optional(),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();
const AttachInput = z
  .object({
    backendKind: backend,
    instanceConfigId: identity.optional(),
    nativeSessionId: identity,
    expectedHome: z.string().min(1).max(4096),
    projectId: identity.nullable(),
  })
  .strict();

export class NativeSessionCatalogIpcError extends Schema.TaggedError<NativeSessionCatalogIpcError>()(
  "NativeSessionCatalogIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* NativeSessionCatalog;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Native conversations", config.rendererUrl);
          if (!windows.has(event.sender.id)) throw new Error("An active Nodex window is required.");
        },
        catch: (cause) => new NativeSessionCatalogIpcError({ operation: "authorize", cause }),
      });
    const { handlePlainCommand, handleQuery } = mapElectronIpcHandlers(
      ipc,
      (_channel, handler) =>
        (event, ...args) =>
          authorize(event).pipe(
            Effect.andThen(
              // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Electron's erased callback failure is immediately translated to this adapter error.
              handler(event, ...args).pipe(
                Effect.mapError(
                  (cause) => new NativeSessionCatalogIpcError({ operation: "request", cause }),
                ),
              ),
            ),
          ),
    );
    yield* handleQuery("native-sessions:list", (_, input) =>
      Effect.try({
        try: () => ListInput.parse(input),
        catch: (cause) => new NativeSessionCatalogIpcError({ operation: "list.input", cause }),
      }).pipe(Effect.flatMap(catalog.list)),
    );
    yield* handlePlainCommand("native-sessions:attach", (_, input) =>
      Effect.try({
        try: () => AttachInput.parse(input),
        catch: (cause) => new NativeSessionCatalogIpcError({ operation: "attach.input", cause }),
      }).pipe(Effect.flatMap(catalog.attach)),
    );
  }),
);
