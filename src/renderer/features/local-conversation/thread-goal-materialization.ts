import type { CodexThreadGoalDraftInput, CodexThreadGoalMaterializedDraft } from "@/lib/types";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "@/lib/renderer-command";

const THREAD_GOAL_LONG_OBJECTIVE_THRESHOLD = 4000;

const materializeThreadGoalDraftCommand = defineRendererCommand({
  key: "thread_goal.materialize_draft",
  channel: "codex:thread:goal:materialize-draft",
  authority: "external",
  owner: "ThreadGoalMaterialization",
  protocol: { kind: "pending_operation" },
  trace: { scopeKind: "thread" },
});

function hasThreadGoalMaterializedAttachments(draft: CodexThreadGoalDraftInput): boolean {
  return draft.pastedTextAttachments.length > 0 || draft.imageAttachments.length > 0;
}

function normalizeMaterializedDraftResponse(response: unknown): CodexThreadGoalMaterializedDraft {
  if (!response || typeof response !== "object") {
    throw new Error("Thread goal materialization returned an invalid response");
  }

  const materialized = response as Partial<CodexThreadGoalMaterializedDraft>;
  if (typeof materialized.objective !== "string") {
    throw new Error("Thread goal materialization returned an invalid objective");
  }

  return {
    objective: materialized.objective,
    attachmentDirectory:
      typeof materialized.attachmentDirectory === "string"
        ? materialized.attachmentDirectory
        : null,
  };
}

export async function materializeThreadGoalDraft(
  draft: CodexThreadGoalDraftInput,
): Promise<CodexThreadGoalMaterializedDraft> {
  const trimmedObjective = draft.objective.trim();
  const hasAttachments = hasThreadGoalMaterializedAttachments(draft);
  if (!trimmedObjective && !hasAttachments) {
    throw new Error("Goal objective must not be empty");
  }

  if (
    !hasAttachments &&
    Array.from(trimmedObjective).length <= THREAD_GOAL_LONG_OBJECTIVE_THRESHOLD
  ) {
    return {
      objective: trimmedObjective,
      attachmentDirectory: null,
    };
  }

  return normalizeMaterializedDraftResponse(
    await invokePlainCommand(materializeThreadGoalDraftCommand, draft),
  );
}

export async function cleanupMaterializedThreadGoalDraft(
  materialized: CodexThreadGoalMaterializedDraft | null,
): Promise<void> {
  if (!materialized?.attachmentDirectory) return;
  await runBestEffortThreadGoalCleanup(async () => {
    await invokeRendererControl(
      "codex:thread:goal:materialized-cleanup",
      materialized.attachmentDirectory,
    );
  });
}

export async function runBestEffortThreadGoalCleanup(
  cleanup: () => Promise<unknown>,
): Promise<void> {
  await cleanup().catch(() => undefined);
}

export async function readThreadGoalEditableObjective(objective: string): Promise<string> {
  const editableObjective = await invokeRendererQuery(
    "codex:thread:goal:editable-objective:read",
    objective,
  );
  if (typeof editableObjective !== "string") {
    throw new Error("Thread goal editable objective returned an invalid response");
  }
  return editableObjective;
}
