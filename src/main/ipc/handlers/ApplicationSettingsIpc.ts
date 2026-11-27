import { rendererSpaceParameter } from "../../../shared/space-ipc-policy";
import { CoreAuthority } from "../../core-runtime/CoreAuthority";
import { readEffectiveLinkOpeningSettings } from "../../settings/effective-link-opening";
import {
  agentProfilesFor,
  parseAgentProfileDriver,
  parseAgentProfilesUpdate,
} from "../../../shared/agents/profiles";
import release from "../../../../resources/agent-runtime/codex-app-server.lock.json";
import type { CodexExecutablePreference } from "../../../shared/codex-executable-settings";
import { CodexExecutableUpdateSchema } from "../../../shared/codex-executable-settings";
import { checkCodexExecutable } from "../../codex/CodexExecutableProbe";
import { HostShellEnvironment } from "../../host-runtime/HostShellEnvironment";
import * as Option from "effect/Option";
import { ModelPolicySchema, MODEL_POLICY_CHANGED_CHANNEL } from "../../../shared/model-policy";
import {
  TERMINAL_SHELL_SETTINGS_CHANGED_CHANNEL,
  TerminalShellSettingsSchema,
} from "../../../shared/terminal-shell-settings";
import {
  LINK_OPENING_SETTINGS_CHANGED_CHANNEL,
  LinkOpeningSettingsSchema,
} from "../../../shared/link-opening-settings";
import { UpdateAgentRuntimeSettingsInputSchema } from "../../../shared/agent-runtime-settings";
import {
  USAGE_METER_SETTINGS_CHANGED_CHANNEL,
  UsageMeterSettingsSchema,
} from "../../../shared/usage-meter-settings";
import { AcpAgentSettingsUpdateSchema } from "../../../shared/acp-agent-settings";
import {
  COMPOSER_PREDICTION_SETTINGS_CHANGED_CHANNEL,
  ComposerPredictionSettingsSchema,
} from "../../../shared/composer-prediction-settings";
import { MINI_RESTING_MODES } from "../../../shared/mini";
import { APP_LOCALES } from "../../../shared/i18n/locales";
import {
  activateElectronLanguagePreference,
  broadcastLanguageSettings,
} from "../../i18n/electron-language-settings";
import { UpdateInboxSettingsInputSchema } from "../../../shared/schemas/inbox";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { IpcApi } from "../../../shared/ipc-api";
import { CodexHomeSettingsUpdateSchema } from "../../../shared/codex-home-settings";
import {
  COMMAND_KEYBINDINGS_CHANGED_CHANNEL,
  CommandKeybindingValidationError,
  getPrimaryCommandAccelerator,
  type CommandKeybindingMutationResult,
  type CommandKeybindingUpdate,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";
import type {
  UpdateBackupSettingsInput,
  UpdateCodexDeveloperInstructionSettingsInput,
  UpdateCodexGitSettingsInput,
  UpdateDiagnosticsSettingsInput,
  UpdateHistorySettingsInput,
  UpdateTelemetrySettingsInput,
  UpdateThreadNotificationSettingsInput,
  UpdateWindowRestoreSettingsInput,
} from "../../../shared/types";
import { THREAD_NOTIFICATION_TURN_MODES } from "../../../shared/types";
import { CoreModules } from "../../core-runtime/CoreModules";
import {
  readRoutingConsent,
  writeRoutingConsent,
} from "../../../host/inbox-application/InboxRoutingConsent";
import { MainConfig } from "../../app/MainConfig";
import {
  AgentRuntimeProviderConfiguration,
  acpConfigurationStatus,
} from "../../agent-runtime/AgentRuntimeProviderConfiguration";
import { resolveCodexHome } from "../../codex/codex-home";
import { inspectCodexAccountHome } from "../../platform/node/CodexAccountHome";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { ApplicationMenuRuntime } from "../../host-runtime/ApplicationMenuRuntime";
import { DesktopNotificationRuntime } from "../../host-runtime/DesktopNotificationRuntime";
import { shell } from "electron";
import { MiniRuntime } from "../../mini/MiniRuntime";
import { DictationRuntime } from "../../host-runtime/DictationRuntime";
import { StoreAdministrationSchedulerRuntime } from "../../host-runtime/StoreAdministrationSchedulerRuntime";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import {
  ApplicationSettings,
  prepareCommandKeymapMutation,
  type ApplicationSettingsCommand,
  type ApplicationSettingsSnapshot,
  type PreparedCommandKeymapMutation,
} from "../../settings/ApplicationSettings";
import { readThirdPartyNotices } from "../../third-party-notices";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ApplicationSettingsIpcError extends Schema.TaggedError<ApplicationSettingsIpcError>()(
  "ApplicationSettingsIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type SettingsReadChannel =
  | "codex-command-keymap-state"
  | "settings:acp-agents:get"
  | "settings:codex-home:get"
  | "settings:backup:get"
  | "settings:diagnostics:get"
  | "settings:git:get"
  | "settings:history:get"
  | "settings:telemetry:get"
  | "settings:thread-notifications:get"
  | "settings:terminal-shell:get"
  | "settings:mini:get"
  | "settings:window-restore:get"
  | "settings:link-opening:get"
  | "settings:model-policy:get"
  | "settings:usage-meters:get"
  | "settings:agent-runtime:get"
  | "settings:composer-predictions:get"
  | "settings:inbox:get";

const MiniSettingsChange = z.strictObject({
  shown: z.boolean().optional(),
  resting: z.enum(MINI_RESTING_MODES).optional(),
});

const BackupUpdate = z
  .object({
    autoEnabled: z.boolean(),
    intervalHours: z.number().int().min(1),
    retentionCount: z.number().int().nonnegative(),
    retentionGiB: z.number().int().min(0).max(8_192),
  })
  .strict() satisfies z.ZodType<UpdateBackupSettingsInput>;
const HistoryUpdate = z
  .object({ retentionCount: z.number().int().nonnegative() })
  .strict() satisfies z.ZodType<UpdateHistorySettingsInput>;
const DiagnosticsUpdate = z
  .object({
    enabled: z.boolean(),
    dsn: z.string(),
    environment: z.string(),
    release: z.string().nullable(),
    tracesSampleRate: z.number().min(0).max(1),
    replayEnabled: z.boolean(),
    replaysSessionSampleRate: z.number().min(0).max(1),
    replaysOnErrorSampleRate: z.number().min(0).max(1),
  })
  .strict() satisfies z.ZodType<UpdateDiagnosticsSettingsInput>;
const TelemetryUpdate = z
  .object({
    enabled: z.boolean(),
  })
  .strict() satisfies z.ZodType<UpdateTelemetrySettingsInput>;
const LanguageUpdate = z.enum(APP_LOCALES).nullable();
const ThreadNotificationUpdate = z
  .object({
    turnMode: z.enum(THREAD_NOTIFICATION_TURN_MODES),
    questionsEnabled: z.boolean(),
    readbackEnabled: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<UpdateThreadNotificationSettingsInput>;
const DeveloperInstructionUpdate = z
  .object({
    detailLevel: z.enum(["STEPS_PROSE", "STEPS_COMMANDS", "STEPS_EXECUTION"]).optional(),
    defaultModeRequestUserInput: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<UpdateCodexDeveloperInstructionSettingsInput>;
const GitUpdate = z
  .object({
    branchPrefix: z.string().optional(),
    commitInstructions: z.string().optional(),
    pullRequestInstructions: z.string().optional(),
  })
  .strict() satisfies z.ZodType<UpdateCodexGitSettingsInput>;
const WindowRestoreUpdate = z
  .object({ policy: z.enum(["all", "last-window", "none"]) })
  .strict() satisfies z.ZodType<UpdateWindowRestoreSettingsInput>;
const Keybinding = z.object({ key: z.string().nullable() }).strict();
const CommandKeybindingMutation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set"), keybinding: Keybinding }).strict(),
  z
    .object({ type: z.literal("replace"), oldKeybinding: Keybinding, newKeybinding: Keybinding })
    .strict(),
  z.object({ type: z.literal("append"), keybinding: Keybinding }).strict(),
  z.object({ type: z.literal("remove"), keybinding: Keybinding }).strict(),
  z.object({ type: z.literal("reset") }).strict(),
]) satisfies z.ZodType<CommandKeybindingUpdate>;

const settingsError = (operation: string) => (cause: unknown) =>
  new ApplicationSettingsIpcError({ operation, cause });

export const live: Layer.Layer<
  never,
  never,
  | CoreModules
  | CoreAuthority
  | ApplicationMenuRuntime
  | ApplicationSettings
  | AgentRuntimeProviderConfiguration
  | DictationRuntime
  | MiniRuntime
  | DesktopNotificationRuntime
  | StoreAdministrationSchedulerRuntime
  | ElectronIpc
  | MainConfig
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const core = yield* CoreModules;
    const personalSpaceId = (yield* CoreAuthority).identity.libraryId;
    const applicationSettings = yield* ApplicationSettings;
    const runtimeProviders = yield* AgentRuntimeProviderConfiguration;
    const config = yield* MainConfig;
    const dictation = yield* DictationRuntime;
    const mini = yield* MiniRuntime;
    const notifications = yield* DesktopNotificationRuntime;
    const ipc = yield* ElectronIpc;
    const menus = yield* ApplicationMenuRuntime;
    const schedulers = yield* StoreAdministrationSchedulerRuntime;
    const windows = yield* WindowRuntime;
    if (runtimeProviders.catalogChanges)
      yield* runtimeProviders.catalogChanges.pipe(
        Stream.runForEach(() =>
          Effect.sync(() =>
            safeBroadcastToWindows(windows.all(), "agent-settings-changed", [undefined]),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
    yield* applicationSettings.composerPredictionSettingsChanges.pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() => {
          safeBroadcastToWindows(windows.all(), COMPOSER_PREDICTION_SETTINGS_CHANGED_CHANNEL, [
            settings,
          ]);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* applicationSettings.modelPolicyChanges.pipe(
      Stream.runForEach((policy) =>
        Effect.sync(() => {
          safeBroadcastToWindows(windows.all(), MODEL_POLICY_CHANGED_CHANNEL, [policy]);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* applicationSettings.usageMeterSettingsChanges.pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() => {
          safeBroadcastToWindows(windows.all(), USAGE_METER_SETTINGS_CHANGED_CHANNEL, [settings]);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* applicationSettings.linkOpeningSettingsChanges.pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() => {
          safeBroadcastToWindows(windows.all(), LINK_OPENING_SETTINGS_CHANGED_CHANNEL, [settings]);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* applicationSettings.terminalShellSettingsChanges.pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), TERMINAL_SHELL_SETTINGS_CHANGED_CHANNEL, [
            settings,
          ]),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const keybindingMutations = yield* Semaphore.make(1);
    const codexHomeMutations = yield* Semaphore.make(1);
    const languageMutations = yield* Semaphore.make(1);
    const authorize = (event: IpcMainInvokeEvent, capability: string, allowMini = false) =>
      Effect.try({
        try: () => {
          if (
            !isTrustedAppRendererIpcSender({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: allowMini
                ? windows.hasAppRenderer(event.sender.id)
                : windows.has(event.sender.id),
              senderType: event.sender.getType(),
              senderUrl: event.senderFrame?.url ?? "",
              isMainFrame: event.senderFrame === event.sender.mainFrame,
            })
          ) {
            throw new Error(`${capability} requires an active Nodex window`);
          }
        },
        catch: settingsError("authorize-renderer"),
      });
    const parse = <A>(operation: string, evaluate: () => A) =>
      Effect.try({ try: evaluate, catch: settingsError(operation) });
    const read = <A>(operation: string, select: (snapshot: ApplicationSettingsSnapshot) => A) =>
      applicationSettings
        .snapshot()
        .pipe(Effect.map(select), Effect.mapError(settingsError(operation)));
    const update = <A>(
      operation: string,
      command: ApplicationSettingsCommand,
      select: (snapshot: ApplicationSettingsSnapshot) => A,
    ) =>
      applicationSettings.update(command).pipe(
        Effect.tap(() =>
          command.type === "update-agent-profiles"
            ? runtimeProviders.refresh.pipe(
                Effect.catch(() =>
                  Effect.logWarning(
                    "Provider settings were saved; execution configuration could not refresh",
                  ),
                ),
              )
            : Effect.void,
        ),
        Effect.map(select),
        Effect.mapError(settingsError(operation)),
      );
    const handleRead = <Channel extends SettingsReadChannel>(
      channel: Channel,
      capability: string,
      select: (snapshot: ApplicationSettingsSnapshot) => IpcApi[Channel]["result"],
    ) =>
      ipc.handleQuery(channel, (event, ..._args: IpcApi[Channel]["args"]) =>
        authorize(event, capability, channel === "codex-command-keymap-state").pipe(
          Effect.andThen(read(`read-${channel}`, select)),
        ),
      );
    const broadcastKeymap = (state: CommandKeymapState): void => {
      menus.refresh(state);
      safeBroadcastToWindows(windows.appRenderers(), COMMAND_KEYBINDINGS_CHANGED_CHANNEL, [state]);
    };
    const commitKeymap = (
      mutation: PreparedCommandKeymapMutation,
    ): Effect.Effect<CommandKeybindingMutationResult, ApplicationSettingsIpcError> => {
      const { nextState, previousState, command } = mutation;
      const syncMini =
        command.type === "reset-command-keybindings" ||
        command.commandId === "openMini" ||
        getPrimaryCommandAccelerator(previousState, "openMini") !==
          getPrimaryCommandAccelerator(nextState, "openMini");
      return Effect.gen(function* () {
        const rejection = yield* dictation.syncCommandKeymap(nextState);
        if (rejection)
          return {
            type: "rejected" as const,
            state: mini.decorateKeymap(previousState),
            reason: rejection,
          };
        if (syncMini) {
          const reason = yield* mini.syncCommandKeymap(nextState);
          if (reason) {
            yield* dictation.restoreCommandKeymap(previousState);
            return {
              type: "rejected" as const,
              state: mini.decorateKeymap(previousState),
              reason,
            };
          }
        }
        const snapshot = yield* applicationSettings
          .update(command, { expectedRevision: mutation.expectedRevision })
          .pipe(Effect.mapError(settingsError("commit-command-keybindings")));
        const state = mini.decorateKeymap(snapshot.commandKeymap);
        yield* Effect.sync(() => broadcastKeymap(state));
        return { type: "applied" as const, state };
      }).pipe(
        Effect.catch((cause) =>
          Effect.all([
            dictation.restoreCommandKeymap(previousState).pipe(Effect.ignore),
            syncMini ? mini.restoreCommandKeymap(previousState).pipe(Effect.ignore) : Effect.void,
          ]).pipe(Effect.andThen(Effect.fail(cause))),
        ),
        Effect.mapError((cause) =>
          cause instanceof ApplicationSettingsIpcError
            ? cause
            : settingsError("synchronize-command-keybindings")(cause),
        ),
        Effect.uninterruptible,
      );
    };
    const prepareKeymap = (
      command: PreparedCommandKeymapMutation["command"],
    ): Effect.Effect<
      | { readonly type: "prepared"; readonly mutation: PreparedCommandKeymapMutation }
      | { readonly type: "rejected"; readonly result: CommandKeybindingMutationResult },
      ApplicationSettingsIpcError
    > =>
      applicationSettings.snapshot().pipe(
        Effect.mapError(settingsError("read-command-keybindings")),
        Effect.flatMap((snapshot) =>
          Effect.try({
            try: () => ({
              type: "prepared" as const,
              mutation: prepareCommandKeymapMutation(snapshot, command),
            }),
            catch: (cause) =>
              cause instanceof CommandKeybindingValidationError
                ? cause
                : settingsError("prepare-command-keybindings")(cause),
          }),
        ),
        Effect.catch((cause) => {
          if (!(cause instanceof CommandKeybindingValidationError)) return Effect.fail(cause);
          return applicationSettings.snapshot().pipe(
            Effect.map((snapshot) => ({
              type: "rejected" as const,
              result: {
                type: "rejected" as const,
                state: mini.decorateKeymap(snapshot.commandKeymap),
                reason: cause.rejection,
              },
            })),
            Effect.mapError(settingsError("read-command-keybindings")),
          );
        }),
      );
    const mutateKeymap = (command: PreparedCommandKeymapMutation["command"]) =>
      keybindingMutations.withPermits(1)(
        prepareKeymap(command).pipe(
          Effect.flatMap((prepared) =>
            prepared.type === "rejected"
              ? Effect.succeed(prepared.result)
              : commitKeymap(prepared.mutation),
          ),
        ),
      );

    yield* handleRead("settings:backup:get", "Backup settings", (value) => value.backup);
    yield* ipc.handlePlainCommand("settings:backup:update", (event, input: unknown) =>
      authorize(event, "Backup settings").pipe(
        Effect.andThen(parse("parse-backup-settings", () => BackupUpdate.parse(input))),
        Effect.flatMap((parsed) =>
          update(
            "update-backup-settings",
            { type: "update-backup", input: parsed },
            (value) => value.backup,
          ),
        ),
        Effect.tap((value) => schedulers.configureBackup(value)),
      ),
    );
    yield* ipc.handleQuery("settings:agent-profiles:get", (event, driver: unknown) =>
      authorize(event, "Agent profiles").pipe(
        Effect.andThen(parse("parse-agent-profile-driver", () => parseAgentProfileDriver(driver))),
        Effect.flatMap((driver) =>
          read("read-agent-profiles", (value) => ({
            instances: agentProfilesFor(value.agentProfiles, driver),
          })),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("settings:agent-profiles:update", (event, input: unknown) =>
      authorize(event, "Agent profiles").pipe(
        Effect.andThen(parse("parse-agent-profiles", () => parseAgentProfilesUpdate(input))),
        Effect.flatMap((input) =>
          update("update-agent-profiles", { type: "update-agent-profiles", input }, (value) => ({
            instances: agentProfilesFor(value.agentProfiles, input.driver),
          })),
        ),
        Effect.tap(() =>
          Effect.sync(() =>
            safeBroadcastToWindows(windows.all(), "agent-settings-changed", [undefined]),
          ),
        ),
      ),
    );
    const shellEnvironment = Option.getOrUndefined(
      yield* Effect.serviceOption(HostShellEnvironment),
    );
    const executableSettings = (preference: CodexExecutablePreference) =>
      Effect.gen(function* () {
        const probe = preference.executable
          ? yield* checkCodexExecutable(preference.executable, config, shellEnvironment)
          : null;
        return { ...preference, probe, pinnedVersion: release.appServerRuntimeVersion };
      });
    yield* ipc.handleQuery("settings:codex-executable:get", (event) =>
      authorize(event, "Codex executable settings").pipe(
        Effect.andThen(read("read-codex-executable", (value) => value.codexExecutable)),
        Effect.flatMap(executableSettings),
      ),
    );
    yield* ipc.handlePlainCommand("settings:codex-executable:update", (event, input: unknown) =>
      authorize(event, "Codex executable settings").pipe(
        Effect.andThen(
          parse("parse-codex-executable", () => CodexExecutableUpdateSchema.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-codex-executable",
            { type: "update-codex-executable", input: parsed },
            (value) => value.codexExecutable,
          ),
        ),
        Effect.flatMap(executableSettings),
      ),
    );
    yield* handleRead("settings:codex-home:get", "Codex home settings", (value) => value.codexHome);
    yield* ipc.handlePlainCommand("settings:codex-home:update", (event, input: unknown) =>
      authorize(event, "Codex home settings").pipe(
        Effect.andThen(
          parse("parse-codex-home-settings", () => CodexHomeSettingsUpdateSchema.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          codexHomeMutations.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* read("read-active-codex-home", (value) => value.codexHome);
              const target = yield* parse("resolve-codex-home", () =>
                resolveCodexHome({
                  configuredHome: parsed.homePath,
                  configuredAccountHome: parsed.accountHomePath ?? current.accountHomePath,
                  environment: config.environment,
                  homeDirectory: config.homeDirectory,
                }),
              );
              yield* parse("validate-codex-account-home", () =>
                inspectCodexAccountHome({
                  sharedHome: target.resolvedHomePath,
                  accountHome: target.resolvedAccountHomePath,
                  platform: config.platform,
                }),
              );
              return yield* update(
                "update-codex-home-settings",
                { type: "update-codex-home", input: parsed },
                (value) => value.codexHome,
              );
            }),
          ),
        ),
      ),
    );
    yield* handleRead("settings:acp-agents:get", "ACP Agent settings", (value) => value.acpAgents);
    yield* ipc.handleQuery("settings:acp-agents:configuration-status", (event) =>
      authorize(event, "ACP Agent settings").pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const result = yield* Effect.result(runtimeProviders.refresh);
            const current = yield* applicationSettings.snapshot();
            return acpConfigurationStatus(
              current.acpAgents.instances,
              result._tag === "Success" ? result.success : null,
            );
          }),
        ),
        Effect.mapError(settingsError("read-acp-agent-configuration-status")),
      ),
    );
    yield* ipc.handlePlainCommand("settings:acp-agents:update", (event, input: unknown) =>
      authorize(event, "ACP Agent settings").pipe(
        Effect.andThen(
          parse("parse-acp-agent-settings", () => AcpAgentSettingsUpdateSchema.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          Effect.gen(function* () {
            const previous = yield* applicationSettings.snapshot();
            const saved = yield* applicationSettings.update({
              type: "update-acp-agents",
              input: parsed,
            });
            const result = yield* Effect.result(runtimeProviders.refresh);
            const instances = [...previous.acpAgents.instances, ...saved.acpAgents.instances];
            safeBroadcastToWindows(windows.all(), "agent-settings-changed", [undefined]);
            return {
              ...saved.acpAgents,
              ...acpConfigurationStatus(
                instances,
                result._tag === "Success" ? result.success : null,
              ),
            };
          }).pipe(Effect.mapError(settingsError("update-acp-agent-settings"))),
        ),
      ),
    );
    yield* handleRead("settings:history:get", "History settings", (value) => value.history);
    yield* ipc.handlePlainCommand("settings:history:update", (event, input: unknown) =>
      authorize(event, "History settings").pipe(
        Effect.andThen(parse("parse-history-settings", () => HistoryUpdate.parse(input))),
        Effect.flatMap((parsed) =>
          update(
            "update-history-settings",
            { type: "update-history", input: parsed },
            (value) => value.history,
          ),
        ),
      ),
    );
    yield* handleRead(
      "settings:diagnostics:get",
      "Diagnostics settings",
      (value) => value.diagnostics,
    );
    yield* ipc.handlePlainCommand("settings:diagnostics:update", (event, input: unknown) =>
      authorize(event, "Diagnostics settings").pipe(
        Effect.andThen(parse("parse-diagnostics-settings", () => DiagnosticsUpdate.parse(input))),
        Effect.flatMap((parsed) =>
          update(
            "update-diagnostics-settings",
            { type: "update-diagnostics", input: parsed },
            (value) => value.diagnostics,
          ),
        ),
      ),
    );
    yield* handleRead("settings:telemetry:get", "Telemetry settings", (value) => value.telemetry);
    yield* ipc.handlePlainCommand("settings:telemetry:update", (event, input: unknown) =>
      authorize(event, "Telemetry settings").pipe(
        Effect.andThen(parse("parse-telemetry-settings", () => TelemetryUpdate.parse(input))),
        Effect.flatMap((parsed) =>
          update(
            "update-telemetry-settings",
            { type: "update-telemetry", input: parsed },
            (value) => value.telemetry,
          ),
        ),
      ),
    );
    yield* handleRead(
      "settings:thread-notifications:get",
      "Thread notification settings",
      (value) => value.notifications,
    );
    yield* ipc.handleQuery("settings:notification-authorization:read", (event) =>
      authorize(event, "Notification authorization").pipe(
        Effect.andThen(notifications.authorization.read),
        Effect.mapError(settingsError("notification-authorization-read")),
      ),
    );
    yield* ipc.handlePlainCommand("settings:notification-authorization:request", (event) =>
      authorize(event, "Notification authorization").pipe(
        Effect.andThen(notifications.authorization.request),
        Effect.mapError(settingsError("notification-authorization-request")),
      ),
    );
    yield* ipc.handlePlainCommand("settings:notification-authorization:open-settings", (event) =>
      authorize(event, "Notification authorization").pipe(
        Effect.andThen(
          config.platform === "darwin"
            ? Effect.tryPromise(() =>
                shell.openExternal(
                  "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
                ),
              )
            : Effect.void,
        ),
        Effect.mapError(settingsError("notification-authorization-open-settings")),
      ),
    );
    yield* ipc.handlePlainCommand("settings:thread-notifications:update", (event, input: unknown) =>
      authorize(event, "Thread notification settings").pipe(
        Effect.andThen(
          parse("parse-thread-notification-settings", () => ThreadNotificationUpdate.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-thread-notification-settings",
            { type: "update-thread-notifications", input: parsed },
            (value) => value.notifications,
          ),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("settings:codex-developer:update", (event, input: unknown) =>
      authorize(event, "Developer instruction settings").pipe(
        Effect.andThen(
          parse("parse-developer-instruction-settings", () =>
            DeveloperInstructionUpdate.parse(input),
          ),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-developer-instruction-settings",
            { type: "update-developer-instructions", input: parsed },
            (value) => value.developer,
          ),
        ),
      ),
    );
    yield* handleRead("settings:git:get", "Git settings", (value) => value.git);
    yield* ipc.handlePlainCommand("settings:git:update", (event, input: unknown) =>
      authorize(event, "Git settings").pipe(
        Effect.andThen(parse("parse-git-settings", () => GitUpdate.parse(input))),
        Effect.flatMap((parsed) =>
          update(
            "update-git-settings",
            { type: "update-git", input: parsed },
            (value) => value.git,
          ),
        ),
      ),
    );
    yield* handleRead(
      "settings:terminal-shell:get",
      "Terminal shell settings",
      (value) => value.terminalShell,
    );
    yield* ipc.handlePlainCommand("settings:terminal-shell:update", (event, input: unknown) =>
      authorize(event, "Terminal shell settings").pipe(
        Effect.andThen(
          parse("parse-terminal-shell-settings", () => TerminalShellSettingsSchema.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-terminal-shell-settings",
            { type: "update-terminal-shell", input: parsed },
            (value) => value.terminalShell,
          ),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("settings:language:update", (event, input: unknown) =>
      authorize(event, "Language settings").pipe(
        Effect.andThen(parse("parse-language-settings", () => LanguageUpdate.parse(input))),
        Effect.flatMap((preference) =>
          languageMutations.withPermit(
            update(
              "update-language-settings",
              { type: "update-language", input: preference },
              (snapshot) => snapshot.languagePreference,
            ).pipe(
              Effect.flatMap((saved) =>
                Effect.tryPromise({
                  try: () => activateElectronLanguagePreference(saved),
                  catch: settingsError("activate-language-settings"),
                }),
              ),
              Effect.tap((settings) =>
                Effect.sync(() => broadcastLanguageSettings(settings, config.rendererUrl)),
              ),
              Effect.uninterruptible,
            ),
          ),
        ),
      ),
    );
    yield* handleRead("settings:mini:get", "Mini settings", (value) => value.mini);
    yield* ipc.handlePlainCommand("settings:mini:update", (event, input: unknown) =>
      authorize(event, "Mini settings").pipe(
        Effect.andThen(parse("parse-mini", () => MiniSettingsChange.parse(input))),
        Effect.flatMap((parsed) =>
          update("update-mini", { type: "update-mini", input: parsed }, (value) => value.mini),
        ),
      ),
    );
    yield* handleRead(
      "settings:window-restore:get",
      "Window restore settings",
      (value) => value.windowRestore,
    );
    yield* ipc.handlePlainCommand("settings:window-restore:update", (event, input: unknown) =>
      authorize(event, "Window restore settings").pipe(
        Effect.andThen(
          parse("parse-window-restore-settings", () => WindowRestoreUpdate.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-window-restore-settings",
            { type: "update-window-restore", input: parsed },
            (value) => value.windowRestore,
          ),
        ),
      ),
    );
    yield* handleRead(
      "settings:agent-runtime:get",
      "Agent execution settings",
      (value) => value.agentRuntime,
    );
    yield* ipc.handlePlainCommand("settings:agent-runtime:update", (event, input: unknown) =>
      authorize(event, "Agent execution settings").pipe(
        Effect.andThen(
          parse("parse-agent-runtime-settings", () =>
            UpdateAgentRuntimeSettingsInputSchema.parse(input),
          ),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-agent-runtime-settings",
            { type: "update-agent-runtime", input: parsed },
            (value) => value.agentRuntime,
          ).pipe(Effect.tap(() => runtimeProviders.refresh)),
        ),
      ),
    );
    yield* handleRead(
      "settings:composer-predictions:get",
      "Composer prediction settings",
      (value) => value.composerPredictions,
    );
    yield* ipc.handlePlainCommand("settings:composer-predictions:update", (event, input: unknown) =>
      authorize(event, "Composer prediction settings").pipe(
        Effect.andThen(
          parse("parse-composer-prediction-settings", () =>
            ComposerPredictionSettingsSchema.parse(input),
          ),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-composer-prediction-settings",
            { type: "update-composer-predictions", input: parsed },
            (value) => value.composerPredictions,
          ),
        ),
      ),
    );
    yield* handleRead("settings:model-policy:get", "Model policy", (value) => value.modelPolicy);
    yield* ipc.handlePlainCommand("settings:model-policy:update", (event, input: unknown) =>
      authorize(event, "Model policy").pipe(
        Effect.andThen(parse("parse-model-policy", () => ModelPolicySchema.parse(input))),
        Effect.flatMap((parsed) =>
          update(
            "update-model-policy",
            { type: "update-model-policy", input: parsed },
            (value) => value.modelPolicy,
          ),
        ),
        Effect.tap(() =>
          runtimeProviders.refresh.pipe(
            Effect.mapError(
              (cause) =>
                new ApplicationSettingsIpcError({ operation: "apply-model-policy", cause }),
            ),
          ),
        ),
      ),
    );
    yield* handleRead(
      "settings:usage-meters:get",
      "Usage meter settings",
      (value) => value.usageMeters,
    );
    yield* ipc.handlePlainCommand("settings:usage-meters:update", (event, input: unknown) =>
      authorize(event, "Usage meter settings").pipe(
        Effect.andThen(
          parse("parse-usage-meter-settings", () => UsageMeterSettingsSchema.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-usage-meter-settings",
            { type: "update-usage-meters", input: parsed },
            (value) => value.usageMeters,
          ),
        ),
      ),
    );
    yield* handleRead(
      "settings:link-opening:get",
      "Link opening settings",
      (value) => value.linkOpening,
    );
    yield* ipc.handleQuery("settings:link-opening:effective", (event) =>
      authorize(event, "Link opening settings").pipe(
        Effect.andThen(applicationSettings.snapshot()),
        Effect.flatMap((snapshot) =>
          readEffectiveLinkOpeningSettings({
            preferences: snapshot.linkOpening,
            activeSpaceId:
              rendererSpaceParameter(event.senderFrame?.url ?? "") ??
              windows.bootstrap(event.sender.id).activeSpaceId,
            personalSpaceId,
            workspace: core.workspace,
          }),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("settings:link-opening:update", (event, input: unknown) =>
      authorize(event, "Link opening settings").pipe(
        Effect.andThen(
          parse("parse-link-opening-settings", () => LinkOpeningSettingsSchema.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-link-opening-settings",
            { type: "update-link-opening", input: parsed },
            (value) => value.linkOpening,
          ),
        ),
      ),
    );
    yield* ipc.handleQuery("settings:inbox:get", (event) =>
      authorize(event, "Inbox settings", true).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const value = (yield* applicationSettings.snapshot()).inbox;
            const start = yield* readRoutingConsent(core, value);
            return {
              ...value,
              dispatchMode: start ? ("act_on_requests" as const) : ("suggest" as const),
            };
          }),
        ),
        Effect.mapError(settingsError("read-inbox-settings")),
      ),
    );
    yield* ipc.handlePlainCommand("settings:inbox:update", (event, input: unknown) =>
      authorize(event, "Inbox settings").pipe(
        Effect.andThen(
          parse("parse-inbox-settings", () => UpdateInboxSettingsInputSchema.parse(input)),
        ),
        Effect.tap((parsed) =>
          parsed.dispatchMode === undefined
            ? Effect.void
            : writeRoutingConsent(core, parsed.dispatchMode === "act_on_requests").pipe(
                Effect.mapError(settingsError("write-inbox-consent")),
              ),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-inbox-settings",
            { type: "update-inbox", input: parsed },
            (value) => value.inbox,
          ),
        ),
      ),
    );
    yield* ipc.handleQuery("settings:third-party-notices:get", (event) =>
      authorize(event, "Third-party notices").pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              readThirdPartyNotices({
                appPath: config.projectRootPath,
                cwd: config.projectRootPath,
                isPackaged: config.isPackaged,
                resourcesPath: config.resourcesPath,
              }),
            catch: settingsError("read-third-party-notices"),
          }),
        ),
      ),
    );
    yield* handleRead("codex-command-keymap-state", "Command keybindings", (value) =>
      mini.decorateKeymap(value.commandKeymap),
    );
    yield* ipc.handlePlainCommand(
      "set-codex-command-keybinding",
      (event, commandId: unknown, input: unknown) =>
        authorize(event, "Command keybindings").pipe(
          Effect.andThen(
            parse("parse-command-keybinding", () => {
              if (typeof commandId !== "string") throw new Error("commandId must be a string");
              return {
                type: "update-command-keybinding" as const,
                commandId,
                input: CommandKeybindingMutation.parse(input),
              };
            }),
          ),
          Effect.flatMap(mutateKeymap),
        ),
    );
    yield* ipc.handlePlainCommand("reset-codex-command-keybindings", (event) =>
      authorize(event, "Command keybindings").pipe(
        Effect.andThen(mutateKeymap({ type: "reset-command-keybindings" })),
      ),
    );
  }),
);
