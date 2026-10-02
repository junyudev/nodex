import { expect, test, type Page } from "@playwright/test";
import { openComposerModelPicker as openModelPicker } from "./support/composer-model-picker";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import { AGENT_CLI_SCENARIO_ID } from "../../scripts/scenarios/scenarios/agent-cli-workflow";
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

interface OpenCodeObservation {
  readonly kind: string;
  readonly model?: { providerID: string; modelID: string };
  readonly variant?: string;
  readonly agent?: string;
  readonly cwd?: string;
}

test("chooses a connected OpenCode model with native options before its first prompt and restores the session without replay", async () => {
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
    await expect(
      page.getByRole("button", { name: "Connect providers…", exact: true }),
    ).toBeVisible();
    expect(
      observations().filter(({ kind }) => kind === "createSession" || kind === "prompt"),
    ).toEqual([]);
    await kimi.click();
    await openModelPicker(page);
    await page.getByRole("button", { name: /^Variant /u }).click();
    await page.getByRole("menuitem", { name: "high", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "high", exact: true })).not.toBeVisible();
    await openModelPicker(page);
    await page.getByRole("button", { name: /^Mode /u }).click();
    await page.getByRole("menuitem", { name: "plan", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "plan", exact: true })).not.toBeVisible();
    await openModelPicker(page);
    await expect(page.getByRole("button", { name: "Variant high", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mode plan", exact: true })).toBeVisible();
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
          (await invoke<ProjectSession | null>(page, "project-sessions:get", sessionId))?.thread
            ?.backendBinding,
      )
      .toEqual({ kind: "opencode", instanceConfigId: "opencode-default" });
    const linked = await invoke<ProjectSession>(page, "project-sessions:get", sessionId);
    if (!linked.thread) throw new Error("OpenCode Thread was not attached");
    threadId = linked.thread.threadId;
    const read = () =>
      invoke<AgentBackendSessionPresentation | null>(page, "agent-backend:session:read", threadId);
    await expect
      .poll(async () => (await read())?.snapshot.turns.at(-1)?.stopReason, { timeout: 30_000 })
      .toBe("end_turn");
    const completed = await read();
    if (!completed) throw new Error("OpenCode session closed after completing its first turn");
    expect(completed.snapshot.status).toBe("idle");
    expect(completed.snapshot.error).toBeNull();
    expect(completed.snapshot.turns.flatMap(({ updates }) => updates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "message", role: "agent", text: "OPEN_CODE_OK" }),
      ]),
    );
    expect(completed.configOptions.find(({ category }) => category === "model")).toMatchObject({
      currentValue: "moonshot/kimi-k3",
    });
    expect(completed.configOptions.find(({ id }) => id === "variant")).toMatchObject({
      currentValue: "high",
    });
    expect(completed.modes?.currentModeId).toBe("plan");
    expect(observations().find(({ kind }) => kind === "prompt")).toMatchObject({
      model: { providerID: "moonshot", modelID: "kimi-k3" },
      variant: "high",
      agent: "plan",
      cwd: sourceRoot,
    });
    const promptCount = observations().filter(({ kind }) => kind === "prompt").length;
    const sessionCount = observations().filter(({ kind }) => kind === "createSession").length;
    expect(sessionCount).toBe(1);
    page = await harness.restart();
    const restored = await invoke<AgentBackendSessionPresentation>(
      page,
      "agent-backend:session:open",
      { threadId },
    );
    expect(restored.snapshot.sessionId).toBe(completed.snapshot.sessionId);
    expect(restored.snapshot.status).toBe("idle");
    expect(restored.snapshot.turns.at(-1)).toMatchObject({
      clientUserMessageId: completed.snapshot.turns.at(-1)?.clientUserMessageId,
      nativeUserMessageId: completed.snapshot.turns.at(-1)?.nativeUserMessageId,
      stopReason: "end_turn",
    });
    expect(restored.snapshot.turns.flatMap(({ updates }) => updates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "message", role: "agent", text: "OPEN_CODE_OK" }),
      ]),
    );
    expect(restored.configOptions.find(({ category }) => category === "model")).toMatchObject({
      currentValue: "moonshot/kimi-k3",
    });
    expect(restored.configOptions.find(({ id }) => id === "variant")).toMatchObject({
      currentValue: "high",
    });
    expect(restored.modes?.currentModeId).toBe("plan");
    expect(observations().filter(({ kind }) => kind === "prompt")).toHaveLength(promptCount);
    expect(observations().filter(({ kind }) => kind === "createSession")).toHaveLength(
      sessionCount,
    );
    await page.screenshot({
      path: path.join(evidenceRoot, "restored-conversation.png"),
      animations: "disabled",
    });
    rmSync(path.join(nativeRoot, "sessions.json"), { force: true });
    page = await harness.restart();
    await expect(invoke(page, "agent-backend:session:open", { threadId })).rejects.toThrow(
      /session|available|found/iu,
    );
    const missing = await invoke<ProjectSession>(page, "project-sessions:get", sessionId);
    expect(missing.thread?.backendBinding).toEqual({
      kind: "opencode",
      instanceConfigId: "opencode-default",
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
      const presentation = await invoke(harness.page, "agent-backend:session:read", threadId).catch(
        (cause) => ({ error: cause instanceof Error ? cause.message : String(cause) }),
      );
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
