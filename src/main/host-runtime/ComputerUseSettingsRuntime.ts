import { hostCapabilities } from "../../shared/host-capabilities";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  isComputerUseSoundMode,
  type ComputerUseApprovedApp,
  type ComputerUseApprovedMessageThread,
  type ComputerUseSettingsSnapshot,
  type ComputerUseSoundMode,
} from "../../shared/computer-use-settings";
import type { ComputerUseRuntimeResult } from "./ComputerUseRuntime";
import { MainConfig } from "../app/MainConfig";
import { DesktopToolRuntime } from "./DesktopToolRuntime";
import { RemoteHostedPipRuntime } from "./RemoteHostedPipRuntime";

const execFileAsync = promisify(execFile);
const COMPUTER_USE_APP_APPROVALS_FILENAME = "ComputerUseAppApprovals.json";
const COMPUTER_USE_MESSAGES_APPROVALS_FILENAME = "MessagesSendApprovals.json";
const COMPUTER_USE_GROUP_CONTAINER = "2DC432GLL2.com.openai.sky.CUAService";
const COMPUTER_USE_DEFAULTS_DOMAIN = "com.openai.sky.CUAService";
const COMPUTER_USE_SOUND_MODE_KEY = "computerUseSoundMode";
const DEFAULT_SOUND_MODE: ComputerUseSoundMode = "foregroundClicks";
const LOCKED_USE_INSTALLER_RELATIVE_PATH = path.join(
  "Contents",
  "SharedSupport",
  "Codex Computer Use Installer.app",
  "Contents",
  "MacOS",
  "Codex Computer Use Installer",
);

export class ComputerUseSettingsError extends Schema.TaggedError<ComputerUseSettingsError>()(
  "ComputerUseSettingsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ComputerUseSettingsRuntime extends Context.Service<
  ComputerUseSettingsRuntime,
  {
    readonly getSnapshot: Effect.Effect<ComputerUseSettingsSnapshot, ComputerUseSettingsError>;
    readonly removeAppApproval: (
      bundleIdentifier: string,
    ) => Effect.Effect<ComputerUseSettingsSnapshot, ComputerUseSettingsError>;
    readonly removeMessageApproval: (
      chatGuid: string,
    ) => Effect.Effect<ComputerUseSettingsSnapshot, ComputerUseSettingsError>;
    readonly setAlwaysHidePictureInPicture: (
      value: boolean,
    ) => Effect.Effect<ComputerUseSettingsSnapshot, ComputerUseSettingsError>;
    readonly setLockedUseEnabled: (
      value: boolean,
    ) => Effect.Effect<ComputerUseSettingsSnapshot, ComputerUseSettingsError>;
    readonly setSoundMode: (
      value: ComputerUseSoundMode,
    ) => Effect.Effect<ComputerUseSettingsSnapshot, ComputerUseSettingsError>;
  }
>()("nodex/main/host-runtime/ComputerUseSettingsRuntime") {}

interface AppApprovalsFile {
  readonly approvedBundleIdentifiers: readonly string[];
}

interface MessagesApprovalsFile {
  readonly approvedChats: Readonly<Record<string, string>>;
}

interface ExecResult {
  readonly stderr: string;
  readonly stdout: string;
}

export interface ComputerUseSettingsPorts {
  readonly exec: (
    executablePath: string,
    args: readonly string[],
    options?: { readonly timeout: number },
  ) => Effect.Effect<ExecResult, ComputerUseSettingsError>;
  readonly getAlwaysHide: () => boolean;
  readonly getRuntimeResult: Effect.Effect<ComputerUseRuntimeResult, ComputerUseSettingsError>;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly readLockedUseAllowed: Effect.Effect<boolean, ComputerUseSettingsError>;
  readonly setAlwaysHide: (value: boolean) => Effect.Effect<void, ComputerUseSettingsError>;
}

const settingsError = (operation: string, cause: unknown) =>
  new ComputerUseSettingsError({ operation, cause });

function normalizedUniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.flatMap((value) => {
        if (typeof value !== "string") return [];
        const normalized = value.trim();
        return normalized ? [normalized] : [];
      }),
    ),
  ];
}

function parseAppApprovals(value: unknown): AppApprovalsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { approvedBundleIdentifiers: [] };
  }
  return {
    approvedBundleIdentifiers: normalizedUniqueStrings(
      Reflect.get(value, "approvedBundleIdentifiers"),
    ),
  };
}

function parseMessagesApprovals(value: unknown): MessagesApprovalsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { approvedChats: {} };
  }
  const candidate = Reflect.get(value, "approvedChats");
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { approvedChats: {} };
  }
  const approvedChats: Record<string, string> = {};
  for (const [rawGuid, rawDisplayName] of Object.entries(candidate)) {
    const chatGuid = rawGuid.trim();
    const displayName = typeof rawDisplayName === "string" ? rawDisplayName.trim() : "";
    if (!chatGuid || !displayName) continue;
    approvedChats[chatGuid] = displayName;
  }
  return { approvedChats };
}

