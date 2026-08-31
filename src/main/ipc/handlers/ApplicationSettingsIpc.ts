import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { IpcApi } from "../../../shared/ipc-api";
import {
  COMMAND_KEYBINDINGS_CHANGED_CHANNEL,
  CommandKeybindingValidationError,
  type CommandKeybindingMutationResult,
  type CommandKeybindingUpdate,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";
import type {
  UpdateAcpAgentSettingsInput,
  UpdateBackupSettingsInput,
  UpdateCodexDeveloperInstructionSettingsInput,
  UpdateCodexGitSettingsInput,
  UpdateDiagnosticsSettingsInput,
  UpdateHistorySettingsInput,
  UpdateTelemetrySettingsInput,
  UpdateThreadNotificationSettingsInput,
  UpdateWindowRestoreSettingsInput,
} from "../../../shared/types";
import { MainConfig } from "../../app/MainConfig";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { ApplicationMenuRuntime } from "../../host-runtime/ApplicationMenuRuntime";
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
  | "settings:backup:get"
  | "settings:codex-developer:get"
  | "settings:diagnostics:get"
  | "settings:git:get"
  | "settings:history:get"
  | "settings:telemetry:get"
  | "settings:thread-notifications:get"
  | "settings:window-restore:get";

const BackupUpdate = z
  .object({
    autoEnabled: z.boolean(),
    intervalHours: z.number().int().min(1),
    retentionCount: z.number().int().nonnegative(),
    retentionGiB: z.number().int().min(0).max(8_192),
  })
  .strict() satisfies z.ZodType<UpdateBackupSettingsInput>;
const AcpAgentSettingsUpdate = z
  .object({
    instances: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(128),
            agentDefinitionId: z.string().trim().min(1).max(128),
            packageRoot: z.string().trim().min(1).max(4_096),
            nodeExecutable: z.string().trim().min(1).max(4_096),
            enabled: z.boolean(),
            credentials: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("inherit-host-profile") }).strict(),
              z
                .object({ kind: z.literal("isolated-home"), home: z.string().trim().min(1) })
                .strict(),
            ]),
            proxy: z.enum(["inherit-host", "isolated"]),
          })
          .strict(),
      )
      .max(16),
  })
  .strict() satisfies z.ZodType<UpdateAcpAgentSettingsInput>;
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
    clientKey: z.string(),
    environment: z.string(),
    autoCaptureEnabled: z.boolean(),
  })
  .strict() satisfies z.ZodType<UpdateTelemetrySettingsInput>;
const ThreadNotificationUpdate = z
  .object({
    turnMode: z.enum(["off", "unfocused", "always"]),
    permissionsEnabled: z.boolean(),
    questionsEnabled: z.boolean(),
  })
  .strict() satisfies z.ZodType<UpdateThreadNotificationSettingsInput>;
const DeveloperInstructionUpdate = z
  .object({ detailLevel: z.enum(["STEPS_PROSE", "STEPS_COMMANDS", "STEPS_EXECUTION"]) })
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
  | ApplicationMenuRuntime
  | ApplicationSettings
  | DictationRuntime
  | StoreAdministrationSchedulerRuntime
  | ElectronIpc
  | MainConfig
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const applicationSettings = yield* ApplicationSettings;
    const config = yield* MainConfig;
    const dictation = yield* DictationRuntime;
    const ipc = yield* ElectronIpc;
    const menus = yield* ApplicationMenuRuntime;
    const schedulers = yield* StoreAdministrationSchedulerRuntime;
    const windows = yield* WindowRuntime;
    const keybindingMutations = yield* Semaphore.make(1);
    const authorize = (event: IpcMainInvokeEvent, capability: string) =>
      Effect.try({
        try: () => {
          if (
            !isTrustedAppRendererIpcSender({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: windows.has(event.sender.id),
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
      applicationSettings
        .update(command)
        .pipe(Effect.map(select), Effect.mapError(settingsError(operation)));
    const handleRead = <Channel extends SettingsReadChannel>(
      channel: Channel,
      capability: string,
      select: (snapshot: ApplicationSettingsSnapshot) => IpcApi[Channel]["result"],
    ) =>
      ipc.handleQuery(channel, (event, ..._args: IpcApi[Channel]["args"]) =>
        authorize(event, capability).pipe(Effect.andThen(read(`read-${channel}`, select))),
      );
    const broadcastKeymap = (state: CommandKeymapState): void => {
      menus.refresh(state);
      safeBroadcastToWindows(windows.all(), COMMAND_KEYBINDINGS_CHANGED_CHANNEL, [state]);
    };
    const commitKeymap = (
      mutation: PreparedCommandKeymapMutation,
    ): Effect.Effect<CommandKeybindingMutationResult, ApplicationSettingsIpcError> =>
      dictation.syncCommandKeymap(mutation.nextState).pipe(
        Effect.flatMap((rejection) => {
          if (rejection) {
            return Effect.succeed<CommandKeybindingMutationResult>({
              type: "rejected" as const,
              state: mutation.previousState,
              reason: rejection,
            });
          }
          return applicationSettings
            .update(mutation.command, { expectedRevision: mutation.expectedRevision })
            .pipe(
              Effect.map((snapshot) => snapshot.commandKeymap),
              Effect.tap((state) => Effect.sync(() => broadcastKeymap(state))),
              Effect.map(
                (state) =>
                  ({ type: "applied" as const, state }) satisfies CommandKeybindingMutationResult,
              ),
              Effect.mapError(settingsError("commit-command-keybindings")),
            );
        }),
        Effect.catch((cause) =>
          dictation
            .restoreCommandKeymap(mutation.previousState)
            .pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
        ),
        Effect.mapError((cause) =>
          cause instanceof ApplicationSettingsIpcError
            ? cause
            : settingsError("synchronize-command-keybindings")(cause),
        ),
      );
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
                state: snapshot.commandKeymap,
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
    yield* handleRead("settings:acp-agents:get", "ACP Agent settings", (value) => value.acpAgents);
    yield* ipc.handlePlainCommand("settings:acp-agents:update", (event, input: unknown) =>
      authorize(event, "ACP Agent settings").pipe(
        Effect.andThen(
          parse("parse-acp-agent-settings", () => AcpAgentSettingsUpdate.parse(input)),
        ),
        Effect.flatMap((parsed) =>
          update(
            "update-acp-agent-settings",
            { type: "update-acp-agents", input: parsed },
            (value) => value.acpAgents,
          ),
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
    yield* handleRead(
      "settings:codex-developer:get",
      "Developer instruction settings",
      (value) => value.developer,
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
    yield* handleRead(
      "codex-command-keymap-state",
      "Command keybindings",
      (value) => value.commandKeymap,
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
