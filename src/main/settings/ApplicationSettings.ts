import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  AppUpdateSettings,
  BackupSettings,
  CodexDeveloperInstructionSettings,
  CodexExecutionHostSettings,
  CodexGitSettings,
  DiagnosticsSettings,
  HistorySettings,
  ManagedWorktreeSettings,
  TelemetrySettings,
  ThreadNotificationSettings,
  UpdateAppUpdateSettingsInput,
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
import {
  getAppUpdateSettings,
  getBackupSettings,
  getCodexDeveloperInstructionSettings,
  getCodexExecutionHostSettings,
  getCodexGitSettings,
  getCommandKeymapState,
  getDiagnosticsSettings,
  getHistorySettings,
  getManagedWorktreeSettings,
  getTelemetrySettings,
  getThreadNotificationSettings,
  getWindowRestoreSettings,
  resetCommandKeybindings,
  updateAppUpdateSettings,
  updateBackupSettings,
  updateCodexDeveloperInstructionSettings,
  updateCodexExecutionHostSettings,
  updateCodexGitSettings,
  updateCommandKeybinding,
  updateDiagnosticsSettings,
  updateHistorySettings,
  updateManagedWorktreeSettings,
  updateTelemetrySettings,
  updateThreadNotificationSettings,
  updateWindowRestoreSettings,
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
  readonly managedWorktrees: ManagedWorktreeSettings;
  readonly executionHosts: CodexExecutionHostSettings;
  readonly commandKeymap: CommandKeymapState;
  readonly appUpdate: AppUpdateSettings;
  readonly windowRestore: WindowRestoreSettings;
}

export type ApplicationSettingsCommand =
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
  | {
      readonly type: "update-managed-worktrees";
      readonly input: UpdateManagedWorktreeSettingsInput;
    }
  | {
      readonly type: "update-execution-hosts";
      readonly input: UpdateCodexExecutionHostSettingsInput;
    }
  | {
      readonly type: "update-command-keybinding";
      readonly commandId: string;
      readonly input: CommandKeybindingUpdate;
    }
  | { readonly type: "reset-command-keybindings" }
  | { readonly type: "update-app-update"; readonly input: UpdateAppUpdateSettingsInput }
  | { readonly type: "update-window-restore"; readonly input: UpdateWindowRestoreSettingsInput };

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
    readonly snapshot: (
      buildDefaultChannel?: AppUpdateSettings["channel"],
    ) => Effect.Effect<ApplicationSettingsSnapshot, ApplicationSettingsError>;
    readonly update: (
      command: ApplicationSettingsCommand,
      options?: {
        readonly expectedRevision?: string;
        readonly buildDefaultChannel?: AppUpdateSettings["channel"];
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

function makeSnapshot(
  source: ApplicationSettingsDocumentSource,
  buildDefaultChannel: AppUpdateSettings["channel"] = "stable",
): ApplicationSettingsSnapshot {
  const document = readSettingsTomlDocumentSnapshot(source.settingsPath);
  const snapshotSource: ApplicationSettingsDocumentSource = {
    ...source,
    document: document.document,
  };
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
    managedWorktrees: getManagedWorktreeSettings(snapshotSource),
    executionHosts: getCodexExecutionHostSettings(snapshotSource),
    commandKeymap: getCommandKeymapState(snapshotSource),
    appUpdate: getAppUpdateSettings(snapshotSource, buildDefaultChannel),
    windowRestore: getWindowRestoreSettings(snapshotSource),
  };
}

function applyCommand(
  source: ApplicationSettingsDocumentSource,
  command: ApplicationSettingsCommand,
  buildDefaultChannel: AppUpdateSettings["channel"],
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
    case "update-managed-worktrees":
      updateManagedWorktreeSettings(command.input, source);
      return;
    case "update-execution-hosts":
      updateCodexExecutionHostSettings(command.input, source);
      return;
    case "update-command-keybinding":
      updateCommandKeybinding(command.commandId, command.input, source);
      return;
    case "reset-command-keybindings":
      resetCommandKeybindings(source);
      return;
    case "update-app-update":
      updateAppUpdateSettings(command.input, source, buildDefaultChannel);
      return;
    case "update-window-restore":
      updateWindowRestoreSettings(command.input, source);
      return;
  }
}

export const make = Effect.fn("ApplicationSettings.make")(function* (input: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly settingsPath: string;
}) {
  const source: ApplicationSettingsDocumentSource = {
    environment: Object.freeze({ ...input.environment }),
    settingsPath: input.settingsPath,
  };
  const writes = yield* Semaphore.make(1);
  const attempt = <A>(operation: string, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new ApplicationSettingsError({ operation, cause }),
    });
  const readUnlocked = (buildDefaultChannel: AppUpdateSettings["channel"] = "stable") =>
    attempt("read", () => makeSnapshot(source, buildDefaultChannel));

  return ApplicationSettings.of({
    snapshot: (buildDefaultChannel = "stable") =>
      writes.withPermits(1)(readUnlocked(buildDefaultChannel)),
    update: (command, options = {}) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const actualRevision = yield* attempt(
            "read-revision",
            () => makeSnapshot(source, options.buildDefaultChannel ?? "stable").revision,
          );
          if (
            options.expectedRevision !== undefined &&
            actualRevision !== options.expectedRevision
          ) {
            return yield* new ApplicationSettingsConflictError({
              expectedRevision: options.expectedRevision,
              actualRevision,
            });
          }
          yield* attempt(command.type, () =>
            applyCommand(source, command, options.buildDefaultChannel ?? "stable"),
          );
          return yield* readUnlocked(options.buildDefaultChannel ?? "stable");
        }),
      ),
  });
});

export const live: Layer.Layer<ApplicationSettings, never, MainConfig> = Layer.effect(
  ApplicationSettings,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return yield* make({
      environment: config.environment,
      settingsPath: config.profileSettingsPath,
    });
  }),
);
