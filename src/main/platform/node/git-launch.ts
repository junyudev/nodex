import { escapeWindowsShellArg } from "@nodex/agent-runtime/windows-shell";
import { statSync } from "node:fs";
import { win32 } from "node:path";
import { claudeExecutableCandidates, claudeHostEnvironmentValue } from "./ClaudeExecutable";
import { childProcessEnvironment } from "./child-process-environment";

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Prefer native Git. Only batch launchers acquire cmd.exe; Git arguments remain literal. */
export function resolveGitLaunch(
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: string = process.platform,
  exists: (file: string) => boolean = isFile,
) {
  const env = childProcessEnvironment(environment, platform);
  if (platform !== "win32") return { command: "git", args: [...args], env, shell: false as const };
  const candidates = [
    ...claudeExecutableCandidates("git.exe", env, platform),
    ...claudeExecutableCandidates("git", env, platform).filter((file) =>
      /\.(cmd|bat)$/iu.test(file),
    ),
  ];
  const executable = candidates.find(exists) ?? "git";
  if (!/\.(cmd|bat)$/iu.test(executable))
    return { command: executable, args: [...args], env, shell: false as const };
  if (args.some((arg) => /[\r\n\0]/u.test(arg)))
    throw new Error(
      "A Git batch launcher cannot accept line breaks or NUL in arguments. Use native git.exe.",
    );
  const root = claudeHostEnvironmentValue(env, "SystemRoot", platform) ?? "C:\\Windows";
  const shell =
    claudeHostEnvironmentValue(env, "ComSpec", platform)?.trim() ||
    win32.join(root, "System32", "cmd.exe");
  return {
    command: escapeWindowsShellArg(executable),
    args: args.map(escapeWindowsShellArg),
    env,
    shell,
  };
}
