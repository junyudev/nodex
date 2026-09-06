/* oxlint-disable effecttsgo/async-function -- Filesystem availability is checked at the Node platform boundary. */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { SandboxPolicy } from "@nodex/codex-app-server-protocol/v2/SandboxPolicy";
import type { AdditionalContextEntry } from "@nodex/codex-app-server-protocol/v2/AdditionalContextEntry";
import type { MainConfigValue } from "../../app/MainConfig";
import { resolveCoreExecutable } from "../../core-client/core-launcher";

export interface NodexCliTaskContext {
  readonly hostId: string;
  readonly projectId: string | null;
  readonly verifiedBuiltinFullAccess: boolean;
  readonly planMode: boolean;
  readonly sandboxPolicy: Pick<SandboxPolicy, "type"> | null | undefined;
}

class BootstrapUnavailable extends Data.TaggedError("NodexCliBootstrapUnavailable") {}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

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

/** Recomputed for each Turn, including resumed tasks; context is never process-global authority. */
export const buildNodexCliBootstrap = (
  config: MainConfigValue,
  task: NodexCliTaskContext,
): Effect.Effect<AdditionalContextEntry> => {
  const unavailable = (reason: string): AdditionalContextEntry => ({
    kind: "application",
    value: `Nodex CLI connection: unavailable (${reason}). Do not reuse a previous Turn's Nodex connection instructions or change permissions, Profile, or Project to bypass this limitation.`,
  });
  if (task.hostId !== "local") return Effect.succeed(unavailable("remote execution host"));
  if (!task.projectId) return Effect.succeed(unavailable("no Project is bound to this task"));
  if (task.planMode) return Effect.succeed(unavailable("Plan Mode"));
  if (!task.verifiedBuiltinFullAccess)
    return Effect.succeed(unavailable("requires the selected built-in Full access mode"));
  if (task.sandboxPolicy?.type !== "dangerFullAccess")
    return Effect.succeed(unavailable("the runtime sandbox is not Full access"));
  if (config.platform === "win32")
    return Effect.succeed(unavailable("this shell bootstrap is not supported on Windows"));
  const projectId = task.projectId;
  return Effect.tryPromise({
    try: async () => {
      const paths = nodexCliPaths(config);
      await access(paths.executable, constants.X_OK);
      await access(paths.skill, constants.R_OK);
      if (!(await stat(paths.executable)).isFile() || !(await stat(paths.skill)).isFile()) {
        return unavailable("the current build's CLI or bundled Skill is not a file");
      }
      const command = `/usr/bin/env NODEX_HOME=${quote(config.nodexHome)} ${quote(paths.executable)} --profile ${quote(config.profileId)} --project ${quote(projectId)}`;
      return {
        kind: "application" as const,
        value: `Nodex CLI connection for this Turn: local Full access; Project ${quote(projectId)}.\nRead the bundled official Skill at ${quote(paths.skill)} when working with Nodex content. Use this command prefix for every Nodex call, even if the working directory changes:\n${command}\nDiscover once with capabilities and context; consult command --help and docs nested-markdown as needed. Use direct stdout/stdin for ordinary work. These are Native CLI operations under Project access, not Turn-scoped dynamic-tool authorization. Core checks access on every call. This connection applies only to this Turn; later task context supersedes it.`,
      };
    },
    catch: () => new BootstrapUnavailable(),
  }).pipe(
    Effect.orElseSucceed(() =>
      unavailable("the current build's CLI or bundled Skill is unavailable"),
    ),
  );
};
