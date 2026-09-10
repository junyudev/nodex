import { randomUUID } from "node:crypto";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
import { CODEX_CLIENT_THREAD_ID_PREFIX } from "../../shared/codex-client-thread";
import { dedupeCodexLiveFileAttachments } from "../../shared/codex-live-file-attachments";
import type {
  CodexPendingStartConversationParamsInput,
  CodexPendingWorktreeCreateInput,
  CodexPendingWorktreeCreateResult,
  CodexPendingWorktreeRequest,
} from "../../shared/codex-pending-worktree";
import type {
  CodexLiveFileAttachment,
  CodexPastedTextAttachment,
  CodexPermissionState,
  CodexThreadGoalDraftInput,
} from "../../shared/types";
import {
  rewriteExecutionWorkspacePath,
  rewriteExecutionWorkspaceRoots,
} from "./codex-execution-workspace-roots";

export { dedupeCodexLiveFileAttachments } from "../../shared/codex-live-file-attachments";

export interface AllocatedCodexPendingWorktreeRequest {
  readonly request: CodexPendingWorktreeRequest;
  readonly result: CodexPendingWorktreeCreateResult;
}

const CODEX_ONBOARDING_INTERACTIVE_TOOLS_CONFIG_KEY = "features.onboarding_interactive_tools";
const CODEX_PENDING_FILES_HEADING = "# Files mentioned by the user:";
const CODEX_PENDING_USER_REQUEST_HEADING = "## My request for Codex:";
const CODEX_PENDING_PASTED_TEXT_REQUEST =
  "The attached pasted text file(s) contain the user's request. Read and act on that content.";

export interface CodexPendingThreadStartProjection {
  readonly defaultFeatureOverrides: NonNullable<ThreadStartParams["config"]> | null;
  readonly configOverrides: NonNullable<ThreadStartParams["config"]>;
  readonly memoryPreferences?: CodexPendingStartConversationParamsInput["memoryPreferences"];
}

export function shouldSendCodexPendingPermissionOverrides(input: {
  readonly effectivePreset: CodexPermissionState["effectivePreset"];
  readonly permissionProfileId?: string;
}): boolean {
  return input.permissionProfileId !== undefined || input.effectivePreset !== "custom";
}

/** Exact `gBe`: append pasted source files with preview-derived display labels. */
export function appendCodexPendingPastedTextAttachments(
  fileAttachments: readonly CodexLiveFileAttachment[],
  pastedTextAttachments: readonly CodexPastedTextAttachment[] = [],
): CodexLiveFileAttachment[] {
  return [
    ...fileAttachments,
    ...pastedTextAttachments.map(({ file, preview }) => ({
      ...file,
      label: preview || file.label.replace(/\.txt$/i, ""),
    })),
  ];
}

/** Exact `La`: a materialized goal excludes only its pasted source files. */
export function filterCodexPendingGoalSourceFileAttachments(
  fileAttachments: readonly CodexLiveFileAttachment[],
  threadGoalDraft: CodexThreadGoalDraftInput | null | undefined,
): CodexLiveFileAttachment[] {
  const goalSourcePaths = new Set(
    (threadGoalDraft?.pastedTextAttachments ?? []).flatMap((attachment) =>
      attachment.file ? [attachment.file.path] : [],
    ),
  );
  if (goalSourcePaths.size === 0) return [...fileAttachments];
  return fileAttachments.filter((attachment) => !goalSourcePaths.has(attachment.path));
}

/** Exact realization order: filter goal sources from files, append added files, then dedupe. */
export function buildCodexPendingFirstTurnAttachments(input: {
  readonly fileAttachments: readonly CodexLiveFileAttachment[];
  readonly addedFiles: readonly CodexLiveFileAttachment[];
  readonly threadGoalDraft?: CodexThreadGoalDraftInput | null;
}): CodexLiveFileAttachment[] {
  return dedupeCodexLiveFileAttachments([
    ...filterCodexPendingGoalSourceFileAttachments(input.fileAttachments, input.threadGoalDraft),
    ...input.addedFiles,
  ]);
}

