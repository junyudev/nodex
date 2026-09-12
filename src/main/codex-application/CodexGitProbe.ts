import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  isCodexNonGitRepositoryMessage,
  runCodexGitCommand,
  type CodexGitCommandResult,
} from "../codex/codex-git-command";

const GIT_PROBE_TIMEOUT_MS = 8_000;
const GIT_PROBE_MAX_OUTPUT_BYTES = 256 * 1_024;

type GitProbeCommand = (
  args: readonly string[],
  cwd: string,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly maxOutputBytes: number;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  },
) => Promise<CodexGitCommandResult>;

export interface CodexGitProbeOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly command?: GitProbeCommand;
  readonly remoteIsNonGitWorkspace?: (hostId: string, cwd: string) => Effect.Effect<boolean>;
}

class CodexGitProbeCommandError extends Data.TaggedError("CodexGitProbeCommandError")<{
  readonly cause: unknown;
}> {}

export class CodexGitProbe extends Context.Service<
  CodexGitProbe,
  {
    readonly readPath: (cwd: string, args: readonly string[]) => Effect.Effect<string | null>;
    readonly isNonGitWorkspace: (cwd: string) => Effect.Effect<boolean>;
    readonly isNonGitWorkspaceOnHost: (hostId: string, cwd: string) => Effect.Effect<boolean>;
  }
>()("nodex/main/codex-application/CodexGitProbe") {}

export const make = (options: CodexGitProbeOptions): CodexGitProbe["Service"] => {
  const command = options.command ?? runCodexGitCommand;
  const run = (cwd: string, args: readonly string[]) =>
    Effect.tryPromise({
      try: (signal) =>
        command(args, cwd, {
          env: options.environment,
          maxOutputBytes: GIT_PROBE_MAX_OUTPUT_BYTES,
          signal,
          timeoutMs: GIT_PROBE_TIMEOUT_MS,
        }),
      catch: (cause) => new CodexGitProbeCommandError({ cause }),
    });

  const readPath = (cwd: string, args: readonly string[]): Effect.Effect<string | null> => {
    const normalizedCwd = cwd.trim();
    if (!normalizedCwd) return Effect.succeed(null);
    return run(normalizedCwd, args).pipe(
      Effect.map((result) => result.stdout.trim() || null),
      Effect.catch(() => Effect.succeed(null)),
    );
  };

  const isNonGitWorkspace = (cwd: string): Effect.Effect<boolean> => {
    const normalizedCwd = cwd.trim();
    if (!normalizedCwd) return Effect.succeed(false);
    return run(normalizedCwd, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.as(false),
      Effect.catch((error) => Effect.succeed(isCodexNonGitRepositoryMessage(String(error.cause)))),
    );
  };

  const isNonGitWorkspaceOnHost = (hostId: string, cwd: string): Effect.Effect<boolean> => {
    if (hostId === "local") return isNonGitWorkspace(cwd);
    if (!options.remoteIsNonGitWorkspace) return Effect.succeed(false);
    return options.remoteIsNonGitWorkspace(hostId, cwd);
  };

  return CodexGitProbe.of({ readPath, isNonGitWorkspace, isNonGitWorkspaceOnHost });
};
