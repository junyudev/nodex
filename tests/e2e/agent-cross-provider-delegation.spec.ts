import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { materializeDevelopmentSeed } from "../../scripts/scenarios/harness/development-seed";
import { crossProviderRuntimeRoot } from "../../scripts/scenarios/runtime/cross-provider-delegation";
import { CROSS_PROVIDER_SCENARIO_ID } from "../../scripts/scenarios/scenarios/agent-cross-provider-delegation";
import { parseScenarioManifest } from "../../scripts/scenarios/contracts";
import { invokeIpc } from "./support/editor-scenario";
import { waitForDraftScene } from "./support/new-chat-draft";
import { openSubagentsPanel } from "./support/subagents-panel";

test("a Claude chat delegates to Codex and OpenCode and attributes cross-chat messages", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({
    label: "agent-cross-provider-delegation",
    prepareAgentRuntime: false,
    environment: { NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: "./scripted-agent-runtime" },
  });
  const root = crossProviderRuntimeRoot(harness.profile.nodexHome);
  try {
    const manifest = await materializeDevelopmentSeed({
      scenarioId: CROSS_PROVIDER_SCENARIO_ID,
      nodexHome: harness.profile.nodexHome,
      runtimeClock: "manual",
    });
    const parentSession = manifest.entityIdsByKey!.parentSession!;
    const releaseNotesSession = manifest.entityIdsByKey!.releaseNotesSession!;
    const page = await harness.launch();
    await page.setViewportSize({ width: 1440, height: 960 });
    const providers = await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
    expect(providers.flatMap((provider) => provider.models.map((model) => model.slug))).toEqual(
      expect.arrayContaining(["claude-opus-5-5", "gpt-6.1-sol", "opencode/glm-5.3-flash-free"]),
    );
    const project = page.locator(`[data-app-action-sidebar-project-id="${manifest.projectId}"]`);
    await project.hover();
    const expand = project.getByRole("button", { name: "Expand project", exact: true });
    if (await expand.count()) await expand.click();
    await page.locator(`[data-app-action-sidebar-thread-id="${parentSession}"]`).click();
    const scene = await waitForDraftScene(page, parentSession);
    await expect(scene.locator("[data-user-message-origin]")).toHaveCount(0);
    const composer = scene.locator('[data-codex-composer="true"]:visible');
    await composer.fill(
      "Build passkey sign-in for Lumen and delegate the routes, migration, docs, and tests.",
    );
    await composer.press("Enter");
    const group = scene
      .getByRole("status")
      .filter({ has: page.getByRole("button", { name: "Show all 4 subagents" }) });
    await expect(group).toBeVisible({ timeout: 45_000 });
    const overview = () =>
      invokeIpc(page, "agent-runtime:session:overview", { sessionId: parentSession });
    await expect
      .poll(
        async () =>
          (await overview()).active.items.filter((task) => task.origin === "app_owned").length,
      )
      .toBe(4);
    const active = (await overview()).active.items;
    const webauthn = active.find((task) => task.title === "WebAuthn routes");
    if (!webauthn?.childThreadId) throw new Error("WebAuthn child identity missing");
    const parent = await invokeIpc(page, "project-sessions:get", parentSession);
    expect(parent?.executionRef?.threadId).toBeTruthy();
    await expect
      .poll(
        () =>
          parseScenarioManifest(
            JSON.parse(fs.readFileSync(path.join(root, "scenario-manifest.json"), "utf8")),
          ).entityIdsByKey?.parentThread,
      )
      .toBe(parent!.executionRef!.threadId);
    // Gate every child at its native Run; none can finish because a slow machine took longer.
    await expect
      .poll(
        () =>
          fs
            .readFileSync(path.join(root, "native.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.event === "child.ready").length,
      )
      .toBe(4);
    fs.writeFileSync(path.join(root, "gates/webauthn"), "release");
    await expect
      .poll(
        async () =>
          (await overview()).terminal.items.find((task) => task.id === webauthn.id)?.status,
      )
      .toBe("completed");
    await expect(scene.locator('[data-runtime-notice="report"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await openSubagentsPanel(page);
    await page.getByRole("button", { name: "Open subagent WebAuthn routes", exact: true }).click();
    const detail = page.locator("[data-subagents-side-panel-tab]").last();
    await expect(detail.locator('[data-user-message-origin="agent"]').first()).toBeVisible();
    // The canonical child retains the selected provider, model and effort.
    const child = await invokeIpc(page, "agent-runtime:session:inspect", {
      sessionId: parentSession,
      threadId: webauthn.childThreadId,
    });
    expect(child.thread.modelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: expect.arrayContaining([{ id: "reasoningEffort", value: "xhigh" }]),
    });
    for (const key of ["credentials", "tests", "docs"])
      fs.writeFileSync(path.join(root, "gates", key), "release");
    await expect
      .poll(
        async () =>
          (await overview()).terminal.items.filter((task) => task.origin === "app_owned").length,
      )
      .toBe(4);
    expect(
      (await overview()).terminal.items.find((task) => task.title === "Sign-in tests")?.status,
    ).toBe("failed");
    const release = await invokeIpc(page, "project-sessions:get", releaseNotesSession);
    if (!release?.executionRef) throw new Error("Release notes did not receive its message");
    await page
      .locator(`[data-app-action-sidebar-thread-id="${release.executionRef.threadId}"]`)
      .click();
    const releaseScene = await waitForDraftScene(page, releaseNotesSession);
    await expect(releaseScene.locator('[data-user-message-origin="agent"]').first()).toBeVisible();
    await testInfo.attach("scenario-manifest", {
      path: path.join(root, "scenario-manifest.json"),
      contentType: "application/json",
    });
  } catch (error) {
    await testInfo.attach("runtime-logs", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile)),
      contentType: "text/plain",
    });
    if (fs.existsSync(path.join(root, "native.jsonl")))
      await testInfo.attach("native-peer", {
        path: path.join(root, "native.jsonl"),
        contentType: "text/plain",
      });
    throw error;
  } finally {
    await harness.close();
  }
});