/** Exact attachment-only subset of `JBe`/`oVe` used by the ordinary pending producer. */
export function buildCodexPendingComposerPrompt(input: {
  readonly prompt: string;
  readonly fileAttachments: readonly CodexLiveFileAttachment[];
  readonly pastedTextAttachments?: readonly CodexPastedTextAttachment[];
  readonly addedFiles: readonly CodexLiveFileAttachment[];
}): string {
  const pastedTextAttachments = input.pastedTextAttachments ?? [];
  const attachments = dedupeCodexLiveFileAttachments([
    ...input.addedFiles,
    ...appendCodexPendingPastedTextAttachments(input.fileAttachments, pastedTextAttachments),
  ]);
  let context = "";
  if (attachments.length > 0) {
    context += `\n${CODEX_PENDING_FILES_HEADING}\n`;
    for (const attachment of attachments) {
      const lineSuffix =
        attachment.startLine == null
          ? ""
          : attachment.endLine != null && attachment.endLine !== attachment.startLine
            ? ` (lines ${attachment.startLine}-${attachment.endLine})`
            : ` (line ${attachment.startLine})`;
      context += `\n## ${attachment.label}: ${attachment.path}${lineSuffix}\n`;
    }
  }
  const pastedTextOwnsEmptyRequest =
    input.prompt.trim().length === 0 && pastedTextAttachments.length > 0;
  const prefix = `${context}${
    pastedTextOwnsEmptyRequest ? `\n${CODEX_PENDING_PASTED_TEXT_REQUEST}\n` : ""
  }`;
  return `${prefix ? `${prefix}\n${CODEX_PENDING_USER_REQUEST_HEADING}\n` : ""}${input.prompt}\n`;
}

/** Promote the onboarding control flag into the builder path and remove its raw override. */
export function projectCodexPendingThreadStart(input: {
  readonly defaultFeatureOverrides: NonNullable<ThreadStartParams["config"]> | null;
  readonly frozen: Pick<
    CodexPendingStartConversationParamsInput,
    "configOverrides" | "memoryPreferences"
  >;
}): CodexPendingThreadStartProjection {
  const {
    [CODEX_ONBOARDING_INTERACTIVE_TOOLS_CONFIG_KEY]: onboardingInteractiveTools,
    ...configOverrides
  } = input.frozen.configOverrides ?? {};
  return {
    defaultFeatureOverrides:
      onboardingInteractiveTools === true
        ? {
            ...(input.defaultFeatureOverrides ?? {}),
            [CODEX_ONBOARDING_INTERACTIVE_TOOLS_CONFIG_KEY]: true,
          }
        : input.defaultFeatureOverrides,
    configOverrides,
    ...(input.frozen.memoryPreferences === undefined
      ? {}
      : { memoryPreferences: input.frozen.memoryPreferences }),
  };
}

type CodexPendingStartConversationFreezeInput = Omit<
  CodexPendingStartConversationParamsInput,
  "cwd" | "workspaceRoots"
> & {
  readonly sourceWorkspaceRoot: string;
  readonly sourceWorkspaceRoots?: readonly string[];
};

function dedupeWorkspaceRoots(primaryRoot: string, workspaceRoots: readonly string[]): string[] {
  return rewriteExecutionWorkspaceRoots({
    sourcePrimary: primaryRoot,
    targetPrimary: primaryRoot,
    workspaceRoots,
  });
}

/** Rebase a frozen source path without losing a nested cwd suffix. */
export function rebaseCodexPendingWorkspacePath(input: {
  readonly path: string;
  readonly sourceWorkspaceRoot: string;
  readonly worktreeWorkspaceRoot: string;
}): string {
  return rewriteExecutionWorkspacePath({
    path: input.path,
    sourcePrimary: input.sourceWorkspaceRoot,
    targetPrimary: input.worktreeWorkspaceRoot,
  });
}

/** Replace only the primary source root and retain every other project root. */
export function rebaseCodexPendingWorkspaceRoots(input: {
  readonly sourceWorkspaceRoot: string;
  readonly worktreeWorkspaceRoot: string;
  readonly workspaceRoots: readonly string[];
}): string[] {
  return rewriteExecutionWorkspaceRoots({
    sourcePrimary: input.sourceWorkspaceRoot,
    targetPrimary: input.worktreeWorkspaceRoot,
    workspaceRoots: input.workspaceRoots,
  });
}

