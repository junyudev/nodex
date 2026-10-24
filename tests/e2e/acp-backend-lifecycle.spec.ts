import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { chooseComposerModel } from "./support/composer-model-picker";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import type { AgentRuntimeConversation } from "../../src/shared/agent-runtime-api";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import type { ProjectSession } from "../../src/shared/types";

const repositoryRoot = process.cwd();
const instanceConfigId = "acp-personal-e2e";
const secondInstanceId = "acp-work-e2e";
const agentDefinitionId = "scripted-agent";
const protocolSessionId = "acp-electron-e2e-session";
const liveMessage = "ACP_ELECTRON_LIVE_MESSAGE";
const restoredMessage = "ACP_ELECTRON_RESTORED_MESSAGE";

type AcpObservation =
  | { readonly method: "initialize" }
  | { readonly method: "session/new"; readonly cwd: string }
  | { readonly method: "session/load"; readonly sessionId: string }
  | { readonly method: "session/prompt"; readonly sessionId: string };

const readObservations = (observationPath: string): readonly AcpObservation[] => {
  try {
    return JSON.parse(fs.readFileSync(observationPath, "utf8")) as AcpObservation[];
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
};

const scriptedEnvironment = (observationPath: string, message = liveMessage) => [
  {
    name: "NODEX_SCRIPTED_ACP_SCENARIO",
    sensitive: false as const,
    value: JSON.stringify({
      sessionId: protocolSessionId,
      sessionLifecycle: {
        load: true,
        list: false,
        delete: false,
        fork: false,
        resume: false,
        close: false,
        loadReplay: [restoredMessage],
      },
      beforePrompt: [message],
    }),
  },
  { name: "NODEX_SCRIPTED_ACP_OBSERVATION", sensitive: false as const, value: observationPath },
];

const invoke = async <Result>(page: Page, channel: string, ...args: unknown[]): Promise<Result> =>
  (await page.evaluate(
    async ({ targetChannel, targetArgs }) => {
      if (!window.api) throw new Error("Nodex preload API is unavailable");
      const api = window.api as unknown as {
        invoke(target: string, ...input: unknown[]): Promise<unknown>;
      };
      const result = await api.invoke(targetChannel, ...targetArgs);
      if (!targetChannel.startsWith("acp:")) return result;
      const envelope = result as { ok: boolean; value?: unknown; error?: { message: string } };
      if (!envelope.ok) throw new Error(envelope.error?.message ?? "ACP request failed");
      return envelope.value;
    },
    { targetChannel: channel, targetArgs: args },
  )) as Result;

test("runs a chat on an ACP agent and continues its protocol session after restart", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({ label: "acp-backend-lifecycle" });
  const observationPath = path.join(harness.profile.runRoot, "scripted-acp-observations.json");
  const secondObservationPath = path.join(
    harness.profile.runRoot,
    "scripted-acp-work-observations.json",
  );
  const source = {
    kind: "local",
    executable: process.execPath,
    args: [path.join(repositoryRoot, "scripts/scenarios/runtime/scripted-acp-agent.ts")],
  };

  try {
    let page = await harness.launch();
    await invoke(page, "settings:acp-agents:update", {
      instances: [
        {
          id: instanceConfigId,
          agentDefinitionId,
          displayName: "ACP personal",
          source,
          environment: scriptedEnvironment(observationPath),
          customModels: ["scripted-model"],
          enabled: true,
          credentials: { kind: "isolated-home", home: harness.profile.runRoot },
          proxy: "isolated",
        },
        {
          id: secondInstanceId,
          agentDefinitionId,
          displayName: "ACP work",
          source,
          environment: scriptedEnvironment(secondObservationPath, "ACP_WORK_MESSAGE"),
          customModels: ["scripted-model"],
          enabled: true,
          credentials: {
            kind: "isolated-home",
            home: path.join(harness.profile.runRoot, "second-profile"),
          },
          proxy: "isolated",
        },
      ],
    });

    for (const instanceId of [instanceConfigId, secondInstanceId]) {
      const operationId = createUuidV7();
      await invoke(page, "acp:connection:start", { instanceId, operationId });
      await expect
        .poll(
          async () =>
            (await invoke<{ phase: string }>(page, "acp:operation:read", { operationId })).phase,
        )
        .toBe("succeeded");
    }

    const projects = await invoke<{
      readonly items: readonly {
        readonly id: string;
        readonly primaryWorkspaceRoot: string | null;
      }[];
    }>(page, "projects:list");
    const project = projects.items.find(
      ({ primaryWorkspaceRoot }) => primaryWorkspaceRoot !== null,
    );
    if (!project) throw new Error("ACP Electron scenario requires one local Project");
    const sessionId = createUuidV7();
    const created = await invoke<{
      readonly ok: boolean;
      readonly value?: { readonly id: string };
      readonly error?: { readonly message: string };
    }>(page, "project-sessions:create", {
      operationId: createBoundedOperationId("e2e.acp.session.create"),
      payload: {
        sessionId,
        input: {
          projectId: project.id,
          noThreadFallbackTitle: "ACP lifecycle E2E",
          initialPageIds: [],
        },
      },
    });
    if (!created.ok || created.value?.id !== sessionId) {
      throw new Error(created.error?.message ?? "Could not create ACP scenario Session");
    }

    await page.getByText("ACP lifecycle E2E", { exact: true }).first().click();
    const composer = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .first();
    await composer.fill("Start the ACP lifecycle scenario");
    await chooseComposerModel(page, "ACP personal scripted-model");
    await expect(composer).toHaveText("Start the ACP lifecycle scenario");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await invoke<ProjectSession>(page, "project-sessions:get", sessionId)).executionRef,
      )
      .toBeTruthy();
    const { executionRef } = await invoke<ProjectSession>(page, "project-sessions:get", sessionId);
    const target = { sessionId, threadId: executionRef!.threadId };
    // The chat runs on the configured ACP agent and keeps its protocol session.
    const protocolSession = async () => {
      const control = await invoke<AgentRuntimeConversation>(
        page,
        "agent-runtime:session:control",
        target,
      );
      const thread = control.snapshot.projection.providerThreads.find(
        (candidate) => candidate.id === control.snapshot.projection.thread.activeProviderThreadId,
      );
      return {
        provider: control.snapshot.projection.thread.providerInstanceId,
        nativeId: thread?.nativeThreadRef?.nativeId ?? null,
      };
    };
    await expect.poll(protocolSession).toEqual({
      provider: agentRuntimeProviderId({
        kind: "acp",
        agentDefinitionId,
        instanceConfigId,
      }),
      nativeId: protocolSessionId,
    });
    await expect(page.getByText(liveMessage, { exact: true }).first()).toBeVisible();
    await expect
      .poll(() => readObservations(observationPath))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "session/new" }),
          expect.objectContaining({ method: "session/prompt", sessionId: protocolSessionId }),
        ]),
      );
    await composer.fill("Continue in the same protocol session");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect
      .poll(
        () =>
          readObservations(observationPath).filter(({ method }) => method === "session/prompt")
            .length,
      )
      .toBe(2);
    await expect(page.getByText(liveMessage, { exact: true })).toHaveCount(2);

    // The window reopens on the chat.
    page = await harness.restart();
    // History comes back from Nodex; the agent is not asked to replay it.
    await expect(page.getByText(liveMessage, { exact: true })).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByText(restoredMessage, { exact: true })).toHaveCount(0);
    const followUp = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .first();
    await followUp.fill("Continue after restart");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    // The restarted agent process loads the same protocol session before the prompt.
    await expect
      .poll(() => readObservations(observationPath).map(({ method }) => method))
      .toEqual(["initialize", "session/load", "session/prompt"]);
    expect(
      readObservations(observationPath).filter(({ method }) => method !== "initialize"),
    ).toEqual([
      { method: "session/load", sessionId: protocolSessionId },
      { method: "session/prompt", sessionId: protocolSessionId },
    ]);
    await expect(page.getByText(liveMessage, { exact: true })).toHaveCount(3);
    await expect(page.getByText(restoredMessage, { exact: true })).toHaveCount(0);
    expect(await protocolSession()).toMatchObject({ nativeId: protocolSessionId });

    // The same native ID and model in another instance remain a distinct account and history.
    const secondSessionId = createUuidV7();
    await invoke(page, "project-sessions:create", {
      operationId: createBoundedOperationId("e2e.acp.second.create"),
      payload: {
        sessionId: secondSessionId,
        input: {
          projectId: project.id,
          noThreadFallbackTitle: "ACP work account",
          initialPageIds: [],
        },
      },
    });
    const secondProviderId = agentRuntimeProviderId({
      kind: "acp",
      agentDefinitionId,
      instanceConfigId: secondInstanceId,
    })!;
    await invoke(page, "agent-runtime:session:launch", {
      launchId: createUuidV7(),
      acceptedAt: Date.now(),
      sessionId: secondSessionId,
      projectId: project.id,
      title: "ACP work account",
      modelSelection: { instanceId: secondProviderId, model: "scripted-model" },
      interactionMode: "default",
      message: { messageId: createUuidV7(), text: "Use the work account" },
    });
    await expect
      .poll(
        () =>
          readObservations(secondObservationPath).filter(
            ({ method }) => method === "session/prompt",
          ).length,
      )
      .toBe(1);
    const second = await invoke<AgentRuntimeConversation>(page, "agent-runtime:session:control", {
      sessionId: secondSessionId,
    });
    expect(second.snapshot.projection.thread.providerInstanceId).toBe(secondProviderId);
    expect(second.threadId).not.toBe(target.threadId);
    expect(await protocolSession()).toEqual({
      provider: agentRuntimeProviderId({ kind: "acp", agentDefinitionId, instanceConfigId }),
      nativeId: protocolSessionId,
    });
    expect(
      readObservations(observationPath).filter(({ method }) => method === "session/prompt"),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
