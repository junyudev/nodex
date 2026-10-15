import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import type { AgentModelCatalog } from "../../../shared/agent-model-catalog";
import { MainConfig } from "../../app/MainConfig";
import {
  applyCodexWorktreeShellEnvironment,
  type CodexStoredShellEnvironment,
} from "../../codex/codex-worktree-shell-environment";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { OpenCodeSdk, type OpenCodeLaunchInput } from "../../platform/node/OpenCodeSdk";
import { agentRuntimeError, AgentRuntimeError } from "../AgentRuntimeError";
import { openCodeCatalog } from "./OpenCodeModels";

export class OpenCodeModelCatalog extends Context.Service<
  OpenCodeModelCatalog,
  {
    readonly discover: (input: {
      readonly instanceConfigId: string;
      readonly workspaceRoot: string;
      readonly workspaceEnvironment?: CodexStoredShellEnvironment | null;
      readonly forceReload?: boolean;
    }) => Effect.Effect<AgentModelCatalog, AgentRuntimeError>;
  }
>()("nodex/main/agent-backend/OpenCodeModelCatalog") {}
const failure = (
  operation: string,
  message: string,
  reason: AgentRuntimeError["reason"] = "request",
) =>
  new AgentRuntimeError({ message, operation: `opencode.${operation}`, reason, retryable: false });

/** Metadata connections are bounded and shared; discovery never allocates a native conversation. */
export const make = Effect.gen(function* () {
  const settings = yield* ApplicationSettings;
  const sdk = yield* OpenCodeSdk;
  const config = yield* MainConfig;
  const launchInput = Effect.fn("OpenCodeModelCatalog.launchInput")(function* (
    instanceId: string,
    cwd: string,
    environment?: Readonly<Record<string, string>>,
    workspaceEnvironment?: CodexStoredShellEnvironment | null,
  ) {
    const launch = yield* settings.openCodeLaunchConfiguration(instanceId).pipe(
      Effect.mapError((cause) =>
        agentRuntimeError({
          operation: "opencode.settings",
          reason: "initialize",
          retryable: false,
          cause,
        }),
      ),
    );
    if (!launch.instance.enabled)
      return yield* Effect.fail(
        failure("settings", "This OpenCode instance is disabled", "authorization"),
      );
    const base = applyCodexWorktreeShellEnvironment(
      { ...config.environment, ...environment },
      workspaceEnvironment,
      config.platform,
    );
    return {
      binaryPath: launch.instance.binaryPath,
      serverUrl: launch.instance.serverUrl,
      cwd,
      profileDirectory: launch.profileDirectory,
      environment: { ...base, ...launch.environment },
      ...(launch.environment.OPENCODE_SERVER_PASSWORD
        ? { serverPassword: launch.environment.OPENCODE_SERVER_PASSWORD }
        : {}),
      ...(launch.environment.OPENCODE_SERVER_USERNAME
        ? { serverUsername: launch.environment.OPENCODE_SERVER_USERNAME }
        : {}),
    } satisfies OpenCodeLaunchInput;
  });
  const discovery = yield* RcMap.make({
    lookup: (key: string) => sdk.open(JSON.parse(key) as OpenCodeLaunchInput),
    capacity: 32,
    idleTimeToLive: "30 seconds",
  });
  return OpenCodeModelCatalog.of({
    discover: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const launch = yield* launchInput(
            input.instanceConfigId,
            input.workspaceRoot,
            undefined,
            input.workspaceEnvironment,
          );
          const key = JSON.stringify(launch);
          if (input.forceReload) yield* RcMap.invalidate(discovery, key);
          const connection = yield* RcMap.get(discovery, key).pipe(
            Effect.catchTag("ExceededCapacityError", () =>
              Effect.fail(
                failure(
                  "discover",
                  "Too many OpenCode catalogs are active. Try again shortly",
                  "pressure",
                ),
              ),
            ),
          );
          const inventory = yield* connection.inventory;
          return openCodeCatalog(input.instanceConfigId, inventory);
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            binding: { kind: "opencode", instanceConfigId: input.instanceConfigId },
            models: [],
            configOptions: [],
            modes: null,
            health: {
              status:
                error.reason === "authentication-required"
                  ? "authentication-required"
                  : "unavailable",
              error: error.message,
            },
            defaultModel: null,
          } satisfies AgentModelCatalog),
        ),
      ),
  });
});
export const live = Layer.effect(OpenCodeModelCatalog, make);
