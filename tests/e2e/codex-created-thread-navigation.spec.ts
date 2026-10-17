import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import type { IpcApi } from "../../src/shared/ipc-api";
import { openNewChatDraft } from "./support/new-chat-draft";

const invoke = <Channel extends keyof IpcApi>(
  page: Page,
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<IpcApi[Channel]["result"]> =>
  page.evaluate(
    async ({ channel, args }) => {
      const bridge = window.api as unknown as {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      };
      return await bridge.invoke(channel, ...args);
    },
    { channel, args: args as unknown as unknown[] },
  ) as Promise<IpcApi[Channel]["result"]>;

interface NativeRecord {
  readonly event: string;
  readonly sessionId?: string;
  readonly threadId?: string;
}

test("opens the chat an Agent created from its row, once, in the chat it started", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-created-chat-"));
  const codex = path.join(fixture, "codex");
  const body = fs
    .readFileSync(path.resolve("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs"), "utf8")
    .replace(/^#![^\n]*\n/u, "");
  fs.writeFileSync(codex, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
  const harness = await ElectronScenarioHarness.create({
    label: "agent-created-chat-navigation",
    prepareAgentRuntime: false,
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
  const records = (): NativeRecord[] =>
    fs
      .readFileSync(path.join(fixture, "native.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NativeRecord);
  try {
    const page = await harness.launch();
    await page.setViewportSize({ width: 1440, height: 960 });
    const project = (await invoke(page, "projects:list")).items[0];
    if (!project) throw new Error("Fixture Project missing");
    fs.writeFileSync(
      path.join(fixture, "plan.json"),
      JSON.stringify({
        "Start a plan review": {
          createSession: {
            prompt: "Review the plan",
            title: "Plan review",
            target: { type: "project", projectId: project.id, environment: { type: "local" } },
          },
        },
      }),
    );

    const sourceScene = await openNewChatDraft(page);
    const composer = sourceScene.locator('[data-codex-composer="true"]:visible');
    await composer.fill("Start a plan review");
    await composer.press("Enter");
    await expect(sourceScene.getByText("Codex started Plan review", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const created = records().find((record) => record.event === "session.created");
    if (!created?.sessionId || !created.threadId) throw new Error("The Agent created no chat");

    const sourceRow = page.locator(
      '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"]',
    );
    const sourceThreadId = await sourceRow.getAttribute("data-app-action-sidebar-thread-id");
    if (!sourceThreadId) throw new Error("The source chat has no sidebar row");
    const createdRow = sourceScene.getByRole("button", {
      name: "Created chat: Plan review",
      exact: true,
    });
    const createdScene = page.locator(
      `[data-workbench-scene-owner="session:${created.sessionId}"]`,
    );
    const createdRows = page.locator(
      '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-title="Plan review"]',
    );

    // The row opens the chat the Agent started, already answering its own prompt.
    await createdRow.click();
    await expect(createdScene).toBeVisible({ timeout: 30_000 });
    await expect(createdScene.getByText("Review the plan", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(createdScene.getByText("Codex child report", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(
      (await invoke(page, "agent-runtime:session:inspect", { sessionId: created.sessionId }))
        .threadId,
    ).toBe(created.threadId);

    // Opening it again returns to the same chat instead of adding another.
    await page.locator(`[data-app-action-sidebar-thread-id="${sourceThreadId}"]`).click();
    await expect(sourceScene).toBeVisible();
    await createdRow.click();
    await expect(createdScene).toBeVisible();
    await expect(createdRows).toHaveCount(1);
    expect(records().filter((record) => record.event === "session.created")).toHaveLength(1);
    expect(
      records().filter((record) => record.event === "prompt" && record.threadId !== undefined)
        .length,
    ).toBe(2);
    await testInfo.attach("created-chat-navigation", {
      body: JSON.stringify({ sourceThreadId, created }, null, 2),
      contentType: "application/json",
    });
  } finally {
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
