/* @effect-diagnostics asyncFunction:off -- Filesystem availability is checked at the Node platform boundary. */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { AdditionalContextEntry } from "@nodex/codex-app-server-protocol/v2/AdditionalContextEntry";
import type { MainConfigValue } from "../../app/MainConfig";
import { resolveCoreExecutable } from "../../core-client/core-launcher";
import { nodexCliBootstrapPrompt } from "./NodexCliBootstrapPrompt";
import {
  bindNodexCliShell,
  nodexCliShellPaths,
  shellQuote as quote,
  unbindNodexCliShell,
} from "./NodexCliShell";
import type { ScopedAgentCoreConnection } from "../../../host/ScopedAgentCore";

export interface NodexCliTaskContext {
  readonly threadId: string;
  readonly hostId: string;
  readonly scopedConnection?: ScopedAgentCoreConnection;
}

class BootstrapUnavailable extends Data.TaggedError("NodexCliBootstrapUnavailable")<{
  readonly cause: unknown;
}> {}

export const nodexCliPaths = (config: MainConfigValue) => ({
  executable: join(
    dirname(
      resolveCoreExecutable({
        environment: config.environment,
        isPackaged: config.isPackaged,
        appResourcesPath: config.resourcesPath,
        repositoryRoot: config.projectRootPath,
      }),
    ),
    config.platform === "win32" ? "nodex.exe" : "nodex",
  ),
  skill: config.isPackaged
    ? join(config.resourcesPath, "agent-skills/skills/nodex/SKILL.md")
    : join(config.projectRootPath, ".generated/official-agent-skills/skills/nodex/SKILL.md"),
});

/** Providers with shared servers install this routing into the shell they launch. */
export const nodexCliShellBinding = (config: MainConfigValue, taskId: string) => ({
  taskId,
  profileHome: config.nodexHome,
  bin: nodexCliShellPaths(config.nodexHome).bin,
  skill: nodexCliPaths(config).skill,
});

/** Recomputed for each Turn, including resumed tasks; context is never process-global authority. */
export const buildNodexCliBootstrap = (
  config: MainConfigValue,
  task: NodexCliTaskContext,
): Effect.Effect<AdditionalContextEntry & { readonly routed: boolean }, BootstrapUnavailable> => {
  const unavailableContext = (reason: string) => ({
    kind: "application" as const,
    routed: false,
    value: `Nodex CLI connection: unavailable (${reason}).`,
  });
  const unavailable = (reason: string) =>
    Effect.tryPromise({
      try: async () => {
        await unbindNodexCliShell(config.nodexHome, task.threadId, config.platform);
        return unavailableContext(reason);
      },
      catch: (cause) => new BootstrapUnavailable({ cause }),
    });
  if (task.hostId !== "local") return unavailable("remote execution host");
  const scopedConnection = task.scopedConnection;
  if (!scopedConnection) return unavailable("no active Agent Turn");
  return Effect.tryPromise({
    try: async () => {
      const paths = nodexCliPaths(config);
      await access(paths.executable, config.platform === "win32" ? constants.F_OK : constants.X_OK);
      await access(paths.skill, constants.R_OK);
      if (!(await stat(paths.executable)).isFile() || !(await stat(paths.skill)).isFile()) {
        throw new Error("The current CLI or bundled Skill is not a file");
      }
      await bindNodexCliShell({
        platform: config.platform,
        nodexHome: config.nodexHome,
        threadId: task.threadId,
        executable: paths.executable,
        scopedConnection,
      });
      return {
        kind: "application" as const,
        routed: true,
        value: nodexCliBootstrapPrompt.replace("{{skill}}", quote(paths.skill)),
      };
    },
    catch: (cause) => new BootstrapUnavailable({ cause }),
  }).pipe(
    Effect.catch(() => unavailable("the current build's CLI or bundled Skill is unavailable")),
  );
};