const requireIdentifier = (
  value: string,
  label: string,
): Effect.Effect<string, ComputerUseSettingsError> =>
  Effect.try({
    try: () => {
      const normalized = value.trim();
      if (!normalized || normalized.length > 1_024) throw new Error(`${label} is invalid`);
      return normalized;
    },
    catch: (cause) => settingsError("validate-identifier", cause),
  });

const readJsonFile = (filePath: string): Effect.Effect<unknown> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await fs.readFile(filePath, "utf8")),
    catch: (cause) => settingsError("read-json", cause),
  }).pipe(Effect.orElseSucceed(() => null));

const writeJsonFileAtomically = (
  filePath: string,
  value: unknown,
): Effect.Effect<void, ComputerUseSettingsError> =>
  Effect.gen(function* () {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    yield* Effect.tryPromise({
      try: () => fs.mkdir(path.dirname(filePath), { recursive: true }),
      catch: (cause) => settingsError("create-settings-directory", cause),
    });
    yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () =>
          fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          }),
        catch: (cause) => settingsError("write-settings", cause),
      });
      yield* Effect.tryPromise({
        try: () => fs.rename(temporaryPath, filePath),
        catch: (cause) => settingsError("commit-settings", cause),
      });
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => fs.rm(temporaryPath, { force: true })).pipe(Effect.ignore),
      ),
    );
  });

const make = (
  ports: ComputerUseSettingsPorts,
): Effect.Effect<ComputerUseSettingsRuntime["Service"]> =>
  Effect.gen(function* () {
    const mutationLock = yield* Semaphore.make(1);
    const applicationSupportPath = path.join(
      ports.homeDirectory,
      "Library",
      "Group Containers",
      COMPUTER_USE_GROUP_CONTAINER,
      "Library",
      "Application Support",
      "Software",
    );
    const appApprovalsPath = path.join(applicationSupportPath, COMPUTER_USE_APP_APPROVALS_FILENAME);
    const messagesApprovalsPath = path.join(
      applicationSupportPath,
      COMPUTER_USE_MESSAGES_APPROVALS_FILENAME,
    );
    const resolveLockedUseInstallerPath = (appPath: string) =>
      path.join(appPath, LOCKED_USE_INSTALLER_RELATIVE_PATH);
    const readApprovedApps: Effect.Effect<ComputerUseApprovedApp[]> = readJsonFile(
      appApprovalsPath,
    ).pipe(
      Effect.map((value) =>
        parseAppApprovals(value).approvedBundleIdentifiers.map((bundleIdentifier) => ({
          bundleIdentifier,
          displayName: bundleIdentifier,
        })),
      ),
    );
    const readApprovedMessageThreads: Effect.Effect<ComputerUseApprovedMessageThread[]> =
      readJsonFile(messagesApprovalsPath).pipe(
        Effect.map((value) =>
          Object.entries(parseMessagesApprovals(value).approvedChats)
            .map(([chatGuid, displayName]) => ({ chatGuid, displayName }))
            .sort(
              (left, right) =>
                left.displayName.localeCompare(right.displayName) ||
                left.chatGuid.localeCompare(right.chatGuid),
            ),
        ),
      );
    const readSoundMode: Effect.Effect<ComputerUseSoundMode> = !hostCapabilities(ports.platform)
      .computerControl
      ? Effect.succeed(DEFAULT_SOUND_MODE)
      : ports
          .exec("/usr/bin/defaults", [
            "read",
            COMPUTER_USE_DEFAULTS_DOMAIN,
            COMPUTER_USE_SOUND_MODE_KEY,
          ])
          .pipe(
            Effect.map(({ stdout }) => {
              const value = stdout.trim();
              return isComputerUseSoundMode(value) ? value : DEFAULT_SOUND_MODE;
            }),
            Effect.orElseSucceed(() => DEFAULT_SOUND_MODE),
          );
    const readLockedUseEnabled = (appPath: string): Effect.Effect<boolean> =>
      !hostCapabilities(ports.platform).computerControl
        ? Effect.succeed(false)
        : ports.exec(resolveLockedUseInstallerPath(appPath), ["status"], { timeout: 120_000 }).pipe(
            Effect.map(({ stdout }) => stdout.trim() === "OK: installed"),
            Effect.orElseSucceed(() => false),
          );
    const getSnapshot = Effect.gen(function* () {
      const runtime = yield* ports.getRuntimeResult;
      const available = runtime.status === "available";
      const [approvedApps, approvedMessageThreads, soundMode, lockedUseAllowed] = yield* Effect.all(
        [
          readApprovedApps,
          readApprovedMessageThreads,
          readSoundMode,
          available
            ? ports.readLockedUseAllowed.pipe(Effect.orElseSucceed(() => false))
            : Effect.succeed(false),
        ] as const,
        { concurrency: "unbounded" },
      );
      const lockedUseEnabled =
        lockedUseAllowed && runtime.status === "available"
          ? yield* readLockedUseEnabled(runtime.appPath)
          : null;
      return {
        alwaysHidePictureInPicture: ports.getAlwaysHide(),
        approvedApps,
        approvedMessageThreads,
        available,
        lockedUseAllowed,
        lockedUseEnabled,
        message: runtime.status === "unavailable" ? runtime.message : null,
        soundMode,
      } satisfies ComputerUseSettingsSnapshot;
    });
    const mutate = <A>(effect: Effect.Effect<A, ComputerUseSettingsError>) =>
      mutationLock.withPermits(1)(effect);

    return ComputerUseSettingsRuntime.of({
      getSnapshot,
      removeAppApproval: (bundleIdentifier) =>
        mutate(
          Effect.gen(function* () {
            const identifier = yield* requireIdentifier(bundleIdentifier, "Bundle identifier");
            const current = parseAppApprovals(yield* readJsonFile(appApprovalsPath));
            yield* writeJsonFileAtomically(appApprovalsPath, {
              approvedBundleIdentifiers: current.approvedBundleIdentifiers.filter(
                (entry) => entry !== identifier,
              ),
            });
            return yield* getSnapshot;
          }),
        ),
      removeMessageApproval: (chatGuid) =>
        mutate(
          Effect.gen(function* () {
            const identifier = yield* requireIdentifier(chatGuid, "Message thread identifier");
            const current = parseMessagesApprovals(yield* readJsonFile(messagesApprovalsPath));
            yield* writeJsonFileAtomically(messagesApprovalsPath, {
              approvedChats: Object.fromEntries(
                Object.entries(current.approvedChats).filter(([entry]) => entry !== identifier),
              ),
            });
            return yield* getSnapshot;
          }),
        ),
      setAlwaysHidePictureInPicture: (value) =>
        mutate(ports.setAlwaysHide(value).pipe(Effect.andThen(getSnapshot))),
      setLockedUseEnabled: (value) =>
        mutate(
          Effect.gen(function* () {
            const runtime = yield* ports.getRuntimeResult;
            if (runtime.status !== "available") {
              return yield* settingsError(
                "set-locked-use",
                new Error("Computer Use is unavailable"),
              );
            }
            const allowed = yield* ports.readLockedUseAllowed.pipe(
              Effect.orElseSucceed(() => false),
            );
            if (!allowed) {
              return yield* settingsError(
                "set-locked-use",
                new Error("Locked use is disabled by configuration requirements"),
              );
            }
            yield* ports.exec(
              resolveLockedUseInstallerPath(runtime.appPath),
              [value ? "install" : "uninstall"],
              { timeout: 120_000 },
            );
            return yield* getSnapshot;
          }),
        ),
      setSoundMode: (value) =>
        mutate(
          Effect.gen(function* () {
            if (!isComputerUseSoundMode(value)) {
              return yield* settingsError(
                "set-sound-mode",
                new Error("Computer Use sound mode is invalid"),
              );
            }
            if (hostCapabilities(ports.platform).computerControl) {
              yield* ports.exec("/usr/bin/defaults", [
                "write",
                COMPUTER_USE_DEFAULTS_DOMAIN,
                COMPUTER_USE_SOUND_MODE_KEY,
                value,
              ]);
            }
            return yield* getSnapshot;
          }),
        ),
    });
  });

