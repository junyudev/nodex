import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { NativeSessionCatalog } from "../../agent-backend/NativeSessionCatalog";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../../agent-runtime/AgentRuntimeApplication";
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
const ImportPreviewInput = z
  .object({
    reference: z.string().trim().min(1).max(8192),
    backendKind: backend.optional(),
    instanceConfigId: identity.optional(),
  })
  .strict();
const ImportInput = z
  .object({
    backendKind: backend,
    instanceConfigId: identity.optional(),
    requestId: z.uuid(),
    acceptedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    nativeSessionId: z.uuid(),
    expectedHome: z.string().min(1).max(4096),
    projectId: identity.nullable(),
    cwd: z.string().trim().min(1).max(4096),
  })
  .strict()
  .refine(
    (input) =>
      input.backendKind === "claude"
        ? !!input.instanceConfigId
        : input.instanceConfigId === undefined,
    "The source profile must match the selected Agent.",
  );

export class NativeSessionCatalogIpcError extends Schema.TaggedError<NativeSessionCatalogIpcError>()(
  "NativeSessionCatalogIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* NativeSessionCatalog;
    const runtime = yield* AgentRuntimeApplication;
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
              // Electron's erased callback failure is immediately translated to this adapter error.
              handler(event, ...args).pipe(
                Effect.mapError(
                  (cause) => new NativeSessionCatalogIpcError({ operation: "request", cause }),
                ),
              ),
            ),
          ),
    );
    yield* handleQuery("native-sessions:list", (_, input) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try({
          try: () => ListInput.parse(input),
          catch: (cause) => new NativeSessionCatalogIpcError({ operation: "list.input", cause }),
        });
        const page = yield* catalog.list(parsed);
        const imported = yield* runtime.findNativeImports({
          backendKind: parsed.backendKind,
          sourceHome: page.nativeHome,
          nativeThreadIds: page.entries.map((entry) => entry.nativeSessionId),
        });
        return {
          ...page,
          entries: page.entries.map((entry) => ({
            ...entry,
            ...imported.find((copy) => copy.nativeSessionId === entry.nativeSessionId),
          })),
        };
      }),
    );
    yield* handleQuery("native-sessions:preview-import", (_, input) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try({
          try: () => ImportPreviewInput.parse(input),
          catch: (cause) =>
            new NativeSessionCatalogIpcError({ operation: "import.preview.input", cause }),
        });
        const preview = yield* catalog.previewImport(parsed);
        const matches = yield* Effect.forEach(preview.matches, (match) =>
          Effect.gen(function* () {
            const copies = yield* runtime.findNativeImports({
              backendKind: match.backendKind,
              sourceHome: match.nativeHome,
              nativeThreadIds: [match.nativeSessionId],
            });
            return { ...match, ...copies[0] };
          }),
        );
        return { matches };
      }),
    );
    yield* handlePlainCommand("native-sessions:import", (_, input) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try({
          try: () => ImportInput.parse(input),
          catch: (cause) => new NativeSessionCatalogIpcError({ operation: "import.input", cause }),
        });
        return yield* runtime.submitNativeImport(
          parsed,
          catalog.prepareImport(parsed).pipe(
            Effect.mapError((cause) =>
              cause.admissionRejected
                ? new AgentRuntimeApplicationError({
                    operation: "import",
                    message: cause.message,
                    admissionRejected: true,
                  })
                : cause,
            ),
          ),
        );
      }),
    );
  }),
);
