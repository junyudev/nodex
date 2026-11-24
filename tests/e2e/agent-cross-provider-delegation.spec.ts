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
import { waitForCodexRuntimeCatalog } from "./support/agent-runtime-catalog";
import { invokeIpc } from "./support/editor-scenario";
import { waitForDraftScene } from "./support/new-chat-draft";
import { openSubagentsPanel, selectSubagentsList } from "./support/subagents-panel";

test("a Claude chat delegates across providers and shows one subagent while its task history grows", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({
    label: "agent-cross-provider-delegation",
    prepareAgentRuntime: false,
    environment: { NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: "./scripted-agent-runtime" },
  });
  const root = crossProviderRuntimeRoot(harness.profile.nodexHome);
  const releaseGate = (key: string) => fs.writeFileSync(path.join(root, "gates", key), "release");
  const nativePeerLog = path.join(root, "native.jsonl");
  const nativeEvents = () =>
    fs.existsSync(nativePeerLog)
      ? fs
          .readFileSync(nativePeerLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
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
    const providers = await waitForCodexRuntimeCatalog(page);
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
    await composer.click();
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
    const migration = active.find((task) => task.title === "Credentials migration");
    if (!migration?.childThreadId) throw new Error("Credentials migration child identity missing");
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
      .poll(() => nativeEvents().filter((entry) => entry.event === "child.ready").length)
      .toBe(4);
    // The subagent's card marks the harness that runs it and names it with the model. The
    // parent's finished turn folds its work away; unfold it while the children still run.
    const worked = scene.locator('[data-agent-body-toggle="true"]').first();
    await expect(worked).toBeVisible();
    if ((await worked.getAttribute("aria-expanded")) === "false") await worked.click();
    await group.getByRole("button", { name: "WebAuthn routes", exact: true }).hover();
    const card = page.getByRole("dialog", { name: "WebAuthn routes details" });
    await expect(card.locator('[data-agent-identity="codex"]')).toHaveText("Codex · GPT-6.1 Sol");
    await page.mouse.move(0, 0);
    releaseGate("webauthn");
    await expect
      .poll(
        async () =>
          (await overview()).terminal.items.find((task) => task.id === webauthn.id)?.status,
      )
      .toBe("completed");
    // Its report reads like the row that started it.
    await expect(scene.locator('[data-runtime-notice="report"]').first()).toHaveText(
      "WebAuthn routes finished",
      { timeout: 30_000 },
    );
    await openSubagentsPanel(page);
    const panel = page.locator("[data-subagents-panel-overview]");
    const row = (name: string) =>
      page.getByRole("button", { name: `Open subagent ${name}`, exact: true });
    // The overview opens as a map: the lead counts what is back, and each card names the
    // harness that runs its subagent, with an edge drawn by how that work stands.
    const map = panel.locator("[data-delegation-map]");
    const node = (name: string) => map.locator("[data-delegation-node]").filter({ has: row(name) });
    const lead = map.locator("[data-delegation-lead]");
    await expect(lead).toContainText("Claude Code · lead");
    await expect(lead).toContainText("Delegating · 1/4 back");
    await expect(node("WebAuthn routes").locator('[data-agent-driver="codex"]')).toContainText(
      "GPT-6.1 Sol · Extra High",
    );
    await expect(node("WebAuthn routes")).toHaveAttribute("data-delegation-edge", "returned");
    await expect(node("Passkey docs").locator('[data-agent-driver="opencode"]')).toContainText(
      "GLM-5.3-Flash Free",
    );
    await expect(node("Passkey docs")).toHaveAttribute("data-delegation-edge", "flowing");
    await row("WebAuthn routes").click();
    const detail = page.locator("[data-subagents-side-panel-tab]").last();
    await expect(detail.locator('[data-agent-identity="codex"]').first()).toContainText(
      "GPT-6.1 Sol · Extra High",
    );
    // The task names the chat that sent it, marked with that chat's own harness.
    const sentBy = detail.locator('[data-user-message-origin="agent"]').first();
    await expect(sentBy).toHaveText("Sent byPasskey sign-in");
    await expect(sentBy.locator('[data-conversation-reference="chat"] svg')).toHaveCount(1);
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
    await detail.getByRole("button", { name: "Back to subagents" }).click();

    // Let the other three subagents settle so the migration follow-up is the only live work.
    for (const key of ["tests", "docs"]) releaseGate(key);
    await expect(lead).toContainText("Delegating · 3/4 back");
    expect(
      (await overview()).terminal.items.find((task) => task.title === "Sign-in tests")?.status,
    ).toBe("failed");
    releaseGate("credentials");

    const findFollowUp = () =>
      nativeEvents().find((entry) => entry.event === "tool.result" && entry.name === "task_send");
    await expect
      .poll(() => findFollowUp()?.result)
      .toMatchObject({
        conversationTaskId: migration.id,
        taskId: expect.any(String),
        delivery: "started",
      });
    expect(findFollowUp()?.result.taskId).not.toBe(migration.id);
    const migrationReady = nativeEvents().find(
      (entry) => entry.event === "child.ready" && entry.key === "credentials",
    );
    if (!migrationReady) throw new Error("Original migration native turn missing");
    const followUpReady = () =>
      nativeEvents().find(
        (entry) => entry.event === "child.ready" && entry.key === "credentials-down",
      );
    await expect.poll(followUpReady).toMatchObject({
      kind: "codex",
      threadId: migrationReady.threadId,
      turnId: expect.any(String),
    });
    expect(followUpReady().turnId).not.toBe(migrationReady.turnId);

    const unfoldParentWork = async () => {
      for (const toggle of await scene.locator('[data-agent-body-toggle="true"]').all()) {
        if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      }
    };
    const migrationCards = scene
      .getByTestId("delegated-task-group")
      .getByRole("button", { name: "Credentials migration", exact: true });
    await unfoldParentWork();
    await expect(migrationCards).toHaveCount(2);
    // Each transcript card keeps its own turn: the first one is back while the follow-up runs.
    const migrationDetails = page.getByRole("dialog", { name: "Credentials migration details" });
    for (const [index, status] of ["Done", "Running"].entries()) {
      await migrationCards.nth(index).hover();
      await expect(migrationDetails.getByText(status, { exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(migrationDetails).toBeHidden();
    }

    const migrationNode = node("Credentials migration");
    await expect(migrationNode).toHaveCount(1);
    await expect(migrationNode).toHaveAttribute("data-delegation-edge", "flowing");
    await expect(lead).toContainText("Delegating · 3/4 back");

    const migrationRow = panel.locator(row("Credentials migration"));
    const activeSection = panel.locator('[data-subagent-overview-section="active"]');
    const doneSection = panel.locator('[data-subagent-overview-section="done"]');
    await selectSubagentsList(page);
    await expect(migrationRow).toHaveCount(1);
    await expect(
      activeSection.getByRole("button", { name: "Open subagent Credentials migration" }),
    ).toBeVisible();

    await panel.getByRole("radio", { name: "Map", exact: true }).click();
    releaseGate("credentials-down");
    await expect(migrationNode).toHaveCount(1);
    await expect(migrationNode).toHaveAttribute("data-delegation-edge", "returned");
    await expect(lead).toContainText("All 4 back");

    await selectSubagentsList(page);
    await expect(migrationRow).toHaveCount(1);
    await expect(
      doneSection.getByRole("button", { name: "Open subagent Credentials migration" }),
    ).toBeVisible();

    await unfoldParentWork();
    await expect(migrationCards).toHaveCount(2);
    const release = await invokeIpc(page, "project-sessions:get", releaseNotesSession);
    if (!release?.executionRef) throw new Error("Release notes did not receive its message");
    await page
      .locator(`[data-app-action-sidebar-thread-id="${release.executionRef.threadId}"]`)
      .click();
    const releaseScene = await waitForDraftScene(page, releaseNotesSession);
    await expect(releaseScene.locator('[data-user-message-origin="agent"]').first()).toHaveText(
      "Sent byPasskey sign-in",
    );
    await releaseScene.getByRole("button", { name: "Open Passkey sign-in" }).first().click();
    await waitForDraftScene(page, parentSession);
    await testInfo.attach("scenario-manifest", {
      path: path.join(root, "scenario-manifest.json"),
      contentType: "application/json",
    });
  } catch (error) {
    await testInfo.attach("runtime-logs", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile)),
      contentType: "text/plain",
    });
    if (fs.existsSync(nativePeerLog))
      await testInfo.attach("native-peer", {
        path: nativePeerLog,
        contentType: "text/plain",
      });
    throw error;
  } finally {
    await harness.close();
  }
});
