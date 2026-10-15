/* @effect-diagnostics asyncFunction:off -- Filesystem availability is checked at the Node platform boundary. */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { AdditionalContextEntry } from "@nodex/codex-app-server-protocol/v2/AdditionalContextEntry";
import type { CoreAuthorityIdentity } from "../../core-runtime/CoreAuthority";
import type { MainConfigValue } from "../../app/MainConfig";
import { resolveCoreExecutable } from "../../core-client/core-launcher";
import { nodexCliBootstrapPrompt } from "./NodexCliBootstrapPrompt";
import { bindNodexCliShell, shellQuote as quote, unbindNodexCliShell } from "./NodexCliShell";
import type { NodexAgentTurnContext } from "../../../shared/nodex-agent-authority";

export interface NodexCliTaskContext {
  readonly threadId: string;
  readonly hostId: string;
  readonly projectId: string | null;
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

/** Provider-neutral context selects the exact Profile without relying on a native shell snapshot. */
export const buildAgentRuntimeCliContext = (
  config: MainConfigValue,
  identity: CoreAuthorityIdentity,
  authority: NodexAgentTurnContext,
): Effect.Effect<string | null> => {
  if (config.platform === "win32") return Effect.succeed(null);
  const projectId = authority.actorProjectId;
  return Effect.tryPromise({
    try: async () => {
      const paths = nodexCliPaths(config);
      await Promise.all([
        access(paths.executable, constants.X_OK),
        access(paths.skill, constants.R_OK),
      ]);
      if (!(await stat(paths.executable)).isFile() || !(await stat(paths.skill)).isFile())
        return null;
      const command = `NODEX_HOME=${quote(config.nodexHome)} ${quote(paths.executable)} --expect-profile ${quote(identity.profileId)}${projectId ? ` --project ${quote(projectId)}` : ""}`;
      return `For shell content work, use ${command} followed by the command, including after changing directories. Read the bundled Skill at ${quote(paths.skill)}. This CLI selects the current build, Profile.`;
    },
    catch: (cause) => new BootstrapUnavailable({ cause }),
  }).pipe(Effect.catch(() => Effect.succeed(null)));
};

/** Recomputed for each Turn, including resumed tasks; context is never process-global authority. */
export const buildNodexCliBootstrap = (
  config: MainConfigValue,
  identity: CoreAuthorityIdentity,
  task: NodexCliTaskContext,
): Effect.Effect<AdditionalContextEntry, BootstrapUnavailable> => {
  const unavailableContext = (reason: string): AdditionalContextEntry => ({
    kind: "application",
    value: `Nodex CLI connection: unavailable (${reason}).`,
  });
  const unavailable = (reason: string) =>
    Effect.tryPromise({
      try: async () => {
        await unbindNodexCliShell(config.nodexHome, task.threadId);
        return unavailableContext(reason);
      },
      catch: (cause) => new BootstrapUnavailable({ cause }),
    });
  if (task.hostId !== "local") return unavailable("remote execution host");
  if (config.platform === "win32")
    return unavailable("this shell bootstrap is not supported on Windows");
  const projectId = task.projectId;
  return Effect.tryPromise({
    try: async () => {
      const paths = nodexCliPaths(config);
      await access(paths.executable, constants.X_OK);
      await access(paths.skill, constants.R_OK);
      if (!(await stat(paths.executable)).isFile() || !(await stat(paths.skill)).isFile()) {
        throw new Error("The current CLI or bundled Skill is not a file");
      }
      await bindNodexCliShell({
        nodexHome: config.nodexHome,
        threadId: task.threadId,
        executable: paths.executable,
        profileId: identity.profileId,
        projectId,
      });
      return {
        kind: "application" as const,
        value: nodexCliBootstrapPrompt
          .replace(/\{\{(project|skill)\}\}/g, (_, field: string) =>
            field === "project" ? (projectId ? quote(projectId) : "none") : quote(paths.skill),
          )
          .trim(),
      };
    },
    catch: (cause) => new BootstrapUnavailable({ cause }),
  }).pipe(
    Effect.catch(() => unavailable("the current build's CLI or bundled Skill is unavailable")),
  );
};
