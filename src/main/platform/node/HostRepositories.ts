/* @effect-diagnostics asyncFunction:off -- Host-local filesystem and Git admission, before execution is enabled. */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { canonicalGitRemote, type ProjectSource } from "../../../shared/project-sources";
import { HostWorkspaceError } from "../../../host/HostWorkspace";
import { scrubHostAgentEnvironment } from "../../../host/HostAgentPolicy";

const exec = promisify(execFile);
const contains = (parent: string, child: string) => {
  const path = relative(parent, child);
  return (
    !path ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
};

/** The private configuration is the only place where a remote identity becomes a clone path. */
export async function hostRepositories(input: {
  readonly coreHome: string;
  readonly executionHome: string;
  readonly repositories: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
}) {
  const paths = new Map<string, string>();
  const env = scrubHostAgentEnvironment(input.environment, input.coreHome);
  for (const [remote, configured] of Object.entries(input.repositories)) {
    if (canonicalGitRemote(remote) !== remote)
      throw new Error("Host repository keys must be canonical HTTPS Git remotes");
    const clone = await realpath(configured);
    if (contains(input.coreHome, clone) || contains(clone, input.coreHome))
      throw new Error("Repository clones and private Core state must be disjoint");
    const git = async (args: readonly string[]) =>
      (
        await exec("git", ["-C", clone, ...args], { env, timeout: 10_000, maxBuffer: 64 * 1024 })
      ).stdout.trim();
    if ((await realpath(await git(["rev-parse", "--show-toplevel"]))) !== clone)
      throw new Error("A Host repository mapping must name the clone root");
    const commonDirectory = await realpath(
      await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    if (contains(input.coreHome, commonDirectory) || contains(commonDirectory, input.coreHome))
      throw new Error("Repository Git state and private Core state must be disjoint");
    const names = (await git(["remote"])).split(/\r?\n/u).filter(Boolean);
    if (names.length > 32) throw new Error("A Host clone has too many Git remotes");
    let matched = false;
    for (const name of names) {
      if (canonicalGitRemote(await git(["remote", "get-url", name])) === remote) matched = true;
    }
    if (!matched) throw new Error(`The Host clone does not have the configured remote: ${remote}`);
    paths.set(remote, clone);
  }
  return {
    projectlessRoot: join(input.executionHome, "tasks"),
    resolve: (sources: readonly ProjectSource[]) =>
      Effect.forEach(sources, (source) => {
        if (source.kind !== "repository")
          return Effect.fail(
            new HostWorkspaceError({ message: "Team Projects require repository identities" }),
          );
        const path = paths.get(source.remote);
        return path
          ? Effect.succeed(path)
          : Effect.fail(
              new HostWorkspaceError({
                message: `Map this repository on the Host before starting work: ${source.remote}`,
              }),
            );
      }),
  };
}
