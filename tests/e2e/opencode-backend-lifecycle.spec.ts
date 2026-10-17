import { expect, test, type Page } from "@playwright/test";
import { openComposerModelPicker as openModelPicker } from "./support/composer-model-picker";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import { AGENT_CLI_SCENARIO_ID } from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import type { AgentRuntimeConversation } from "../../src/shared/agent-runtime-api";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import { waitForRuntimeCompletedAgentTurn } from "./support/agent-smoke-harness";
import type { ProjectSession } from "../../src/shared/types";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";

const invoke = async <Result>(page: Page, channel: string, ...args: unknown[]): Promise<Result> =>
  await page.evaluate(
    async ({ channel, args }) => {
      const api = window.api as unknown as {
        invoke(channel: string, ...args: unknown[]): Promise<Result>;
      };
      return await api.invoke(channel, ...args);
    },
    { channel, args },
  );

interface OpenCodeObservation {
  readonly kind: string;
  readonly model?: { providerID: string; modelID: string };
  readonly variant?: string;
  readonly agent?: string;
  readonly cwd?: string;
}

test("chooses an OpenCode model with native options before its first prompt and reopens the chat without replay", async () => {
  test.setTimeout(240_000);
  const harness = await ElectronScenarioHarness.create({
    label: "opencode-backend-lifecycle",
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: path.resolve("."),
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  const sourceRoot = realpathSync(harness.profile.initialProjectsDirectory);
  const profileDirectory = path.join(harness.profile.runRoot, "opencode-profile");
  const nativeRoot = path.join(profileDirectory, "data", "opencode");
  const observationPath = path.join(nativeRoot, "observations.jsonl");
  const binaryPath = path.join(harness.profile.runRoot, "opencode");
  const fixtureUrl = pathToFileURL(
    path.resolve("scripts/scenarios/runtime/scripted-opencode-agent.mjs"),
  ).href;
  writeFileSync(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(fixtureUrl)});\n`, {
    mode: 0o755,
  });
  const observations = (): readonly OpenCodeObservation[] =>
    existsSync(observationPath)
      ? readFileSync(observationPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const rendererErrors: string[] = [];
  let threadId: string | undefined;
  let harnessSessionId = "";
  try {
    writeFileSync(path.join(sourceRoot, "README.md"), "Isolated OpenCode workspace\n");
    let page = await harness.launch();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const manifest = await materializeScenario(
      AGENT_CLI_SCENARIO_ID,
      new RendererIpcSeedAdapter(page),
      sourceRoot,
    );
    await invoke(page, "settings:opencode-agents:update", {
      instances: [
        {
          id: "opencode-default",
          displayName: "OpenCode",
          enabled: true,
          binaryPath,
          profileDirectory,
          serverUrl: null,
          environment: [],
        },
      ],
    });
    const sessionId = createUuidV7();
    harnessSessionId = sessionId;
    const created = await invoke<{ ok: boolean }>(page, "project-sessions:create", {
      operationId: createBoundedOperationId("e2e.opencode.create"),
      payload: {
        sessionId,
        input: {
          projectId: manifest.projectId,
          noThreadFallbackTitle: "OpenCode lifecycle",
          initialPageIds: [],
        },
      },
    });
    expect(created.ok).toBe(true);
    const projectRow = page.locator(`[data-app-action-sidebar-project-id="${manifest.projectId}"]`);
    await projectRow.hover();
    const expand = projectRow.getByRole("button", { name: "Expand project", exact: true });
    if (await expand.count()) await expand.click();
    await page.getByText("OpenCode lifecycle", { exact: true }).first().click();
    const search = await openModelPicker(page);
    await search.fill("Kimi");
    const kimi = page.getByRole("option", { name: /Kimi K3.*OpenCode/u });
    await expect(kimi).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage providers", exact: true })).toBeVisible();
    expect(
      observations().filter(({ kind }) => kind === "createSession" || kind === "prompt"),
    ).toEqual([]);
    await kimi.click();
    await expect(search).toBeHidden();
    // OpenCode's variant is offered as Reasoning and its agent mode as Agent.
    await openModelPicker(page);
    await page.getByRole("button", { name: /^Reasoning /u }).click();
    await page.getByRole("menuitem", { name: /^high$/iu }).click();
    await expect(page.getByRole("menuitem", { name: /^high$/iu })).not.toBeVisible();
    await openModelPicker(page);
    await page.getByRole("button", { name: /^Agent /u }).click();
    await page.getByRole("menuitem", { name: /^plan$/iu }).click();
    await expect(page.getByRole("menuitem", { name: /^plan$/iu })).not.toBeVisible();
    await openModelPicker(page);
    await expect(page.getByRole("button", { name: /^Reasoning high$/iu })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Agent plan$/iu })).toBeVisible();
    const evidenceRoot = path.resolve("notes.local/artifacts/opencode-model-picker");
    mkdirSync(evidenceRoot, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceRoot, "model-options.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    const composer = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .first();
    await composer.fill("OPEN_CODE_OK");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await invoke<ProjectSession | null>(page, "project-sessions:get", sessionId))
            ?.executionRef,
      )
      .toBeTruthy();
    const linked = await invoke<ProjectSession>(page, "project-sessions:get", sessionId);
    threadId = linked.executionRef!.threadId;
    const target = { sessionId, threadId };
    const completed = await waitForRuntimeCompletedAgentTurn(page, target, 30_000);
    const thread = completed.snapshot.projection.thread;
    expect(thread.providerInstanceId).toBe(
      agentRuntimeProviderId({ kind: "opencode", instanceConfigId: "opencode-default" }),
    );
    expect(thread.modelSelection).toMatchObject({ model: "moonshot/kimi-k3" });
    expect(thread.modelSelection.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "high" })]),
    );
    await expect(page.getByText("OPEN_CODE_OK", { exact: true }).last()).toBeVisible();
    expect(observations().find(({ kind }) => kind === "prompt")).toMatchObject({
      model: { providerID: "moonshot", modelID: "kimi-k3" },
      variant: "high",
      agent: "plan",
      cwd: sourceRoot,
    });
    const promptCount = observations().filter(({ kind }) => kind === "prompt").length;
    const sessionCount = observations().filter(({ kind }) => kind === "createSession").length;
    expect(sessionCount).toBe(1);

    // Nodex keeps the history; reopening never prompts or creates a native session again.
    page = await harness.restart();
    await expect(page.getByText("OPEN_CODE_OK", { exact: true }).last()).toBeVisible({
      timeout: 30_000,
    });
    const restored = await invoke<AgentRuntimeConversation>(
      page,
      "agent-runtime:session:control",
      target,
    );
    expect(restored.snapshot.projection.thread.modelSelection).toEqual(thread.modelSelection);
    expect(restored.snapshot.projection.runs.at(-1)?.status).toBe("completed");
    await page.screenshot({
      path: path.join(evidenceRoot, "restored-conversation.png"),
      animations: "disabled",
    });
    expect(observations().filter(({ kind }) => kind === "prompt")).toHaveLength(promptCount);
    expect(observations().filter(({ kind }) => kind === "createSession")).toHaveLength(
      sessionCount,
    );
    expect(rendererErrors).toEqual([]);
    writeFileSync(
      path.join(evidenceRoot, "verified.json"),
      JSON.stringify(
        {
          scenarioId: AGENT_CLI_SCENARIO_ID,
          profileHome: harness.profile.nodexHome,
          projectId: manifest.projectId,
          sessionId,
          threadId,
          model: "moonshot/kimi-k3",
          variant: "high",
          mode: "plan",
          beforePromptCreatedSessions: 0,
          totalCreatedSessions: sessionCount,
          promptsAfterRestart: promptCount,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await test.info().attach("opencode-peer", {
      body: existsSync(observationPath)
        ? readFileSync(observationPath, "utf8")
        : "No native observations",
      contentType: "text/plain",
    });
    await test.info().attach("opencode-runtime", {
      body: await readBoundedElectronRuntimeLogs(harness.profile, 524_288),
      contentType: "text/plain",
    });
    if (threadId) {
      const presentation = await invoke(harness.page, "agent-runtime:session:read", {
        sessionId: harnessSessionId,
        threadId,
      }).catch((cause) => ({ error: cause instanceof Error ? cause.message : String(cause) }));
      await test.info().attach("opencode-session", {
        body: JSON.stringify(presentation, null, 2),
        contentType: "application/json",
      });
    }
    await test.info().attach("opencode-renderer", {
      body: `${rendererErrors.join("\n")}\n${await harness.page.locator("body").innerText()}`,
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
});
