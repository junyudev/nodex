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
        value: `Nodex CLI connection for this Turn: local Full access; Project ${quote(projectId)}.\nUse nodex directly: the host-managed shell command selects this build, Profile and Project, including after changing directories. Do not reuse command prefixes from earlier Turns.\nRead the bundled official Skill at ${quote(paths.skill)} when working with Nodex content. Discover once with nodex capabilities and nodex context; consult command --help and docs nested-markdown as needed. Use direct stdout/stdin for ordinary work. These are Native CLI operations under Project access, not Turn-scoped dynamic-tool authorization. Core checks access on every call. This connection applies only to this Turn; later task context supersedes it.`,
      };
    },
    catch: (cause) => new BootstrapUnavailable({ cause }),
  }).pipe(
    Effect.catch(() => unavailable("the current build's CLI or bundled Skill is unavailable")),
  );
};
