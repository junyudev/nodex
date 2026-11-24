import type { AgentProfile, AgentProfilesUpdate } from "../../shared/agents/profiles";
import type { ProfileAgentDriver } from "../../shared/agents/registry";
import type { CodexExecutablePreference } from "../../shared/codex-executable-settings";
import type { AppComponentId, SetAppComponentEnabledInput } from "../../shared/app-components";
import * as Redacted from "effect/Redacted";
import type { ProviderKeyConnection, ProviderKeySettings } from "../../shared/provider-keys";
import type { PluginProjectScope } from "../../shared/agent-plugins/session-plugins";
import type { AppLocalePreference } from "../../shared/i18n/locales";
import { readPluginScopes, writePluginScope } from "./application-settings-persistence";
import { getLogger } from "../logging/logger";
import { DEFAULT_MODEL_POLICY, sameModelPolicy, type ModelPolicy } from "../../shared/model-policy";
import { getModelPolicy, updateModelPolicy } from "./application-settings-persistence";
import {
  DEFAULT_TERMINAL_SHELL_SETTINGS,
  type TerminalShellSettings,
} from "../../shared/terminal-shell-settings";
import {
  DEFAULT_LINK_OPENING_SETTINGS,
  sameLinkOpeningSettings,
  type LinkOpeningSettings,
} from "../../shared/link-opening-settings";
import type {
  AgentRuntimeSettings,
  UpdateAgentRuntimeSettingsInput,
} from "../../shared/agent-runtime-settings";
import {
  DEFAULT_USAGE_METER_SETTINGS,
  sameUsageMeterSettings,
  type UsageMeterSettings,
} from "../../shared/usage-meter-settings";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ComposerPredictionSettings } from "../../shared/composer-prediction-settings";
import type { InboxSettings, UpdateInboxSettingsInput } from "../../shared/inbox";
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  applyCommandKeybindingUpdate,
  createCommandKeymapState,
  type CommandKeybindingUpdate,
  type CommandKeybindingOverrides,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import type {
  AcpAgentSettings,
  AppUpdateSettings,
  BackupSettings,
  CodexDeveloperInstructionSettings,
  CodexExecutionHostSettings,
  CodexGitSettings,
  CodexHomeSettingsSnapshot,
  CodexHomeSettingsUpdateInput,
  DiagnosticsSettings,
  HistorySettings,
  ManagedWorktreeSettings,
  TelemetrySettings,
  ThreadNotificationSettings,
  UpdateAppUpdateSettingsInput,
  UpdateAcpAgentSettingsInput,
  UpdateBackupSettingsInput,
  UpdateCodexDeveloperInstructionSettingsInput,
  UpdateCodexExecutionHostSettingsInput,
  UpdateCodexGitSettingsInput,
  UpdateDiagnosticsSettingsInput,
  UpdateHistorySettingsInput,
  UpdateManagedWorktreeSettingsInput,
  UpdateTelemetrySettingsInput,
  UpdateThreadNotificationSettingsInput,
  UpdateWindowRestoreSettingsInput,
  WindowRestoreSettings,
} from "../../shared/types";
import { MainConfig } from "../app/MainConfig";
import { SecretEncryption, type SecretEncryptionAdapter } from "../platform/SecretEncryption";
import {
  migrateProfileAgentProfiles,
  getAgentProfiles,
  getAgentProfileLaunchConfiguration,
  updateAgentProfiles,
  getAcpAgentSettings,
  getAcpLaunchConfiguration,
  getProviderKeySettings,
  getProviderKeySecret,
  updateProviderKeySettings,
  getAppUpdateSettings,
  getDisabledAppComponents,
  preserveLegacyNightlyChannel,
  getBackupSettings,
  getCodexDeveloperInstructionSettings,
  getCodexExecutionHostSettings,
  getCodexGitSettings,
  getCodexHomeSettings,
  getCodexExecutable,
  getCommandKeymapState,
  getDiagnosticsSettings,
  getHistorySettings,
  getManagedWorktreeSettings,
  getTelemetrySettings,
  getThreadNotificationSettings,
  getWindowRestoreSettings,
  getLanguagePreference,
  getTerminalShellSettings,
  updateTerminalShellSettings,
  getComposerPredictionSettings,
  getAgentRuntimeSettings,
  updateAgentRuntimeSettings,
  getUsageMeterSettings,
  getLinkOpeningSettings,
  updateLinkOpeningSettings,
  updateUsageMeterSettings,
  getInboxSettings,
  resetCommandKeybindings,
  updateAppUpdateSettings,
  updateAppComponentPreference,
  updateAcpAgentSettings,
  updateBackupSettings,
  updateCodexDeveloperInstructionSettings,
  updateCodexExecutionHostSettings,
  updateCodexGitSettings,
  updateCodexHomeSettings,
  updateCodexExecutable,
  updateCommandKeybinding,
  updateDiagnosticsSettings,
  updateHistorySettings,
  updateManagedWorktreeSettings,
  updateTelemetrySettings,
  updateThreadNotificationSettings,
  updateWindowRestoreSettings,
  updateLanguagePreference,
  updateComposerPredictionSettings,
  updateInboxSettings,
  type ApplicationSettingsDocumentSource,
} from "./application-settings-persistence";
import { readSettingsTomlDocumentSnapshot } from "./settings-document";

