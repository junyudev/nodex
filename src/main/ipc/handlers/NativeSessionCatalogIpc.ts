import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { NativeSessionCatalogInput } from "../../../shared/native-session-catalog";
import { NativeSessionCatalog } from "../../agent-backend/NativeSessionCatalog";
import { discoverProjects } from "../../agent-backend/project-discovery";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../../agent-runtime/AgentRuntimeApplication";
import { MainConfig } from "../../app/MainConfig";
import { probeGitRepository } from "../../platform/node/GitRepositoryProbe";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

/** The most identities one Runtime lookup accepts. */
const NATIVE_IMPORT_LOOKUP_SIZE = 100;
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
    const settings = yield* ApplicationSettings;
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
    const readCatalogPage = (input: NativeSessionCatalogInput) =>
      Effect.gen(function* () {
        const page = yield* catalog.list(input);
        const lookups = yield* Effect.forEach(
          Arr.chunksOf(
            page.entries.map((entry) => entry.nativeSessionId),
            NATIVE_IMPORT_LOOKUP_SIZE,
          ),
          (nativeThreadIds) =>
            runtime.findNativeImports({
              backendKind: input.backendKind,
              sourceHome: page.nativeHome,
              nativeThreadIds,
            }),
        );
        const imported = new Map(lookups.flat().map((copy) => [copy.nativeSessionId, copy]));
        return {
          ...page,
          entries: page.entries.map((entry) => ({
            ...entry,
            ...imported.get(entry.nativeSessionId),
          })),
        };
      });
    yield* handleQuery("native-sessions:list", (_, input) =>
      Effect.try({
        try: () => ListInput.parse(input),
        catch: (cause) => new NativeSessionCatalogIpcError({ operation: "list.input", cause }),
      }).pipe(Effect.flatMap(readCatalogPage)),
    );
    yield* handleQuery("native-sessions:discover-projects", () =>
      Effect.gen(function* () {
        const { claudeAgents } = yield* settings.snapshot();
        const now = yield* Clock.currentTimeMillis;
        return yield* discoverProjects({
          sources: [
            { backendKind: "codex" as const },
            ...claudeAgents.instances
              .filter((instance) => instance.enabled)
              .map((instance) => ({
                backendKind: "claude" as const,
                instanceConfigId: instance.id,
              })),
          ],
          nodexHome: config.nodexHome,
          now,
          readPage: (source, cursor) =>
            readCatalogPage({ ...source, ...(cursor ? { cursor } : {}) }),
          probe: (cwd) => Effect.promise(() => probeGitRepository(cwd)),
        });
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
