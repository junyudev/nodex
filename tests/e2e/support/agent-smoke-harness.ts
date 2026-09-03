import { expect, type Locator, type Page } from "@playwright/test";

import {
  classifyAgentSmokeTurnSnapshot,
  summarizeAgentSmokeTurnSnapshot,
} from "../../../scripts/agent-smoke-turn-outcome";
import type { CodexExecutionProfile } from "../../../src/shared/codex-execution-profile";
import type { CodexModelOption } from "../../../src/shared/types";
import { createBoundedOperationId } from "../../../src/shared/operation-identity";
import { createUuidV7 } from "../../../src/shared/uuid-v7";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (isRecord(value)) return value;
  throw new Error(`${label} returned no record`);
};

export const requireCoreValue = (result: unknown, label: string): unknown => {
  if (isRecord(result) && result.ok === true && "value" in result) return result.value;
  const message =
    isRecord(result) && isRecord(result.error) && typeof result.error.message === "string"
      ? result.error.message
      : "unknown Core error";
  throw new Error(`${label} failed: ${message}`);
};

export const invokeIpc = async (
  page: Page,
  channel: string,
  ...arguments_: readonly unknown[]
): Promise<unknown> =>
  await page.evaluate(
    async ({ targetChannel, targetArguments }) =>
      await window.api?.invoke(targetChannel, ...targetArguments),
    { targetChannel: channel, targetArguments: arguments_ },
  );

export const collectRecords = (value: unknown): Record<string, unknown>[] => {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;
    records.push(candidate);
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(value);
  return records;
};

export const createAgentSmokeDraft = async (
  page: Page,
  workspaceRoot: string,
  projectName: string,
): Promise<{ projectId: string; projectSessionId: string }> => {
  const projectId = createUuidV7();
  const project = requireRecord(
    requireCoreValue(
      await invokeIpc(page, "projects:create", {
        operationId: createBoundedOperationId("e2e.agent-smoke.project.create"),
        payload: {
          projectId,
          input: { name: projectName, sources: [workspaceRoot] },
        },
      }),
      "Agent smoke Project creation",
    ),
    "Agent smoke Project creation",
  );
  if (typeof project.id !== "string") throw new Error("Agent smoke Project returned no id");
  await page.reload();
  await page.evaluate(() => window.api?.awaitInitialization?.());
  await page.getByRole("button", { name: `Start new chat in ${projectName}`, exact: true }).click();

  let projectSessionId: string | null = null;
  await expect
    .poll(async () => {
      const window = requireRecord(
        await invokeIpc(page, "workspace:tasks:list", project.id, { first: 20 }),
        "Agent smoke task window",
      );
      if (!Array.isArray(window.items)) return "missing";
      const draft = window.items.find(
        (item) => isRecord(item) && item.projectId === project.id && item.thread === null,
      );
      projectSessionId = isRecord(draft) && typeof draft.id === "string" ? draft.id : null;
      return projectSessionId ? "ready" : "missing";
    })
    .toBe("ready");
  if (!projectSessionId) throw new Error("Agent smoke draft returned no Project Session id");
  return { projectId: project.id, projectSessionId };
};

export const setAgentExecutionProfile = async (
  page: Page,
  input: { readonly preferredModelId?: string } = {},
): Promise<CodexExecutionProfile> => {
  const models = (await invokeIpc(page, "codex:model:list")) as readonly CodexModelOption[];
  const model =
    models.find(
      (candidate) =>
        !candidate.hidden &&
        (candidate.id === input.preferredModelId || candidate.model === input.preferredModelId),
    ) ?? models.find((candidate) => !candidate.hidden);
  if (!model) throw new Error("Scripted Agent smoke found no visible Codex model");
  const reasoningEffort =
    model.supportedReasoningEfforts.find((candidate) => candidate.reasoningEffort === "low")
      ?.reasoningEffort ??
    model.defaultReasoningEffort ??
    model.supportedReasoningEfforts[0]?.reasoningEffort ??
    null;
  const profile: CodexExecutionProfile = {
    modelId: model.id,
    reasoningEffort,
    serviceTier: null,
  };
  await selectCodexExecutionProfile(page, model, profile);
  return profile;
};

const exactMenuItem = (page: Page, text: string): Locator =>
  page.getByRole("menuitem").filter({ hasText: text }).last();

const openFlyoutSubmenu = async (
  page: Page,
  trigger: Locator,
  expectedItem: Locator,
): Promise<void> => {
  await expect(trigger).toBeVisible();
  await trigger.hover();
  if (await expectedItem.isVisible().catch(() => false)) return;
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await expect(expectedItem).toBeVisible();
};

