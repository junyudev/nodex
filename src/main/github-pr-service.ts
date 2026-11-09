import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type {
  GhCliStatusResult,
  GhPrCheckRun,
  GhPrChecksRequest,
  GhPrChecksResult,
  GhPrComment,
  GhPrCommentInput,
  GhPrCommentResult,
  GhPrCommentsRequest,
  GhPrCommentsResult,
  GhPrCreateInput,
  GhPrDiffRequest,
  GhPrDiffResult,
  GhPrMergeInput,
  GhPrMutationResult,
  GhPrStatusRequest,
  GhPrStatusResult,
  GhPrUpdateInput,
} from "../shared/types";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandError extends Error {
  stderr?: string;
  exitCode?: number | null;
  code?: unknown;
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
        const exitCode =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? (error as { code: number }).code
            : 0;
        if (error && !allowedExitCodes.includes(exitCode)) {
          const failure = error as CommandError;
          failure.stderr = typeof stderr === "string" ? stderr : "";
          failure.exitCode = exitCode;
          reject(failure);
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

async function requireGhCli(cwd: string): Promise<GhCliStatusResult> {
  const status = await readGhCliStatusForDirectory(cwd);
  return status;
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

function disabledChecks(cwd: string, status: GhCliStatusResult): GhPrChecksResult {
  return {
    cwd,
    available: false,
    disabledReason: status.status,
    checks: [],
    message: status.message,
  };
}

function disabledComments(cwd: string, status: GhCliStatusResult): GhPrCommentsResult {
  return {
    cwd,
    available: false,
    disabledReason: status.status,
    comments: [],
    message: status.message,
  };
}

function disabledDiff(cwd: string, status: GhCliStatusResult): GhPrDiffResult {
  return {
    cwd,
    available: false,
    disabledReason: status.status,
    patch: "",
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

function parseJsonSafely(value: string): unknown {
  try {
    return parseJson(value);
  } catch {
    return null;
  }
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

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function makePrArg(prNumber?: number | null): string[] {
  return typeof prNumber === "number" && Number.isFinite(prNumber) && prNumber > 0
    ? [String(prNumber)]
    : [];
}

async function resolveGhPrNumber(cwd: string, prNumber?: number | null): Promise<number> {
  if (typeof prNumber === "number" && Number.isFinite(prNumber) && prNumber > 0) {
    return prNumber;
  }

  const result = await runCommand("gh", ["pr", "view", "--json", "number"], cwd);
  const number = asNumber(asRecord(parseJson(result.stdout))?.number);
  if (!number) {
    throw new Error("Could not resolve pull request number.");
  }
  return number;
}

async function resolveGhPrHeadCommitSha(cwd: string, prNumber: number): Promise<string> {
  const result = await runCommand(
    "gh",
    ["pr", "view", String(prNumber), "--json", "headRefOid"],
    cwd,
  );
  const headRefOid = asString(asRecord(parseJson(result.stdout))?.headRefOid);
  if (!headRefOid) {
    throw new Error("Could not resolve pull request head commit.");
  }
  return headRefOid;
}

function parseGhPrReviewComment(item: unknown): GhPrComment[] {
  const record = asRecord(item);
  if (!record) return [];
  const author = asRecord(record.user) ?? asRecord(record.author);
  const numericId = asNumber(record.id);
  const id =
    asString(record.node_id) ??
    asString(record.id) ??
    (numericId !== null ? String(numericId) : null) ??
    asString(record.url) ??
    "";
  const side = asString(record.side);
  const startSide = asString(record.start_side);
  return [
    {
      id,
      path: asString(record.path),
      line: asNumber(record.line),
      side: side === "LEFT" || side === "RIGHT" ? side : null,
      startLine: asNumber(record.start_line),
      startSide: startSide === "LEFT" || startSide === "RIGHT" ? startSide : null,
      replyToId:
        asNumber(record.in_reply_to_id) !== null
          ? String(asNumber(record.in_reply_to_id))
          : asString(record.in_reply_to_id),
      outdated: asBoolean(record.outdated),
      body: asString(record.body) ?? "",
      author: asString(author?.login) ?? asString(record.author),
      url: asString(record.html_url) ?? asString(record.url),
    },
  ];
}

export async function readGhCliStatus(input: { cwd: string }): Promise<GhCliStatusResult> {
  const cwd = await ensureDirectory(input.cwd);
  return readGhCliStatusForDirectory(cwd);
}

export async function readGhPrStatus(input: GhPrStatusRequest): Promise<GhPrStatusResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await requireGhCli(cwd);
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

export async function readGhPrChecks(input: GhPrChecksRequest): Promise<GhPrChecksResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await requireGhCli(cwd);
  if (!ghStatus.available) return disabledChecks(cwd, ghStatus);

  try {
    const result = await runCommand(
      "gh",
      ["pr", "checks", ...makePrArg(input.prNumber), "--json", "name,status,conclusion,detailsUrl"],
      cwd,
      [0, 1],
    );
    const data = parseJson(result.stdout);
    const checks = Array.isArray(data)
      ? data.flatMap((item): GhPrCheckRun[] => {
          const record = asRecord(item);
          if (!record) return [];
          return [
            {
              name: asString(record.name) ?? "Check",
              status: asString(record.status),
              conclusion: asString(record.conclusion),
              detailsUrl: asString(record.detailsUrl),
            },
          ];
        })
      : [];
    return {
      cwd,
      available: true,
      disabledReason: null,
      checks,
      message: result.exitCode === 0 ? null : result.stderr.trim() || null,
    };
  } catch (error) {
    return {
      ...disabledChecks(cwd, {
        ...ghStatus,
        status: "error",
        message: getCommandMessage(error, "Could not read pull request checks."),
      }),
      available: false,
    };
  }
}

export async function readGhPrComments(input: GhPrCommentsRequest): Promise<GhPrCommentsResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await requireGhCli(cwd);
  if (!ghStatus.available) return disabledComments(cwd, ghStatus);

  try {
    const prNumber = await resolveGhPrNumber(cwd, input.prNumber);
    const result = await runCommand(
      "gh",
      ["api", `repos/{owner}/{repo}/pulls/${prNumber}/comments`, "--paginate", "--slurp"],
      cwd,
    );
    const data = parseJson(result.stdout);
    const commentsValue = Array.isArray(data) && data.every(Array.isArray) ? data.flat() : data;
    const comments = Array.isArray(commentsValue)
      ? commentsValue.flatMap(parseGhPrReviewComment)
      : [];
    return {
      cwd,
      available: true,
      disabledReason: null,
      comments,
      message: null,
    };
  } catch (error) {
    return disabledComments(cwd, {
      ...ghStatus,
      status: "error",
      message: getCommandMessage(error, "Could not read pull request comments."),
    });
  }
}

export async function readGhPrDiff(input: GhPrDiffRequest): Promise<GhPrDiffResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await requireGhCli(cwd);
  if (!ghStatus.available) return disabledDiff(cwd, ghStatus);

  try {
    const result = await runCommand(
      "gh",
      ["pr", "diff", ...makePrArg(input.prNumber), "--patch"],
      cwd,
    );
    return {
      cwd,
      available: true,
      disabledReason: null,
      patch: result.stdout,
      message: null,
    };
  } catch (error) {
    return disabledDiff(cwd, {
      ...ghStatus,
      status: "error",
      message: getCommandMessage(error, "Could not read pull request diff."),
    });
  }
}

export async function createGhPrComment(input: GhPrCommentInput): Promise<GhPrCommentResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await requireGhCli(cwd);
  if (!ghStatus.available) return disabledMutation(cwd, ghStatus);
  if (input.body.trim().length === 0) {
    return disabledMutation(cwd, {
      ...ghStatus,
      status: "error",
      message: "Pull request comment body is required.",
    });
  }

  try {
    const prNumber = await resolveGhPrNumber(cwd, input.prNumber);
    const result =
      input.type === "inline"
        ? await runCommand(
            "gh",
            [
              "api",
              "-X",
              "POST",
              `repos/{owner}/{repo}/pulls/${prNumber}/comments`,
              "-f",
              `body=${input.body.trim()}`,
              "-f",
              `commit_id=${input.commitSha?.trim() || (await resolveGhPrHeadCommitSha(cwd, prNumber))}`,
              "-f",
              `path=${input.path}`,
              "-F",
              `line=${input.line}`,
              "-f",
              `side=${input.side}`,
              ...(input.startLine ? ["-F", `start_line=${input.startLine}`] : []),
              ...(input.startSide ? ["-f", `start_side=${input.startSide}`] : []),
            ],
            cwd,
          )
        : input.type === "reply"
          ? await runCommand(
              "gh",
              [
                "api",
                "-X",
                "POST",
                `repos/{owner}/{repo}/pulls/${prNumber}/comments/${input.commentId}/replies`,
                "-f",
                `body=${input.body.trim()}`,
              ],
              cwd,
            )
          : await runCommand(
              "gh",
              ["pr", "comment", String(prNumber), "--body", input.body.trim()],
              cwd,
            );
    return {
      cwd,
      available: true,
      disabledReason: null,
      url:
        asString(asRecord(parseJsonSafely(result.stdout))?.html_url) ??
        (result.stdout.trim() || null),
      message: null,
    };
  } catch (error) {
    return disabledMutation(cwd, {
      ...ghStatus,
      status: "error",
      message: getCommandMessage(error, "Could not create pull request comment."),
    });
  }
}

export async function mergeGhPr(input: GhPrMergeInput): Promise<GhPrMutationResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await requireGhCli(cwd);
  if (!ghStatus.available) return disabledMutation(cwd, ghStatus);

  const method = input.method ?? "merge";
  try {
    const result = await runCommand(
      "gh",
      [
        "pr",
        "merge",
        String(input.prNumber),
        method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge",
      ],
      cwd,
    );
    return {
      cwd,
      available: true,
      disabledReason: null,
      url: null,
      message: result.stdout.trim() || null,
    };
  } catch (error) {
    return disabledMutation(cwd, {
      ...ghStatus,
      status: "error",
      message: getCommandMessage(error, "Could not merge pull request."),
    });
  }
}

export async function updateGhPr(input: GhPrUpdateInput): Promise<GhPrMutationResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await requireGhCli(cwd);
  if (!ghStatus.available) return disabledMutation(cwd, ghStatus);

  const args = ["pr", "edit", String(input.prNumber)];
  if (input.title?.trim()) args.push("--title", input.title.trim());
  if (input.body !== undefined && input.body !== null) args.push("--body", input.body);
  if (args.length === 3) {
    return {
      cwd,
      available: true,
      disabledReason: null,
      url: null,
      message: "No pull request fields changed.",
    };
  }

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
      message: getCommandMessage(error, "Could not update pull request."),
    });
  }
}

export async function createGhPr(input: GhPrCreateInput): Promise<GhPrMutationResult> {
  const cwd = await ensureDirectory(input.cwd);
  const ghStatus = await requireGhCli(cwd);
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
