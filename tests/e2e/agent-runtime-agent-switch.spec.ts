import { expect, test, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import type { IpcApi } from "../../src/shared/ipc-api";
import { chooseComposerModel } from "./support/composer-model-picker";
import { waitForDraftScene } from "./support/new-chat-draft";

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
  readonly kind: "codex" | "claude";
  readonly event: string;
  readonly prompt?: string;
  readonly items?: unknown;
}

const CLAUDE_ID = agentRuntimeProviderId({ kind: "claude", instanceConfigId: "claude-fixture" });

/**
 * One Electron Profile whose Codex and Claude are native protocol peers recording what they
 * receive, with a started chat in the fixture Project.
 */
async function withAgentPeers(
  testInfo: TestInfo,
  label: string,
  run: (fixture: {
    readonly page: Page;
    readonly sessionId: string;
    /** Sends from the visible Composer and waits until the chat has the reply and is idle. */
    readonly send: (prompt: string, reply: string, count: number) => Promise<void>;
    readonly records: () => readonly NativeRecord[];
    readonly models: { readonly claude: string; readonly codex: string };
  }) => Promise<void>,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `nodex-${label}-`));
  const codex = path.join(home, "codex");
  const claude = path.join(home, "claude");
  const peer = fs
    .readFileSync(path.resolve("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs"), "utf8")
    .replace(/^#![^\n]*\n/u, "");
  for (const executable of [codex, claude])
    fs.writeFileSync(executable, `#!${process.execPath}\n${peer}`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, "plan.json"), "{}");
  const records = () =>
    fs.existsSync(path.join(home, "native.jsonl"))
      ? fs
          .readFileSync(path.join(home, "native.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as NativeRecord)
      : [];
  const harness = await ElectronScenarioHarness.create({
    label,
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_CROSS_PROVIDER_HOME: home,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
  try {
    const page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    await invoke(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "claude-fixture",
          displayName: "Runtime Claude",
          binaryPath: claude,
          configDirectory: path.join(home, "claude-home"),
          enabled: true,
          customModels: [],
          environment: [{ name: "NODEX_TEST_CROSS_PROVIDER_HOME", value: home, sensitive: false }],
        },
      ],
    });
    const providers = await invoke(page, "agent-runtime:providers:read", { refresh: true });
    const claudeModel = providers.find((provider) => provider.instanceId === CLAUDE_ID)?.models[0];
    const codexModel = providers.find((provider) => provider.instanceId === "codex")?.models[0];
    if (!claudeModel || !codexModel) throw new Error("Both native provider catalogs must load");
    const project = (await invoke(page, "projects:list")).items[0];
    if (!project) throw new Error("Fixture Project missing");
    await page
      .getByRole("button", { name: `Start new chat in ${project.name}`, exact: true })
      .click();
    const receipt = await invoke(page, "project-sessions:ensure-default-draft", {
      operationId: createBoundedOperationId("session.ensure-default-draft"),
      payload: { candidateSessionId: randomUUID(), projectId: project.id },
    });
    if (!("value" in receipt)) throw new Error("Default draft admission failed");
    await waitForDraftScene(page, receipt.value.id);
    const composer = page.locator('[data-codex-composer="true"]:visible');
    const send = async (prompt: string, reply: string, count: number) => {
      await composer.fill(prompt);
      await composer.press("Enter");
      await expect(page.getByText(reply, { exact: true }).filter({ visible: true })).toHaveCount(
        count,
        { timeout: 30_000 },
      );
      await expect
        .poll(async () =>
          (await invoke(page, "agent-runtime:activity:read")).items.some(
            (activity) => activity.activeRunId !== null,
          ),
        )
        .toBe(false);
    };
    await run({
      page,
      sessionId: receipt.value.id,
      send,
      records,
      models: {
        claude: `${claudeModel.name} Runtime Claude`,
        codex: `${codexModel.name} Codex`,
      },
    });
  } finally {
    await testInfo.attach(`${label}-main.log`, {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 250_000)),
      contentType: "text/plain",
    });
    await testInfo.attach(`${label}-native.jsonl`, {
      body: fs.existsSync(path.join(home, "native.jsonl"))
        ? fs.readFileSync(path.join(home, "native.jsonl"))
        : Buffer.from(""),
      contentType: "text/plain",
    });
    await harness.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const runSlashCommand = async (page: Page, id: string) => {
  await page.locator('[data-codex-composer="true"]:visible').fill(`/${id}`);
  await page.locator(`[data-slash-command-row="${id}"]`).click();
};