export interface ApplicationSettingsSnapshot {
  readonly revision: string;
  readonly backup: BackupSettings;
  readonly history: HistorySettings;
  readonly diagnostics: DiagnosticsSettings;
  readonly telemetry: TelemetrySettings;
  readonly notifications: ThreadNotificationSettings;
  readonly developer: CodexDeveloperInstructionSettings;
  readonly git: CodexGitSettings;
  readonly codexHome: CodexHomeSettingsSnapshot;
  readonly codexExecutable: CodexExecutablePreference;
  readonly managedWorktrees: ManagedWorktreeSettings;
  readonly executionHosts: CodexExecutionHostSettings;
  readonly acpAgents: AcpAgentSettings;
  readonly agentProfiles: AgentProfile[];
  readonly providerKeys: ProviderKeySettings;
  readonly commandKeymap: CommandKeymapState;
  readonly appUpdate: AppUpdateSettings;
  readonly disabledAppComponents: readonly AppComponentId[];
  readonly terminalShell: TerminalShellSettings;
  readonly windowRestore: WindowRestoreSettings;
  readonly languagePreference: AppLocalePreference;
  readonly inbox: InboxSettings;
  readonly composerPredictions: ComposerPredictionSettings;
  readonly agentRuntime: AgentRuntimeSettings;
  readonly usageMeters: UsageMeterSettings;
  readonly modelPolicy: ModelPolicy;
  readonly linkOpening: LinkOpeningSettings;
}

export type ProviderKeySettingsMutation =
  | { readonly connection: ProviderKeyConnection; readonly key?: Redacted.Redacted }
  | { readonly removeId: string };

export interface ProviderKeySettingsChange {
  readonly settings: ProviderKeySettings;
  /** A replacement can have the same key hint as the previous key. */
  readonly savedKeyId?: string;
}

