import {
  DictationDiagnosticsSchema,
  type DictationTextResult,
} from "../../../shared/dictation-diagnostics";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { writeFile } from "node:fs/promises";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { createKeyboardLayoutSnapshot } from "../../../shared/command-keybindings";
import type { GlobalDictationContextMenuAction } from "../../../shared/global-dictation";
import {
  DictationRecordingIdSchema,
  DictationRecordingMimeTypeSchema,
  DictationRecordingSurfaceSchema,
} from "../../../shared/dictation-history";
import type { DictationSurface } from "../../../shared/dictation";
import { MainConfig } from "../../app/MainConfig";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { CodexMedia } from "../../codex-application/CodexMedia";
import { validateDictationTranscriptionInput } from "../../dictation-transcription-input";
import { parseDictationSettingsPatch } from "../../dictation/dictation-settings-store";
import { registerDictationStreamingElectronAdapter } from "../../dictation/dictation-streaming-electron-adapter";
import { DictationRuntime } from "../../host-runtime/DictationRuntime";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class DictationIpcError extends Schema.TaggedError<DictationIpcError>()(
  "DictationIpcError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const SessionId = z.string().uuid();
const DictationError = z
  .object({
    kind: z.enum([
      "microphone-permission-denied",
      "microphone-restricted",
      "microphone-not-found",
      "microphone-busy",
      "constraint-unsatisfied",
      "capture-unsupported",
      "capture-interrupted",
      "transcription-network",
      "transcription-rate-limited",
      "transcription-auth",
      "transcription-service",
      "history-unavailable",
      "accessibility-denied",
      "paste-failed",
      "unknown",
    ]),
    retryable: z.boolean(),
    operation: z.enum(["permission", "capture", "stream", "transcribe", "history", "paste"]),
    status: z.number().int().safe().optional(),
    nativeName: z.string().max(80).optional(),
  })
  .strict();
const GlobalRendererEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z
    .object({
      type: z.literal("accepted"),
      sessionId: SessionId,
      requestId: SessionId,
      targetId: z.string().min(1).max(160),
    })
    .strict(),
  z
    .object({
      type: z.literal("declined"),
      sessionId: SessionId,
      requestId: SessionId,
      reason: z.enum(["busy", "deadline-expired", "focus-not-owned", "hidden", "unavailable"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("state"),
      sessionId: SessionId,
      state: z.enum(["listening", "transcribing"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("completed"),
      sessionId: SessionId,
      transcript: z.string().max(1_000_000),
    })
    .strict(),
  z.object({ type: z.literal("cancelled"), sessionId: SessionId }).strict(),
  z.object({ type: z.literal("failed"), sessionId: SessionId, error: DictationError }).strict(),
  z.object({ type: z.literal("dismiss"), sessionId: SessionId }).strict(),
  z.object({ type: z.literal("close"), sessionId: SessionId.nullable() }).strict(),
  z.object({ type: z.literal("interactive"), enabled: z.boolean() }).strict(),
]);
const MicrophoneLease = z
  .object({ sessionId: SessionId, surface: z.enum(["composer", "global"]) })
  .strict();
const RecordingCreate = z
  .object({
    id: DictationRecordingIdSchema,
    mimeType: DictationRecordingMimeTypeSchema,
    surface: DictationRecordingSurfaceSchema,
  })
  .strict();
const RecordingAppend = z
  .object({ id: DictationRecordingIdSchema, chunk: z.instanceof(Uint8Array) })
  .strict();
const RecordingFinalize = z
  .object({
    id: DictationRecordingIdSchema,
    durationMs: z.number().int().nonnegative().safe(),
    status: z.enum(["completed", "cancelled"]),
  })
  .strict();
const RecordingTranscript = z
  .object({ id: DictationRecordingIdSchema, transcript: z.string().nullable() })
  .strict();
const TranscriptCleanup = z
  .object({
    requestId: SessionId,
    transcript: z.string().max(1_000_000),
    surroundingText: z.string().max(100_000).nullable(),
  })
  .strict();
const KeyboardLayout = z
  .object({
    generation: z.number().int().nonnegative().safe(),
    entries: z.record(z.string(), z.string().max(32)),
  })
  .strict();

const validate = <A>(operation: string, parse: () => A): Effect.Effect<A, DictationIpcError> =>
  Effect.try({
    try: parse,
    catch: (cause) => new DictationIpcError({ operation, cause }),
  });

const saveExtension = (mimeType: string): string =>
  mimeType.split(/[/;]/u)[1]?.replace(/[^a-z0-9]/giu, "") || "audio";

export const live = (
  options: {
    readonly authorize?: (
      event: IpcMainEvent | IpcMainInvokeEvent,
      capability: string,
      developmentOrigin: string | null,
    ) => void;
    readonly registerStreaming?: typeof registerDictationStreamingElectronAdapter;
  } = {},
): Layer.Layer<
  never,
  never,
  | CodexMedia
  | DictationRuntime
  | ElectronDesktop
  | ElectronIpc
  | MainConfig
  | ScopedCallbackRuntime
  | WindowRuntime
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const callbacks = yield* ScopedCallbackRuntime;
      const config = yield* MainConfig;
      const desktop = yield* ElectronDesktop;
      const dictation = yield* DictationRuntime;
      const ipc = yield* ElectronIpc;
      const media = yield* CodexMedia;
      const windows = yield* WindowRuntime;
      const transcriptionFibers = yield* FiberMap.make<string, DictationTextResult>();
      const transcriptionOwners = new Map<string, number>();
      const authorizeRenderer = options.authorize ?? requireTrustedAppRendererSender;
      const registerStreaming =
        options.registerStreaming ?? registerDictationStreamingElectronAdapter;

      const trusted = (event: IpcMainInvokeEvent, capability: string) =>
        validate("authorize-renderer", () =>
          authorizeRenderer(event, capability, config.rendererUrl),
        );
      const authorized = <A, E>(
        event: IpcMainInvokeEvent,
        capability: string,
        effect: Effect.Effect<A, E>,
      ) => trusted(event, capability).pipe(Effect.andThen(effect));
      const runOwnedTranscriptTask = Effect.fn("DictationIpc.runOwnedTranscriptTask")(function* <E>(
        event: IpcMainInvokeEvent,
        requestId: string,
        task: Effect.Effect<DictationTextResult, E>,
      ) {
        const reserved = yield* Effect.sync(() => {
          if (transcriptionOwners.has(requestId)) return false;
          transcriptionOwners.set(requestId, event.sender.id);
          return true;
        });
        if (!reserved) {
          return yield* new DictationIpcError({
            operation: "reserve-transcription",
            cause: new Error("Dictation transcript request already exists"),
          });
        }
        const fiber = yield* FiberMap.run(transcriptionFibers, requestId, task, {
          onlyIfMissing: true,
          startImmediately: true,
        });
        return yield* Fiber.join(fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (transcriptionOwners.get(requestId) === event.sender.id) {
                transcriptionOwners.delete(requestId);
              }
            }),
          ),
        );
      });

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerStreaming({
            ipcMain,
            readConnectInfo: (signal) =>
              callbacks.runPromise(media.prepareStreamingConnectInfo, { signal }),
            requireTrustedSender: (event) =>
              authorizeRenderer(event, "Dictation streaming", config.rendererUrl),
          }),
        ),
        (release) => Effect.sync(release),
      );

      yield* ipc.handleQuery("codex:dictation:state:read", (event) =>
        authorized(event, "Dictation capability state", media.dictationState),
      );
      yield* ipc.handleQuery("codex:dictation:microphone-access:read", (event) =>
        authorized(event, "Microphone permission state", dictation.readMicrophoneAccess),
      );
      yield* ipc.handlePlainCommand("codex:dictation:microphone-access:request", (event) =>
        authorized(event, "Microphone permission request", dictation.requestMicrophoneAccess),
      );
      yield* ipc.handleControl(
        "codex:dictation:microphone-lease:acquire",
        (event, input: unknown) =>
          trusted(event, "Dictation microphone lease").pipe(
            Effect.andThen(validate("parse-microphone-lease", () => MicrophoneLease.parse(input))),
            Effect.flatMap((lease) =>
              dictation.acquireMicrophone({
                webContentsId: event.sender.id,
                sessionId: lease.sessionId,
                surface: lease.surface as DictationSurface,
              }),
            ),
          ),
      );
      yield* ipc.handleControl(
        "codex:dictation:microphone-lease:release",
        (event, input: unknown) =>
          trusted(event, "Dictation microphone lease release").pipe(
            Effect.andThen(
              validate("parse-microphone-lease-release", () => SessionId.parse(input)),
            ),
            Effect.flatMap((sessionId) => dictation.releaseMicrophone(event.sender.id, sessionId)),
          ),
      );
      yield* ipc.handlePlainCommand("codex:dictation:microphone-access:open-settings", (event) =>
        authorized(
          event,
          "Microphone privacy settings",
          Effect.tryPromise({
            try: () =>
              desktop.shell.openExternal(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
              ),
            catch: (cause) =>
              new DictationIpcError({ operation: "open-microphone-settings", cause }),
          }),
        ),
      );
      yield* ipc.handleQuery("codex:dictation:microphone-route-hint:read", (event) =>
        authorized(event, "Dictation microphone route", dictation.readMicrophoneRouteHint),
      );
      yield* ipc.handleQuery("codex:dictation:global-permissions:read", (event) =>
        authorized(event, "Global dictation permissions", dictation.readGlobalPermissions),
      );
      yield* ipc.handlePlainCommand(
        "codex:dictation:global-permissions:request-input-monitoring",
        (event) =>
          authorized(
            event,
            "Global dictation Input Monitoring request",
            dictation.requestInputMonitoring,
          ),
      );
      yield* ipc.handlePlainCommand(
        "codex:dictation:global-permissions:request-accessibility",
        (event) =>
          authorized(
            event,
            "Global dictation Accessibility request",
            dictation.requestAccessibility,
          ),
      );
      yield* ipc.handlePlainCommand(
        "codex:dictation:global-permissions:open-input-monitoring-settings",
        (event) =>
          authorized(
            event,
            "Input Monitoring settings",
            Effect.tryPromise({
              try: () =>
                desktop.shell.openExternal(
                  "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
                ),
              catch: (cause) =>
                new DictationIpcError({ operation: "open-input-monitoring-settings", cause }),
            }),
          ),
      );
      yield* ipc.handlePlainCommand(
        "codex:dictation:global-permissions:open-accessibility-settings",
        (event) =>
          authorized(
            event,
            "Accessibility settings",
            Effect.tryPromise({
              try: () =>
                desktop.shell.openExternal(
                  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                ),
              catch: (cause) =>
                new DictationIpcError({ operation: "open-accessibility-settings", cause }),
            }),
          ),
      );
      yield* ipc.handleQuery("codex:dictation:settings:read", (event) =>
        authorized(event, "Dictation settings", dictation.readSettings),
      );
      yield* ipc.handlePlainCommand("codex:dictation:settings:update", (event, input: unknown) =>
        trusted(event, "Dictation settings update").pipe(
          Effect.andThen(
            validate("parse-dictation-settings", () => parseDictationSettingsPatch(input)),
          ),
          Effect.flatMap(dictation.updateSettings),
        ),
      );
      yield* ipc.handlePlainCommand(
        "codex:dictation:settings:consume-global-shortcut-nudge",
        (event) =>
          authorized(
            event,
            "Global dictation shortcut nudge",
            dictation.consumeGlobalShortcutNudge,
          ),
      );
      yield* ipc.handlePlainCommand("codex:dictation:history:create", (event, input: unknown) =>
        trusted(event, "Dictation recording history").pipe(
          Effect.andThen(validate("parse-recording-create", () => RecordingCreate.parse(input))),
          Effect.flatMap(dictation.createRecording),
        ),
      );
      yield* ipc.handleControl("codex:dictation:history:append", (event, input: unknown) =>
        trusted(event, "Dictation recording history").pipe(
          Effect.andThen(validate("parse-recording-append", () => RecordingAppend.parse(input))),
          Effect.flatMap(dictation.appendRecording),
        ),
      );
      yield* ipc.handleControl("codex:dictation:history:finalize", (event, input: unknown) =>
        trusted(event, "Dictation recording history").pipe(
          Effect.andThen(
            validate("parse-recording-finalize", () => RecordingFinalize.parse(input)),
          ),
          Effect.flatMap(dictation.finalizeRecording),
        ),
      );
      yield* ipc.handleControl("codex:dictation:history:set-diagnostics", (event, input: unknown) =>
        trusted(event, "Dictation performance details").pipe(
          Effect.andThen(
            validate("parse-recording-diagnostics", () =>
              z
                .object({ id: DictationRecordingIdSchema, diagnostics: DictationDiagnosticsSchema })
                .strict()
                .parse(input),
            ),
          ),
          Effect.flatMap(dictation.setRecordingDiagnostics),
        ),
      );
      yield* ipc.handlePlainCommand(
        "codex:dictation:history:set-transcript",
        (event, input: unknown) =>
          trusted(event, "Dictation recording history").pipe(
            Effect.andThen(
              validate("parse-recording-transcript", () => RecordingTranscript.parse(input)),
            ),
            Effect.flatMap(dictation.setRecordingTranscript),
          ),
      );
      yield* ipc.handleQuery("codex:dictation:history:list", (event) =>
        authorized(event, "Dictation recording history", dictation.listRecordings),
      );
      yield* ipc.handleQuery("codex:dictation:history:read-audio", (event, input: unknown) =>
        trusted(event, "Dictation recording history").pipe(
          Effect.andThen(
            validate("parse-recording-id", () => DictationRecordingIdSchema.parse(input)),
          ),
          Effect.flatMap(dictation.readRecordingAudio),
        ),
      );
      yield* ipc.handlePlainCommand("codex:dictation:history:download", (event, input: unknown) =>
        trusted(event, "Dictation recording download").pipe(
          Effect.andThen(
            validate("parse-recording-id", () => DictationRecordingIdSchema.parse(input)),
          ),
          Effect.flatMap((id) => dictation.readRecordingAudio(id)),
          Effect.flatMap((audio) => {
            const owner = windows.get(event.sender.id);
            if (!owner) {
              return Effect.fail(
                new DictationIpcError({
                  operation: "resolve-download-owner",
                  cause: new Error("Dictation recording download requires an owned window"),
                }),
              );
            }
            return Effect.tryPromise({
              try: () =>
                desktop.dialog.showSaveDialog(owner, {
                  defaultPath: `dictation-${new Date(audio.recording.createdAtMs).toISOString().replaceAll(":", "-")}.${saveExtension(audio.recording.mimeType)}`,
                  title: "Save dictation recording",
                }),
              catch: (cause) => new DictationIpcError({ operation: "choose-download-path", cause }),
            }).pipe(
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<{ readonly status: "cancelled" | "saved" }, DictationIpcError> => {
                  if (result.canceled || !result.filePath) {
                    return Effect.succeed({ status: "cancelled" as const });
                  }
                  return Effect.tryPromise({
                    try: () => writeFile(result.filePath, audio.bytes, { mode: 0o600 }),
                    catch: (cause) =>
                      new DictationIpcError({ operation: "write-dictation-download", cause }),
                  }).pipe(Effect.as({ status: "saved" as const }));
                },
              ),
            );
          }),
        ),
      );
      yield* ipc.handlePlainCommand("codex:dictation:history:delete", (event, input: unknown) =>
        trusted(event, "Dictation recording deletion").pipe(
          Effect.andThen(
            validate("parse-recording-id", () => DictationRecordingIdSchema.parse(input)),
          ),
          Effect.flatMap(dictation.deleteRecording),
        ),
      );
      yield* ipc.handleQuery("global-dictation-capture-fn-hotkey", (event) =>
        authorized(event, "Global dictation shortcut", dictation.captureFnHotkey),
      );
      yield* ipc.handleControl("global-dictation:event", (event, input: unknown) =>
        trusted(event, "Global dictation").pipe(
          Effect.andThen(
            validate("parse-global-dictation-event", () => GlobalRendererEvent.parse(input)),
          ),
          Effect.flatMap((globalEvent) =>
            dictation.handleRendererEvent(event.sender.id, globalEvent),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("global-dictation:context-menu", (event) =>
        trusted(event, "Global dictation context menu").pipe(
          Effect.andThen(
            validate("authorize-global-dictation-context-menu", () => {
              if (!dictation.ownsGlobalRenderer(event.sender.id)) {
                throw new Error("Context menu sender does not own the global dictation window");
              }
            }),
          ),
          Effect.andThen(
            Effect.callback<GlobalDictationContextMenuAction, DictationIpcError>((resume) => {
              const window = windows.get(event.sender.id);
              if (!window || window.isDestroyed()) {
                resume(Effect.succeed(null));
                return;
              }
              let selected: GlobalDictationContextMenuAction = null;
              try {
                const menu = desktop.menu.buildFromTemplate([
                  {
                    id: "close-window",
                    label: "Close window",
                    click: () => {
                      selected = "close-window";
                    },
                  },
                ]);
                menu.popup({ window, callback: () => resume(Effect.succeed(selected)) });
                return Effect.sync(() => menu.closePopup(window));
              } catch (cause) {
                resume(
                  Effect.fail(
                    new DictationIpcError({
                      operation: "show-global-dictation-context-menu",
                      cause,
                    }),
                  ),
                );
              }
            }),
          ),
        ),
      );
      yield* ipc.handleControl("global-dictation:keyboard-layout:update", (event, input: unknown) =>
        trusted(event, "Global dictation keyboard layout").pipe(
          Effect.andThen(
            validate("parse-global-dictation-keyboard-layout", () => {
              const parsed = KeyboardLayout.parse(input);
              return createKeyboardLayoutSnapshot(parsed.generation, parsed.entries);
            }),
          ),
          Effect.flatMap(dictation.updateKeyboardLayout),
        ),
      );
      yield* ipc.handlePlainCommand("codex:dictation:transcribe", (event, input: unknown) =>
        trusted(event, "Dictation transcription").pipe(
          Effect.andThen(
            validate("parse-dictation-transcription", () =>
              validateDictationTranscriptionInput(input),
            ),
          ),
          Effect.flatMap((request) =>
            runOwnedTranscriptTask(
              event,
              request.requestId,
              media.transcribe({
                requestId: request.requestId,
                contentType: request.contentType,
                base64Payload: request.base64Payload,
              }),
            ),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("codex:dictation:cleanup", (event, input: unknown) =>
        trusted(event, "Dictation transcript cleanup").pipe(
          Effect.andThen(validate("parse-dictation-cleanup", () => TranscriptCleanup.parse(input))),
          Effect.flatMap((request) =>
            runOwnedTranscriptTask(
              event,
              request.requestId,
              media.cleanupTranscript({
                requestId: request.requestId,
                transcript: request.transcript,
                surroundingText: request.surroundingText,
              }),
            ),
          ),
        ),
      );
      yield* ipc.handleControl("codex:dictation:transcribe:cancel", (event, input: unknown) =>
        trusted(event, "Dictation transcription cancellation").pipe(
          Effect.andThen(validate("parse-transcription-id", () => SessionId.parse(input))),
          Effect.flatMap((requestId) => {
            if (transcriptionOwners.get(requestId) !== event.sender.id)
              return Effect.succeed(false);
            return FiberMap.has(transcriptionFibers, requestId).pipe(
              Effect.flatMap((active) =>
                active
                  ? FiberMap.remove(transcriptionFibers, requestId).pipe(Effect.as(true))
                  : Effect.succeed(false),
              ),
            );
          }),
        ),
      );
    }),
  );
