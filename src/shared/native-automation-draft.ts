import { claudeAgent } from "./agents/claude";
import { CODEX_BINDING } from "./agents/codex";
import { isAbsoluteAppFilesystemPath } from "./app-protocol";
import type { AutomationInput } from "./core-modules/automation-module";
import type {
  NativeAutomationCandidate,
  NativeAutomationOrigin,
  NativeAutomationScheduleProblem,
} from "./native-automation-import";

/** Create metadata awaiting the Core import contract. */
export type NativeAutomationCreateDraft = AutomationInput & {
  readonly initial_status: "PAUSED";
  readonly import_origin: NativeAutomationOrigin;
};

type DraftBlocker =
  | { readonly field: "schedule"; readonly reason: NativeAutomationScheduleProblem }
  | { readonly field: "heartbeatTarget"; readonly reason: "needs-nodex-session" }
  | { readonly field: "projectId"; readonly reason: "needs-project" }
  | {
      readonly field: "folders";
      readonly reason: "needs-project-folder" | "invalid-path" | "exceeds-core-bound";
    }
  | { readonly field: "name" | "prompt"; readonly reason: "exceeds-core-bound" }
  | { readonly field: "name"; readonly reason: "empty" };

type UnmappedField = {
  readonly field:
    | "memory"
    | "notificationPolicy"
    | "additionalFolders"
    | "model"
    | "reasoningEffort";
  readonly reason: "no-equivalent" | "exceeds-core-bound";
};

export type NativeAutomationDraftIssue =
  | DraftBlocker
  | UnmappedField
  | { readonly field: "localEnvironmentConfigPath"; readonly reason: "invalid-path" };

export interface NativeAutomationDraftOptions {
  readonly timezone: string;
  readonly projectId: string | null;
  /** An admitted Nodex Session corresponding to the native heartbeat conversation. */
  readonly targetSessionId?: string;
}

export interface NativeAutomationDraftResult {
  readonly draft: NativeAutomationCreateDraft | null;
  readonly issues: readonly NativeAutomationDraftIssue[];
}

const utf8 = new TextEncoder();
const validAbsolutePath = (path: string) =>
  !path.includes("\0") &&
  utf8.encode(path).length <= 16 * 1024 &&
  isAbsoluteAppFilesystemPath(path);

export function nativeAutomationCreateDraft(
  candidate: NativeAutomationCandidate,
  { timezone, projectId, targetSessionId }: NativeAutomationDraftOptions,
): NativeAutomationDraftResult {
  const issues: NativeAutomationDraftIssue[] = [];
  const { agent, sourceHome, sourceAutomationId, schedule, kind, executionEnvironment } = candidate;
  const folders = [...new Set(candidate.folders)];
  const name = candidate.name.trim();
  const prompt = candidate.prompt.trim();
  const nativeEnvironmentFile =
    agent === "codex" ? candidate.localEnvironmentConfigPath : undefined;
  const environmentFile = nativeEnvironmentFile?.trim();
  const invalidEnvironmentFile = !!environmentFile && !validAbsolutePath(environmentFile);
  const invalidFolder = kind === "cron" && folders.some((folder) => !validAbsolutePath(folder));
  const tooManyFolders = kind === "cron" && folders.length > 128;
  const projectRequired =
    kind === "cron" &&
    (folders.length > 0 ||
      executionEnvironment === "worktree" ||
      (!!environmentFile && !invalidEnvironmentFile));
  const missingTarget = kind === "heartbeat" && !targetSessionId?.trim();
  const missingProject = projectRequired && !projectId;
  const missingFolder = kind === "cron" && !!projectId && folders.length === 0;
  const nameTooLong = Array.from(name).length > 256;
  const promptTooLong = utf8.encode(prompt).length > 1024 * 1024;

  if (schedule.kind === "unsupported") issues.push({ field: "schedule", reason: schedule.reason });
  if (missingTarget) issues.push({ field: "heartbeatTarget", reason: "needs-nodex-session" });
  if (missingProject) issues.push({ field: "projectId", reason: "needs-project" });
  if (missingFolder) issues.push({ field: "folders", reason: "needs-project-folder" });
  if (invalidFolder) issues.push({ field: "folders", reason: "invalid-path" });
  if (tooManyFolders) issues.push({ field: "folders", reason: "exceeds-core-bound" });
  if (kind === "cron" && invalidEnvironmentFile)
    issues.push({ field: "localEnvironmentConfigPath", reason: "invalid-path" });
  if (!name) issues.push({ field: "name", reason: "empty" });
  if (nameTooLong) issues.push({ field: "name", reason: "exceeds-core-bound" });
  if (promptTooLong) issues.push({ field: "prompt", reason: "exceeds-core-bound" });

  if (agent === "codex" && candidate.memory)
    issues.push({ field: "memory", reason: "no-equivalent" });
  if (agent === "claude" && candidate.additionalFolders?.length)
    issues.push({ field: "additionalFolders", reason: "no-equivalent" });
  const notification = candidate.notificationPolicy;
  if (notification && notification !== "failed_runs_only")
    issues.push({ field: "notificationPolicy", reason: "no-equivalent" });

  const model = candidate.model?.trim();
  const effort = candidate.reasoningEffort?.trim();
  const modelTooLong = !!model && utf8.encode(model).length > 512;
  const effortTooLong = !!effort && utf8.encode(effort).length > 64;
  if (modelTooLong) issues.push({ field: "model", reason: "exceeds-core-bound" });
  if (effortTooLong) issues.push({ field: "reasoningEffort", reason: "exceeds-core-bound" });

  if (
    schedule.kind === "unsupported" ||
    missingTarget ||
    missingProject ||
    missingFolder ||
    invalidFolder ||
    tooManyFolders ||
    !name ||
    nameTooLong ||
    promptTooLong
  )
    return { draft: null, issues };

  return {
    draft: {
      kind,
      name,
      prompt,
      mode: "ask_first",
      initial_status: "PAUSED",
      import_origin: { agent, sourceHome, sourceAutomationId },
      trigger: { kind: "clock", rrule: schedule.rrule, timezone },
      backend_binding:
        agent === "codex"
          ? CODEX_BINDING
          : {
              driver: claudeAgent.driver,
              instanceId: candidate.conversationSource.instanceConfigId,
            },
      ...(kind === "heartbeat"
        ? { target_session_id: targetSessionId?.trim() }
        : {
            project_id: projectId,
            cwds: folders,
            execution_environment: executionEnvironment,
            ...(environmentFile &&
              !invalidEnvironmentFile && { local_environment_config_path: environmentFile }),
          }),
      ...(model && !modelTooLong && { model }),
      ...(effort && !effortTooLong && { reasoning_effort: effort }),
      ...(notification === "failed_runs_only" && {
        notification_policy: { kind: "set", value: notification },
      }),
    },
    issues,
  };
}