/** The Session whose chat Scene is on screen. */
const visibleSession = async (page: Page) =>
  (
    await page
      .locator('[data-workbench-scene-owner^="session:"]:visible')
      .first()
      .getAttribute("data-workbench-scene-owner")
  )?.slice("session:".length) ?? null;

test("continues a finished Codex chat on Claude with its history, then returns to Codex with only what it missed", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withAgentPeers(
    testInfo,
    "agent-switch",
    async ({ page, sessionId, send, records, models }) => {
      const prompts = (kind: NativeRecord["kind"]) =>
        records().filter((record) => record.kind === kind && record.event === "prompt");
      await send("Remember the codeword ORCHID", "Codex child report", 1);

      // The finished Codex chat continues on Claude, which receives the conversation so far.
      await chooseComposerModel(page, models.claude);
      await send("Continue on Claude", "Claude child report", 1);
      const claudePrompt = prompts("claude").at(-1)?.prompt ?? "";
      expect(claudePrompt).toContain("Context handoff (full_thread_summary):");
      expect(claudePrompt).toContain("Remember the codeword ORCHID");
      expect(claudePrompt).toContain("Codex child report");
      expect(claudePrompt.endsWith("User message:\nContinue on Claude")).toBe(true);
      const dividers = page
        .locator('[data-runtime-notice="agentHandoff"]')
        .filter({ visible: true });
      await expect(dividers).toHaveCount(1);
      await expect(dividers.first()).toContainText("Codex");
      await expect(dividers.first()).toContainText("Runtime Claude");
      expect(
        (await invoke(page, "agent-runtime:session:inspect", { sessionId })).thread.modelSelection
          .instanceId,
      ).toBe(CLAUDE_ID);

      // Codex resumes its own native conversation and receives only Claude's part as history.
      await chooseComposerModel(page, models.codex);
      await send("Back on Codex", "Codex child report", 2);
      expect(prompts("codex").at(-1)?.prompt).toBe("Back on Codex");
      const injected = JSON.stringify(
        records().findLast((record) => record.kind === "codex" && record.event === "inject")?.items,
      );
      expect(injected).toContain("Continue on Claude");
      expect(injected).toContain("Claude child report");
      expect(injected).not.toContain("Remember the codeword ORCHID");
      await expect(dividers).toHaveCount(2);
    },
  );
});

test("merges a fork's finished work back into the chat it came from with that chat's next message", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withAgentPeers(testInfo, "agent-merge-back", async ({ page, sessionId, send, records }) => {
    await send("Remember the codeword ORCHID", "Codex child report", 1);
    await runSlashCommand(page, "fork");
    await page.getByRole("button", { name: /Fork conversation/u }).click();
    // The fork opens with the source's history and continues on its own.
    await expect.poll(() => visibleSession(page), { timeout: 30_000 }).not.toBe(sessionId);
    await send("Explore an alternative", "Codex child report", 2);

    await runSlashCommand(page, "merge");
    await expect.poll(() => visibleSession(page), { timeout: 30_000 }).toBe(sessionId);
    await expect(
      page.getByText("The fork's work joins your next message in this chat."),
    ).toBeVisible();
    await send("Use what the fork found", "Codex child report", 2);
    const injected = JSON.stringify(
      records().findLast((record) => record.kind === "codex" && record.event === "inject")?.items,
    );
    expect(injected).toContain("Explore an alternative");
    expect(injected).not.toContain("Remember the codeword ORCHID");
    expect(records().findLast((record) => record.event === "prompt")?.prompt).toBe(
      "Use what the fork found",
    );
    await expect(
      page.locator('[data-runtime-notice="agentHandoff"]').filter({ visible: true }),
    ).toContainText("Fork merged back");
  });
});