export const live: Layer.Layer<
  ComputerUseSettingsRuntime,
  never,
  DesktopToolRuntime | MainConfig | RemoteHostedPipRuntime
> = Layer.effect(
  ComputerUseSettingsRuntime,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const desktopTools = yield* DesktopToolRuntime;
    const remoteHostedPip = yield* RemoteHostedPipRuntime;
    const exec = (
      executablePath: string,
      args: readonly string[],
      options?: { readonly timeout: number },
    ) =>
      Effect.tryPromise({
        try: async () => {
          const result = await execFileAsync(executablePath, [...args], {
            ...options,
            encoding: "utf8",
          });
          return { stderr: String(result.stderr), stdout: String(result.stdout) };
        },
        catch: (cause) => settingsError("exec", cause),
      });
    return yield* make({
      exec,
      getAlwaysHide: remoteHostedPip.getAlwaysHide,
      getRuntimeResult: desktopTools.ensureComputerUse.pipe(
        Effect.mapError((cause) => settingsError("computer-use-runtime", cause)),
      ),
      homeDirectory: homedir(),
      platform: config.platform as NodeJS.Platform,
      readLockedUseAllowed: desktopTools.readConfigRequirements.pipe(
        Effect.map(
          (response) => response.requirements?.computerUse?.allowLockedComputerUse === true,
        ),
        Effect.mapError((cause) => settingsError("read-config-requirements", cause)),
      ),
      setAlwaysHide: (value) =>
        remoteHostedPip
          .setAlwaysHide(value)
          .pipe(Effect.mapError((cause) => settingsError("set-always-hide", cause))),
    });
  }),
);

export const testLayer = (
  ports: ComputerUseSettingsPorts,
): Layer.Layer<ComputerUseSettingsRuntime> => Layer.effect(ComputerUseSettingsRuntime, make(ports));
