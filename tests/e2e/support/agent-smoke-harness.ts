import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type {
  ThreadReadResponse,
  ThreadTurnsListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import { formatCodexReasoningEffortLabel } from "../../../src/renderer/lib/codex-thread-settings";
import {
  chooseComposerEffort,
  chooseComposerModel,
  refreshComposerModels,
} from "./composer-model-picker";

import {
  classifyAgentSmokeTurnSnapshot,
  summarizeAgentSmokeTurnSnapshot,
} from "../../../scripts/agent-smoke-turn-outcome";
import type { CodexExecutionProfile } from "../../../src/shared/codex-execution-profile";
import { parseModelOption } from "../../../src/shared/codex-composer-catalog";
import type { CodexNativeRequestOutcome } from "../../../src/shared/codex-native-request-outcome";
import type { CodexModelOption } from "../../../src/shared/types";
import type { IpcApi } from "../../../src/shared/ipc-api";
import type { AgentRuntimeConversation } from "../../../src/shared/agent-runtime-api";
import { createBoundedOperationId } from "../../../src/shared/operation-identity";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { waitForDraftScene } from "./new-chat-draft";

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

/** Read native catalog facts for tests of the Codex account and protocol surface. */
export const readCodexModelCatalog = async (page: Page): Promise<CodexModelOption[]> => {
  const models: CodexModelOption[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const requestId = randomUUID();
    const timeoutMs = 15_000;
    const outcome = (await invokeIpc(page, "codex:app-server:request", {
      hostId: "local",
      request: {
        id: requestId,
        method: "model/list",
        params: { cursor, limit: 100 },
      },
      caller: {
        requestId,
        timeoutMs,
        expiresAtMs: Date.now() + timeoutMs,
        retainResponse: false,
      },
      scheduling: { priority: "background", source: "models" },
    })) as CodexNativeRequestOutcome<{
      readonly data: readonly unknown[];
      readonly nextCursor?: string | null;
    }>;

    if (outcome.type === "error") throw new Error(outcome.error.message);
    models.push(
      ...outcome.result.data
        .map(parseModelOption)
        .filter((model): model is CodexModelOption => model !== null),
    );
    cursor = outcome.result.nextCursor ?? null;
    if (cursor === null) return models;
    if (seen.has(cursor)) throw new Error(`Model catalog repeated cursor '${cursor}'`);
    seen.add(cursor);
  }

  throw new Error("Model catalog exceeded 100 pages without completing");
};

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
        (item) =>
          isRecord(item) &&
          item.projectId === project.id &&
          item.thread === null &&
          item.executionRef == null,
      );
      projectSessionId = isRecord(draft) && typeof draft.id === "string" ? draft.id : null;
      return projectSessionId ? "ready" : "missing";
    })
    .toBe("ready");
  if (!projectSessionId) throw new Error("Agent smoke draft returned no Project Session id");
  await waitForDraftScene(page, projectSessionId);
  return { projectId: project.id, projectSessionId };
};

export const setAgentExecutionProfile = async (
  page: Page,
  input: { readonly preferredModelId?: string } = {},
): Promise<CodexExecutionProfile> => {
  // The Composer owns a Runtime catalog, independent of the native account endpoint. Explicit
  // refresh is user demand; reading the native catalog cannot populate this cold cache.
  await refreshComposerModels(page);
  type RuntimeModel = IpcApi["agent-runtime:providers:read"]["result"][number]["models"][number];
  let model: RuntimeModel | undefined;
  await expect
    .poll(
      async () => {
        const providers = (await invokeIpc(
          page,
          "agent-runtime:providers:read",
          {},
        )) as IpcApi["agent-runtime:providers:read"]["result"];
        const provider = providers.find((candidate) => candidate.instanceId === "codex");
        if (!provider?.enabled || !provider.installed || provider.status === "error") return null;
        model =
          provider.models.find((candidate) => candidate.slug === input.preferredModelId) ??
          provider.models.find((candidate) => candidate.isDefault) ??
          provider.models[0];
        return model?.slug ?? null;
      },
      {
        timeout: 15_000,
        message: "The Composer Runtime catalog must advertise a selectable Codex model",
      },
    )
    .not.toBeNull();
  if (!model) throw new Error("Scripted Agent smoke found no visible Runtime Codex model");
  const effort = model.capabilities?.optionDescriptors?.find(
    (option) => option.type === "select" && /effort|reasoning/i.test(option.id),
  );
  const choices = effort?.type === "select" ? effort.options : [];
  const reasoningEffort =
    choices.find((candidate) => candidate.id === "low")?.id ??
    (effort?.type === "select" ? effort.currentValue : undefined) ??
    choices.find((candidate) => candidate.isDefault)?.id ??
    choices[0]?.id ??
    null;
  const profile: CodexExecutionProfile = {
    modelId: model.slug,
    reasoningEffort,
    serviceTier: null,
  };
  await chooseCodexExecutionProfile(page, model.name, profile);
  return profile;
};