export const selectCodexExecutionProfile = async (
  page: Page,
  model: CodexModelOption,
  profile: CodexExecutionProfile,
): Promise<void> => {
  const trigger = page.getByRole("button", { name: "Select model" });
  const openRootMenu = async (): Promise<void> => {
    const modelSummary = page.locator('[aria-label^="Model "]').last();
    if (await modelSummary.isVisible().catch(() => false)) return;
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(modelSummary).toBeVisible();
  };
  await openRootMenu();
  const modelItem = exactMenuItem(page, model.displayName);
  await openFlyoutSubmenu(page, page.locator('[aria-label^="Model "]').last(), modelItem);
  await modelItem.click();
  await openRootMenu();
  if (profile.reasoningEffort) {
    const effortItem = page.locator(`[data-intelligence-option="${profile.reasoningEffort}"]`);
    await openFlyoutSubmenu(page, page.locator('[aria-label^="Effort "]').last(), effortItem);
    await effortItem.click();
  }
  await page.keyboard.press("Escape");
};

export const waitForAgentThreadExecutionProfile = async (
  page: Page,
  threadId: string,
  expectedProfile: CodexExecutionProfile,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        const summary = await invokeIpc(page, "codex:thread:summary:get", threadId);
        return isRecord(summary) ? summary.executionProfile : null;
      },
      { timeout: 15_000 },
    )
    .toEqual(expectedProfile);
};

export interface AgentFirstSubmissionEvidence {
  readonly submitToFirstVisibleUserMessageMs: number;
  readonly submitToThreadLinkMs: number;
  readonly blankFrameCount: number;
  readonly duplicateFrameCount: number;
  readonly finalUserMessageCount: number;
  readonly clientUserMessageIdentityCount: number;
}

export interface AgentPromptSubmissionResult {
  readonly threadId: string;
  readonly firstSubmission: AgentFirstSubmissionEvidence;
}