export type ApplicationSettingsCommand =
  | { readonly type: "update-terminal-shell"; readonly input: TerminalShellSettings }
  | { readonly type: "update-backup"; readonly input: UpdateBackupSettingsInput }
  | { readonly type: "update-history"; readonly input: UpdateHistorySettingsInput }
  | { readonly type: "update-diagnostics"; readonly input: UpdateDiagnosticsSettingsInput }
  | { readonly type: "update-telemetry"; readonly input: UpdateTelemetrySettingsInput }
  | {
      readonly type: "update-thread-notifications";
      readonly input: UpdateThreadNotificationSettingsInput;
    }
  | {
      readonly type: "update-developer-instructions";
      readonly input: UpdateCodexDeveloperInstructionSettingsInput;
    }
  | { readonly type: "update-git"; readonly input: UpdateCodexGitSettingsInput }
  | { readonly type: "update-codex-executable"; readonly input: string }
  | { readonly type: "update-codex-home"; readonly input: CodexHomeSettingsUpdateInput }
  | {
      readonly type: "update-managed-worktrees";
      readonly input: UpdateManagedWorktreeSettingsInput;
    }
  | {
      readonly type: "update-execution-hosts";
      readonly input: UpdateCodexExecutionHostSettingsInput;
    }
  | { readonly type: "update-acp-agents"; readonly input: UpdateAcpAgentSettingsInput }
  | { readonly type: "update-agent-profiles"; readonly input: AgentProfilesUpdate }
  | { readonly type: "update-provider-keys"; readonly input: ProviderKeySettingsMutation }
  | {
      readonly type: "update-command-keybinding";
      readonly commandId: string;
      readonly input: CommandKeybindingUpdate;
    }
  | { readonly type: "reset-command-keybindings" }
  | { readonly type: "update-app-update"; readonly input: UpdateAppUpdateSettingsInput }
  | { readonly type: "update-app-component"; readonly input: SetAppComponentEnabledInput }
  | { readonly type: "update-window-restore"; readonly input: UpdateWindowRestoreSettingsInput }
  | { readonly type: "update-language"; readonly input: AppLocalePreference }
  | { readonly type: "update-agent-runtime"; readonly input: UpdateAgentRuntimeSettingsInput }
  | { readonly type: "update-composer-predictions"; readonly input: ComposerPredictionSettings }
  | { readonly type: "update-link-opening"; readonly input: LinkOpeningSettings }
  | { readonly type: "update-model-policy"; readonly input: ModelPolicy }
  | { readonly type: "update-usage-meters"; readonly input: UsageMeterSettings }
  | { readonly type: "update-inbox"; readonly input: UpdateInboxSettingsInput };

export class ApplicationSettingsError extends Schema.TaggedError<ApplicationSettingsError>()(
  "ApplicationSettingsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ApplicationSettingsConflictError extends Schema.TaggedError<ApplicationSettingsConflictError>()(
  "ApplicationSettingsConflictError",
  { expectedRevision: Schema.String, actualRevision: Schema.String },
) {}

export class ApplicationSettings extends Context.Service<
  ApplicationSettings,
  {
    /** Current Profile meter choices and subsequent saved changes. */
    readonly terminalShellSettingsChanges: Stream.Stream<TerminalShellSettings>;
    readonly linkOpeningSettingsChanges: Stream.Stream<LinkOpeningSettings>;
    readonly modelPolicyChanges: Stream.Stream<ModelPolicy>;
    readonly usageMeterSettingsChanges: Stream.Stream<UsageMeterSettings>;
    /** Latest saved preference; slow observers may coalesce intermediate invalidations. */
    readonly composerPredictionSettingsChanges: Stream.Stream<ComposerPredictionSettings>;
    /** Latest saved Inbox preferences, for work that waits on them. */
    readonly inboxSettingsChanges: Stream.Stream<InboxSettings>;
    readonly threadNotificationSettingsChanges: Stream.Stream<ThreadNotificationSettings>;
    readonly telemetrySettingsChanges: Stream.Stream<TelemetrySettings>;
    readonly acpLaunchConfiguration: (
      instanceId: string,
    ) => Effect.Effect<ReturnType<typeof getAcpLaunchConfiguration>, ApplicationSettingsError>;
    readonly agentProfileLaunchConfiguration: <Driver extends ProfileAgentDriver>(
      driver: Driver,
      instanceId: string,
    ) => Effect.Effect<
      ReturnType<typeof getAgentProfileLaunchConfiguration<Driver>>,
      ApplicationSettingsError
    >;
    readonly providerKeySettingsChanges: Stream.Stream<ProviderKeySettingsChange>;
    readonly providerKeySecret: (
      id: string,
    ) => Effect.Effect<Redacted.Redacted, ApplicationSettingsError>;
    readonly pluginScopes?: Effect.Effect<
      Readonly<Record<string, PluginProjectScope>>,
      ApplicationSettingsError
    >;
    readonly setPluginScope?: (
      id: string,
      scope: PluginProjectScope,
    ) => Effect.Effect<void, ApplicationSettingsError>;
    readonly snapshot: () => Effect.Effect<ApplicationSettingsSnapshot, ApplicationSettingsError>;
    readonly update: (
      command: ApplicationSettingsCommand,
      options?: {
        readonly expectedRevision?: string;
      },
    ) => Effect.Effect<
      ApplicationSettingsSnapshot,
      ApplicationSettingsError | ApplicationSettingsConflictError
    >;
  }
