import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { CoreClient, CoreModuleResponseError } from "../../src/main/core-client/core-client";
import type { WindowSessionBootstrap } from "../../src/shared/window-session";
import { openNewChatDraft } from "./support/new-chat-draft";

const timestamp = Date.now().toString(16).padStart(12, "0");
const threadId = (suffix: string) =>
  `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix}`;
const rootId = threadId("000000000101");
const childId = threadId("000000000202");
const createdRootId = threadId("000000000401");
const grandchildId = threadId("000000000402");

interface ScriptedRequest {
  readonly method: string;
  readonly params: { readonly threadId?: string; readonly ephemeral?: boolean };
}

async function readRoot(core: CoreClient, id: string) {
  try {
    const snapshot = await core.workspaceRead({
      kind: "codex_thread_session",
      thread_id: id,
      expected_execution_host_id: "local",
    });
    if (snapshot.value.kind !== "codex_thread_session") throw new Error("Unexpected root query");
    return snapshot.value;
  } catch (error) {
    if (error instanceof CoreModuleResponseError && error.coreError.code === "not_found")
      return null;
    throw error;
  }
}

async function sessionsForThread(core: CoreClient, id: string) {
  const snapshot = await core.workspaceRead({
    kind: "session_window",
    archived: false,
    window: { first: 200, after: null },
  });
  if (snapshot.value.kind !== "session_window") throw new Error("Unexpected Session query");
  expect(snapshot.value.sessions.next_cursor).toBeNull();
  return snapshot.value.sessions.items.filter((item) => item.task.session.thread_id === id);
}