export function projectCodexPendingWorktreeLaunchLocation(input: {
  readonly params: Pick<
    CodexPendingStartConversationParamsInput,
    "cwd" | "projectAssignment" | "workspaceRoots"
  >;
  readonly sourceWorkspaceRoot: string;
  readonly worktreeWorkspaceRoot: string;
}): {
  readonly cwd: string;
  readonly projectAssignment: CodexPendingStartConversationParamsInput["projectAssignment"];
  readonly workspaceRoots: readonly string[];
} {
  const rebasePath = (candidate: string): string =>
    rebaseCodexPendingWorkspacePath({
      path: candidate,
      sourceWorkspaceRoot: input.sourceWorkspaceRoot,
      worktreeWorkspaceRoot: input.worktreeWorkspaceRoot,
    });
  const projectAssignment = input.params.projectAssignment
    ? {
        ...input.params.projectAssignment,
        ...(input.params.projectAssignment.path
          ? { path: rebasePath(input.params.projectAssignment.path) }
          : {}),
      }
    : input.params.projectAssignment;
  const cwd = rebasePath(input.params.cwd);
  const assignmentPath = projectAssignment?.path;
  return {
    cwd,
    workspaceRoots: rewriteExecutionWorkspaceRoots({
      sourcePrimary: input.sourceWorkspaceRoot,
      targetPrimary: input.worktreeWorkspaceRoot,
      workspaceRoots: input.params.workspaceRoots,
      explicitRoots: [cwd, ...(assignmentPath ? [assignmentPath] : [])],
    }),
    projectAssignment,
  };
}

/** Freeze the exact start payload before asynchronous worktree realization begins. */
export function buildCodexPendingStartConversationParams(
  input: CodexPendingStartConversationFreezeInput,
): CodexPendingStartConversationParamsInput {
  const { sourceWorkspaceRoot, sourceWorkspaceRoots, ...params } = input;
  return {
    ...params,
    input: [...params.input],
    commentAttachments: [...params.commentAttachments],
    workspaceRoots: dedupeWorkspaceRoots(
      sourceWorkspaceRoot,
      sourceWorkspaceRoots ?? [sourceWorkspaceRoot],
    ),
    cwd: sourceWorkspaceRoot,
    fileAttachments: params.fileAttachments.map((attachment) => ({ ...attachment })),
    addedFiles: params.addedFiles.map((attachment) => ({ ...attachment })),
    ...(params.pastedTextAttachments === undefined
      ? {}
      : { pastedTextAttachments: [...params.pastedTextAttachments] }),
    executionProfile: params.executionProfile ? { ...params.executionProfile } : null,
    config: { ...params.config },
    ...(params.configOverrides === undefined
      ? {}
      : { configOverrides: { ...params.configOverrides } }),
    ...(params.memoryPreferences === undefined
      ? {}
      : {
          memoryPreferences:
            params.memoryPreferences === null ? null : { ...params.memoryPreferences },
        }),
  };
}

/**
 * Project the frozen start payload onto a fresh platform thread config.
 * The full frozen config is intentionally absent: it is permission-derivation input only.
 */
export function buildCodexPendingThreadStartConfig(
  platformConfig: ThreadStartParams["config"],
  frozen: Pick<CodexPendingStartConversationParamsInput, "configOverrides" | "memoryPreferences">,
): NonNullable<ThreadStartParams["config"]> {
  const configOverrides = projectCodexPendingThreadStart({
    defaultFeatureOverrides: null,
    frozen,
  }).configOverrides;
  const memoryConfig =
    frozen.memoryPreferences === null || frozen.memoryPreferences === undefined
      ? {}
      : {
          "memories.generate_memories": frozen.memoryPreferences.generateMemories,
          "memories.use_memories": frozen.memoryPreferences.useMemories,
        };
  return {
    ...(platformConfig ?? {}),
    ...memoryConfig,
    ...configOverrides,
  };
}

/** Exact host-scoped pending ID plus conversation-only client identity allocation. */
export function allocateCodexPendingWorktreeRequest(
  input: CodexPendingWorktreeCreateInput,
  createId: () => string = randomUUID,
): AllocatedCodexPendingWorktreeRequest {
  const pendingWorktreeId = `${input.hostId}:${createId()}`;
  if (input.launchMode === "create-stable-worktree") {
    return {
      request: { ...input, id: pendingWorktreeId },
      result: { pendingWorktreeId, clientThreadId: null },
    };
  }

  const clientThreadId = `${CODEX_CLIENT_THREAD_ID_PREFIX}${createId()}`;
  return {
    request: { ...input, id: pendingWorktreeId, clientThreadId },
    result: { pendingWorktreeId, clientThreadId },
  };
}
