import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import {
  ClaudeEnvironmentValueSchema,
  ENVIRONMENT_NAME_PATTERN,
} from "../../shared/claude-agent-settings";
import { killChildProcessTree } from "../process-tree";

export interface CodexStoredShellEnvironment {
  readonly version: 1;
  readonly set: Readonly<Record<string, string>>;
  readonly exclude: readonly string[];
}

const storedEnvironmentNameSchema = z.string().max(128).regex(ENVIRONMENT_NAME_PATTERN);
const storedShellEnvironmentSchema = z
  .object({
    version: z.literal(1),
    set: z.record(storedEnvironmentNameSchema, ClaudeEnvironmentValueSchema),
    exclude: z.array(storedEnvironmentNameSchema),
  })
  .strict();
const MAX_STORED_SHELL_ENVIRONMENT_BYTES = 1024 * 1024;

const CODEX_SHELL_ENVIRONMENT_DELIMITER = "_SHELL_ENV_DELIMITER_";
const CODEX_SHELL_ENVIRONMENT_COMMAND = [
  `echo -n "${CODEX_SHELL_ENVIRONMENT_DELIMITER}"`,
  "command env",
  `echo -n "${CODEX_SHELL_ENVIRONMENT_DELIMITER}"`,
  "exit",
].join("; ");

const CODEX_INTERACTIVE_SHELL_ENVIRONMENT = {
  CODEX_SHELL: "1",
  DISABLE_AUTO_UPDATE: "true",
  ZSH_TMUX_AUTOSTART: "false",
  ZSH_TMUX_AUTOSTARTED: "true",
} as const;

const CODEX_VOLATILE_SETUP_ENVIRONMENT_KEYS = new Set([
  "CODEX_SOURCE_TREE_PATH",
  "CODEX_WORKTREE_PATH",
  "CODEX_SETUP_EXIT_CODE",
  "OLDPWD",
  "PWD",
  "SHELLOPTS",
  "SHLVL",
  "_",
  "CODEX_SHELL",
]);

interface CodexEnvironmentEntry {
  readonly key: string;
  readonly value: string;
}

function normalizeCodexEnvironmentKey(key: string, platform: string): string {
  return platform === "win32" ? key.toUpperCase() : key;
}

function indexCodexEnvironment(
  environment: Readonly<Record<string, string>>,
  platform: string,
): Map<string, CodexEnvironmentEntry> {
  const entries = new Map<string, CodexEnvironmentEntry>();
  for (const [key, value] of Object.entries(environment)) {
    entries.set(normalizeCodexEnvironmentKey(key, platform), { key, value });
  }
  return entries;
}

function isExcludedCodexEnvironmentKey(key: string, platform: NodeJS.Platform): boolean {
  const normalizedKey = normalizeCodexEnvironmentKey(key, platform);
  return (
    CODEX_VOLATILE_SETUP_ENVIRONMENT_KEYS.has(normalizedKey) ||
    normalizedKey.startsWith("BASH_FUNC_")
  );
}

function hasLineBreak(value: string | undefined): boolean {
  return value?.includes("\n") === true || value?.includes("\r") === true;
}

function compactProcessEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Apply captured setup changes and removals without mutating the host environment. */
export function applyCodexWorktreeShellEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  shellEnvironment: CodexStoredShellEnvironment | null | undefined,
  platform: string = process.platform,
): Record<string, string> {
  const entries = indexCodexEnvironment(compactProcessEnvironment(environment), platform);
  for (const key of shellEnvironment?.exclude ?? []) {
    entries.delete(normalizeCodexEnvironmentKey(key, platform));
  }
  for (const [key, value] of Object.entries(shellEnvironment?.set ?? {})) {
    entries.set(normalizeCodexEnvironmentKey(key, platform), { key, value });
  }
  return Object.fromEntries([...entries.values()].map(({ key, value }) => [key, value]));
}

function withoutCodexShellEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const compact = compactProcessEnvironment(environment);
  delete compact.CODEX_SHELL;
  return compact;
}