test("opens a completed created card atomically and keeps a created grandchild in its captured root", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "created-thread-root-and-descendant-navigation",
    prepareAgentRuntime: false,
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_SUBAGENT_UUID_V7_TIMESTAMP_HEX: timestamp,
      NODEX_FAKE_CREATED_THREAD_NAVIGATION: "1",
      NODEX_FAKE_SUBAGENT_AUTO_COMPLETE_ROOT_MS: "1200",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-subagent-app-server.mjs"),
  );
  try {
    const page = await harness.launch();
    await page.setViewportSize({ width: 1440, height: 960 });
    const sourceScene = await openNewChatDraft(page);
    await sourceScene
      .locator('[data-codex-composer="true"][aria-label="Do anything"]')
      .fill("Create an independent root and inspect a created descendant");
    await sourceScene.getByRole("button", { name: "Send prompt" }).click();
    const rootCard = sourceScene.getByRole("button", {
      name: "Open chat: Independent created chat",
      exact: true,
    });
    await expect(rootCard).toBeVisible({ timeout: 30_000 });
    const core = await CoreClient.connect({
      nodexHome: harness.profile.nodexHome,
      clientKind: "test",
      buildId: "created-thread-navigation-e2e",
      requestTimeoutMs: 30_000,
    });
    // Summary reads may display the native target, but cannot establish its Core or Session identity.
    await expect(
      core.workspaceRead({ kind: "thread", thread_id: createdRootId }),
    ).rejects.toMatchObject({
      coreError: { code: "not_found" },
    });
    await expect(
      core.workspaceRead({ kind: "thread", thread_id: grandchildId }),
    ).rejects.toMatchObject({
      coreError: { code: "not_found" },
    });
    expect(await sessionsForThread(core, createdRootId)).toEqual([]);
    const originalRoot = await readRoot(core, rootId);
    expect(originalRoot).not.toBeNull();
    if (!originalRoot) throw new Error("Source draft never became a linked root");

    await rootCard.click();
    await expect.poll(() => readRoot(core, createdRootId), { timeout: 30_000 }).not.toBeNull();
    const created = await readRoot(core, createdRootId);
    if (!created) throw new Error("Created card did not establish a root Session");
    expect(created.thread).toMatchObject({
      thread_id: createdRootId,
      execution_host_id: "local",
      parent_thread_id: null,
      session_id: created.session.id,
    });
    expect(created.session.thread_id).toBe(createdRootId);
    const createdScene = page.locator(
      `[data-workbench-scene-owner="session:${created.session.id}"]`,
    );
    await expect(createdScene).toBeVisible();
    await expect(
      createdScene.getByText("Atomic created root opened.", { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    expect(await sessionsForThread(core, createdRootId)).toHaveLength(1);

    const sourceRow = page.locator(
      `[data-app-action-sidebar-thread-host-id="local"][data-app-action-sidebar-thread-id="${rootId}"]`,
    );
    await sourceRow.click();
    await expect(sourceScene).toBeVisible();
    await rootCard.click();
    await expect(createdScene).toBeVisible();
    expect((await readRoot(core, createdRootId))?.session.id).toBe(created.session.id);
    expect(await sessionsForThread(core, createdRootId)).toHaveLength(1);

    await sourceRow.click();
    await expect(sourceScene).toBeVisible();
    await page.getByRole("button", { name: "Open subagents" }).first().click();
    const overview = page.locator(`[data-subagents-panel-overview="${rootId}"]`);
    await expect(overview).toBeVisible({ timeout: 30_000 });
    await overview.getByRole("button", { name: "Open subagent Deep investigator" }).click();
    const detail = page.locator(`[data-subagents-side-panel-tab="subagents:${rootId}"]`);
    await expect(detail).toHaveAttribute("data-subagents-selected-hydration", "ready", {
      timeout: 30_000,
    });
    const grandchildCard = detail.getByRole("button", {
      name: "Open chat: Created grandchild",
      exact: true,
    });
    await expect(grandchildCard).toBeVisible({ timeout: 30_000 });
    // Native thread/started establishes this real child; it is never a catalogue-created root.
    await expect
      .poll(async () => {
        try {
          const snapshot = await core.workspaceRead({ kind: "thread", thread_id: grandchildId });
          return snapshot.value.kind === "thread" ? snapshot.value.thread.parent_thread_id : null;
        } catch (error) {
          if (error instanceof CoreModuleResponseError && error.coreError.code === "not_found")
            return null;
          throw error;
        }
      })
      .toBe(childId);
    await grandchildCard.click();
    await expect(detail).toHaveAttribute("data-subagents-selected-hydration", "ready", {
      timeout: 30_000,
    });
    await expect(
      detail.getByText("Grandchild remains in the captured top-root panel.", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(`[data-subagents-side-panel-tab="subagents:${childId}"]`),
    ).toHaveCount(0);
    await expect(sourceScene).toBeVisible();
    await expect
      .poll(async () => {
        const selectedWindow = await page.evaluate(
          async () =>
            (await window.api!.invoke("window-sessions:bootstrap")) as WindowSessionBootstrap,
        );
        return selectedWindow.session.layout.location;
      })
      .toMatchObject({ kind: "session", sessionId: originalRoot.session.id });
    for (const id of [childId, grandchildId]) {
      const snapshot = await core.workspaceRead({ kind: "thread", thread_id: id });
      if (snapshot.value.kind !== "thread") throw new Error("Unexpected child query");
      expect(snapshot.value.thread.execution_host_id).toBe("local");
      expect(snapshot.value.thread.session_id).toBeNull();
      expect(await sessionsForThread(core, id)).toEqual([]);
    }
    expect(await sessionsForThread(core, createdRootId)).toHaveLength(1);
    const requests = fs
      .readFileSync(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ScriptedRequest);
    expect(
      requests.filter(
        (request) =>
          request.method === "turn/start" &&
          [createdRootId, childId, grandchildId].includes(request.params.threadId ?? ""),
      ),
    ).toEqual([]);
    const state = JSON.parse(
      fs.readFileSync(path.join(harness.profile.runRoot, ".fake-codex/state.json"), "utf8"),
    ) as { lastDiscoveryThreadIds?: string[]; createdGrandchildAnnounced?: boolean };
    expect(state.lastDiscoveryThreadIds).not.toContain(createdRootId);
    expect(state.lastDiscoveryThreadIds).not.toContain(grandchildId);
    expect(state.createdGrandchildAnnounced).toBe(true);
    await testInfo.attach("created-thread-navigation-receipts", {
      body: JSON.stringify(
        {
          source: { hostId: "local", threadId: rootId, sessionId: originalRoot.session.id },
          createdRoot: { threadId: createdRootId, sessionId: created.session.id, sessionCount: 1 },
          selectedDescendant: {
            threadId: grandchildId,
            parentThreadId: childId,
            rootThreadId: rootId,
          },
          nativeReads: requests.filter((request) =>
            ["thread/read", "thread/turns/list", "thread/items/list"].includes(request.method),
          ),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await harness.close();
  }
});
