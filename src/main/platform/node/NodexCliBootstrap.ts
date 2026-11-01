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
import {
  bindNodexCliShell,
  NODEX_AGENT_ATTRIBUTION_ENV,
  shellQuote as quote,
  unbindNodexCliShell,
} from "./NodexCliShell";
import type { NodexAgentTurnContext } from "../../../shared/nodex-agent-authority";

export interface NodexCliTaskContext {
  readonly threadId: string;
  readonly hostId: string;
  readonly projectId: string | null;
  /** Core's credential for this task's chat, so the content it changes names that chat. */
  readonly agentAttribution: string | null;
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

/**
 * A Codex shell names its task in `CODEX_THREAD_ID`, so plain `nodex` routes through that task's
 * binding exactly as in native chats. Other providers receive an explicit command that selects the
 * exact Profile without relying on a shell snapshot.
 */
export const buildAgentRuntimeCliContext = (
  config: MainConfigValue,
  identity: CoreAuthorityIdentity,
  authority: NodexAgentTurnContext,
  codexShellTaskId: string | null,
  agentAttribution: string | null,
): Effect.Effect<string | null> => {
  const projectId = authority.actorProjectId;
  if (codexShellTaskId)
    return buildNodexCliBootstrap(config, identity, {
      threadId: codexShellTaskId,
      hostId: "local",
      projectId,
      agentAttribution,
    }).pipe(
      Effect.map((entry) => entry.value),
      Effect.orElseSucceed(() => null),
    );
  return Effect.tryPromise({
    try: async () => {
      const paths = nodexCliPaths(config);
      await Promise.all([
        access(paths.executable, config.platform === "win32" ? constants.F_OK : constants.X_OK),
        access(paths.skill, constants.R_OK),
      ]);
      if (!(await stat(paths.executable)).isFile() || !(await stat(paths.skill)).isFile())
        return null;
      if (config.platform === "win32") {
        const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
        const command = `$env:NODEX_HOME=${psQuote(config.nodexHome)}; $env:NODEX_AGENT_ATTRIBUTION=${psQuote(agentAttribution ?? "")}; & ${psQuote(paths.executable)} --expect-profile ${psQuote(identity.profileId)}${projectId ? ` --project ${psQuote(projectId)}` : ""}`;
        return `For shell content work, use this PowerShell prefix followed by the command, including after changing directories: ${command}. Read the bundled Skill at ${psQuote(paths.skill)}. From cmd or Git Bash, invoke PowerShell with -NoProfile -Command and this prefix.`;
      }
      const attribution = agentAttribution
        ? `${NODEX_AGENT_ATTRIBUTION_ENV}=${quote(agentAttribution)} `
        : "";
      const command = `NODEX_HOME=${quote(config.nodexHome)} ${attribution}${quote(paths.executable)} --expect-profile ${quote(identity.profileId)}${projectId ? ` --project ${quote(projectId)}` : ""}`;
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
        await unbindNodexCliShell(config.nodexHome, task.threadId, config.platform);
        return unavailableContext(reason);
      },
      catch: (cause) => new BootstrapUnavailable({ cause }),
    });
  if (task.hostId !== "local") return unavailable("remote execution host");
  const projectId = task.projectId;
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
        profileId: identity.profileId,
        projectId,
        agentAttribution: task.agentAttribution,
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
