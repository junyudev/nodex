import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chooseComposerModel } from "./support/composer-model-picker";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import type { AgentRuntimeConversation } from "../../src/shared/agent-runtime-api";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import type { ProjectSession } from "../../src/shared/types";

const repositoryRoot = process.cwd();
const instanceConfigId = "claude-e2e";
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

const prepareScriptedAcpPackage = (input: {
  readonly packageRoot: string;
  readonly observationPath: string;
}): void => {
  const entryDirectory = path.join(input.packageRoot, "dist");
  fs.mkdirSync(entryDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(input.packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@agentclientprotocol/claude-agent-acp",
      version: "0.73.0",
      type: "module",
    })}\n`,
  );
  const scriptedAgentUrl = pathToFileURL(
    path.join(repositoryRoot, "scripts/scenarios/runtime/scripted-acp-agent.ts"),
  ).href;
  const scenario = {
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
    beforePrompt: [liveMessage],
  };
  fs.writeFileSync(
    path.join(entryDirectory, "index.js"),
    [
      'if (process.argv.includes("--version")) { console.log("0.73.0"); process.exit(0); }',
      `process.env.NODEX_SCRIPTED_ACP_SCENARIO = ${JSON.stringify(JSON.stringify(scenario))};`,
      `process.env.NODEX_SCRIPTED_ACP_OBSERVATION = ${JSON.stringify(input.observationPath)};`,
      `await import(${JSON.stringify(scriptedAgentUrl)});`,
    ].join("\n"),
  );
};

const invoke = async <Result>(page: Page, channel: string, ...args: unknown[]): Promise<Result> =>
  (await page.evaluate(
    async ({ targetChannel, targetArgs }) => {
      if (!window.api) throw new Error("Nodex preload API is unavailable");
      const api = window.api as unknown as {
        invoke(target: string, ...input: unknown[]): Promise<unknown>;
      };
      return await api.invoke(targetChannel, ...targetArgs);
    },
    { targetChannel: channel, targetArgs: args },
  )) as Result;

test("runs a chat on an ACP agent and continues its protocol session after restart", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({ label: "acp-backend-lifecycle" });
  const packageRoot = path.join(harness.profile.runRoot, "scripted-acp-package");
  const observationPath = path.join(harness.profile.runRoot, "scripted-acp-observations.json");
  prepareScriptedAcpPackage({ packageRoot, observationPath });

  try {
    let page = await harness.launch();
    await invoke(page, "settings:acp-agents:update", {
      instances: [
        {
          id: instanceConfigId,
          agentDefinitionId: "claude-agent-acp",
          packageRoot,
          nodeExecutable: process.execPath,
          enabled: true,
          credentials: { kind: "isolated-home", home: harness.profile.runRoot },
          proxy: "isolated",
        },
      ],
    });

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
    await chooseComposerModel(page, "Claude Agent");
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
        agentDefinitionId: "claude-agent-acp",
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
  } finally {
    await harness.close();
  }
});
