import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type {
  CommandKeybindingRejection,
  CommandKeymapState,
  KeyboardLayoutSnapshot,
} from "../../shared/command-keybindings";
import type {
  DictationSettings,
  DictationSettingsPatch,
  DictationSurface,
  GlobalDictationPermissionSnapshot,
  MicrophoneAccessResult,
  MicrophoneAccessStatus,
} from "../../shared/dictation";
import type {
  DictationRecordingAppendInput,
  DictationRecordingAudio,
  DictationRecordingCreateInput,
  DictationRecordingFinalizeInput,
  DictationRecordingMetadata,
  DictationRecordingSetTranscriptInput,
  DictationRecordingSetDiagnosticsInput,
} from "../../shared/dictation-history";
import type { GlobalDictationRendererEvent } from "../../shared/global-dictation";
import { APP_RENDERER_URL } from "../../shared/app-renderer-policy";
import { MainConfig } from "../app/MainConfig";
import { ClipboardSafePasteService } from "../dictation/clipboard-safe-paste-service";
import { DictationMicrophoneLease } from "../dictation/dictation-microphone-lease";
import { FileDictationRecordingStore } from "../dictation/dictation-recording-store";
import { DictationSettingsStore } from "../dictation/dictation-settings-store";
import { GlobalDictationManager } from "../dictation/global-dictation-manager";
import { GlobalDictationWindowController } from "../dictation/global-dictation-window-controller";
import {
  MacDictationNativeHelperClient,
  resolveMacDictationHelperExecutable,
} from "../dictation/mac-dictation-native-helper-client";
import { createSystemMicrophonePermissionService } from "../dictation/system-microphone-permission-service";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ElectronPrivacy } from "../platform/electron/ElectronPrivacy";
import { RendererClientRuntime } from "./RendererClientRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

export class DictationRuntimeError extends Schema.TaggedError<DictationRuntimeError>()(
  "DictationRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class DictationRuntime extends Context.Service<
  DictationRuntime,
  {
    readonly changes: Stream.Stream<void>;
    readonly globalAvailable: () => boolean;
    readonly microphoneOwner: () => "none" | "dictation" | "realtime-voice";
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void, DictationRuntimeError>;
    readonly syncCommandKeymap: (
      state: CommandKeymapState,
    ) => Effect.Effect<CommandKeybindingRejection | null, DictationRuntimeError>;
    readonly restoreCommandKeymap: (
      state: CommandKeymapState,
    ) => Effect.Effect<void, DictationRuntimeError>;
    readonly updateKeyboardLayout: (
      snapshot: KeyboardLayoutSnapshot,
    ) => Effect.Effect<boolean, DictationRuntimeError>;
    readonly captureFnHotkey: Effect.Effect<"Fn" | null, DictationRuntimeError>;
    readonly handleRendererEvent: (
      webContentsId: number,
      event: GlobalDictationRendererEvent,
    ) => Effect.Effect<boolean>;
    readonly ownsGlobalRenderer: (webContentsId: number) => boolean;
    readonly releaseOwner: (webContentsId: number) => Effect.Effect<void>;
    readonly readMicrophoneAccess: Effect.Effect<MicrophoneAccessStatus>;
    readonly requestMicrophoneAccess: Effect.Effect<MicrophoneAccessResult, DictationRuntimeError>;
    readonly acquireMicrophone: (input: {
      readonly webContentsId: number;
      readonly sessionId: string;
      readonly surface: DictationSurface;
    }) => Effect.Effect<boolean>;
    readonly releaseMicrophone: (
      webContentsId: number,
      sessionId: string,
    ) => Effect.Effect<boolean>;
    readonly readMicrophoneRouteHint: Effect.Effect<string | null, DictationRuntimeError>;
    readonly readGlobalPermissions: Effect.Effect<
      GlobalDictationPermissionSnapshot,
      DictationRuntimeError
    >;
    readonly requestInputMonitoring: Effect.Effect<
      GlobalDictationPermissionSnapshot,
      DictationRuntimeError
    >;
    readonly requestAccessibility: Effect.Effect<
      GlobalDictationPermissionSnapshot,
      DictationRuntimeError
    >;
    readonly readSettings: Effect.Effect<DictationSettings, DictationRuntimeError>;
    readonly updateSettings: (
      patch: DictationSettingsPatch,
    ) => Effect.Effect<DictationSettings, DictationRuntimeError>;
    readonly consumeGlobalShortcutNudge: Effect.Effect<boolean, DictationRuntimeError>;
    readonly createRecording: (
      input: DictationRecordingCreateInput,
    ) => Effect.Effect<DictationRecordingMetadata, DictationRuntimeError>;
    readonly appendRecording: (
      input: DictationRecordingAppendInput,
    ) => Effect.Effect<DictationRecordingMetadata, DictationRuntimeError>;
    readonly finalizeRecording: (
      input: DictationRecordingFinalizeInput,
    ) => Effect.Effect<DictationRecordingMetadata, DictationRuntimeError>;
    readonly setRecordingDiagnostics: (
      input: DictationRecordingSetDiagnosticsInput,
    ) => Effect.Effect<DictationRecordingMetadata, DictationRuntimeError>;
    readonly setRecordingTranscript: (
      input: DictationRecordingSetTranscriptInput,
    ) => Effect.Effect<DictationRecordingMetadata, DictationRuntimeError>;
    readonly listRecordings: Effect.Effect<
      readonly DictationRecordingMetadata[],
      DictationRuntimeError
    >;
    readonly readRecordingAudio: (
      id: string,
    ) => Effect.Effect<DictationRecordingAudio, DictationRuntimeError>;
    readonly deleteRecording: (id: string) => Effect.Effect<void, DictationRuntimeError>;
  }
>()("nodex/main/host-runtime/DictationRuntime") {}

const unavailablePermissions: GlobalDictationPermissionSnapshot = {
  available: false,
  inputMonitoring: false,
  accessibility: false,
};

const attemptPromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DictationRuntimeError({ operation, cause }),
  });

