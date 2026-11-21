/* @effect-diagnostics asyncFunction:off -- Node executable discovery and version probe. */
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexExecutableProbe } from "../../../shared/codex-executable-settings";
import {
  CODEX_APP_SERVER_MINIMUM_VERSION,
  extractCodexAppServerVersion,
  isCodexAppServerVersionAtLeast,
  parseCodexCliVersion,
} from "../../../shared/codex-app-server-version";
import { executableCandidates, hostEnvironmentValue } from "./HostExecutableSearch";
import { execFileAsync } from "./child-stdio-errors";

export function classifyCodexExecutable(stdout: string, binaryPath: string): CodexExecutableProbe {
  const version = extractCodexAppServerVersion(parseCodexCliVersion(stdout));
  if (!version) return { status: "invalid-version" };
  if (!isCodexAppServerVersionAtLeast(version, CODEX_APP_SERVER_MINIMUM_VERSION))
    return { status: "too-old", version };
  return { status: "ready", version, binaryPath };
}

export async function probeCodexExecutable(input: {
  readonly executable: string;
  readonly home: string;
  readonly platform: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}): Promise<CodexExecutableProbe> {
  const { executable, environment, home, platform, signal } = input;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const expanded = /^~[/\\]/u.test(executable) ? paths.join(home, executable.slice(2)) : executable;
  if (!paths.isAbsolute(expanded) && /[/\\]/u.test(expanded)) return { status: "not-found" };
  const candidates = executableCandidates(expanded, environment, platform).filter(paths.isAbsolute);
  let binaryPath: string | undefined;
  for (const candidate of candidates) {
    signal.throwIfAborted();
    try {
      await access(candidate, windows ? constants.F_OK : constants.X_OK);
      if ((await stat(candidate)).isFile()) {
        binaryPath = await realpath(candidate);
        break;
      }
    } catch {
      // Continue to the next PATH entry.
    }
  }
  if (!binaryPath) return { status: "not-found" };
  const scratch = await mkdtemp(path.join(tmpdir(), "nodex-codex-version-"));
  try {
    signal.throwIfAborted();
    const { stdout, stderr } = await execFileAsync(binaryPath, ["--version"], {
      cwd: scratch,
      env: {
        PATH: hostEnvironmentValue(environment, "PATH", platform),
        ...(windows
          ? { SystemRoot: hostEnvironmentValue(environment, "SystemRoot", platform) }
          : {}),
        HOME: scratch,
        USERPROFILE: scratch,
        CODEX_HOME: scratch,
        XDG_CONFIG_HOME: scratch,
        XDG_DATA_HOME: scratch,
        APPDATA: scratch,
        LOCALAPPDATA: scratch,
      },
      signal,
      timeout: 4_000,
      maxBuffer: 16 * 1024,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    return classifyCodexExecutable(stdout.trim() || stderr, binaryPath);
  } catch {
    signal.throwIfAborted();
    return { status: "probe-failed" };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
