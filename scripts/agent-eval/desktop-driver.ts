import { expect, type Page } from "@playwright/test";
import type { CodexExecutionProfile } from "../../src/shared/codex-execution-profile";
import type { CodexModelOption } from "../../src/shared/types";
import {
  invokeIpc,
  isRecord,
  requireRecord,
  selectCodexExecutionProfile,
  sendAgentPromptWithEvidence,
  type AgentFirstSubmissionEvidence,
} from "../../tests/e2e/support/agent-smoke-harness";
import { classifyAgentSmokeTurnSnapshot } from "../agent-smoke-turn-outcome";
import { isPaidChatGptPlan } from "../paid-agent-smoke-contract";
import {
  readPaidAgentRolloutEvidence,
  type PaidAgentRolloutEvidence,
} from "../paid-agent-rollout-evidence";

export interface DesktopAgentInput {
  readonly page: Page;
  readonly projectId: string;
  readonly codexHome: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onStarted?: (input: { threadId: string; projectSessionId: string }) => void;
}

export interface DesktopAgentResult {
  readonly projectId: string;
  readonly projectSessionId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly status: "completed" | "failed" | "interrupted" | "systemError" | "timedOut";
  readonly finalText: string;
  readonly executionProfile: CodexExecutionProfile;
  readonly firstSubmission: AgentFirstSubmissionEvidence;
  readonly snapshot: Record<string, unknown>;
  readonly summary: Record<string, unknown>;
  readonly rollout: PaidAgentRolloutEvidence | null;
  readonly durationMs: number;
}

const preflightModel = async (page: Page): Promise<CodexModelOption> => {
  const models = (await invokeIpc(page, "codex:model:list")) as readonly CodexModelOption[];
  const model = models.find(
    (candidate) =>
      !candidate.hidden && (candidate.id === "gpt-5.6-luna" || candidate.model === "gpt-5.6-luna"),
  );
  if (!model?.supportedReasoningEfforts.some((option) => option.reasoningEffort === "max")) {
    throw new Error("The desktop evaluation requires gpt-5.6-luna with max reasoning");
  }
  return model;
};

const latestTurn = (snapshot: Record<string, unknown>): Record<string, unknown> | null => {
  const turn = Array.isArray(snapshot.turns) ? snapshot.turns.at(-1) : null;
  return isRecord(turn) ? turn : null;
};

