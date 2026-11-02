import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Avoid .cmd shims and shell interpolation, including paths containing spaces. */
export function vitePlusCommand(args: readonly string[]): { command: string; args: string[] } {
  if (process.env.VP_CLI_BIN) return { command: process.env.VP_CLI_BIN, args: [...args] };
  return {
    command: process.execPath,
    args: [join(dirname(require.resolve("vite-plus/package.json")), "bin/vp"), ...args],
  };
}

export function runVitePlus(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const invocation = vitePlusCommand(args);
  execFileSync(invocation.command, invocation.args, { ...options, stdio: "inherit" });
}
