import { expect, test, type Page } from "@playwright/test";
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
import type { AgentRuntimeSettings } from "../../src/shared/agent-runtime-settings";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../src/shared/model-policy";
import type { ProjectSession } from "../../src/shared/types";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { openComposerModelPicker } from "./support/composer-model-picker";
import { openWorkbenchSettings } from "./support/workbench-settings";

const titleAgentId = agentRuntimeProviderId({ kind: "opencode", instanceConfigId: "title-agent" })!;
const chatAgentId = agentRuntimeProviderId({ kind: "opencode", instanceConfigId: "chat-agent" })!;

const invoke = async <Result>(page: Page, channel: string, ...args: unknown[]): Promise<Result> =>
  await page.evaluate(
    async ({ channel, args }) =>
      await (
        window.api as unknown as {
          invoke(channel: string, ...args: unknown[]): Promise<Result>;
        }
      ).invoke(channel, ...args),
    { channel, args },
  );

interface Observation {
  readonly kind: string;
  readonly text?: string;
}

test("a chosen title model titles a chat that runs on another Agent", async () => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({
    label: "chat-title-model",
    environment: { NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: path.resolve(".") },
  });
  const sourceRoot = realpathSync(harness.profile.initialProjectsDirectory);
  const binaryPath = path.join(harness.profile.runRoot, "opencode");
  const fixtureUrl = pathToFileURL(
    path.resolve("scripts/scenarios/runtime/scripted-opencode-agent.mjs"),
  ).href;
  writeFileSync(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(fixtureUrl)});\n`, {
    mode: 0o755,
  });
  const profileOf = (id: string) => path.join(harness.profile.runRoot, id);
  const observed = (id: string): readonly Observation[] => {
    const file = path.join(profileOf(id), "data", "opencode", "observations.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Observation)
      : [];
  };
  try {
    writeFileSync(path.join(sourceRoot, "README.md"), "Isolated workspace\n");
    const page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 860 });
    const manifest = await materializeScenario(
      AGENT_CLI_SCENARIO_ID,
      new RendererIpcSeedAdapter(page),
      sourceRoot,
    );
    const agent = (id: string, displayName: string) => {
      mkdirSync(profileOf(id), { recursive: true });
      return {
        id,
        displayName,
        enabled: true,
        binaryPath,
        profileDirectory: profileOf(id),
        serverUrl: null,
        environment: [],
      };
    };
    await invoke(page, "settings:opencode-agents:update", {
      instances: [agent("chat-agent", "OpenCode"), agent("title-agent", "Titles")],
    });

    // An Agent's models arrive with its first check, as when one is added in Settings.
    await expect
      .poll(
        async () =>
          (
            await invoke<readonly { instanceId: string; models: readonly unknown[] }[]>(
              page,
              "agent-runtime:providers:read",
              { refresh: true },
            )
          ).find((provider) => provider.instanceId === titleAgentId)?.models.length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    // OpenCode models that are not free start off, and off models are not offered.
    await invoke(
      page,
      "settings:model-policy:update",
      [titleAgentId, chatAgentId].reduce(
        (policy, instanceId) =>
          setModelOn(policy, { instanceId, driver: "opencode" }, "moonshot/kimi-k3", true),
        DEFAULT_MODEL_POLICY,
      ),
    );

    await test.step("Settings names what titles chats, and starts on each chat's Agent", async () => {
      await openWorkbenchSettings(page);
      await page.getByRole("link", { name: "General", exact: true }).click();
      const trigger = page.getByRole("button", { name: "Title chats with", exact: true });
      await expect(trigger).toHaveText("Light model, same Agent");
      await trigger.click();
      const titles = page.getByRole("option", { name: /Kimi K3.*Titles/u });
      await expect(titles).toBeVisible();
      // A title always runs at its lightest effort, so the menu offers no effort of its own.
      await expect(page.getByRole("slider", { name: "Effort" })).toHaveCount(0);
      await titles.click();
      await expect(trigger).toHaveText("Titles · Kimi K3");
      expect(await invoke<AgentRuntimeSettings>(page, "settings:agent-runtime:get")).toMatchObject({
        titleModel: {
          instanceId: titleAgentId,
          model: "moonshot/kimi-k3",
        },
      });
      await page.getByRole("button", { name: "Back to app", exact: true }).click();
    });

    const sessionId = createUuidV7();
    const created = await invoke<{ ok: boolean }>(page, "project-sessions:create", {
      operationId: createBoundedOperationId("e2e.title-model.create"),
      payload: {
        sessionId,
        input: {
          projectId: manifest.projectId,
          noThreadFallbackTitle: "New chat",
          initialPageIds: [],
        },
      },
    });
    expect(created.ok).toBe(true);
    const project = page.locator(`[data-app-action-sidebar-project-id="${manifest.projectId}"]`);
    await project.hover();
    const expand = project.getByRole("button", { name: "Expand project", exact: true });
    if (await expand.count()) await expand.click();
    await page.locator(`[data-app-action-sidebar-thread-id="${sessionId}"]`).click();
    const search = await openComposerModelPicker(page);
    await search.fill("Kimi");
    await page
      .getByRole("option", { name: /Kimi K3/u })
      .first()
      .click();
    await expect(search).toBeHidden();
    const composer = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .first();
    await composer.fill("PROMPT_FOR_TITLE");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();

    await expect
      .poll(
        async () =>
          (await invoke<ProjectSession>(page, "project-sessions:get", sessionId)).displayTitle,
        { timeout: 30_000 },
      )
      .toBe("Scripted OpenCode title");
    const utility = observed("title-agent").filter(({ kind }) => kind === "utilityPrompt");
    expect(utility).toHaveLength(1);
    expect(utility[0]!.text).toContain("PROMPT_FOR_TITLE");
    expect(utility[0]!.text).toContain("JSON Schema");
    // Its session ended with the request, and the chat's own Agent never saw a title request.
    expect(observed("title-agent").map(({ kind }) => kind)).toContain("deleteSession");
    expect(observed("chat-agent").filter(({ kind }) => kind === "utilityPrompt")).toEqual([]);
    await expect
      .poll(() => observed("chat-agent").filter(({ kind }) => kind === "prompt").length)
      .toBe(1);
  } catch (error) {
    await test.info().attach("runtime-log", {
      body: await readBoundedElectronRuntimeLogs(harness.profile, 524_288),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
});
