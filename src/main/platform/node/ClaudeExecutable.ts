// @effect-diagnostics asyncFunction:off
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, posix, win32 } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexLocalShellEnvironmentRuntimeError } from "../../codex/CodexLocalShellEnvironmentRuntime";

export class ClaudeExecutableError extends Schema.TaggedError<ClaudeExecutableError>()(
  "ClaudeExecutableError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export const claudeHostEnvironmentValue = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: string = process.platform,
): string | undefined =>
  platform === "win32"
    ? Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    : environment[name];
export const claudeNativeHome = (
  environment: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
): string | undefined =>
  claudeHostEnvironmentValue(environment, "HOME", platform) ??
  (platform === "win32"
    ? claudeHostEnvironmentValue(environment, "USERPROFILE", platform)
    : undefined);

/** Resolve native executables and npm launchers without asking a shell to evaluate user input. */
export const claudeExecutableCandidates = (
  binary: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: string,
  cwd?: string,
): readonly string[] => {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const home = claudeNativeHome(environment, platform);
  if (binary.startsWith("~/") && !home) return [];
  const expanded = binary.startsWith("~/") ? path.join(home!, binary.slice(2)) : binary;
  const roots = path.isAbsolute(expanded)
    ? [expanded]
    : (claudeHostEnvironmentValue(environment, "PATH", platform) ?? "")
        .split(windows ? ";" : delimiter)
        .map((directory) => path.join(cwd ? path.resolve(cwd, directory) : directory, expanded));
  if (!windows || win32.extname(expanded)) return roots;
  const extensions = (
    claudeHostEnvironmentValue(environment, "PATHEXT", platform) ?? ".EXE;.CMD;.BAT;.PS1"
  ).split(";");
  return roots.flatMap((root) => [
    root,
    ...extensions.map((extension) => `${root}${extension.toLowerCase()}`),
  ]);
};
export const claudeWindowsPackageEntries = (launcher: string): readonly string[] => {
  if (!/\.(cmd|bat|ps1)$/iu.test(launcher)) return [launcher];
  const directory = win32.dirname(launcher);
  return [
    win32.join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    win32.join(directory, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  ];
};
export async function resolveClaudeExecutable(
  binary: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
  cwd?: string,
): Promise<string> {
  for (const candidate of claudeExecutableCandidates(binary, environment, platform, cwd)) {
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      for (const entry of platform === "win32"
        ? claudeWindowsPackageEntries(candidate)
        : [candidate]) {
        try {
          if (!(await stat(entry)).isFile()) continue;
          return await realpath(entry);
        } catch {
          /* Native packages and older JavaScript packages have different entrypoints. */
        }
      }
    } catch {
      /* Try the next executable or package entry. */
    }
  }
  throw new Error(
    `Claude Code executable was not found: ${binary}. Install Claude Code or choose its executable in Agent settings.`,
  );
}

/** Recover only executable search paths; shell credentials and account selection stay native. */
export const resolveClaudeLaunch = Effect.fn("ClaudeExecutable.resolveLaunch")(function* (
  input: {
    readonly binary: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly platform: string;
    readonly cwd: string;
    readonly allowPathDiscovery: boolean;
  },
  loadShellEnvironment: Effect.Effect<NodeJS.ProcessEnv, CodexLocalShellEnvironmentRuntimeError>,
) {
  const resolve = (environment: Readonly<Record<string, string | undefined>>) =>
    Effect.tryPromise({
      try: () => resolveClaudeExecutable(input.binary, environment, input.platform, input.cwd),
      catch: (cause) =>
        new ClaudeExecutableError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(Effect.map((executable) => ({ executable, environment })));
  return yield* resolve(input.environment).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        if (!input.allowPathDiscovery || /[/\\]/u.test(input.binary)) return yield* cause;
        const shellEnvironment = yield* loadShellEnvironment.pipe(
          Effect.timeout("5 seconds"),
          Effect.orElseSucceed(() => input.environment),
        );
        const windows = input.platform === "win32";
        const path = windows ? win32 : posix;
        const home = claudeNativeHome(input.environment, input.platform);
        const searchPath = [
          claudeHostEnvironmentValue(shellEnvironment, "PATH", input.platform) ??
            claudeHostEnvironmentValue(input.environment, "PATH", input.platform),
          ...(input.binary === "claude" && home ? [path.join(home, ".local", "bin")] : []),
        ]
          .filter((entry): entry is string => entry !== undefined && entry !== "")
          .join(windows ? ";" : delimiter);
        const environment = {
          ...Object.fromEntries(
            Object.entries(input.environment).filter(([name]) =>
              windows ? name.toUpperCase() !== "PATH" : name !== "PATH",
            ),
          ),
          PATH: searchPath,
        };
        return yield* resolve(environment);
      }),
    ),
  );
});
