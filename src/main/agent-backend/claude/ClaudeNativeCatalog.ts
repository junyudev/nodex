import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute } from "node:path";
import { z } from "zod";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import type { ClaudeDiscovery } from "../../../shared/claude-models";
import {
  nativeSessionCatalogTitle,
  type NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import { nativeSessionCwdAvailable } from "../../platform/node/NativeSessionCatalogPaths";
import { MainConfig } from "../../app/MainConfig";
import { ClaudeSdk, claudeEnvironment } from "../../platform/node/ClaudeSdk";
import {
  claudeDiscoveryFingerprint,
  discoverClaudeSkills,
  probeClaudeVersion,
} from "../../platform/node/ClaudeDiscovery";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { agentRuntimeError, type AgentRuntimeError } from "../AgentRuntimeError";
import { claudeModelOptions } from "./ClaudeModels";
import {
  applyCodexWorktreeShellEnvironment,
  type CodexStoredShellEnvironment,
} from "../../codex/codex-worktree-shell-environment";

interface NativeDiscoveryLocation {
  readonly workspaceRoot: string;
  readonly workspaceEnvironment?: CodexStoredShellEnvironment | null;
}

export class ClaudeNativeCatalog extends Context.Service<
  ClaudeNativeCatalog,
  {
    readonly nativeHome: (instanceConfigId: string) => Effect.Effect<string, AgentRuntimeError>;
    readonly nativeCatalog: (input: {
      readonly instanceConfigId: string;
      readonly cursor?: string;
    }) => Effect.Effect<NativeSessionCatalogPage, AgentRuntimeError>;
    readonly nativeSessionInfo: (input: {
      readonly instanceConfigId: string;
      readonly nativeSessionId: string;
      readonly expectedHome?: string;
    }) => Effect.Effect<
      | (SDKSessionInfo & {
          readonly cwd: string;
          readonly nativeHome: string;
          readonly cwdAvailable: boolean;
        })
      | null,
      AgentRuntimeError
    >;
    readonly models: (
      instanceConfigId: string,
      workspaceRoot: string,
      forceReload?: boolean,
    ) => Effect.Effect<readonly AgentSessionConfigSelectOption[], AgentRuntimeError>;
    readonly discover: (
      instanceConfigId: string,
      location: NativeDiscoveryLocation,
      forceReload?: boolean,
    ) => Effect.Effect<ClaudeDiscovery, AgentRuntimeError>;
  }
>()("nodex/main/agent-backend/ClaudeNativeCatalog") {}

const failure = (
  operation: string,
  cause: unknown,
  reason: AgentRuntimeError["reason"] = "request",
) => agentRuntimeError({ operation: `Claude ${operation}`, reason, retryable: false, cause });
const CLAUDE_ACCOUNT_ENVIRONMENT_NAMES = new Set(["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR"]);
const claudeWorkspaceInheritsPath = (
  environment: CodexStoredShellEnvironment | null | undefined,
  platform: string,
) =>
  ![...Object.keys(environment?.set ?? {}), ...(environment?.exclude ?? [])].some((name) =>
    platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH",
  );
/** Worktree setup cannot select a different Claude account; explicit profile values win. */
const claudeLaunchEnvironment = (
  config: Pick<MainConfig["Service"], "environment" | "platform">,
  workspaceEnvironment: CodexStoredShellEnvironment | null | undefined,
  environmentOverrides: Readonly<Record<string, string>>,
) => {
  const environment = applyCodexWorktreeShellEnvironment(
    config.environment,
    workspaceEnvironment,
    config.platform,
  );
  return applyCodexWorktreeShellEnvironment(
    {
      ...Object.fromEntries(
        Object.entries(environment).filter(
          ([name]) => !CLAUDE_ACCOUNT_ENVIRONMENT_NAMES.has(name.toUpperCase()),
        ),
      ),
      ...Object.fromEntries(
        Object.entries(config.environment).filter(([name]) =>
          CLAUDE_ACCOUNT_ENVIRONMENT_NAMES.has(name.toUpperCase()),
        ),
      ),
    },
    { version: 1, set: environmentOverrides, exclude: [] },
    config.platform,
  );
};

/** Discovery owns short-lived SDK metadata queries; it never opens a Nodex execution Session. */
export const make = Effect.gen(function* () {
  const settings = yield* ApplicationSettings;
  const sdk = yield* ClaudeSdk;
  const config = yield* MainConfig;
  const lanes = yield* RcMap.make({ lookup: (_id: string) => Semaphore.make(1) });
  const discovery = yield* Semaphore.make(2);
  const catalogCache = new Map<string, { expires: number; value: ClaudeDiscovery }>();
  const nativeScope = Effect.fn("ClaudeNativeCatalog.nativeScope")(function* (
    instanceConfigId: string,
  ) {
    const launch = yield* settings
      .claudeLaunchConfiguration(instanceConfigId)
      .pipe(Effect.mapError((cause) => failure("settings", cause)));
    const input = {
      instance: launch.instance,
      environment: { ...config.environment, ...launch.environment },
    };
    const nativeHome = yield* sdk.nativeHome(input);
    return { input, nativeHome };
  });
  const nativeHome = (instanceConfigId: string) =>
    nativeScope(instanceConfigId).pipe(Effect.map((scope) => scope.nativeHome));
  const nativeCatalog = Effect.fn("ClaudeNativeCatalog.nativeCatalog")(function* (input: {
    readonly instanceConfigId: string;
    readonly cursor?: string;
  }) {
    const scope = yield* nativeScope(input.instanceConfigId);
    const offset = yield* Effect.try({
      try: () => {
        if (!input.cursor) return 0;
        const cursor = z
          .object({
            home: z.string(),
            instance: z.string(),
            offset: z.number().int().min(0).max(100_000),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
        if (cursor.home !== scope.nativeHome || cursor.instance !== input.instanceConfigId)
          throw new Error("The Claude Code profile changed. Refresh to see its conversations.");
        return cursor.offset;
      },
      catch: (cause) => failure("catalog cursor", cause),
    });
    const sessions = yield* sdk.listSessions(scope.input, offset);
    if ((yield* nativeHome(input.instanceConfigId)) !== scope.nativeHome)
      return yield* failure(
        "catalog",
        new Error("The Claude Code profile changed. Refresh to see its conversations."),
        "resource-not-found",
      );
    const candidates = yield* Effect.forEach(
      sessions.slice(0, 50),
      (session) =>
        Effect.gen(function* () {
          if (
            !session.cwd ||
            !Number.isSafeInteger(session.lastModified) ||
            session.lastModified < 0
          )
            return null;
          const available = yield* Effect.tryPromise({
            try: () => nativeSessionCwdAvailable(session.cwd!),
            catch: (cause) => failure("catalog working directory", cause),
          });
          return {
            nativeSessionId: session.sessionId,
            title: nativeSessionCatalogTitle(
              session.customTitle || session.summary,
              "Claude conversation",
            ),
            cwd: session.cwd,
            cwdAvailable: available,
            updatedAt: session.lastModified,
          };
        }),
      { concurrency: 4 },
    );
    return {
      nativeHome: scope.nativeHome,
      entries: candidates.filter((candidate) => candidate !== null),
      nextCursor:
        sessions.length > 50
          ? Buffer.from(
              JSON.stringify({
                home: scope.nativeHome,
                instance: input.instanceConfigId,
                offset: offset + 50,
              }),
            ).toString("base64url")
          : null,
    } satisfies NativeSessionCatalogPage;
  });
  const nativeSessionInfo = Effect.fn("ClaudeNativeCatalog.nativeSessionInfo")(function* (input: {
    readonly instanceConfigId: string;
    readonly nativeSessionId: string;
    readonly expectedHome?: string;
  }) {
    const scope = yield* nativeScope(input.instanceConfigId);
    if (input.expectedHome !== undefined && scope.nativeHome !== input.expectedHome)
      return yield* failure(
        "attachment",
        new Error("The Claude Code profile changed. Refresh to see its conversations."),
        "resource-not-found",
      );
    const info = yield* sdk.sessionInfo(scope.input, input.nativeSessionId);
    if (!info) return null;
    if (info.sessionId !== input.nativeSessionId || !info.cwd || !isAbsolute(info.cwd))
      return yield* failure(
        "import",
        new Error("This conversation has no recorded working folder, so it can’t be imported."),
        "resource-not-found",
      );
    const cwd = info.cwd;
    const available = yield* Effect.tryPromise({
      try: () => nativeSessionCwdAvailable(cwd),
      catch: (cause) => failure("working directory", cause),
    });
    if ((yield* nativeHome(input.instanceConfigId)) !== scope.nativeHome)
      return yield* failure(
        "attachment",
        new Error("The Claude Code profile changed. Refresh to see its conversations."),
        "resource-not-found",
      );
    return { ...info, cwd, nativeHome: scope.nativeHome, cwdAvailable: available };
  });
  const exclusive = <A, E, R>(id: string, action: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lane = yield* RcMap.get(lanes, id);
        return yield* lane.withPermits(1)(action);
      }),
    );
  const discover = (
    instanceConfigId: string,
    location: NativeDiscoveryLocation,
    forceReload = false,
  ) =>
    Effect.gen(function* () {
      const { workspaceRoot, workspaceEnvironment } = location;
      const { instance, environment } = yield* settings
        .claudeLaunchConfiguration(instanceConfigId)
        .pipe(Effect.mapError((cause) => failure("settings", cause)));
      const launchEnvironment = claudeLaunchEnvironment(config, workspaceEnvironment, environment);
      const key = claudeDiscoveryFingerprint(instance, launchEnvironment, workspaceRoot);
      return yield* exclusive(
        `discovery:${key}`,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (forceReload) catalogCache.delete(key);
          const cached = catalogCache.get(key);
          if (cached && cached.expires > now) return cached.value;
          const value = yield* discovery.withPermits(1)(
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* sdk.discover({
                  instance,
                  allowPathDiscovery: claudeWorkspaceInheritsPath(
                    workspaceEnvironment,
                    config.platform,
                  ),
                  environment: launchEnvironment,
                  cwd: workspaceRoot,
                });
                const nativeEnvironment = claudeEnvironment(launchEnvironment, instance);
                const configuration = yield* sdk.configuration({
                  instance,
                  environment: launchEnvironment,
                  cwd: workspaceRoot,
                });
                const skills = yield* discoverClaudeSkills(
                  nativeEnvironment,
                  workspaceRoot,
                  session.commands,
                  configuration.skillOverrides,
                );
                const version = yield* probeClaudeVersion(
                  session.diagnostics.health.executable,
                  nativeEnvironment,
                  workspaceRoot,
                );
                return {
                  models: claudeModelOptions(session.models, undefined, instance.customModels),
                  intelligence: session.intelligence,
                  commands: session.commands,
                  skills,
                  health: { ...session.diagnostics.health, version },
                  revision: key,
                } satisfies ClaudeDiscovery;
              }),
            ),
          );
          if (catalogCache.size >= 64) {
            const oldest = catalogCache.keys().next().value;
            if (oldest) catalogCache.delete(oldest);
          }
          catalogCache.set(key, { expires: now + 60_000, value });
          return value;
        }),
      );
    });
  return ClaudeNativeCatalog.of({
    nativeHome,
    nativeCatalog,
    nativeSessionInfo,
    models: (instanceConfigId, workspaceRoot, forceReload) =>
      discover(instanceConfigId, { workspaceRoot }, forceReload).pipe(
        Effect.map(({ models }) => models),
      ),
    discover,
  });
});
export const live = Layer.effect(ClaudeNativeCatalog, make);
