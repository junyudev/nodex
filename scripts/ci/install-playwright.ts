import path from "node:path";
import { runCommand, withCommandSignal } from "../tooling/process.ts";

/** System packages are Linux-only; every host installs the locked browser. */
export async function installPlaywrightChromium(options: {
  readonly platform: NodeJS.Platform;
  readonly signal: AbortSignal;
  readonly execute?: typeof runCommand;
  readonly timeoutMs?: number;
}): Promise<number> {
  const attempts = options.platform === "linux" ? [true, false] : [false];
  for (const withDependencies of attempts) {
    if (options.signal.aborted) return 130;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? 8 * 60_000);
    try {
      const result = await (options.execute ?? runCommand)({
        command: "vp",
        args: [
          "exec",
          "playwright",
          "install",
          ...(withDependencies ? ["--with-deps"] : []),
          "chromium",
        ],
        signal: AbortSignal.any([options.signal, deadline.signal]),
      });
      if (options.signal.aborted) return 130;
      if (!deadline.signal.aborted) return result.exitCode;
      if (!withDependencies) return 124;
      process.stderr.write(
        "Playwright system dependency installation timed out; retrying browser installation.\n",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return 124;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal((signal) =>
    installPlaywrightChromium({ platform: process.platform, signal }),
  );
}