>()("nodex/main/settings/ApplicationSettings") {}

export interface PreparedCommandKeymapMutation {
  readonly command: Extract<
    ApplicationSettingsCommand,
    { readonly type: "update-command-keybinding" | "reset-command-keybindings" }
  >;
  readonly expectedRevision: string;
  readonly previousState: CommandKeymapState;
  readonly nextState: CommandKeymapState;
}

/** Purely computes the shortcut state used for native admission before a CAS commit. */
export function prepareCommandKeymapMutation(
  snapshot: ApplicationSettingsSnapshot,
  command: PreparedCommandKeymapMutation["command"],
): PreparedCommandKeymapMutation {
  const currentOverrides = snapshot.commandKeymap.entries.reduce<CommandKeybindingOverrides>(
    (overrides, entry) => {
      if (entry.customKeybindings === null) return overrides;
      overrides[entry.id] = entry.customKeybindings.flatMap((binding) =>
        binding.key === null ? [] : [binding.key],
      );
      return overrides;
    },
    {},
  );
  const nextState =
    command.type === "reset-command-keybindings"
      ? createCommandKeymapState({})
      : createCommandKeymapState(
          applyCommandKeybindingUpdate(currentOverrides, command.commandId, command.input),
        );
  return {
    command,
    expectedRevision: snapshot.revision,
    previousState: snapshot.commandKeymap,
    nextState,
  };
}

function makeSnapshot(source: ApplicationSettingsDocumentSource): ApplicationSettingsSnapshot {
  migrateProfileAgentProfiles(source);
  const document = readSettingsTomlDocumentSnapshot(source.settingsPath);
  const snapshotSource: ApplicationSettingsDocumentSource = {
    ...source,
    document: document.document,
  };
  const codexHome = getCodexHomeSettings(snapshotSource);
  const executable = getCodexExecutable(snapshotSource);
  const agentProfiles = getAgentProfiles(snapshotSource);
  return {
    revision: document.bytes
      ? createHash("sha256").update(document.bytes).digest("hex")
      : "missing",
    backup: getBackupSettings(snapshotSource),
    history: getHistorySettings(snapshotSource),
    diagnostics: getDiagnosticsSettings(snapshotSource),
    telemetry: getTelemetrySettings(snapshotSource),
    notifications: getThreadNotificationSettings(snapshotSource),
    developer: getCodexDeveloperInstructionSettings(snapshotSource),
    git: getCodexGitSettings(snapshotSource),
    codexExecutable: { executable, activeExecutable: executable },
    codexHome: {
      ...codexHome,
      activeHomePath: codexHome.resolvedHomePath,
      activeAccountHomePath: codexHome.resolvedAccountHomePath,
      restartRequired: false,
    },
    managedWorktrees: getManagedWorktreeSettings(snapshotSource),
    executionHosts: getCodexExecutionHostSettings(snapshotSource),
    acpAgents: getAcpAgentSettings(snapshotSource),
    agentProfiles,
    providerKeys: getProviderKeySettings(snapshotSource),
    commandKeymap: getCommandKeymapState(snapshotSource),
    appUpdate: getAppUpdateSettings(snapshotSource),
    disabledAppComponents: getDisabledAppComponents(snapshotSource),
    windowRestore: getWindowRestoreSettings(snapshotSource),
    languagePreference: getLanguagePreference(snapshotSource),
    terminalShell: getTerminalShellSettings(snapshotSource),
    inbox: getInboxSettings(snapshotSource),
    composerPredictions: getComposerPredictionSettings(snapshotSource),
    agentRuntime: getAgentRuntimeSettings(snapshotSource),
    usageMeters: getUsageMeterSettings(snapshotSource),
    modelPolicy: getModelPolicy(snapshotSource),
    linkOpening: getLinkOpeningSettings(snapshotSource),
  };
}

