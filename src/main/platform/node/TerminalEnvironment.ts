import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TerminalSize } from "../../../shared/types";
import type { TerminalRuntimeConfig } from "../../terminal-runtime/TerminalRuntimeMap";

export interface TerminalEnvironmentInput {
  readonly sessionId: string;
  readonly conversationId?: string | null;
  readonly projectSessionId?: string | null;
  readonly cwd?: string | null;
  readonly size?: TerminalSize | null;
  readonly title?: string | null;
}

export class TerminalEnvironment extends Context.Service<
  TerminalEnvironment,
  {
    readonly resolve: (input: TerminalEnvironmentInput) => Effect.Effect<TerminalRuntimeConfig>;
  }
>()("nodex/main/platform/node/TerminalEnvironment") {}

const directoryExists = (pathname: string): boolean => {
  try {
    return fs.statSync(pathname).isDirectory();
  } catch {
    return false;
  }
};

const resolveCwd = (requested: string | null | undefined): string => {
  const trimmed = requested?.trim();
  if (trimmed && directoryExists(trimmed)) return trimmed;
  const home = os.homedir();
  if (home && directoryExists(home)) return home;
  return process.cwd();
};

const resolveShell = (): Effect.Effect<string> =>
  process.platform === "win32"
    ? Effect.succeed("powershell.exe")
    : Config.String("SHELL").pipe(
        Config.withDefault("/bin/zsh"),
        Effect.orElseSucceed(() => "/bin/zsh"),
      );

export const resolveTerminalCommand = (
  shell: string,
  platform: NodeJS.Platform,
): readonly [string, ...string[]] => {
  if (platform === "win32") return [shell];
  const basename = path.basename(shell).toLowerCase();
  if (basename === "bash") return [shell, "--login", "-i"];
  if (basename === "zsh" || basename === "fish") return [shell, "-l", "-i"];
  return [shell, "-i"];
};

const buildEnvironment = (): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  if (process.platform !== "win32") {
    delete env.TERMINFO;
    delete env.TERMINFO_DIRS;
  }
  return env;
};

export const live: Layer.Layer<TerminalEnvironment> = Layer.succeed(
  TerminalEnvironment,
  TerminalEnvironment.of({
    resolve: (input) =>
      Effect.gen(function* () {
        const shell = yield* resolveShell();
        const [command, ...args] = resolveTerminalCommand(shell, process.platform);
        const size = input.size ?? { cols: 80, rows: 24 };
        return {
          sessionId: input.sessionId,
          conversationId: input.conversationId ?? null,
          projectSessionId: input.projectSessionId ?? null,
          title: input.title ?? null,
          command,
          args,
          cwd: resolveCwd(input.cwd),
          env: buildEnvironment(),
          cols: Math.max(2, Math.floor(size.cols)),
          rows: Math.max(1, Math.floor(size.rows)),
        } satisfies TerminalRuntimeConfig;
      }),
  }),
);