export const sendAgentPromptWithEvidence = async (
  page: Page,
  projectSessionId: string,
  prompt: string,
  beforeSend: () => Promise<void> = async () => undefined,
): Promise<AgentPromptSubmissionResult> => {
  const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
  await expect(composer).toBeVisible();
  await expect(async () => {
    // A newly selected draft can finish hydrating after its composer becomes visible. Refill the
    // current editor if that one-time remount replaces the DOM node we initially targeted.
    await composer.fill(prompt);
    await expect(composer).toHaveText(prompt, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  const sendButton = page.getByRole("button", { name: "Send prompt" });
  await expect(sendButton).toBeEnabled();
  await beforeSend();
  await page.evaluate((expectedPrompt) => {
    const scope = window as typeof window & {
      __agentFirstSubmissionFrame?: number;
      __agentFirstSubmissionBlankFrames?: number;
      __agentFirstSubmissionDuplicateFrames?: number;
      __agentFirstSubmissionSubmittedAt?: number;
      __agentFirstSubmissionFirstUserAt?: number | null;
    };
    if (scope.__agentFirstSubmissionFrame !== undefined) {
      cancelAnimationFrame(scope.__agentFirstSubmissionFrame);
    }
    scope.__agentFirstSubmissionBlankFrames = 0;
    scope.__agentFirstSubmissionDuplicateFrames = 0;
    scope.__agentFirstSubmissionSubmittedAt = performance.now();
    scope.__agentFirstSubmissionFirstUserAt = null;
    const sample = () => {
      const composerContainsPrompt = Array.from(
        document.querySelectorAll<HTMLElement>("[data-codex-composer='true']"),
      ).some((element) => element.textContent?.includes(expectedPrompt) === true);
      const matchingRows = Array.from(
        document.querySelectorAll<HTMLElement>("[data-user-message-bubble='true']"),
      ).filter((element) => element.textContent?.includes(expectedPrompt) === true);
      if (matchingRows.length > 0 && scope.__agentFirstSubmissionFirstUserAt === null) {
        scope.__agentFirstSubmissionFirstUserAt = performance.now();
      }
      if (!composerContainsPrompt && matchingRows.length === 0) {
        scope.__agentFirstSubmissionBlankFrames =
          (scope.__agentFirstSubmissionBlankFrames ?? 0) + 1;
      }
      if (matchingRows.length > 1) {
        scope.__agentFirstSubmissionDuplicateFrames =
          (scope.__agentFirstSubmissionDuplicateFrames ?? 0) + 1;
      }
      scope.__agentFirstSubmissionFrame = requestAnimationFrame(sample);
    };
    scope.__agentFirstSubmissionFrame = requestAnimationFrame(sample);
  }, prompt);
  await sendButton.click();

  await expect(page.locator("[data-user-message-bubble='true']", { hasText: prompt })).toBeVisible({
    timeout: 10_000,
  });

  let threadId: string | null = null;
  let launchFailure: string | null = null;
  try {
    await expect
      .poll(
        async () => {
          const failed = page.getByText("Message could not be sent.", { exact: true }).last();
          if (await failed.isVisible().catch(() => false)) {
            const detail = page.getByText(/Error invoking remote method/u).last();
            launchFailure = (await detail.isVisible().catch(() => false))
              ? ((await detail.textContent())?.replaceAll(/\s+/gu, " ").trim().slice(0, 1_000) ??
                "Message could not be sent.")
              : "Message could not be sent.";
            return "failed";
          }
          const session = await invokeIpc(page, "project-sessions:get", projectSessionId);
          if (!isRecord(session) || !isRecord(session.thread)) return "missing";
          threadId = typeof session.thread.threadId === "string" ? session.thread.threadId : null;
          return threadId ? "linked" : "missing";
        },
        { timeout: 45_000 },
      )
      .toBe("linked");
  } catch (error) {
    if (launchFailure) throw new Error(`Thread launch failed: ${launchFailure}`, { cause: error });
    throw error;
  }
  if (!threadId) throw new Error("Agent smoke turn returned no Thread id");
  const firstSubmission = await page.evaluate((expectedPrompt) => {
    const scope = window as typeof window & {
      __agentFirstSubmissionFrame?: number;
      __agentFirstSubmissionBlankFrames?: number;
      __agentFirstSubmissionDuplicateFrames?: number;
      __agentFirstSubmissionSubmittedAt?: number;
      __agentFirstSubmissionFirstUserAt?: number | null;
    };
    if (scope.__agentFirstSubmissionFrame !== undefined) {
      cancelAnimationFrame(scope.__agentFirstSubmissionFrame);
    }
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-user-message-bubble='true']"),
    ).filter((element) => element.textContent?.includes(expectedPrompt) === true);
    const identities = new Set(
      rows.flatMap((row) =>
        row.dataset.clientUserMessageId ? [row.dataset.clientUserMessageId] : [],
      ),
    );
    const submittedAt = scope.__agentFirstSubmissionSubmittedAt ?? performance.now();
    const firstUserAt = scope.__agentFirstSubmissionFirstUserAt ?? performance.now();
    return {
      submitToFirstVisibleUserMessageMs: firstUserAt - submittedAt,
      submitToThreadLinkMs: performance.now() - submittedAt,
      blankFrameCount: scope.__agentFirstSubmissionBlankFrames ?? 0,
      duplicateFrameCount: scope.__agentFirstSubmissionDuplicateFrames ?? 0,
      finalUserMessageCount: rows.length,
      clientUserMessageIdentityCount: identities.size,
    };
  }, prompt);
  const evidence: AgentFirstSubmissionEvidence = firstSubmission;
  expect(evidence.submitToFirstVisibleUserMessageMs).toBeLessThan(1_000);
  expect(evidence.blankFrameCount).toBe(0);
  expect(evidence.duplicateFrameCount).toBe(0);
  expect(evidence.finalUserMessageCount).toBe(1);
  expect(evidence.clientUserMessageIdentityCount).toBe(1);
  return { threadId, firstSubmission: evidence };
};

export const sendAgentPrompt = async (
  page: Page,
  projectSessionId: string,
  prompt: string,
  beforeSend: () => Promise<void> = async () => undefined,
): Promise<string> =>
  (await sendAgentPromptWithEvidence(page, projectSessionId, prompt, beforeSend)).threadId;

export const waitForFinalMarker = async (
  page: Page,
  marker: string,
  timeout = 60_000,
): Promise<void> => {
  await expect(page.getByText(marker, { exact: true }).last()).toBeVisible({ timeout });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
    timeout,
  });
};

export const waitForCompletedAgentTurn = async (
  page: Page,
  threadId: string,
  timeout = 20_000,
): Promise<unknown> => {
  const deadline = Date.now() + timeout;
  let latestSnapshot: unknown = null;

  while (Date.now() < deadline) {
    latestSnapshot = await invokeIpc(page, "codex:thread:snapshot:request", threadId).catch(
      () => null,
    );
    const outcome = classifyAgentSmokeTurnSnapshot(latestSnapshot);
    if (outcome.kind === "completed") return latestSnapshot;
    if (outcome.kind === "terminalFailure") {
      throw new Error(
        `Agent turn ended with ${outcome.reason}. Latest state:\n${JSON.stringify(summarizeAgentSmokeTurnSnapshot(latestSnapshot, threadId), null, 2)}`,
      );
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for Agent turn completion. Latest state:\n${JSON.stringify(summarizeAgentSmokeTurnSnapshot(latestSnapshot, threadId), null, 2)}`,
  );
};
