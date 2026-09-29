import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import type { AgentBackendSessionPresentation } from "../../src/shared/agent-conversation";
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

test("runs Claude with selected effort and restores its configuration and transcript after restart", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({ label: "claude-backend-lifecycle" });
  const binaryPath = path.join(harness.profile.runRoot, "claude");
  const fixtureUrl = pathToFileURL(
    path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
  ).href;
  writeFileSync(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(fixtureUrl)});\n`, {
    mode: 0o755,
  });
  try {
    let page = await harness.launch();
    await invoke(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "claude-default",
          displayName: "Claude Code",
          binaryPath,
          configDirectory: path.join(harness.profile.runRoot, "claude-config"),
          enabled: true,
          environment: [],
        },
      ],
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Agent", exact: true }).click();
    await page.getByRole("button", { name: "Add variable", exact: true }).click();
    await page.getByLabel("Variable name 1").evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "text/plain",
        'export ANTHROPIC_BASE_URL="https://router.example/"\nexport ANTHROPIC_AUTH_TOKEN="e2e-environment-token"\nANTHROPIC_API_KEY=""',
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.getByLabel("Variable value 1")).toHaveValue("https://router.example/");
    await expect(page.getByLabel("Variable value 2")).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByLabel("Variable value 2")).toHaveValue("");
    await expect(page.getByLabel("Variable value 2")).toHaveAttribute(
      "placeholder",
      "Saved secret — enter to replace",
    );
    await page.screenshot({ path: test.info().outputPath("claude-environment-settings.png") });
    const savedSettings = await invoke<import("../../src/shared/types").ClaudeAgentSettings>(
      page,
      "settings:claude-agents:get",
    );
    expect(savedSettings.instances[0]?.environment[1]).toEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      sensitive: true,
      value: null,
    });
    expect(readFileSync(harness.profile.settingsPath, "utf8")).not.toContain(
      "e2e-environment-token",
    );
    await page.getByRole("button", { name: "Back to app" }).click();
    const projects = await invoke<{ items: { id: string; primaryWorkspaceRoot: string | null }[] }>(
      page,
      "projects:list",
    );
    const project = projects.items.find(
      ({ primaryWorkspaceRoot }) => primaryWorkspaceRoot !== null,
    );
    if (!project) throw new Error("A local Project is required");
    const sessionId = createUuidV7();
    const created = await invoke<{ ok: boolean }>(page, "project-sessions:create", {
      operationId: createBoundedOperationId("e2e.claude.create"),
      payload: {
        sessionId,
        input: {
          projectId: project.id,
          noThreadFallbackTitle: "Native Claude lifecycle",
          initialPageIds: [],
        },
      },
    });
    expect(created.ok).toBe(true);
    await page.getByText("Native Claude lifecycle", { exact: true }).first().click();
    const composer = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .first();
    await composer.fill("Native Claude lifecycle");
    await page.getByRole("button", { name: "Select model", exact: true }).click();
    await page.getByRole("menuitem", { name: "Agent Codex", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(composer).toHaveText("Native Claude lifecycle");
    await page.getByRole("button", { name: "Select model", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Model Claude Opus 5 (default)", exact: true })
      .hover();
    const sonnet = page.getByRole("menuitem", {
      name: /Claude Sonnet 5\s*claude-sonnet-5/u,
      exact: true,
    });
    await expect(sonnet).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("claude-model-picker.png") });
    await sonnet.click();
    await page.getByRole("menuitem", { name: "Effort Default", exact: true }).hover();
    await expect(page.getByRole("menuitem", { name: "Max", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("claude-effort-picker.png") });
    await page.getByRole("menuitem", { name: "Max", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await invoke<ProjectSession | null>(page, "project-sessions:get", sessionId))?.thread
            ?.backendBinding,
      )
      .toEqual({ kind: "claude", instanceConfigId: "claude-default" });
    const linked = await invoke<ProjectSession>(page, "project-sessions:get", sessionId);
    if (!linked.thread) throw new Error("Native task was not attached");
    const threadId = linked.thread.threadId;
    await expect
      .poll(async () => {
        const current = await invoke<AgentBackendSessionPresentation | null>(
          page,
          "agent-backend:session:read",
          threadId,
        );
        if (current?.snapshot.error) throw new Error(current.snapshot.error);
        return current?.snapshot.requests?.length ?? 0;
      })
      .toBe(1);
    await expect(page.getByRole("radiogroup", { name: "Which target?" })).toBeVisible();
    await expect(page.getByText("That chat is not available", { exact: true })).toHaveCount(0);
    await page.getByRole("radio", { name: "Desktop", exact: true }).click();
    await page.getByRole("radio", { name: "Yes", exact: true }).click();
    await page.getByRole("button", { name: "Submit ⏎", exact: true }).click();
    await expect(page.getByText("Native Claude workflow complete", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("claude-conversation.png") });
    const completed = await invoke<AgentBackendSessionPresentation>(
      page,
      "agent-backend:session:read",
      threadId,
    );
    expect(completed.configOptions.find(({ category }) => category === "model")).toMatchObject({
      currentValue: "claude-sonnet-5",
    });
    expect(completed.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "max",
    });
    expect(completed.snapshot.turns.flatMap(({ updates }) => updates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool-call",
          title: "Inspect workspace",
          status: "completed",
        }),
      ]),
    );
    await page.getByText("Inspect workspace", { exact: true }).click();
    await expect(page.getByText("Workspace inspected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("claude-conversation.png") });
    const observations = () =>
      readFileSync(
        path.join(harness.profile.runRoot, "claude-config", "observations.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    expect(observations().find(({ type }) => type === "prompt")).toMatchObject({
      model: "claude-sonnet-5",
      effort: "max",
      content: "Native Claude lifecycle",
      environment: { baseUrl: "https://router.example/", tokenMatches: true, apiKeyEmpty: true },
    });
    await page.getByRole("button", { name: "Select model", exact: true }).click();
    await page.getByRole("menuitem", { name: "Effort Max", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Low", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await composer.fill("Wait for cancellation");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        observations()
          .filter(({ type }) => type === "prompt")
          .at(-1),
      )
      .toMatchObject({
        model: "claude-sonnet-5",
        effort: "low",
        content: "Wait for cancellation",
      });
    await composer.fill("Keep this draft");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeVisible();
    await expect(composer).toHaveText("Keep this draft");
    const cancelled = await invoke<AgentBackendSessionPresentation>(
      page,
      "agent-backend:session:read",
      threadId,
    );
    expect(cancelled.snapshot.turns.at(-1)?.stopReason).toBe("cancelled");
    page = await harness.restart();
    const reopened = await invoke<AgentBackendSessionPresentation>(
      page,
      "agent-backend:session:open",
      { threadId },
    );
    expect(reopened.snapshot.sessionId).toBe(completed.snapshot.sessionId);
    expect(reopened.snapshot.turns.flatMap(({ updates }) => updates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "message", text: "Native Claude workflow complete" }),
      ]),
    );
    expect(reopened.snapshot.status).toBe("idle");
    expect(reopened.configOptions.find(({ category }) => category === "model")).toMatchObject({
      currentValue: "claude-sonnet-5",
    });
    expect(reopened.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "low",
    });
    expect(reopened.snapshot.requests ?? []).toEqual([]);
    await expect(page.getByText("Native Claude workflow complete", { exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});