/** Submit one visible task through Nodex's composer; a human Stop never starts another turn. */
export const runDesktopAgent = async (input: DesktopAgentInput): Promise<DesktopAgentResult> => {
  const { page, projectId, signal } = input;
  signal?.throwIfAborted();
  const accountSnapshot = requireRecord(
    await invokeIpc(page, "codex:account:read"),
    "Evaluation account snapshot",
  );
  const account = requireRecord(accountSnapshot.account, "Evaluation account");
  if (
    account.type !== "chatgpt" ||
    typeof account.planType !== "string" ||
    !isPaidChatGptPlan(account.planType)
  ) {
    throw new Error("The desktop evaluation requires a signed-in ChatGPT subscription");
  }
  const model = await preflightModel(page);
  const executionProfile: CodexExecutionProfile = {
    modelId: model.id,
    reasoningEffort: "max",
    serviceTier: null,
  };
  const permission = requireRecord(
    await invokeIpc(page, "codex:permission:mode:set", projectId, "full-access"),
    "Evaluation Project permission state",
  );
  if (permission.mode !== "full-access") {
    throw new Error("The evaluation Project did not enable full access");
  }
  const project = requireRecord(
    await invokeIpc(page, "projects:get", projectId),
    "Evaluation Project",
  );
  if (typeof project.name !== "string") throw new Error("Evaluation Project has no name");
  const before = requireRecord(
    await invokeIpc(page, "workspace:tasks:list", projectId, { first: 100 }),
    "Evaluation tasks",
  );
  const existingIds = new Set(
    Array.isArray(before.items) ? before.items.filter(isRecord).map((item) => item.id) : [],
  );
  await page
    .getByRole("button", { name: `Start new chat in ${project.name}`, exact: true })
    .click();
  let projectSessionId: string | null = null;
  await expect
    .poll(async () => {
      const tasks = requireRecord(
        await invokeIpc(page, "workspace:tasks:list", projectId, { first: 100 }),
        "Evaluation tasks",
      );
      const draft = Array.isArray(tasks.items)
        ? tasks.items.find(
            (item) =>
              isRecord(item) &&
              item.projectId === projectId &&
              item.thread === null &&
              !existingIds.has(item.id),
          )
        : null;
      projectSessionId = isRecord(draft) && typeof draft.id === "string" ? draft.id : null;
      return projectSessionId;
    })
    .not.toBeNull();
  if (!projectSessionId) throw new Error("Evaluation draft has no Project Session id");
  await selectCodexExecutionProfile(page, model, executionProfile);
  const startedAt = Date.now();
  const submission = await sendAgentPromptWithEvidence(
    page,
    projectSessionId,
    input.prompt,
    async () => {
      signal?.throwIfAborted();
      const refreshed = await preflightModel(page);
      if (refreshed.id !== model.id) throw new Error("Evaluation model changed before submission");
    },
  );
  const { threadId, firstSubmission } = submission;
  input.onStarted?.({ threadId, projectSessionId });
  const deadline = startedAt + (input.timeoutMs ?? 300_000);
  let stopRequestedAt: number | null = null;
  let timedOut = false;
  let snapshot: Record<string, unknown>;
  let status: DesktopAgentResult["status"];
  for (;;) {
    snapshot = requireRecord(
      await invokeIpc(page, "codex:thread:snapshot:request", threadId),
      "Evaluation snapshot",
    );
    const outcome = classifyAgentSmokeTurnSnapshot(snapshot);
    if (outcome.kind !== "pending") {
      status = timedOut ? "timedOut" : outcome.kind === "completed" ? "completed" : outcome.reason;
      break;
    }
    if (stopRequestedAt !== null && Date.now() - stopRequestedAt > 15_000) {
      throw new Error("Evaluation task did not acknowledge Stop within 15 seconds");
    }
    if (stopRequestedAt === null && (signal?.aborted || Date.now() >= deadline)) {
      timedOut = !signal?.aborted;
      stopRequestedAt = Date.now();
      const turn = latestTurn(snapshot);
      await invokeIpc(
        page,
        "codex:turn:interrupt",
        threadId,
        typeof turn?.turnId === "string" ? turn.turnId : undefined,
      );
    }
    await page.waitForTimeout(500);
  }
  const summary = requireRecord(
    await invokeIpc(page, "codex:thread:summary:get", threadId),
    "Evaluation summary",
  );
  expect(summary.executionProfile).toEqual(executionProfile);
  const turn = latestTurn(snapshot);
  const turnId = typeof turn?.turnId === "string" ? turn.turnId : null;
  const finalText = (Array.isArray(turn?.items) ? turn.items : [])
    .filter(isRecord)
    .filter(
      (item) => item.semanticKind === "assistantMessage" && item.assistantPhase === "final_answer",
    )
    .map((item) => (typeof item.markdownText === "string" ? item.markdownText : ""))
    .join("\n");
  const rollout = await readPaidAgentRolloutEvidence(input.codexHome, threadId);
  if (
    status === "completed" &&
    !rollout?.turnContexts.some(
      (context) =>
        context.turnId === turnId && context.model === model.model && context.effort === "max",
    )
  ) {
    throw new Error(
      "Completed evaluation has no rollout evidence of the requested model and reasoning effort",
    );
  }
  return {
    projectId,
    projectSessionId,
    threadId,
    turnId,
    status,
    finalText,
    executionProfile,
    firstSubmission,
    snapshot,
    summary,
    rollout,
    durationMs: Date.now() - startedAt,
  };
};
