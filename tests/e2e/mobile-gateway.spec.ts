import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  CHANNEL_CLOSE,
  createUuidV7 as phoneUuidV7,
  type ChatRequest,
} from "@nodex/mobile-protocol";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import type { ScriptedAcpScenario } from "../../scripts/scenarios/runtime/scripted-acp-agent";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { invokeIpc } from "./support/editor-scenario";
import { MobilePhone, PhoneConnectionClosed, type PhoneChannel } from "./support/mobile-phone";
import { openWorkbenchSettings } from "./support/workbench-settings";

const REPLY = "The phone reached the desktop Agent.";
const instanceId = "mobile-gateway-test";
const agentDefinitionId = "scripted-agent";
const createUuidV7 = (now = Date.now()) =>
  phoneUuidV7((length) => new Uint8Array(randomBytes(length)), now);

async function openMobileSettings(page: Page) {
  await openWorkbenchSettings(page);
  await page.getByRole("link", { name: "Mobile", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Allow phones to connect" })).toBeVisible();
}

async function answerApproval(phone: PhoneChannel, sessionId: string) {
  await expect
    .poll(() => phone.chat(sessionId).state, { timeout: 10_000 })
    .toMatchObject({
      status: "waiting",
      requests: [expect.objectContaining({ kind: "approval" })],
    });
  // Read the real Runtime-backed snapshot too: event-only coverage misses snapshot projection bugs.
  const snapshot = await phone.openChat(sessionId);
  expect(snapshot.state.status).toBe("waiting");
  expect(snapshot.state.requests).toHaveLength(1);
  const request = snapshot.state.requests[0]!;
  expect(request.kind).toBe("approval");
  expect(request.runId).toBeTruthy();
  if (request.kind !== "approval") throw new Error("The Agent did not request approval");
  const option = request.options.find((option) => option.label === "Approve");
  expect(option).toBeDefined();
  await phone.request("chat.respond", {
    sessionId,
    requestId: request.requestId,
    runId: request.runId,
    submissionId: createUuidV7(),
    response: { kind: "option", optionId: option!.id, feedback: null },
  });
  return request;
}

async function waitForIdle(phone: PhoneChannel, sessionId: string, replies: number) {
  await expect
    .poll(
      () => {
        const { state, items } = phone.chat(sessionId);
        return {
          status: state.status,
          activeRunId: state.activeRunId,
          requests: state.requests,
          queuedCount: state.queuedCount,
          replies: items.filter(
            (item) => item.kind === "assistant" && item.text === REPLY && !item.streaming,
          ).length,
        };
      },
      { timeout: 20_000 },
    )
    .toEqual({
      status: "idle",
      activeRunId: null,
      requests: [],
      queuedCount: 0,
      replies,
    });
}

/** The row's full wording belongs to its presentation; this spec cares that the phone is connected. */
const CONNECTED_PHONE = /^iOS · Nodex Mobile e2e · .*Connected$/u;

test("a paired phone captures once, follows Agent Runs, answers approvals and loses access when removed", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const harness = await ElectronScenarioHarness.create({
    label: "mobile-gateway",
    prepareAgentRuntime: false,
    environment: {
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_EXEC_DIR: ".fake-codex/exec",
      NODEX_FAKE_CODEX_APP_SERVER_PATH: path.resolve(
        "tests/e2e/fixtures/codex-queue-app-server.mjs",
      ),
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    },
  });
  let phone: PhoneChannel | undefined;
  let desktop: Page | undefined;
  let completed = false;
  try {
    prepareScenarioCodexAppServerRuntimeSync(
      harness.profile.runRoot,
      path.resolve("tests/e2e/fixtures/codex-exec-app-server.mjs"),
    );
    const page = await harness.launch();
    desktop = page;
    const observationPath = path.join(harness.profile.runRoot, "acp-observations.json");
    const scenario: ScriptedAcpScenario = {
      sessionId: "mobile-gateway-agent",
      sessionLifecycle: { load: true },
      sessionConfig: {
        id: "model",
        category: "model",
        currentValue: "default",
        values: ["default"],
      },
      beforePrompt: [REPLY],
      requestPermission: true,
      completeAfterPermission: true,
      recordPromptText: true,
    };
    // Configure external credential-free peers only. Every operation below uses the actual UI or wire.
    await invokeIpc(page, "settings:acp-agents:update", {
      instances: [
        {
          id: instanceId,
          agentDefinitionId,
          displayName: "Phone test Agent",
          source: {
            kind: "local",
            executable: process.execPath,
            args: [path.resolve("scripts/scenarios/runtime/scripted-acp-agent.ts")],
          },
          environment: [
            {
              name: "NODEX_SCRIPTED_ACP_SCENARIO",
              sensitive: false,
              value: JSON.stringify(scenario),
            },
            { name: "NODEX_SCRIPTED_ACP_OBSERVATION", sensitive: false, value: observationPath },
          ],
          customModels: [],
          enabled: true,
          credentials: {
            kind: "isolated-home",
            home: path.join(harness.profile.runRoot, "acp-home"),
          },
          proxy: "isolated",
        },
      ],
    });
    // Model discovery follows an explicit connection, just as when an Agent is added in Settings.
    const operationId = createUuidV7();
    const connection = await invokeIpc(page, "acp:connection:start", { instanceId, operationId });
    if (!connection.ok) throw new Error(connection.error.message);
    await expect
      .poll(async () => {
        const operation = await invokeIpc(page, "acp:operation:read", { operationId });
        if (!operation.ok) throw new Error(operation.error.message);
        if (operation.value.phase === "failed") throw new Error(operation.value.error?.message);
        return operation.value.phase;
      })
      .toBe("succeeded");
    await invokeIpc(page, "settings:inbox:update", { suggestions: "on_request" });
    // Full access grants the fixture's permission automatically; this scenario needs a human ask.
    await invokeIpc(page, "settings:agent-runtime:update", {
      defaultRuntimeMode: "approval-required",
    });

    const identity = await test.step("pair using Settings and its copied link", async () => {
      await openMobileSettings(page);
      const enabled = page.getByRole("switch", { name: "Allow phones to connect" });
      await expect(enabled).not.toBeChecked();
      await enabled.click();
      await expect(enabled).toBeChecked();
      await page.getByRole("button", { name: "Pair a phone", exact: true }).click();
      await expect(page.getByRole("img", { name: "Pairing code" })).toBeVisible();
      await page.getByRole("button", { name: "Copy link", exact: true }).click();
      await expect(page.getByText("Pairing link copied", { exact: true })).toBeVisible();
      const link = await harness.application.evaluate(({ clipboard }) => clipboard.readText());
      const identity = MobilePhone.fromCopiedLink(link);
      phone = await identity.connect(true);
      expect((await phone.hello).deviceId).toBeTruthy();
      await expect(page.getByText("Gateway test phone", { exact: true })).toBeVisible();
      await expect(page.getByText(CONNECTED_PHONE)).toBeVisible();
      await expect(page.getByRole("img", { name: "Pairing code" })).toHaveCount(0);
      // Prove the saved static key reconnects without the one-time pairing secret.
      await phone.close();
      phone = await identity.connect();
      await expect(page.getByText(CONNECTED_PHONE)).toBeVisible();
      return identity;
    });
    const connected = phone!;

    await test.step("deliver a capture once and accept its real suggestion", async () => {
      await page.getByRole("button", { name: "Back to app", exact: true }).click();
      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      const inbox = page.locator('[data-inbox-scope="library"]');
      await expect(inbox).toBeVisible();
      const issuedAt = Date.now();
      const capture = {
        operationId: createUuidV7(issuedAt),
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        issuedAt,
        scope: { kind: "library" as const },
        text: "Remember the phone gateway checklist.",
        fileRefs: [],
      };
      expect(await connected.request("inbox.capture", capture)).toEqual({ pageId: capture.pageId });
      const row = inbox.getByTestId("inbox-message").filter({ hasText: capture.text });
      await expect(row).toBeVisible();
      expect(await connected.request("inbox.capture", capture)).toEqual({ pageId: capture.pageId });
      const window = await connected.request("inbox.window", {
        scope: capture.scope,
        filter: "inbox",
      });
      expect(
        window.items.filter((item) => item.body === capture.text).map((item) => item.pageId),
      ).toEqual([capture.pageId]);
      await expect(inbox.getByTestId("inbox-message")).toHaveCount(1);
      await connected.request("inbox.decide", {
        operationId: createUuidV7(),
        pageId: capture.pageId,
        decision: { type: "request_suggestion" },
      });
      const directory = path.join(harness.profile.runRoot, ".fake-codex/exec");
      const logPath = path.join(directory, "generations.jsonl");
      const generations = (): { requestId: string; bodies: string[] }[] =>
        existsSync(logPath)
          ? readFileSync(logPath, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      await expect.poll(() => generations().length, { timeout: 30_000 }).toBe(1);
      const generation = generations()[0]!;
      expect(generation.bodies).toEqual([capture.text]);
      writeFileSync(path.join(directory, `${generation.requestId}.answer`), "");
      await expect
        .poll(
          async () =>
            (await connected.request("inbox.message", { pageId: capture.pageId })).proposal?.state,
        )
        .toBe("open");
      const { proposal } = await connected.request("inbox.message", { pageId: capture.pageId });
      if (!proposal) throw new Error("The utility Agent produced no suggestion");
      expect(proposal.action.type).toBe("keep");
      await connected.request("inbox.decide", {
        operationId: createUuidV7(),
        pageId: capture.pageId,
        decision: { type: "accept", proposalId: proposal.proposalId, revision: proposal.revision },
      });
      expect(await connected.request("inbox.message", { pageId: capture.pageId })).toMatchObject({
        state: "kept",
        outcome: "kept",
      });
      await expect(row).toHaveCount(0);
    });

    await test.step("start a chat and follow patches through approval and a follow-up", async () => {
      const providerInstanceId = agentRuntimeProviderId({
        kind: "acp",
        instanceConfigId: instanceId,
        agentDefinitionId,
      })!;
      const catalog = await connected.request("agents.catalog", {});
      const provider = catalog.providers.find(
        (provider) => provider.instanceId === providerInstanceId,
      );
      expect(provider?.unavailableReason).toBeNull();
      const model = provider?.models[0];
      if (!model) throw new Error("The scripted Agent advertised no model");
      const sessionId = createUuidV7();
      const prompt = "Check the phone connection.";
      expect(
        await connected.request("chats.start", {
          sessionId,
          launchId: createUuidV7(),
          messageId: createUuidV7(),
          projectId: null,
          text: prompt,
          fileRefs: [],
          agent: { providerInstanceId, model: model.id },
          location: "local",
        }),
      ).toEqual({ sessionId });
      await connected.openChat(sessionId);
      const first = await answerApproval(connected, sessionId);
      await waitForIdle(connected, sessionId, 1);
      const firstPatchCount = connected.patchCount(sessionId);
      expect(firstPatchCount).toBeGreaterThan(0);
      expect(connected.chat(sessionId).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "user", text: prompt, queued: false }),
        ]),
      );
      const followUp = "Confirm the follow-up arrived.";
      await connected.request("chat.send", {
        sessionId,
        messageId: createUuidV7(),
        text: followUp,
        fileRefs: [],
        delivery: "queue",
      });
      const second: ChatRequest = await answerApproval(connected, sessionId);
      expect(second.runId).not.toBe(first.runId);
      await waitForIdle(connected, sessionId, 2);
      expect(connected.patchCount(sessionId)).toBeGreaterThan(firstPatchCount);
      expect(connected.chat(sessionId).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "user", text: followUp, queued: false }),
        ]),
      );
      const observations = JSON.parse(readFileSync(observationPath, "utf8")) as {
        method: string;
        outcome?: string;
      }[];
      expect(
        observations
          .filter((entry) => entry.method === "session/request_permission")
          .map((entry) => entry.outcome),
      ).toEqual(["selected", "selected"]);
      // The phone asks which of its notified chats are still unread, as the chat list shows them.
      const markUnread = (unread: boolean) =>
        invokeIpc(page, "project-sessions:mark-unread", {
          operationId: createBoundedOperationId("e2e.mobile.session.unread"),
          payload: { sessionId, unread },
        });
      await markUnread(true);
      expect(
        await connected.request("chats.unread", { sessionIds: [sessionId, createUuidV7()] }),
      ).toEqual({ sessionIds: [sessionId] });
      await markUnread(false);
      expect(await connected.request("chats.unread", { sessionIds: [sessionId] })).toEqual({
        sessionIds: [],
      });
    });

    await test.step("remove the phone through Settings and refuse its saved key", async () => {
      await openMobileSettings(page);
      await expect(page.getByText("Gateway test phone", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      expect(await connected.waitForClose()).toBe(CHANNEL_CLOSE.revoked);
      await expect(page.getByText("Gateway test phone", { exact: true })).toHaveCount(0);
      await expect(identity.connect()).rejects.toEqual(
        new PhoneConnectionClosed(CHANNEL_CLOSE.unknownDevice),
      );
    });
    completed = true;
  } finally {
    if (!completed) {
      if (phone) {
        await testInfo
          .attach("mobile-gateway-chat.json", {
            body: Buffer.from(JSON.stringify(phone.diagnostics(), null, 2)),
            contentType: "application/json",
          })
          .catch(() => undefined);
      }
      await testInfo.attach("mobile-gateway-runtime.log", {
        body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 250_000)),
        contentType: "text/plain",
      });
      const screenshot = await desktop?.screenshot().catch(() => null);
      if (screenshot)
        await testInfo.attach("mobile-gateway-desktop", {
          body: screenshot,
          contentType: "image/png",
        });
    }
    await phone?.close();
    await harness.close();
  }
});