export const live = (options: {
  readonly preloadPath: string;
}): Layer.Layer<
  DictationRuntime,
  never,
  ApplicationSettings | MainConfig | ElectronPrivacy | RendererClientRuntime | WindowRuntime
> =>
  Layer.effect(
    DictationRuntime,
    Effect.gen(function* () {
      const applicationSettings = yield* ApplicationSettings;
      const config = yield* MainConfig;
      const privacy = yield* ElectronPrivacy;
      const rendererClients = yield* RendererClientRuntime;
      const windows = yield* WindowRuntime;
      const events = yield* PubSub.sliding<void>(MAIN_OBSERVATION_EVENT_CAPACITY);
      const settings = new DictationSettingsStore(config.nodexHome);
      const recordings = new FileDictationRecordingStore({ profileRoot: config.nodexHome });
      const microphone = new DictationMicrophoneLease();
      const permission = createSystemMicrophonePermissionService({
        platform: config.platform as NodeJS.Platform,
        systemPreferences: privacy.systemPreferences,
      });
      let accepting = true;
      const publish = (): void => {
        if (accepting) PubSub.publishUnsafe(events, undefined);
      };
      const releaseMicrophoneSubscription = microphone.subscribe(publish);
      let globalManager: GlobalDictationManager | null = null;
      let releaseGlobalSubscription = (): void => undefined;
      let releaseGlobalWindowSubscription = (): void => undefined;

      if (config.platform === "darwin") {
        const helper = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new MacDictationNativeHelperClient(
                resolveMacDictationHelperExecutable({
                  isPackaged: config.isPackaged,
                  repositoryRoot: config.projectRootPath,
                  resourcesPath: config.resourcesPath,
                }),
              ),
          ),
          (client) => Effect.sync(() => client.dispose()),
        );
        const windowController = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new GlobalDictationWindowController({
                preloadPath: options.preloadPath,
                rendererUrl: config.rendererUrl ?? APP_RENDERER_URL,
              }),
          ),
          (controller) => Effect.sync(() => controller.dispose()),
        );
        const recoveryWake = yield* Queue.sliding<void>(1);
        const recoveryCallbacks = yield* FiberSet.make();
        const runRecoveryCallback = yield* FiberSet.runtime(recoveryCallbacks)();
        globalManager = new GlobalDictationManager({
          helper,
          windowController,
          pasteService: new ClipboardSafePasteService({ helper }),
          readSettings: () => settings.read(),
          readKeepVisiblePreference: () => settings.readKeepGlobalBarVisiblePreference(),
          writeKeepVisiblePreference: async (value) => {
            await settings.update({ keepGlobalBarVisible: value });
          },
          getFocusedAppWindow: () =>
            windows.all().find((window) => !window.isDestroyed() && window.isFocused()) ?? null,
          getAppWindowByWebContentsId: (webContentsId) => windows.get(webContentsId),
          onRecoveryNeeded: () => {
            void runRecoveryCallback(Queue.offer(recoveryWake, undefined).pipe(Effect.asVoid));
          },
          platform: "darwin",
        });
        releaseGlobalSubscription = globalManager.subscribe(publish);
        releaseGlobalWindowSubscription = windowController.subscribeTerminal((webContentsId) => {
          microphone.releaseOwner(webContentsId);
        });
        const recoverySchedule = Schedule.min([
          Schedule.exponential("250 millis"),
          Schedule.spaced("5 seconds"),
        ]).pipe(Schedule.jittered);
        yield* Queue.take(recoveryWake).pipe(
          Effect.andThen(
            attemptPromise("recover-global-dictation-helper", () => globalManager!.recover()).pipe(
              Effect.retry(recoverySchedule),
            ),
          ),
          Effect.forever,
          Effect.forkScoped({ startImmediately: true }),
        );
        const initialApplicationSettings = yield* applicationSettings.snapshot().pipe(Effect.orDie);
        yield* attemptPromise("initialize-global-dictation", () =>
          globalManager!.initialize(initialApplicationSettings.commandKeymap),
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Global dictation shortcuts are unavailable").pipe(
              Effect.annotateLogs({ operation: error.operation }),
            ),
          ),
        );
      }

      yield* rendererClients.events.pipe(
        Stream.runForEach((event) =>
          event.kind === "disposed"
            ? Effect.sync(() => {
                microphone.releaseOwner(event.webContentsId);
                globalManager?.handleWebContentsGone(event.webContentsId);
              })
            : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          accepting = false;
          releaseMicrophoneSubscription();
          releaseGlobalSubscription();
          releaseGlobalWindowSubscription();
        }).pipe(
          Effect.andThen(globalManager ? Effect.sync(() => globalManager?.dispose()) : Effect.void),
          Effect.andThen(PubSub.shutdown(events)),
          Effect.asVoid,
        ),
      );

      const globalPermissions = (
        operation: string,
        read: (manager: GlobalDictationManager) => Promise<GlobalDictationPermissionSnapshot>,
      ) =>
        globalManager
          ? attemptPromise(operation, () => read(globalManager!))
          : Effect.succeed(unavailablePermissions);

      return DictationRuntime.of({
        changes: Stream.fromPubSub(events),
        globalAvailable: () => globalManager?.isAvailable() ?? false,
        microphoneOwner: () => (microphone.getOwner() ? "dictation" : "none"),
        setEnabled: (enabled) =>
          globalManager
            ? attemptPromise("set-global-dictation-enabled", () =>
                globalManager!.setEnabled(enabled),
              )
            : Effect.void,
        syncCommandKeymap: (state) =>
          globalManager
            ? attemptPromise("sync-global-dictation-keymap", () =>
                globalManager!.syncCommandKeymap(state),
              )
            : Effect.succeed(null),
        restoreCommandKeymap: (state) =>
          globalManager
            ? attemptPromise("restore-global-dictation-keymap", () =>
                globalManager!.restoreCommandKeymap(state),
              )
            : Effect.void,
        updateKeyboardLayout: (snapshot) =>
          globalManager
            ? attemptPromise("update-global-dictation-keyboard-layout", () =>
                globalManager!.updateKeyboardLayout(snapshot),
              )
            : Effect.succeed(false),
        captureFnHotkey: globalManager
          ? attemptPromise("capture-global-dictation-fn-hotkey", () =>
              globalManager!.captureFnHotkey(),
            )
          : Effect.succeed(null),
        handleRendererEvent: (webContentsId, event) =>
          Effect.sync(() => globalManager?.handleRendererEvent(webContentsId, event) ?? false),
        ownsGlobalRenderer: (webContentsId) => globalManager?.ownsRenderer(webContentsId) ?? false,
        releaseOwner: (webContentsId) =>
          Effect.sync(() => {
            microphone.releaseOwner(webContentsId);
            globalManager?.handleWebContentsGone(webContentsId);
          }),
        readMicrophoneAccess: Effect.sync(permission.readStatus),
        requestMicrophoneAccess: attemptPromise("request-microphone-access", () =>
          permission.requestAccess(),
        ),
        acquireMicrophone: (input) => Effect.sync(() => microphone.acquire(input)),
        releaseMicrophone: (webContentsId, sessionId) =>
          Effect.sync(() => microphone.release(webContentsId, sessionId)),
        readMicrophoneRouteHint: globalManager
          ? attemptPromise("read-built-in-microphone", () =>
              globalManager!.queryBuiltInMicrophoneName(),
            )
          : Effect.succeed(null),
        readGlobalPermissions: globalPermissions("read-global-dictation-permissions", (manager) =>
          manager.readPermissions(),
        ),
        requestInputMonitoring: globalPermissions("request-input-monitoring", (manager) =>
          manager.requestInputMonitoring(),
        ),
        requestAccessibility: globalPermissions("request-accessibility", (manager) =>
          manager.requestAccessibility(),
        ),
        readSettings: attemptPromise("read-dictation-settings", () => settings.read()),
        updateSettings: (patch) =>
          attemptPromise("update-dictation-settings", () => settings.update(patch)).pipe(
            Effect.tap((nextSettings) =>
              Effect.sync(() => globalManager?.syncSettings(nextSettings)),
            ),
          ),
        consumeGlobalShortcutNudge: attemptPromise("consume-global-shortcut-nudge", () =>
          settings.consumeGlobalShortcutNudge(),
        ),
        createRecording: (input) =>
          attemptPromise("create-dictation-recording", () => recordings.create(input)),
        appendRecording: (input) =>
          attemptPromise("append-dictation-recording", () => recordings.append(input)),
        finalizeRecording: (input) =>
          attemptPromise("finalize-dictation-recording", () => recordings.finalize(input)),
        setRecordingDiagnostics: (input) =>
          attemptPromise("set-dictation-diagnostics", () => recordings.setDiagnostics(input)),
        setRecordingTranscript: (input) =>
          attemptPromise("set-dictation-transcript", () => recordings.setTranscript(input)),
        listRecordings: attemptPromise("list-dictation-recordings", () => recordings.list()),
        readRecordingAudio: (id) =>
          attemptPromise("read-dictation-recording", () => recordings.readAudio(id)),
        deleteRecording: (id) =>
          attemptPromise("delete-dictation-recording", () => recordings.delete(id)),
      });
    }),
  );