function applyCommand(
  source: ApplicationSettingsDocumentSource,
  command: ApplicationSettingsCommand,
): void {
  switch (command.type) {
    case "update-backup":
      updateBackupSettings(command.input, source);
      return;
    case "update-history":
      updateHistorySettings(command.input, source);
      return;
    case "update-diagnostics":
      updateDiagnosticsSettings(command.input, source);
      return;
    case "update-telemetry":
      updateTelemetrySettings(command.input, source);
      return;
    case "update-thread-notifications":
      updateThreadNotificationSettings(command.input, source);
      return;
    case "update-developer-instructions":
      updateCodexDeveloperInstructionSettings(command.input, source);
      return;
    case "update-git":
      updateCodexGitSettings(command.input, source);
      return;
    case "update-codex-executable":
      updateCodexExecutable(command.input, source);
      return;
    case "update-codex-home":
      updateCodexHomeSettings(command.input, source);
      return;
    case "update-managed-worktrees":
      updateManagedWorktreeSettings(command.input, source);
      return;
    case "update-execution-hosts":
      updateCodexExecutionHostSettings(command.input, source);
      return;
    case "update-agent-profiles":
      updateAgentProfiles(command.input, source);
      return;
    case "update-provider-keys":
      updateProviderKeySettings(
        "removeId" in command.input
          ? command.input
          : {
              connection: command.input.connection,
              key: command.input.key ? Redacted.value(command.input.key) : undefined,
            },
        source,
      );
      return;
    case "update-acp-agents":
      updateAcpAgentSettings(command.input, source);
      return;
    case "update-command-keybinding":
      updateCommandKeybinding(command.commandId, command.input, source);
      return;
    case "reset-command-keybindings":
      resetCommandKeybindings(source);
      return;
    case "update-app-component":
      updateAppComponentPreference(command.input, source);
      return;
    case "update-app-update":
      updateAppUpdateSettings(command.input, source);
      return;
    case "update-terminal-shell":
      updateTerminalShellSettings(command.input, source);
      return;
    case "update-window-restore":
      updateWindowRestoreSettings(command.input, source);
      return;
    case "update-language":
      updateLanguagePreference(command.input, source);
      return;
    case "update-agent-runtime":
      updateAgentRuntimeSettings(command.input, source);
      return;
    case "update-composer-predictions":
      updateComposerPredictionSettings(command.input, source);
      return;
    case "update-link-opening":
      updateLinkOpeningSettings(command.input, source);
      return;
    case "update-model-policy":
      updateModelPolicy(command.input, source);
      break;
    case "update-usage-meters":
      updateUsageMeterSettings(command.input, source);
      return;
    case "update-inbox":
      updateInboxSettings(command.input, source);
      return;
  }
}

