import { execFile } from "./platform/node/child-stdio-errors";
import { stat } from "node:fs/promises";
import type {
  GhCliAvailability,
  GhPrCreateInput,
  GhPrMutationResult,
  GhPrStatusRequest,
  GhPrStatusResult,
} from "../shared/types";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GhCliStatusResult {
  readonly cwd: string;
  readonly available: boolean;
  readonly status: GhCliAvailability;
  readonly message: string | null;
}

const GH_COMMAND_TIMEOUT_MS = 10_000;

async function ensureDirectory(cwd: string): Promise<string> {
  const normalizedCwd = cwd.trim();
  if (!normalizedCwd) {
    throw new Error("Working directory is required");
  }

  const entry = await stat(normalizedCwd).catch(() => null);
  if (!entry?.isDirectory()) {
    throw new Error(`Working directory not found: ${normalizedCwd}`);
  }

  return normalizedCwd;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  allowedExitCodes: number[] = [0],
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: GH_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error ? error.code : 0;
        if (typeof exitCode !== "number" || (error && !allowedExitCodes.includes(exitCode))) {
          reject(Object.assign(error ?? new Error("Command failed"), { stderr }));
          return;
        }

        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode,
        });
      },
    );
  });
}

function getCommandMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;

  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error.message || fallback;
}

function getMissingGhStatus(cwd: string, error: unknown): GhCliStatusResult {
  return {
    cwd,
    available: false,
    status: "missing-gh",
    message: getCommandMessage(error, "GitHub CLI is not installed or is not on PATH."),
  };
}

async function readGhCliStatusForDirectory(cwd: string): Promise<GhCliStatusResult> {
  try {
    await runCommand("gh", ["--version"], cwd);
  } catch (error) {
    return getMissingGhStatus(cwd, error);
  }

  const remoteResult = await runCommand("git", ["remote", "-v"], cwd, [0, 128]).catch(() => null);
  if (!remoteResult?.stdout.trim()) {
    return {
      cwd,
      available: false,
      status: "missing-remote",
      message: "GitHub pull request review requires a Git remote.",
    };
  }

  const authResult = await runCommand("gh", ["auth", "status"], cwd, [0, 1, 4]).catch(
    (error) => error,
  );
  if (authResult instanceof Error || authResult.exitCode !== 0) {
    return {
      cwd,
      available: false,
      status: "not-authenticated",
      message:
        authResult instanceof Error
          ? getCommandMessage(authResult, "GitHub CLI is not authenticated.")
          : authResult.stderr.trim() || "GitHub CLI is not authenticated.",
    };
  }

  return {
    cwd,
    available: true,
    status: "available",
    message: null,
  };
}

function disabledPrStatus(cwd: string, status: GhCliStatusResult): GhPrStatusResult {
  return {
    cwd,
    available: false,
    status: "disabled",
    disabledReason: status.status,
    prNumber: null,
    title: null,
    url: null,
    state: null,
    mergeStateStatus: null,
    message: status.message,
  };
}

function disabledMutation(cwd: string, status: GhCliStatusResult): GhPrMutationResult {
  return {
    cwd,
    available: false,
    disabledReason: status.status,
    url: null,
    message: status.message,
  };
}

function parseJson(value: string): unknown {
  if (!value.trim()) return null;
  return JSON.parse(value) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function makePrArg(prNumber?: number | null): string[] {
  return typeof prNumber === "number" && Number.isFinite(prNumber) && prNumber > 0
    ? [String(prNumber)]
    : [];
}

export async function readGhPrStatus(input: GhPrStatusRequest): Promise<GhPrStatusResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await readGhCliStatusForDirectory(cwd);
  if (!ghStatus.available) return disabledPrStatus(cwd, ghStatus);

  try {
    const result = await runCommand(
      "gh",
      [
        "pr",
        "view",
        ...(input.headBranch ? [input.headBranch] : makePrArg(input.prNumber)),
        "--json",
        "number,title,url,state,mergeStateStatus,headRefName,headRepository,headRepositoryOwner",
      ],
      cwd,
    );
    const data = asRecord(parseJson(result.stdout));
    return {
      cwd,
      available: true,
      status: "ready",
      disabledReason: null,
      prNumber: asNumber(data?.number),
      title: asString(data?.title),
      url: asString(data?.url),
      state: asString(data?.state),
      mergeStateStatus: asString(data?.mergeStateStatus),
      headBranch: asString(data?.headRefName),
      headRepositoryUrl: (() => {
        const repository = asRecord(data?.headRepository);
        const owner = asRecord(data?.headRepositoryOwner);
        const name =
          asString(repository?.nameWithOwner) ??
          (asString(owner?.login) && asString(repository?.name)
            ? `${asString(owner?.login)}/${asString(repository?.name)}`
            : null);
        const url = asString(data?.url);
        return name && url ? `${new URL(url).origin}/${name}` : null;
      })(),
      message: null,
    };
  } catch (error) {
    return {
      ...disabledPrStatus(cwd, {
        ...ghStatus,
        status: "error",
        message: getCommandMessage(error, "Could not read pull request status."),
      }),
      status: "error",
    };
  }
}

export async function createGhPr(input: GhPrCreateInput): Promise<GhPrMutationResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await readGhCliStatusForDirectory(cwd);
  if (!ghStatus.available) return disabledMutation(cwd, ghStatus);

  const args = ["pr", "create", "--title", input.title, "--body", input.body ?? ""];
  if (input.base?.trim()) args.push("--base", input.base.trim());
  if (input.head?.trim()) args.push("--head", input.head.trim());
  if (input.draft === true) args.push("--draft");

  try {
    const result = await runCommand("gh", args, cwd);
    return {
      cwd,
      available: true,
      disabledReason: null,
      url: result.stdout.trim() || null,
      message: null,
    };
  } catch (error) {
    return disabledMutation(cwd, {
      ...ghStatus,
      status: "error",
      message: getCommandMessage(error, "Could not create pull request."),
    });
  }
}
