import { expect, test, type Page } from "@playwright/test";
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

test("continues a finished Codex chat on Claude with its history, then returns to Codex with only what it missed", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-runtime-agent-switch-"));
  const codex = path.join(fixture, "codex");
  const claude = path.join(fixture, "claude");
  const peer = fs
    .readFileSync(path.resolve("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs"), "utf8")
    .replace(/^#![^\n]*\n/u, "");
  for (const executable of [codex, claude])
    fs.writeFileSync(executable, `#!${process.execPath}\n${peer}`, { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
  const records = () =>
    fs.existsSync(path.join(fixture, "native.jsonl"))
      ? fs
          .readFileSync(path.join(fixture, "native.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as NativeRecord)
      : [];
  const prompts = (kind: NativeRecord["kind"]) =>
    records().filter((record) => record.kind === kind && record.event === "prompt");
  const harness = await ElectronScenarioHarness.create({
    label: "agent-runtime-agent-switch",
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
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
          configDirectory: path.join(fixture, "claude-home"),
          enabled: true,
          customModels: [],
          environment: [
            { name: "NODEX_TEST_CROSS_PROVIDER_HOME", value: fixture, sensitive: false },
          ],
        },
      ],
    });
    const providers = await invoke(page, "agent-runtime:providers:read", { refresh: true });
    const claudeId = agentRuntimeProviderId({ kind: "claude", instanceConfigId: "claude-fixture" });
    const claudeModel = providers.find((provider) => provider.instanceId === claudeId)?.models[0];
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
    const sessionId = receipt.value.id;
    const scene = await waitForDraftScene(page, sessionId);
    const composer = scene.locator('[data-codex-composer="true"]:visible');
    const send = async (prompt: string, reply: string, count: number) => {
      await composer.fill(prompt);
      await composer.press("Enter");
      await expect(scene.getByText(reply, { exact: true })).toHaveCount(count, {
        timeout: 30_000,
      });
      await expect
        .poll(
          async () =>
            (await invoke(page, "agent-runtime:session:inspect", { sessionId })).thread.activeRunId,
        )
        .toBeNull();
    };
    await send("Remember the codeword ORCHID", "Codex child report", 1);

    // The finished Codex chat continues on Claude, which receives the conversation so far.
    await chooseComposerModel(page, `${claudeModel.name} Runtime Claude`);
    await send("Continue on Claude", "Claude child report", 1);
    const claudePrompt = prompts("claude").at(-1)?.prompt ?? "";
    expect(claudePrompt).toContain("Context handoff (full_thread_summary):");
    expect(claudePrompt).toContain("Remember the codeword ORCHID");
    expect(claudePrompt).toContain("Codex child report");
    expect(claudePrompt.endsWith("User message:\nContinue on Claude")).toBe(true);
    const dividers = scene.locator('[data-runtime-notice="agentHandoff"]');
    await expect(dividers).toHaveCount(1);
    await expect(dividers.first()).toContainText("Codex");
    await expect(dividers.first()).toContainText("Runtime Claude");
    expect(
      (await invoke(page, "agent-runtime:session:inspect", { sessionId })).thread.modelSelection
        .instanceId,
    ).toBe(claudeId);

    // Codex resumes its own native conversation and receives only Claude's part as history.
    await chooseComposerModel(page, `${codexModel.name} Codex`);
    await send("Back on Codex", "Codex child report", 2);
    expect(prompts("codex").at(-1)?.prompt).toBe("Back on Codex");
    const injected = JSON.stringify(
      records().findLast((record) => record.kind === "codex" && record.event === "inject")?.items,
    );
    expect(injected).toContain("Continue on Claude");
    expect(injected).toContain("Claude child report");
    expect(injected).not.toContain("Remember the codeword ORCHID");
    await expect(dividers).toHaveCount(2);
  } finally {
    await testInfo.attach("agent-switch-main.log", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 250_000)),
      contentType: "text/plain",
    });
    await testInfo.attach("agent-switch-native.jsonl", {
      body: fs.existsSync(path.join(fixture, "native.jsonl"))
        ? fs.readFileSync(path.join(fixture, "native.jsonl"))
        : Buffer.from(""),
      contentType: "text/plain",
    });
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