export const make = Effect.fn("ApplicationSettings.make")(function* (input: {
  readonly hostHomeDirectory: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly isPackaged?: boolean;
  readonly settingsPath: string;
  readonly secretEncryption?: SecretEncryptionAdapter;
}) {
  const source: ApplicationSettingsDocumentSource = {
    hostHomeDirectory: input.hostHomeDirectory,
    environment: Object.freeze({ ...input.environment }),
    ...(input.isPackaged === undefined ? {} : { isPackaged: input.isPackaged }),
    settingsPath: input.settingsPath,
    ...(input.secretEncryption ? { secretEncryption: input.secretEncryption } : {}),
  };
  const writes = yield* Semaphore.make(1);
  const terminalShell = yield* SubscriptionRef.make(DEFAULT_TERMINAL_SHELL_SETTINGS);
  const modelPolicy = yield* SubscriptionRef.make(DEFAULT_MODEL_POLICY);
  const usageMeters = yield* SubscriptionRef.make(DEFAULT_USAGE_METER_SETTINGS);
  const linkOpening = yield* SubscriptionRef.make(DEFAULT_LINK_OPENING_SETTINGS);
  // Observers invalidate predictions and reread settings before admitting new work.
  const composerPredictionChanges = yield* PubSub.sliding<ComposerPredictionSettings>(1);
  yield* Effect.addFinalizer(() => PubSub.shutdown(composerPredictionChanges));
  const inboxChanges = yield* PubSub.sliding<InboxSettings>(1);
  yield* Effect.addFinalizer(() => PubSub.shutdown(inboxChanges));
  // Keep disable edges even if a slow observer sees an immediate re-enable; backpressure avoids loss.
  const threadNotificationChanges = yield* PubSub.bounded<ThreadNotificationSettings>(16);
  yield* Effect.addFinalizer(() => PubSub.shutdown(threadNotificationChanges));
  // A replaced key retires its old usage reading, so every change reaches observers; backpressure avoids loss.
  const providerKeyChanges = yield* PubSub.bounded<ProviderKeySettingsChange>(16);
  yield* Effect.addFinalizer(() => PubSub.shutdown(providerKeyChanges));
  const telemetryChanges = yield* PubSub.sliding<TelemetrySettings>(1);
  yield* Effect.addFinalizer(() => PubSub.shutdown(telemetryChanges));
  // Home and executable stay fixed for this Main lifetime; saved changes apply after restart.
  const activeCodexHome = yield* Ref.make<
    | {
        readonly home: string;
        readonly account: string | null;
        readonly executable: string;
      }
    | undefined
  >(undefined);
  const attempt = <A>(operation: string, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new ApplicationSettingsError({ operation, cause }),
    });
  const readUnlocked = Effect.fn("ApplicationSettings.readUnlocked")(function* () {
    const snapshot = yield* attempt("read", () => makeSnapshot(source));
    if (!sameModelPolicy(yield* SubscriptionRef.get(modelPolicy), snapshot.modelPolicy)) {
      yield* SubscriptionRef.set(modelPolicy, snapshot.modelPolicy);
    }
    if (!sameUsageMeterSettings(yield* SubscriptionRef.get(usageMeters), snapshot.usageMeters)) {
      yield* SubscriptionRef.set(usageMeters, snapshot.usageMeters);
    }
    if (!sameLinkOpeningSettings(yield* SubscriptionRef.get(linkOpening), snapshot.linkOpening)) {
      yield* SubscriptionRef.set(linkOpening, snapshot.linkOpening);
    }
    if (
      (yield* SubscriptionRef.get(terminalShell)).windowsShell !==
      snapshot.terminalShell.windowsShell
    ) {
      yield* SubscriptionRef.set(terminalShell, snapshot.terminalShell);
    }
    const previousHome = yield* Ref.get(activeCodexHome);
    if (previousHome === undefined) {
      yield* Ref.set(activeCodexHome, {
        home: snapshot.codexHome.resolvedHomePath,
        account: snapshot.codexHome.resolvedAccountHomePath,
        executable: snapshot.codexExecutable.executable,
      });
    }
    const activeHomePath = previousHome?.home ?? snapshot.codexHome.resolvedHomePath;
    const activeAccountHomePath = previousHome
      ? previousHome.account
      : snapshot.codexHome.resolvedAccountHomePath;
    return {
      ...snapshot,
      codexExecutable: {
        ...snapshot.codexExecutable,
        activeExecutable: previousHome?.executable ?? snapshot.codexExecutable.executable,
      },
      codexHome: {
        ...snapshot.codexHome,
        activeHomePath,
        activeAccountHomePath,
        restartRequired:
          activeHomePath !== snapshot.codexHome.resolvedHomePath ||
          activeAccountHomePath !== snapshot.codexHome.resolvedAccountHomePath,
      },
    };
  });

  return ApplicationSettings.of({
    terminalShellSettingsChanges: SubscriptionRef.changes(terminalShell),
    usageMeterSettingsChanges: SubscriptionRef.changes(usageMeters),
    modelPolicyChanges: SubscriptionRef.changes(modelPolicy),
    linkOpeningSettingsChanges: SubscriptionRef.changes(linkOpening),
    composerPredictionSettingsChanges: Stream.fromPubSub(composerPredictionChanges),
    inboxSettingsChanges: Stream.fromPubSub(inboxChanges),
    threadNotificationSettingsChanges: Stream.fromPubSub(threadNotificationChanges),
    telemetrySettingsChanges: Stream.fromPubSub(telemetryChanges),
    acpLaunchConfiguration: (instanceId) =>
      writes.withPermits(1)(
        attempt("acp-launch-configuration", () => getAcpLaunchConfiguration(source, instanceId)),
      ),
    agentProfileLaunchConfiguration: (driver, instanceId) =>
      writes.withPermit(
        attempt("agent-profile-launch-configuration", () =>
          getAgentProfileLaunchConfiguration(source, driver, instanceId),
        ),
      ),
    providerKeySettingsChanges: Stream.unwrap(
      writes.withPermit(
        Effect.gen(function* () {
          const changes = yield* PubSub.subscribe(providerKeyChanges);
          const current = yield* Effect.option(readUnlocked());
          const initial = Stream.fromIterable(
            current._tag === "Some" ? [{ settings: current.value.providerKeys }] : [],
          );
          return Stream.concat(initial, Stream.fromSubscription(changes));
        }),
      ),
    ),
    providerKeySecret: (id) =>
      writes.withPermit(
        attempt("provider-key-secret", () => Redacted.make(getProviderKeySecret(source, id))),
      ),
    pluginScopes: writes.withPermits(1)(
      attempt("read-plugin-scopes", () => readPluginScopes(source)),
    ),
    setPluginScope: (id, scope) =>
      writes.withPermits(1)(
        attempt("write-plugin-scope", () => writePluginScope(source, id, scope)),
      ),
    snapshot: () => writes.withPermits(1)(readUnlocked()),
    update: (command, options = {}) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const { revision: actualRevision, composerPredictions: previousComposerPredictions } =
            yield* readUnlocked();
          if (
            options.expectedRevision !== undefined &&
            actualRevision !== options.expectedRevision
          ) {
            return yield* new ApplicationSettingsConflictError({
              expectedRevision: options.expectedRevision,
              actualRevision,
            });
          }
          yield* attempt(command.type, () => applyCommand(source, command));
          const snapshot = yield* readUnlocked();
          if (snapshot.composerPredictions.enabled !== previousComposerPredictions.enabled) {
            yield* PubSub.publish(composerPredictionChanges, snapshot.composerPredictions);
          }
          if (command.type === "update-provider-keys") {
            const input = command.input;
            yield* PubSub.publish(providerKeyChanges, {
              settings: snapshot.providerKeys,
              ...("connection" in input && input.key ? { savedKeyId: input.connection.id } : {}),
            });
          }
          if (command.type === "update-thread-notifications")
            yield* PubSub.publish(threadNotificationChanges, snapshot.notifications);
          if (command.type === "update-inbox") yield* PubSub.publish(inboxChanges, snapshot.inbox);
          if (command.type === "update-telemetry")
            yield* PubSub.publish(telemetryChanges, snapshot.telemetry);
          return snapshot;
        }),
      ),
  });
});

export const live: Layer.Layer<ApplicationSettings, never, MainConfig | SecretEncryption> =
  Layer.effect(
    ApplicationSettings,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const source = {
        hostHomeDirectory: config.homeDirectory,
        environment: config.environment,
        isPackaged: config.isPackaged,
        settingsPath: config.profileSettingsPath,
        secretEncryption: yield* SecretEncryption,
      };
      yield* Effect.sync(() => {
        try {
          preserveLegacyNightlyChannel(source, config.nodexHome, config.appVersion);
        } catch (error) {
          getLogger({ component: "app-update-settings" }).warn(
            "Could not preserve the previous update channel",
            { error },
          );
        }
      });
      return yield* make(source);
    }),
  );
