import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { readCoreRuntimeConnection } from "../../src/main/core-client/runtime-descriptor";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import { invokeIpc } from "./support/editor-scenario";

test("recovers Core loss while three Inbox chats run without repeating dispatch or Agent admission", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-core-recovery-"));
  const peer = fs
    .readFileSync(path.resolve("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs"), "utf8")
    .replace(/^#![^\n]*\n/u, "");
  for (const name of ["codex", "claude"])
    fs.writeFileSync(path.join(fixture, name), `#!${process.execPath}\n${peer}`, { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
  const harness = await ElectronScenarioHarness.create({
    label: "core-recovery-inbox",
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(fixture, "codex"),
    "0.145.0-alpha.15",
  );
  const prefix = "Hold child core-recovery-inbox";
  const prompts = () => {
    const file = path.join(fixture, "native.jsonl");
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event: string; prompt?: string })
          .filter((event) => event.event === "prompt" && event.prompt?.startsWith(prefix))
      : [];
  };
  try {
    const page = await harness.launch();
    const seed = new RendererIpcSeedAdapter(page);
    await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
    await invokeIpc(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "recovery-claude",
          displayName: "Recovery Claude",
          binaryPath: path.join(fixture, "claude"),
          configDirectory: path.join(fixture, "claude-home"),
          enabled: true,
          customModels: [],
          environment: [
            { name: "NODEX_TEST_CROSS_PROVIDER_HOME", value: fixture, sensitive: false },
          ],
        },
      ],
    });
    const claudeId = agentRuntimeProviderId({
      kind: "claude",
      instanceConfigId: "recovery-claude",
    });
    if (!claudeId) throw new Error("Fixture Claude identity is unavailable");
    const providers = await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
    const agents = ["codex", claudeId, claudeId].map((id) => {
      const provider = providers.find((value) => value.instanceId === id);
      if (!provider?.models[0]) throw new Error("Fixture provider is unavailable");
      return {
        instanceId: id,
        model: provider.models[0].slug,
        reasoningEffort: null,
        serviceTier: null,
      };
    });
    const projects = await invokeIpc(page, "projects:list");
    const project = projects.items[0];
    if (!project) throw new Error("Fresh Profile has no Project");
    const messages: Awaited<ReturnType<RendererIpcSeedAdapter["sendInboxMessage"]>>[] = [];
    for (let index = 0; index < agents.length; index += 1)
      messages.push(await seed.sendInboxMessage(`${prefix} ${index}`));
    const inbox = await seed.readInbox("inbox");
    const prepared = await Promise.all(
      messages.map(async (message, index) => {
        const item = inbox.items.find((value) => value.pageId === message.pageId);
        if (!item) throw new Error("Inbox message is missing");
        const decision = await invokeIpc(page, "inbox:prepare-confirmation", {
          kind: "direct",
          storeEpoch: inbox.storeEpoch,
          pageIds: [message.pageId],
          basis: [item.basis],
          action: {
            type: "new_chat",
            projectId: project.id,
            prompt: `${prefix} ${index}`,
            agent: agents[index]!,
            delegates: [],
            plan: null,
          },
        });
        if (decision.kind !== "direct") throw new Error("Expected direct Inbox decision");
        return decision;
      }),
    );
    const dispatch = (decision: (typeof prepared)[number]) =>
      invokeIpc(page, "inbox:dispatch", {
        storeEpoch: decision.storeEpoch,
        operationId: decision.operationId,
        proposalId: decision.proposalId,
        sessionId: decision.sessionId,
        pageIds: decision.pageIds,
        basis: decision.basis,
        action: decision.action,
        executionSelection: decision.executionSelection,
      });
    const receipts = await Promise.all(prepared.map(dispatch));
    expect(receipts.every((result) => result.ok)).toBe(true);
    const sessionIds = prepared.map((decision) => decision.sessionId);
    const activity = async () =>
      (await invokeIpc(page, "agent-runtime:activity:read")).items
        .filter((item) => sessionIds.includes(item.sessionId))
        .map(({ sessionId, activeRunId }) => ({ sessionId, activeRunId }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    await expect
      .poll(async () => (await activity()).filter((item) => item.activeRunId !== null).length)
      .toBe(3);
    await expect.poll(() => prompts().length).toBe(3);
    const before = await activity();
    const initial = readCoreRuntimeConnection(harness.profile.nodexHome).descriptor;
    expect(initial.pid).not.toBe(process.pid);
    process.kill(initial.pid, "SIGKILL");
    await expect
      .poll(
        () => {
          try {
            return (
              readCoreRuntimeConnection(harness.profile.nodexHome).descriptor.start_nonce !==
              initial.start_nonce
            );
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const replacement = readCoreRuntimeConnection(harness.profile.nodexHome).descriptor;
    expect(replacement.profile_id).toBe(initial.profile_id);
    expect(replacement.store_epoch).toBe(initial.store_epoch);
    await expect
      .poll(async () => (await invokeIpc(page, "app:get-core-authority-status")).kind)
      .toBe("ready");
    expect(await activity()).toEqual(before);
    const retries = await Promise.all(prepared.map(dispatch));
    expect(retries.every((result) => result.ok)).toBe(true);
    const processed = await seed.readInbox("processed");
    expect(
      processed.items
        .filter((item) => messages.some((message) => message.pageId === item.pageId))
        .map((item) => ({ state: item.proposal?.state, sessionId: item.proposal?.chat?.sessionId }))
        .sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId))),
    ).toEqual(sessionIds.toSorted().map((sessionId) => ({ state: "completed", sessionId })));
    const resumedMessage = await seed.sendInboxMessage("Core recovery is connected");
    await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
    await expect(page.locator(`[data-inbox-page-id="${resumedMessage.pageId}"]`)).toBeVisible();
    expect(await activity()).toEqual(before);
    expect(prompts()).toHaveLength(3);
    expect(harness.application.process().exitCode).toBeNull();
    await testInfo.attach("core-recovery-evidence", {
      body: JSON.stringify(
        {
          before,
          initial: { pid: initial.pid, nonce: initial.start_nonce },
          replacement: { pid: replacement.pid, nonce: replacement.start_nonce },
          promptCount: prompts().length,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await testInfo.attach("runtime-logs", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
