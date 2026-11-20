import { win32 } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HostShellEnvironment } from "../../host-runtime/HostShellEnvironment";
import { makeHostExecutableSearch } from "./HostExecutableSearch";
import { mergeProcessEnvironments } from "./child-process-environment";

export class ClaudeExecutableError extends Schema.TaggedError<ClaudeExecutableError>()(
  "ClaudeExecutableError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export const claudeWindowsPackageEntries = (launcher: string): readonly string[] => {
  if (!/\.(cmd|bat|ps1)$/iu.test(launcher)) return [launcher];
  const directory = win32.dirname(launcher);
  return [
    win32.join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    win32.join(directory, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  ];
};

interface ClaudeLaunchInput {
  readonly binary: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform: string;
  readonly cwd?: string;
  readonly homeDirectory: string;
  readonly allowPathDiscovery: boolean;
}

/** Recover executable paths while keeping credential overlays and account selection native. */
export const resolveClaudeLaunch = Effect.fn("ClaudeExecutable.resolveLaunch")(function* (
  input: ClaudeLaunchInput,
  shell: Pick<HostShellEnvironment["Service"], "recover" | "latest">,
) {
  const candidate = yield* makeHostExecutableSearch(input, shell).first({
    commands: [input.binary],
    cwd: input.cwd,
    pathOnly: !input.allowPathDiscovery,
    windowsEntries: claudeWindowsPackageEntries,
  });
  if (!candidate) {
    const message = `Claude Code executable was not found: ${input.binary}. Install Claude Code or choose its executable in Agent settings.`;
    return yield* new ClaudeExecutableError({ message, cause: new Error(message) });
  }
  return {
    executable: candidate.realPath,
    environment:
      candidate.environment === input.environment
        ? input.environment
        : mergeProcessEnvironments(input.platform, input.environment, {
            PATH: candidate.environment.PATH,
          }),
  };
});
