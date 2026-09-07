/* oxlint-disable effecttsgo/async-function -- Filesystem availability is checked at the Node platform boundary. */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { SandboxPolicy } from "@nodex/codex-app-server-protocol/v2/SandboxPolicy";
import type { AdditionalContextEntry } from "@nodex/codex-app-server-protocol/v2/AdditionalContextEntry";
import type { CoreAuthorityIdentity } from "../../core-runtime/CoreAuthority";
import type { MainConfigValue } from "../../app/MainConfig";
import { resolveCoreExecutable } from "../../core-client/core-launcher";
import { nodexCliBootstrapPrompt } from "./NodexCliBootstrapPrompt";
import { bindNodexCliShell, shellQuote as quote, unbindNodexCliShell } from "./NodexCliShell";

export interface NodexCliTaskContext {
  readonly threadId: string;
  readonly hostId: string;
  readonly projectId: string | null;
  readonly verifiedBuiltinFullAccess: boolean;
  readonly planMode: boolean;
  readonly sandboxPolicy: Pick<SandboxPolicy, "type"> | null | undefined;
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

/** Recomputed for each Turn, including resumed tasks; context is never process-global authority. */
export const buildNodexCliBootstrap = (
  config: MainConfigValue,
  identity: CoreAuthorityIdentity,
  task: NodexCliTaskContext,
): Effect.Effect<AdditionalContextEntry, BootstrapUnavailable> => {
  const unavailableContext = (reason: string): AdditionalContextEntry => ({
    kind: "application",
    value: `Nodex CLI connection: unavailable (${reason}). Do not reuse a previous Turn's Nodex connection instructions or change permissions, Profile, or Project to bypass this limitation.`,
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
  if (!task.projectId) return unavailable("no Project is bound to this task");
  if (task.planMode) return unavailable("Plan Mode");
  if (!task.verifiedBuiltinFullAccess)
    return unavailable("requires the selected built-in Full access mode");
  if (task.sandboxPolicy?.type !== "dangerFullAccess")
    return unavailable("the runtime sandbox is not Full access");
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
            field === "project" ? quote(projectId) : quote(paths.skill),
          )
          .trim(),
      };
    },
    catch: (cause) => new BootstrapUnavailable({ cause }),
  }).pipe(
    Effect.catch(() => unavailable("the current build's CLI or bundled Skill is unavailable")),
  );
};