export const selectCodexExecutionProfile = async (
  page: Page,
  model: CodexModelOption,
  profile: CodexExecutionProfile,
): Promise<void> => {
  await refreshComposerModels(page);
  await chooseCodexExecutionProfile(page, model.displayName, profile);
};

const chooseCodexExecutionProfile = async (
  page: Page,
  modelName: string,
  profile: CodexExecutionProfile,
): Promise<void> => {
  await chooseComposerModel(page, `${modelName} Codex`, modelName);
  if (profile.reasoningEffort)
    await chooseComposerEffort(page, formatCodexReasoningEffortLabel(profile.reasoningEffort));
  await page.keyboard.press("Escape");
};

export interface AgentRuntimeTarget {
  readonly sessionId: string;
  readonly threadId: string;
}

/**
 * The model and effort Agent execution runs the Session's Thread with. A selection that names
 * no effort runs at the model's default effort.
 */
export const waitForAgentThreadExecutionProfile = async (
  page: Page,
  target: AgentRuntimeTarget,
  expectedProfile: CodexExecutionProfile,
): Promise<void> => {
  await expect
    .poll(
      async () => {
        const conversation = (await invokeIpc(
          page,
          "agent-runtime:session:control",
          target,
        )) as AgentRuntimeConversation;
        const selection = conversation.snapshot.projection.thread.modelSelection;
        const providers = (await invokeIpc(
          page,
          "agent-runtime:providers:read",
          {},
        )) as IpcApi["agent-runtime:providers:read"]["result"];
        const defaultEffort = providers
          .find((provider) => provider.instanceId === selection.instanceId)
          ?.models.find((model) => model.slug === selection.model)
          ?.capabilities?.optionDescriptors?.find((option) => option.id === "reasoningEffort");
        return {
          modelId: selection.model,
          reasoningEffort:
            selection.options?.find((option) => option.id === "reasoningEffort")?.value ??
            (defaultEffort?.type === "select" ? (defaultEffort.currentValue ?? null) : null),
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({
      modelId: expectedProfile.modelId,
      reasoningEffort: expectedProfile.reasoningEffort,
    });
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
      ).some(
        (element) => element.textContent?.replace(/\s+/gu, " ").includes(expectedPrompt) === true,
      );
      const matchingRows = Array.from(
        document.querySelectorAll<HTMLElement>("[data-user-message-bubble='true']"),
      ).filter(
        (element) => element.textContent?.replace(/\s+/gu, " ").includes(expectedPrompt) === true,
      );
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
          if (!isRecord(session)) return "missing";
          const execution = isRecord(session.executionRef) ? session.executionRef : session.thread;
          threadId =
            isRecord(execution) && typeof execution.threadId === "string"
              ? execution.threadId
              : null;
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
  // The submitted bubble settles into the transcript's own row; sample once it has.
  await expect
    .poll(() => page.locator("[data-user-message-bubble='true']", { hasText: prompt }).count())
    .toBe(1);
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
    ).filter(
      (element) => element.textContent?.replace(/\s+/gu, " ").includes(expectedPrompt) === true,
    );
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

/**
 * Sends a follow-up in the open chat and waits until its message is in the transcript. Every
 * painted frame shows the words either in the Composer or as the sent message, never neither.
 */
export const sendAgentFollowUp = async (page: Page, prompt: string): Promise<void> => {
  const composer = page
    .locator('[data-codex-composer="true"][aria-label="Ask for follow-up changes"]')
    .first();
  await expect(async () => {
    await composer.fill(prompt);
    await expect(composer).toHaveText(prompt, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await page.evaluate((expected) => {
    const scope = window as typeof window & {
      __followUpBlankFrames?: number;
      __followUpFrame?: number;
    };
    const shows = (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).some(
        (element) => element.textContent?.replace(/\s+/gu, " ").includes(expected) === true,
      );
    scope.__followUpBlankFrames = 0;
    const sample = () => {
      if (!shows("[data-codex-composer='true']") && !shows("[data-user-message-bubble='true']"))
        scope.__followUpBlankFrames = (scope.__followUpBlankFrames ?? 0) + 1;
      scope.__followUpFrame = requestAnimationFrame(sample);
    };
    scope.__followUpFrame = requestAnimationFrame(sample);
  }, prompt);
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.locator("[data-user-message-bubble='true']", { hasText: prompt })).toHaveCount(
    1,
    { timeout: 10_000 },
  );
  const blankFrames = await page.evaluate(() => {
    const scope = window as typeof window & {
      __followUpBlankFrames?: number;
      __followUpFrame?: number;
    };
    if (scope.__followUpFrame !== undefined) cancelAnimationFrame(scope.__followUpFrame);
    return scope.__followUpBlankFrames ?? 0;
  });
  expect(blankFrames, "frames showing the follow-up nowhere").toBe(0);
};

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

/** The Session's conversation as Agent execution presents it, including its turn items. */
export const readRuntimeConversation = async (
  page: Page,
  target: AgentRuntimeTarget,
): Promise<AgentRuntimeConversation> =>
  (await invokeIpc(page, "agent-runtime:session:read", target)) as AgentRuntimeConversation;

/** Runtime-backed Sessions complete through their captured product binding, including restart. */
export const waitForRuntimeCompletedAgentTurn = async (
  page: Page,
  target: AgentRuntimeTarget,
  timeout = 20_000,
): Promise<AgentRuntimeConversation> => {
  const deadline = Date.now() + timeout;
  let latest: AgentRuntimeConversation | null = null;
  while (Date.now() < deadline) {
    latest = (await invokeIpc(
      page,
      "agent-runtime:session:control",
      target,
    )) as AgentRuntimeConversation;
    expect(latest.sessionId).toBe(target.sessionId);
    expect(latest.threadId).toBe(target.threadId);
    const projection = latest.snapshot.projection;
    const run = projection.runs.at(-1);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run?.providerThreadId,
    );
    if (run?.status === "completed" && providerThread?.status === "idle") return latest;
    if (run && ["failed", "cancelled", "interrupted", "rolled_back"].includes(run.status))
      throw new Error(`Runtime Run ended with ${run.status}: ${JSON.stringify(run)}`);
    await page.waitForTimeout(250);
  }
  throw new Error(`Runtime Run did not complete: ${JSON.stringify(latest).slice(0, 8_000)}`);
};

export interface NativeAgentThreadTail {
  readonly threadId: string;
  readonly status: ThreadReadResponse["thread"]["status"]["type"];
  readonly turns: ThreadTurnsListResponse["data"];
}

/**
 * Reads durable native history without requiring Main to own a resident conversation snapshot.
 * Use this after renderer/app restart, where the selected renderer can be the canonical owner.
 */
export const readNativeAgentThreadTail = async (
  page: Page,
  threadId: string,
): Promise<NativeAgentThreadTail> => {
  const request = async <Result>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result> => {
    const requestId = randomUUID();
    const timeoutMs = 5_000;
    const outcome = (await invokeIpc(page, "codex:app-server:request", {
      hostId: "local",
      caller: {
        requestId,
        timeoutMs,
        expiresAtMs: Date.now() + timeoutMs,
        retainResponse: false,
      },
      request: { id: requestId, method, params },
      scheduling: { priority: "background", source: "history" },
    })) as CodexNativeRequestOutcome<Result>;
    if (outcome.type === "error") throw new Error(outcome.error.message);
    return outcome.result;
  };

  const [metadata, history] = await Promise.all([
    request<ThreadReadResponse>("thread/read", { threadId, includeTurns: false }),
    request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
    }),
  ]);

  return {
    threadId: metadata.thread.id,
    status: metadata.thread.status.type,
    turns: history.data,
  };
};

export const waitForNativeCompletedAgentTurn = async (
  page: Page,
  threadId: string,
  timeout = 20_000,
): Promise<NativeAgentThreadTail> => {
  let latest: NativeAgentThreadTail | null = null;
  await expect
    .poll(
      async () => {
        latest = await readNativeAgentThreadTail(page, threadId);
        const turn = latest.turns[0];
        return {
          threadId: latest.threadId,
          threadStatus: latest.status,
          turnStatus: turn?.status ?? null,
        };
      },
      { timeout },
    )
    .toMatchObject({
      threadId,
      threadStatus: "idle",
      turnStatus: "completed",
    });

  if (!latest) throw new Error(`Native Agent history never resolved for Thread ${threadId}`);
  return latest;
};
