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
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { chooseComposerModel } from "./support/composer-model-picker";

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

test("delegates across Codex and Claude through the Session UI and restores child history after restart", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-runtime-cross-provider-"));
  const source = path.resolve("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs");
  const codex = path.join(fixture, "codex");
  const claude = path.join(fixture, "claude");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = path.join(fixture, "node-runtime");
  const wire = path.join(fixture, "wire.jsonl");
  const processLog = path.join(fixture, "process.log");
  for (const executable of [codex, claude]) {
    const body = fs.readFileSync(source, "utf8").replace(/^#![^\n]*\n/u, "");
    fs.writeFileSync(executable, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  }
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(path.resolve("tests/e2e/fixtures/agent-runtime-wire-observer.cjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
  const harness = await ElectronScenarioHarness.create({
    label: "agent-runtime-cross-provider",
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: launcher,
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
      NODEX_TEST_AGENT_RUNTIME_WIRE_LOG: wire,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
  const launchedSessions: string[] = [];
  const activePage: { current: Page | null } = { current: null };
  const launch = async () => {
    const page = await harness.launch({ phase: "first-window" });
    activePage.current = page;
    for (const stream of [
      harness.application.process().stdout,
      harness.application.process().stderr,
    ])
      stream?.on("data", (bytes: Buffer) => fs.appendFileSync(processLog, bytes));
    await harness.waitForApplicationReady();
    await page.evaluate(() => {
      const api = window.api;
      if (!api) throw new Error("Fixture renderer bridge is unavailable");
      const target = window as typeof window & { runtimeDeliveryEvidence?: unknown[] };
      target.runtimeDeliveryEvidence = [];
      api.on("agent-runtime:session-event", (event: unknown) => {
        const value =
          event as import("../../src/shared/agent-runtime-api").AgentRuntimeSessionEvent;
        const rows = target.runtimeDeliveryEvidence!;
        if (rows.length >= 256) rows.shift();
        rows.push({
          type: value.type,
          subscriptionId: value.subscriptionId,
          threadId: value.threadId,
          ...(value.type === "event"
            ? { sequence: value.event.sequence, eventType: value.event.event.type }
            : { reason: value.reason }),
        });
      });
    });
    return page;
  };
  try {
    let page = await launch();
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
    const claudeProvider = providers.find(
      (provider) =>
        provider.instanceId ===
        agentRuntimeProviderId({ kind: "claude", instanceConfigId: "claude-fixture" }),
    );
    const codexProvider = providers.find((provider) => provider.instanceId === "codex");
    expect(claudeProvider?.installed).toBe(true);
    expect(claudeProvider?.status).not.toBe("error");
    const claudeModel = claudeProvider?.models[0];
    const codexModel = codexProvider?.models[0];
    if (!claudeProvider || !claudeModel || !codexModel)
      throw new Error("Both native provider catalogs must be available");
    const project = (await invoke(page, "projects:list")).items[0];
    if (!project) throw new Error("Fixture Project missing");
    const seed = new RendererIpcSeedAdapter(page);
    const otherProject = await seed.createProject({
      name: "Background content target",
      sources: [harness.profile.initialProjectsDirectory],
    });
    const otherPageId = createUuidV7();
    await seed.createPage({
      key: "background-content",
      pageId: otherPageId,
      operationId: createUuidV7(),
      projectId: otherProject.id,
      status: "plan",
      title: "Cross Project source",
      nfm: "Content in another Project.",
    });
    fs.writeFileSync(
      path.join(fixture, "content-target.json"),
      JSON.stringify({ pageId: otherPageId }),
    );
    fs.writeFileSync(
      path.join(fixture, "plan.json"),
      JSON.stringify({
        "Delegate from Codex": {
          task: "Produce a Claude child report",
          target: { providerInstanceId: claudeProvider.instanceId, model: claudeModel.slug },
        },
        "Delegate from Claude": {
          task: "Produce a Codex child report",
          target: { providerInstanceId: "codex", model: codexModel.slug },
        },
        "Delegate async from Codex": {
          task: "Hold async Claude report",
          target: { providerInstanceId: claudeProvider.instanceId, model: claudeModel.slug },
          mode: "async",
        },
        "Delegate held Codex child": {
          task: "Hold child Codex",
          target: { providerInstanceId: "codex", model: codexModel.slug },
        },
      }),
    );
    const submit = async (prompt: string, modelQuery?: string) => {
      await page
        .getByRole("button", { name: `Start new chat in ${project.name}`, exact: true })
        .click();
      if (modelQuery) await chooseComposerModel(page, modelQuery);
      const receipt = await invoke(page, "project-sessions:ensure-default-draft", {
        operationId: createBoundedOperationId("session.ensure-default-draft"),
        payload: { candidateSessionId: randomUUID(), projectId: project.id },
      });
      if (!("value" in receipt)) throw new Error("Default draft admission failed");
      const draft = receipt.value;
      if (draft.executionRef) throw new Error("Default draft missing");
      const composer = page.locator('[data-codex-composer="true"]').first();
      await composer.fill(prompt);
      await composer.press("Enter");
      await expect
        .poll(async () => (await invoke(page, "project-sessions:get", draft.id))?.executionRef)
        .toBeTruthy();
      launchedSessions.push(draft.id);
      return draft.id;
    };
    const codexSession = await submit("Delegate from Codex");
    await expect(
      page.getByText("Codex received Claude child report", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    const firstOverview = await invoke(page, "agent-runtime:session:overview", {
      sessionId: codexSession,
    });
    const claudeChild = firstOverview.terminal.items.find((task) => task.origin === "app_owned");
    if (!claudeChild?.childThreadId) throw new Error("Claude child missing from bounded metadata");
    await page.getByRole("button", { name: "Task actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Tasks", exact: true }).click();
    await page
      .getByRole("button", {
        name: `Open subagent ${claudeChild.title ?? "Subagent"}`,
        exact: true,
      })
      .click();
    await expect(page.getByText("Claude child report", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    const asyncSession = await submit("Delegate async from Codex");
    await expect(
      page.getByText("Codex delegated async child", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await invoke(page, "agent-runtime:session:inspect", { sessionId: asyncSession })).thread
            .activeRunId,
      )
      .toBeNull();
    fs.writeFileSync(path.join(fixture, "async-release"), "complete");
    await expect(
      page.getByText("Codex received async Claude child report", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    const written = await invoke(page, "pages:detail:get", otherProject.id, otherPageId);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error(written.error.message);
    expect(written.value.page.title).toBe("Written by background Claude child");
    expect((await invoke(page, "project-sessions:get", asyncSession))?.projectId).toBe(project.id);
    const asyncComposer = page.locator('[data-codex-composer="true"]').first();
    await asyncComposer.fill("Follow up after async completion");
    await asyncComposer.press("Enter");
    await expect(page.getByText("Codex follow-up complete", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    const claudeSession = await submit(
      "Delegate from Claude",
      `${claudeModel.name} Runtime Claude`,
    );
    await expect(
      page.getByText("Claude received Codex child report", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    const secondOverview = await invoke(page, "agent-runtime:session:overview", {
      sessionId: claudeSession,
    });
    const codexChild = secondOverview.terminal.items.find((task) => task.origin === "app_owned");
    if (!codexChild?.childThreadId) throw new Error("Codex child missing from bounded metadata");
    const inspected = await invoke(page, "agent-runtime:session:inspect", {
      sessionId: claudeSession,
      threadId: codexChild.childThreadId,
    });
    expect(inspected.sessionId).toBe(claudeSession);
    await expect(
      invoke(page, "agent-runtime:session:inspect", {
        sessionId: codexSession,
        threadId: codexChild.childThreadId,
      }),
    ).rejects.toThrow();
    const followUp = page.locator('[data-codex-composer="true"]').first();
    await followUp.fill("Delegate held Codex child");
    await followUp.press("Enter");
    await expect
      .poll(async () => {
        const overview = await invoke(page, "agent-runtime:session:overview", {
          sessionId: claudeSession,
        });
        return overview.active.items.some(
          (task) => task.childThreadId !== null && task.title?.includes("Hold child"),
        );
      })
      .toBe(true);
    const heldOverview = await invoke(page, "agent-runtime:session:overview", {
      sessionId: claudeSession,
    });
    const held = heldOverview.active.items.find((task) => task.title?.includes("Hold child"));
    if (!held?.childThreadId) throw new Error("Held child missing");
    await page.getByRole("button", { name: "Task actions", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Tasks", exact: true }).click();
    await page.getByRole("button", { name: `Open subagent ${held.title}`, exact: true }).click();
    const detail = page.locator("[data-subagents-side-panel-tab]").last();
    await detail.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await invoke(page, "agent-runtime:session:inspect", {
              sessionId: claudeSession,
              threadId: held.childThreadId!,
            })
          ).thread.activeRunId,
      )
      .toBeNull();
    await harness.stopElectron();
    page = await launch();
    const restored = await invoke(page, "agent-runtime:session:read", {
      sessionId: codexSession,
      threadId: claudeChild.childThreadId,
    });
    expect(
      restored.snapshot.projection.visibleTurnItems.some(
        ({ item }) => item.type === "assistant_message" && item.text === "Claude child report",
      ),
    ).toBe(true);
    expect((await invoke(page, "project-sessions:get", codexSession))?.thread).toBeNull();
    expect((await invoke(page, "project-sessions:get", claudeSession))?.thread).toBeNull();
    const nativeRecords = fs
      .readFileSync(path.join(fixture, "native.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event?: string; prompt?: string });
    expect(
      nativeRecords.filter(
        (record) => record.event === "prompt" && record.prompt === "Hold async Claude report",
      ),
    ).toHaveLength(1);
  } catch (error) {
    const diagnostics = [];
    const page = activePage.current;
    if (page && !page.isClosed()) {
      await testInfo.attach("cross-provider-renderer-delivery.json", {
        body: Buffer.from(
          JSON.stringify(
            await page.evaluate(
              () =>
                (window as typeof window & { runtimeDeliveryEvidence?: unknown[] })
                  .runtimeDeliveryEvidence,
            ),
          ),
        ),
        contentType: "application/json",
      });
      await testInfo.attach("cross-provider-accessibility.txt", {
        body: Buffer.from(await page.locator("body").ariaSnapshot()),
        contentType: "text/plain",
      });
      for (const sessionId of launchedSessions) {
        const root = await invoke(page, "agent-runtime:session:read", { sessionId }).catch(
          () => null,
        );
        diagnostics.push({ sessionId, root });
        const overview = await invoke(page, "agent-runtime:session:overview", {
          sessionId,
        }).catch(() => null);
        const children = [
          ...(overview?.active.items ?? []),
          ...(overview?.terminal.items ?? []),
        ].filter((item) => item.childThreadId !== null);
        for (const child of children) {
          const conversation = await invoke(page, "agent-runtime:session:read", {
            sessionId,
            threadId: child.childThreadId!,
          }).catch(() => null);
          diagnostics.push({ sessionId, child, conversation });
        }
      }
    }
    await testInfo.attach("cross-provider-child-diagnostics.json", {
      body: Buffer.from(JSON.stringify(diagnostics)),
      contentType: "application/json",
    });
    throw error;
  } finally {
    await testInfo.attach("cross-provider-main.log", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 250_000)),
      contentType: "text/plain",
    });
    for (const filename of ["native.jsonl", "wire.jsonl", "process.log"])
      await testInfo.attach(`cross-provider-${filename}`, {
        body: fs.existsSync(path.join(fixture, filename))
          ? fs.readFileSync(path.join(fixture, filename))
          : Buffer.from(""),
        contentType: "text/plain",
      });
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