function resolveCodexLoginShell(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // Match the reference fallback when userInfo is unavailable.
  }
  if (platform === "darwin") return environment.SHELL || "/bin/zsh";
  return environment.SHELL || "/bin/sh";
}

/** Exact shell-env delimiter parser used by `O0/eI`. */
export function parseCodexInteractiveShellEnvironment(output: string): Record<string, string> {
  const environmentBlock = output.split(CODEX_SHELL_ENVIRONMENT_DELIMITER)[1];
  if (environmentBlock === undefined) {
    throw new Error("Shell output did not contain env delimiters");
  }

  const environment: Record<string, string> = {};
  for (const line of environmentBlock.replace(/\r\n/g, "\n").split("\n")) {
    const normalizedLine = line.trimEnd();
    if (!normalizedLine) continue;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) continue;
    environment[normalizedLine.slice(0, separatorIndex)] = normalizedLine.slice(separatorIndex + 1);
  }
  return environment;
}

function readCodexLoginShellEnvironment(input: {
  readonly shell: string;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.shell, ["-ilc", CODEX_SHELL_ENVIRONMENT_COMMAND], {
      env: {
        ...input.baseEnvironment,
        ...CODEX_INTERACTIVE_SHELL_ENVIRONMENT,
      },
      windowsHide: true,
    });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => {
      killChildProcessTree(child, "SIGKILL");
      settle(() => reject(new Error("Interactive login shell environment loading was canceled")));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code, signal) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (code === 0 && signal === null) {
        try {
          const environment = parseCodexInteractiveShellEnvironment(stdout);
          settle(() => resolve(environment));
        } catch (error) {
          settle(() => reject(error));
        }
        return;
      }
      settle(() =>
        reject(
          new Error(
            `Interactive login shell environment failed (${signal ?? `exit ${code ?? "unknown"}`}).${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
          ),
        ),
      );
    });
  });
}

async function readCodexInteractiveShellEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const preferredShell = resolveCodexLoginShell(platform, baseEnvironment);
  const shells = [preferredShell, "/bin/zsh", "/bin/bash"].filter(
    (shell, index, candidates) => candidates.indexOf(shell) === index,
  );
  let lastError: unknown = null;

  for (const shell of shells) {
    signal?.throwIfAborted();
    try {
      return await readCodexLoginShellEnvironment({ shell, baseEnvironment, signal });
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
    }
  }
  throw lastError ?? new Error("No interactive login shell is available");
}

export interface CodexLocalShellEnvironmentOptions {
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly loadInteractiveEnvironment?: (signal?: AbortSignal) => Promise<NodeJS.ProcessEnv>;
  readonly onError?: (error: unknown) => void;
  readonly platform?: NodeJS.Platform;
}

export async function loadCodexLocalShellEnvironment(
  input: CodexLocalShellEnvironmentOptions & { readonly signal?: AbortSignal } = {},
): Promise<NodeJS.ProcessEnv> {
  const baseEnvironment = input.baseEnvironment ?? process.env;
  const platform = input.platform ?? process.platform;
  input.signal?.throwIfAborted();
  if (platform === "win32") return compactProcessEnvironment(baseEnvironment);

  const load = async (): Promise<NodeJS.ProcessEnv> => {
    try {
      const interactiveEnvironment = await (input.loadInteractiveEnvironment?.(input.signal) ??
        readCodexInteractiveShellEnvironment(baseEnvironment, platform, input.signal));
      input.signal?.throwIfAborted();
      return withoutCodexShellEnvironment({
        ...baseEnvironment,
        ...interactiveEnvironment,
      });
    } catch (error) {
      input.signal?.throwIfAborted();
      input.onError?.(error);
      return withoutCodexShellEnvironment(baseEnvironment);
    }
  };

  return await load();
}

/** Exact `L0`: parse newline-delimited `env` output, retaining the final duplicate. */
export function parseCodexCapturedEnvironment(value: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of value.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    environment[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }
  return environment;
}

/** Exact `R0`: persist only stable setup-created changes and removals. */
export function captureCodexShellEnvironmentDelta(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): CodexStoredShellEnvironment | null {
  const beforeByKey = indexCodexEnvironment(before, platform);
  const afterByKey = indexCodexEnvironment(after, platform);
  const normalizedKeys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  const set: Record<string, string> = {};
  const exclude: string[] = [];

  for (const normalizedKey of normalizedKeys) {
    const beforeEntry = beforeByKey.get(normalizedKey);
    const afterEntry = afterByKey.get(normalizedKey);
    const key = afterEntry?.key ?? beforeEntry?.key;
    if (
      !key ||
      isExcludedCodexEnvironmentKey(key, platform) ||
      hasLineBreak(beforeEntry?.value) ||
      hasLineBreak(afterEntry?.value)
    )
      continue;

    if (!afterEntry) {
      exclude.push(key);
      continue;
    }
    if (beforeEntry?.value !== afterEntry.value) set[key] = afterEntry.value;
  }

  if (exclude.length === 0 && Object.keys(set).length === 0) return null;
  exclude.sort();
  return {
    version: 1,
    set: Object.fromEntries(
      Object.entries(set).sort(([left], [right]) => left.localeCompare(right)),
    ),
    exclude,
  };
}

function quotePosixShellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Exact `B0`: source setup in-process and capture the post-success shell environment. */
export function buildCodexPosixSetupCaptureWrapper(input: {
  readonly scriptPath: string;
  readonly capturePath: string;
  readonly beforeCapturePath: string;
}): string {
  return [
    "set -xeo pipefail",
    `capture_path=${quotePosixShellValue(input.capturePath)}`,
    `before_capture_path=${quotePosixShellValue(input.beforeCapturePath)}`,
    'env > "$before_capture_path"',
    `trap 'code=$?; if [ "$code" -eq 0 ]; then env > "$capture_path"; fi' EXIT`,
    `. ${quotePosixShellValue(input.scriptPath)}`,
  ].join("\n");
}

function appendOutputTail(currentTail: string, chunk: string, maxChars = 64_000): string {
  const merged = `${currentTail}${chunk}`;
  return merged.length <= maxChars ? merged : merged.slice(merged.length - maxChars);
}

const SETUP_KILL_ESCALATION_MS = 250;

export interface RunCodexWorktreeSetupScriptInput {
  readonly script: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: { stream: "stdout" | "stderr"; data: string }) => void;
  readonly onCaptureError?: (error: unknown) => void;
  readonly loadBaseEnvironment?: () => Promise<NodeJS.ProcessEnv>;
  readonly onShellEnvironmentError?: (error: unknown) => void;
  readonly readEnvironmentCapture?: (filePath: string) => Promise<string>;
}

/** Exact `I0/B0/K0`: source setup, preserve output, and capture env only after success. */
export async function runCodexWorktreeSetupScript(
  input: RunCodexWorktreeSetupScriptInput,
): Promise<CodexStoredShellEnvironment | null> {
  if (input.signal?.aborted) {
    throw new Error("Worktree environment setup canceled.");
  }
  const captureRoot = await mkdtemp(path.join(tmpdir(), "nodex-worktree-shell-environment-"));
  const scriptPath = path.join(captureRoot, `${randomUUID()}-setup-script.sh`);
  const wrapperPath = path.join(captureRoot, `${randomUUID()}-setup-wrapper.sh`);
  const beforeCapturePath = path.join(captureRoot, `${randomUUID()}-before-env.txt`);
  const capturePath = path.join(captureRoot, `${randomUUID()}-captured-env.txt`);
  await writeFile(scriptPath, input.script, "utf8");
  await writeFile(
    wrapperPath,
    buildCodexPosixSetupCaptureWrapper({
      scriptPath,
      capturePath,
      beforeCapturePath,
    }),
    "utf8",
  );

  try {
    const baseEnvironment = input.loadBaseEnvironment
      ? await input.loadBaseEnvironment()
      : await loadCodexLocalShellEnvironment({
          onError: input.onShellEnvironmentError,
        });
    if (input.signal?.aborted) {
      throw new Error("Worktree environment setup canceled.");
    }
    return await new Promise<CodexStoredShellEnvironment | null>((resolve, reject) => {
      const child = spawn("bash", [wrapperPath], {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: {
          ...baseEnvironment,
          COLORTERM: "truecolor",
          FORCE_COLOR: "1",
          TERM: "xterm-256color",
          ...input.environment,
        },
        windowsHide: true,
      });
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let stdoutTail = "";
      let stderrTail = "";
      let settled = false;
      let canceled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = (): void => {
        canceled = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        killChildProcessTree(child, "SIGTERM");
        if (killTimer) return;
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            killChildProcessTree(child, "SIGKILL");
          } else if (child.pid !== undefined && process.platform !== "win32") {
            // A shell can exit after SIGTERM while a descendant ignores it. The
            // process group remains addressable by the original leader pid.
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // The whole process group has already exited.
            }
          }
          killTimer = null;
        }, SETUP_KILL_ESCALATION_MS);
        killTimer.unref?.();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk);
        if (!text) return;
        stdoutTail = appendOutputTail(stdoutTail, text);
        input.onOutput?.({ stream: "stdout", data: text });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk);
        if (!text) return;
        stderrTail = appendOutputTail(stderrTail, text);
        input.onOutput?.({ stream: "stderr", data: text });
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        if (killTimer && !canceled) clearTimeout(killTimer);
        input.signal?.removeEventListener("abort", onAbort);
        if (canceled) {
          reject(new Error("Worktree environment setup canceled."));
          return;
        }
        reject(new Error(`Worktree environment setup script failed.\n${String(error)}`));
      });

      child.on("close", async (code) => {
        if (settled) return;
        settled = true;
        if (killTimer && !canceled) clearTimeout(killTimer);

        const trailingStdout = stdoutDecoder.end();
        if (trailingStdout) {
          stdoutTail = appendOutputTail(stdoutTail, trailingStdout);
          input.onOutput?.({ stream: "stdout", data: trailingStdout });
        }
        const trailingStderr = stderrDecoder.end();
        if (trailingStderr) {
          stderrTail = appendOutputTail(stderrTail, trailingStderr);
          input.onOutput?.({ stream: "stderr", data: trailingStderr });
        }

        if (canceled) {
          input.signal?.removeEventListener("abort", onAbort);
          reject(new Error("Worktree environment setup canceled."));
          return;
        }

        if (code === 0) {
          try {
            const readEnvironmentCapture =
              input.readEnvironmentCapture ?? ((filePath: string) => readFile(filePath, "utf8"));
            const [beforeCapture, afterCapture] = await Promise.all([
              readEnvironmentCapture(beforeCapturePath),
              readEnvironmentCapture(capturePath),
            ]);
            if (canceled) {
              reject(new Error("Worktree environment setup canceled."));
              return;
            }
            resolve(
              captureCodexShellEnvironmentDelta(
                parseCodexCapturedEnvironment(beforeCapture),
                parseCodexCapturedEnvironment(afterCapture),
              ),
            );
          } catch (error) {
            if (canceled) {
              reject(new Error("Worktree environment setup canceled."));
              return;
            }
            input.onCaptureError?.(error);
            resolve(null);
          } finally {
            input.signal?.removeEventListener("abort", onAbort);
          }
          return;
        }

        input.signal?.removeEventListener("abort", onAbort);
        const output = [stdoutTail.trim(), stderrTail.trim()]
          .filter((chunk) => chunk.length > 0)
          .join("\n");
        reject(
          new Error(`Worktree environment setup script failed.${output ? `\n${output}` : ""}`),
        );
      });
    });
  } finally {
    await rm(captureRoot, { recursive: true, force: true });
  }
}

export async function runCodexWorktreeCleanupScript(input: {
  readonly script: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: { stream: "stdout" | "stderr"; data: string }) => void;
  readonly loadBaseEnvironment?: () => Promise<NodeJS.ProcessEnv>;
}): Promise<void> {
  if (input.signal?.aborted) throw new Error("Worktree environment cleanup canceled.");
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "nodex-worktree-cleanup-"));
  const scriptPath = path.join(temporaryRoot, `${randomUUID()}-cleanup.sh`);
  await writeFile(scriptPath, input.script, "utf8");
  try {
    const baseEnvironment = input.loadBaseEnvironment
      ? await input.loadBaseEnvironment()
      : await loadCodexLocalShellEnvironment();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", [scriptPath], {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: {
          ...baseEnvironment,
          COLORTERM: "truecolor",
          FORCE_COLOR: "1",
          TERM: "xterm-256color",
          ...input.environment,
        },
        windowsHide: true,
      });
      let settled = false;
      let canceled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let stdoutTail = "";
      let stderrTail = "";
      const onAbort = () => {
        canceled = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        killChildProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            killChildProcessTree(child, "SIGKILL");
          }
        }, SETUP_KILL_ESCALATION_MS);
        killTimer.unref?.();
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutTail = appendOutputTail(stdoutTail, text);
        input.onOutput?.({ stream: "stdout", data: text });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrTail = appendOutputTail(stderrTail, text);
        input.onOutput?.({ stream: "stderr", data: text });
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener("abort", onAbort);
        reject(
          canceled
            ? new Error("Worktree environment cleanup canceled.")
            : new Error(`Worktree environment cleanup script failed.\n${String(error)}`),
        );
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        input.signal?.removeEventListener("abort", onAbort);
        if (canceled) {
          reject(new Error("Worktree environment cleanup canceled."));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const output = [stdoutTail.trim(), stderrTail.trim()].filter(Boolean).join("\n");
        reject(
          new Error(`Worktree environment cleanup script failed.${output ? `\n${output}` : ""}`),
        );
      });
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Exact `q2/Y2/X2`: resolve the worktree-local git path, then write or clear it. */
export async function persistCodexWorktreeShellEnvironment(input: {
  readonly cwd: string;
  readonly shellEnvironment: CodexStoredShellEnvironment | null;
  readonly resolveGitPath: (
    cwd: string,
    fileName: "codex-shell-environment.json",
  ) => Promise<string | null>;
}): Promise<void> {
  const gitPath = await input.resolveGitPath(input.cwd, "codex-shell-environment.json");
  if (!gitPath) {
    throw new Error("No git repository found for worktree shell environment");
  }
  await persistCodexWorktreeShellEnvironmentAtGitPath({
    cwd: input.cwd,
    gitPath,
    shellEnvironment: input.shellEnvironment,
  });
}

/** Filesystem adapter after application code has resolved the repository-relative Git path. */
export async function persistCodexWorktreeShellEnvironmentAtGitPath(input: {
  readonly cwd: string;
  readonly gitPath: string;
  readonly shellEnvironment: CodexStoredShellEnvironment | null;
}): Promise<void> {
  const configPath = path.isAbsolute(input.gitPath)
    ? input.gitPath
    : path.resolve(input.cwd, input.gitPath);
  if (input.shellEnvironment === null) {
    await rm(configPath, { force: true });
    return;
  }
  await writeFile(configPath, `${JSON.stringify(input.shellEnvironment, null, 2)}\n`, "utf8");
}

/** Read a bounded, validated setup delta after the Git owner has resolved its worktree-local path. */
export async function loadCodexWorktreeShellEnvironmentAtGitPath(input: {
  readonly cwd: string;
  readonly gitPath: string;
}): Promise<CodexStoredShellEnvironment | null> {
  const configPath = path.isAbsolute(input.gitPath)
    ? input.gitPath
    : path.resolve(input.cwd, input.gitPath);
  const file = await open(configPath, "r").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return null;
  try {
    const buffer = Buffer.alloc(MAX_STORED_SHELL_ENVIRONMENT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_STORED_SHELL_ENVIRONMENT_BYTES) {
      throw new Error("Worktree shell environment exceeds the supported size.");
    }
    return storedShellEnvironmentSchema.parse(JSON.parse(buffer.toString("utf8", 0, length)));
  } finally {
    await file.close();
  }
}
