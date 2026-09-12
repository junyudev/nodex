import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { CodexConnectionState } from "../../src/shared/types";
import type { ConversationFollowerTurnStart } from "../../src/shared/codex-thread-follower-request";
import type { IpcApi } from "../../src/shared/ipc-api";
import type { ConversationResumePreparationOptions } from "../../src/shared/codex-conversation-state/codex-resume-request";
import type {
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadTurnsListResponse,
  TurnStartParams,
} from "@nodex/codex-app-server-protocol/v2";
import { prepareCodexPrompt } from "../../src/shared/codex-prompt-preparation";
import { residentConversationTurns } from "../../src/shared/codex-conversation-state/codex-turn-mutation";
import { CodexPeerClient } from "../../src/main/platform/node/CodexPeerClient";
import { CodexPeerEndpointManager } from "../../src/main/platform/node/CodexPeerEndpoint";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft, invokeIpc, sendAgentPrompt } from "./support/agent-smoke-harness";

test("two live windows recover their resident conversation after the isolated native child exits", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "conversation-native-reconnect",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_RESUME_PARENT_CWD: "1",
      NODEX_FAKE_CODEX_INITIAL_PERMISSION_PROFILE: "reconnect-profile",
      NODEX_FAKE_CODEX_HOLD_CONFIG_PATH: ".fake-codex/hold-personality-config",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  type LogEntry = {
    method: string;
    params: {
      args?: string[];
      pid?: number;
      method?: string;
      cwd?: string;
      requestedCwd?: string;
      responseCwd?: string;
      params?: ThreadResumeParams;
      input?: Array<{ type: string; text?: string }>;
    };
  };
  const readLog = (): LogEntry[] => {
    const file = path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  };
  const connection = (page: Page) =>
    invokeIpc(page, "codex:connection:status", "local") as Promise<CodexConnectionState>;
  const prompts = () =>
    readLog()
      .filter((entry) => entry.method === "turn/start")
      .map((entry) => entry.params.input?.find((item) => item.type === "text")?.text);
  const resumeCount = () =>
    readLog().filter((entry) => entry.method === "rpc" && entry.params.method === "thread/resume")
      .length;
  const bubble = (page: Page, prompt: string) =>
    page.locator("[data-user-message-bubble='true']").filter({ hasText: prompt });
  const firstPrompt = "Preserve this history across the native reconnect";
  const secondPrompt = "Continue once through the recovered Main owner";
  const stalePrompt = "Never send this old prepared turn after reconnect";
  const pages: Page[] = [];
  const rendererErrors: string[] = [];
  const observePage = (page: Page) => {
    pages.push(page);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });
  };
  let failure: unknown;
  try {
    const first = await harness.launch();
    observePage(first);
    const draft = await createAgentSmokeDraft(
      first,
      harness.profile.initialProjectsDirectory,
      "Reconnect history",
    );
    const threadId = await sendAgentPrompt(first, draft.projectSessionId, firstPrompt);
    // The first Turn belongs to the window. Main need not have a resident replica yet.
    // Read native completion independently, then verify the owning window rendered it.
    const readNativeTail = () =>
      first.evaluate(async (id) => {
        const api = window.api;
        if (!api) throw new Error("Missing preload API");
        const read = async (request: IpcApi["codex:app-server:request"]["args"][0]["request"]) => {
          const outcome = (await api.invoke("codex:app-server:request", {
            hostId: "local",
            caller: { requestId: request.id, timeoutMs: 5000, expiresAtMs: null },
            request,
          })) as IpcApi["codex:app-server:request"]["result"];
          if (outcome.type !== "result") throw new Error(outcome.error.message);
          return outcome.result;
        };
        const [metadata, history] = await Promise.all([
          read({
            method: "thread/read",
            id: crypto.randomUUID(),
            params: { threadId: id, includeTurns: false },
          }),
          read({
            method: "thread/turns/list",
            id: crypto.randomUUID(),
            params: {
              threadId: id,
              limit: 5,
              sortDirection: "desc",
              itemsView: "full",
            },
          }),
        ]);
        const thread = (metadata as ThreadReadResponse).thread;
        const turns = (history as ThreadTurnsListResponse).data;
        return { threadId: thread.id, status: thread.status.type, turn: turns[0], turns };
      }, threadId);
    await expect.poll(readNativeTail).toMatchObject({
      threadId,
      status: "idle",
      turn: { status: "completed" },
    });
    // Thread linking precedes native submission. Read its directory only after native completion.
    const selectedCwd = readLog().find((entry) => entry.method === "turn/start")?.params.cwd;
    if (!selectedCwd || path.dirname(selectedCwd) === selectedCwd)
      throw new Error("The disposable conversation needs a working subdirectory");
    await expect(bubble(first, firstPrompt)).toHaveCount(1);
    await expect(
      first.getByText("The task completed successfully.", { exact: true }).last(),
    ).toBeVisible();
    await expect(first.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    const firstTurnObservation = {
      native: await readNativeTail(),
      mainSnapshot: await invokeIpc(first, "codex:thread:snapshot:request", threadId),
    };
    await test.info().attach("first-turn-observation.json", {
      body: JSON.stringify(firstTurnObservation, null, 2),
      contentType: "application/json",
    });
    const opened = harness.application.waitForEvent("window");
    expect(
      await invokeIpc(first, "window:new", {
        activeProjectSessionId: draft.projectSessionId,
        activeProjectId: draft.projectId,
      }),
    ).toBe(true);
    const second = await opened;
    observePage(second);
    await second.waitForURL((url) => url.protocol !== "about:");
    await second.waitForLoadState("domcontentloaded");
    await second.evaluate(() => window.api?.awaitInitialization?.());
    await expect(bubble(second, firstPrompt)).toHaveCount(1);
    const staleAdmission = (await invokeIpc(first, "codex:turn:native:prepare", {
      threadId,
      prompt: stalePrompt,
      clientUserMessageId: "prepared-before-reconnect",
      preparedPrompt: await prepareCodexPrompt(
        stalePrompt,
        { text: stalePrompt },
        {
          resolveImageInput: (source) => ({ type: "image", url: source }),
        },
      ),
    })) as ConversationFollowerTurnStart;
    const stalePrepared = (await invokeIpc(first, "codex:turn:native:inspect", staleAdmission)) as {
      request: TurnStartParams;
    };
    expect(stalePrepared.request.clientUserMessageId).toBe("prepared-before-reconnect");
    const heldConfigCwd = path.join(harness.profile.runRoot, "held-personality-workspace");
    fs.mkdirSync(heldConfigCwd);
    const holdConfigPath = path.join(
      harness.profile.runRoot,
      ".fake-codex/hold-personality-config",
    );
    fs.writeFileSync(holdConfigPath, heldConfigCwd);
    const heldPrompt = "Never dispatch a turn whose configuration read crossed reconnect";
    const heldClientId = "config-read-before-reconnect";
    const heldPreparedPrompt = await prepareCodexPrompt(
      heldPrompt,
      { text: heldPrompt },
      {
        resolveImageInput: (source) => ({ type: "image", url: source }),
      },
    );
    const heldAdmission = (await invokeIpc(first, "codex:turn:native:prepare", {
      threadId,
      prompt: heldPrompt,
      clientUserMessageId: heldClientId,
      preparedPrompt: heldPreparedPrompt,
      originalRequest: {
        threadId,
        clientUserMessageId: heldClientId,
        input: heldPreparedPrompt.inputItems,
        cwd: heldConfigCwd,
      },
      sourceContext: { inheritThreadSettings: false },
    } satisfies IpcApi["codex:turn:native:prepare"]["args"][0])) as ConversationFollowerTurnStart;
    const heldInspection = invokeIpc(first, "codex:turn:native:inspect", heldAdmission).then(
      (value) => ({ success: true, value }),
      (error: unknown) => ({ success: false, error: String(error) }),
    );
    await expect
      .poll(
        () =>
          readLog().filter(
            (entry) => entry.method === "config-read-held" && entry.params.cwd === heldConfigCwd,
          ).length,
      )
      .toBe(1);
    const before = await connection(first);
    expect(before.status).toBe("connected");
    expect(before.native?.transportKind).toBe("stdio");
    const oldGeneration = before.native!.generation;
    const previousResumes = resumeCount();
    const launch = readLog().findLast(
      (entry) => entry.method === "launch" && entry.params.args?.includes("app-server"),
    );
    const pid = launch?.params.pid;
    if (!pid || pid === process.pid)
      throw new Error("The disposable fixture did not identify its native child");
    // The PID comes only from this fresh Profile's fixture log, never from a user's running app.
    process.kill(pid, "SIGTERM");
    const heldConfigOutcome = await heldInspection;
    expect(heldConfigOutcome.success).toBe(false);
    fs.unlinkSync(holdConfigPath);
    await invokeIpc(first, "codex:turn:native:release", heldClientId);
    await expect
      .poll(
        async () => {
          const state = await connection(second);
          return state.status === "connected" && (state.native?.generation ?? 0) > oldGeneration;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const after = await connection(second);
    expect(prompts()).not.toContain(heldPrompt);
    expect(after.native?.sourceEpoch).toBe(before.native?.sourceEpoch);
    expect(after.native?.transportKind).toBe("stdio");
    for (const page of [first, second]) await expect(bubble(page, firstPrompt)).toHaveCount(1);
    await expect.poll(resumeCount, { timeout: 30_000 }).toBeGreaterThan(previousResumes);
    await expect
      .poll(async () => {
        const snapshot = (await invokeIpc(
          second,
          "codex:thread:snapshot:request",
          threadId,
        )) as IpcApi["codex:thread:snapshot:request"]["result"];
        return snapshot?.canonicalState?.currentPermissions?.activePermissionProfile?.id;
      })
      .toBe("reconnect-profile");
    expect(
      readLog().some(
        (entry) =>
          entry.method === "rpc" &&
          entry.params.method === "thread/resume" &&
          entry.params.params?.permissions === "reconnect-profile",
      ),
    ).toBe(true);
    expect(readLog().filter((entry) => entry.method === "resume-permissions")).not.toHaveLength(0);
    const staleOutcome = await invokeIpc(first, "codex:turn:native:execute", {
      hostId: "local",
      request: stalePrepared.request,
      caller: {
        requestId: "stale-after-reconnect",
        timeoutMs: 1_000,
        expiresAtMs: null,
        retainResponse: false,
      },
    } satisfies IpcApi["codex:turn:native:execute"]["args"][0]);
    expect(staleOutcome).toMatchObject({
      type: "error",
      error: { message: expect.stringContaining("Native turn does not match its prepared phase") },
    });
    const started = (await invokeIpc(
      second,
      "codex:turn:start",
      threadId,
      secondPrompt,
    )) as IpcApi["codex:turn:start"]["result"];
    if (!started) throw new Error("Main did not start the reconnect Turn");
    expect(started.turnId).toEqual(expect.any(String));
    await expect.poll(readNativeTail).toMatchObject({
      threadId,
      status: "idle",
      turn: { id: started.turnId, status: "completed" },
    });
    for (const page of [first, second]) {
      await expect(bubble(page, firstPrompt)).toHaveCount(1);
      await expect(bubble(page, secondPrompt)).toHaveCount(1);
      await expect(page.getByText("The task completed successfully.", { exact: true })).toHaveCount(
        2,
      );
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    }
    expect(prompts()).toEqual([firstPrompt, secondPrompt]);
    const native = await readNativeTail();
    expect(native.turns).toHaveLength(2);
    expect(new Set(native.turns.map((turn) => turn.id)).size).toBe(2);
    const mainSnapshot = (await invokeIpc(
      second,
      "codex:thread:snapshot:request",
      threadId,
    )) as IpcApi["codex:thread:snapshot:request"]["result"];
    const durable = (await invokeIpc(
      second,
      "codex:thread:history-hydration:prepare",
      threadId,
    )) as IpcApi["codex:thread:history-hydration:prepare"]["result"];
    const resumeContexts = readLog().filter((entry) => entry.method === "resume-context");
    expect(resumeContexts.length).toBeGreaterThan(0);
    for (const entry of resumeContexts) {
      expect(entry.params.requestedCwd).toBe(selectedCwd);
      expect(entry.params.responseCwd).toBe(path.dirname(selectedCwd));
    }
    expect(
      readLog()
        .filter((entry) => entry.method === "turn/start")
        .map((entry) => entry.params.cwd),
    ).toEqual([selectedCwd, selectedCwd]);
    expect(mainSnapshot?.cwd).toBe(selectedCwd);
    expect(mainSnapshot?.canonicalState?.cwd).toBe(selectedCwd);
    expect(durable.context.cwd).toBe(selectedCwd);
    expect(durable.summary.cwd).toBe(selectedCwd);
    const selectedPermissions: NonNullable<ConversationResumePreparationOptions["permissions"]> = {
      activePermissionProfile: { id: "selected-profile", extends: null },
      runtimeWorkspaceRoots: [selectedCwd],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
    const resumeOptions: ConversationResumePreparationOptions[] = [
      { serviceTier: null },
      { serviceTier: "priority" },
      { serviceTier: "priority", permissions: selectedPermissions },
      {
        serviceTier: "priority",
        permissions: selectedPermissions,
        useAppServerPermissionDefault: true,
      },
    ];
    const optionPreparations = [];
    for (const options of resumeOptions) {
      const prepared = await second.evaluate(
        async ({ id, cwd, options }) => {
          const api = window.api;
          if (!api) throw new Error("Missing preload API");
          const preparation = (await api.invoke(
            "codex:thread:resume:prepare",
            id,
            null,
            { cwd },
            options,
          )) as IpcApi["codex:thread:resume:prepare"]["result"];
          try {
            const requestId = (await api.invoke(
              "codex:thread:resume:retry",
              preparation.receiptId,
            )) as IpcApi["codex:thread:resume:retry"]["result"];
            const outcome = (await api.invoke("codex:app-server:request", {
              hostId: preparation.hostId,
              caller: { requestId, timeoutMs: 5000, expiresAtMs: null },
              request: { method: "thread/resume", id: requestId, params: preparation.params },
            })) as IpcApi["codex:app-server:request"]["result"];
            if (outcome.type !== "result") throw new Error(outcome.error.message);
            const accepted = (await api.invoke(
              "codex:thread:resume:accept",
              preparation.receiptId,
            )) as IpcApi["codex:thread:resume:accept"]["result"];
            return {
              params: preparation.params,
              originalId: preparation.nativeRequestId,
              requestId,
              acceptedThreadId: accepted.threadId,
            };
          } finally {
            await api.invoke("codex:thread:resume:release", preparation.receiptId);
          }
        },
        { id: threadId, cwd: selectedCwd, options },
      );
      expect(prepared.params.serviceTier).toBe(options.serviceTier);
      expect(Object.hasOwn(prepared.params, "serviceTier")).toBe(true);
      if (options.permissions && !options.useAppServerPermissionDefault) {
        expect(prepared.params).toMatchObject({
          permissions: "selected-profile",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          runtimeWorkspaceRoots: [selectedCwd],
        });
        expect(prepared.params).not.toHaveProperty("sandbox");
      }
      if (options.useAppServerPermissionDefault) {
        for (const key of [
          "permissions",
          "approvalPolicy",
          "approvalsReviewer",
          "runtimeWorkspaceRoots",
          "sandbox",
        ])
          expect(prepared.params).not.toHaveProperty(key);
      }
      expect(prepared.requestId).not.toBe(prepared.originalId);
      expect(prepared.acceptedThreadId).toBe(threadId);
      optionPreparations.push(prepared);
    }
    expect(
      readLog()
        .filter((entry) => entry.method === "rpc" && entry.params.method === "thread/resume")
        .slice(-resumeOptions.length)
        .map((entry) => entry.params.params),
    ).toEqual(JSON.parse(JSON.stringify(optionPreparations.map((prepared) => prepared.params))));
    const peerErrors: unknown[] = [];
    const endpoint = new CodexPeerEndpointManager(harness.profile.nodexHome, (error) =>
      peerErrors.push(error),
    );
    const peer = new CodexPeerClient(
      () => endpoint.getOrStartRouterEndpoint(),
      (error) => peerErrors.push(error),
    );
    const permissionPreparations = [];
    const readOwnerExecutionState = async () => {
      const snapshot = (await invokeIpc(
        second,
        "codex:thread:snapshot:request",
        threadId,
      )) as IpcApi["codex:thread:snapshot:request"]["result"];
      const state = snapshot?.canonicalState;
      if (!state) throw new Error("Owner execution state is unavailable");
      return {
        latestModel: state.latestModel,
        latestReasoningEffort: state.latestReasoningEffort,
        latestCollaborationMode: state.latestCollaborationMode,
        latestThreadSettings: state.latestThreadSettings,
        permissions: state.currentPermissions,
      };
    };
    const permissionCases: Array<{
      name: string;
      fields: Partial<TurnStartParams>;
      context: ConversationFollowerTurnStart["context"];
      expected: Partial<TurnStartParams>;
      settings: Partial<
        Pick<TurnStartParams, "personality" | "summary" | "effort" | "collaborationMode">
      >;
    }> = [
      {
        name: "server-default",
        settings: { personality: null, summary: null, effort: null },
        fields: { approvalPolicy: "never", permissions: "ignored-profile", serviceTier: null },
        context: { useAppServerPermissionDefault: true },
        expected: {
          approvalPolicy: null,
          approvalsReviewer: null,
          permissions: null,
          sandboxPolicy: null,
          serviceTier: null,
        },
      },
      {
        name: "named-profile",
        settings: { personality: "pragmatic", summary: "auto" },
        fields: { permissions: "peer-selected-profile", serviceTier: "priority" },
        context: { useAppServerPermissionDefault: false },
        expected: {
          permissions: "peer-selected-profile",
          sandboxPolicy: null,
          serviceTier: "priority",
        },
      },
      {
        name: "explicit-sandbox",
        settings: { personality: "none", summary: "none" },
        fields: { sandboxPolicy: { type: "readOnly", networkAccess: false }, serviceTier: null },
        context: { useAppServerPermissionDefault: false },
        expected: {
          permissions: null,
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          serviceTier: null,
        },
      },
      {
        name: "full-collaboration",
        fields: { permissions: null, serviceTier: null },
        context: { useAppServerPermissionDefault: false },
        settings: {
          personality: null,
          summary: null,
          effort: null,
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "scenario-planner",
              reasoning_effort: "high",
              developer_instructions: "Keep these peer-selected planning instructions",
            },
          },
        },
        expected: { permissions: null, serviceTier: null, model: null },
      },
    ];
    try {
      await peer.waitUntilInitialized({ timeoutMs: 10_000 });
      for (const entry of permissionCases) {
        const ownerStateBefore = await readOwnerExecutionState();
        const prompt = `Retain ${entry.name} permission intent through the recovered peer owner`;
        const clientUserMessageId = `peer-permission-${entry.name}`;
        const preparedPrompt = await prepareCodexPrompt(
          prompt,
          { text: prompt },
          {
            resolveImageInput: (source) => ({ type: "image", url: source }),
          },
        );
        const admission = (await invokeIpc(second, "codex:turn:native:prepare", {
          threadId,
          prompt,
          clientUserMessageId,
          preparedPrompt,
          originalRequest: {
            threadId,
            clientUserMessageId,
            input: preparedPrompt.inputItems,
            cwd: selectedCwd,
            ...entry.fields,
            ...entry.settings,
          },
          sourceContext: entry.context,
        } satisfies IpcApi["codex:turn:native:prepare"]["args"][0])) as ConversationFollowerTurnStart;
        try {
          expect(admission.context).toEqual(entry.context);
          const response = await peer.sendRequest(
            "thread-follower-start-turn",
            {
              conversationId: threadId,
              turnStart: admission,
            },
            { hostId: "local", timeoutMs: 30_000 },
          );
          expect(response.resultType, JSON.stringify(response)).toBe("success");
          const accepted = readLog()
            .filter((record) => record.method === "turn/start")
            .find(
              (record) =>
                (record.params as TurnStartParams).clientUserMessageId === clientUserMessageId,
            );
          expect(accepted?.params).toMatchObject({
            ...entry.expected,
            ...entry.settings,
            multiAgentMode: "explicitRequestOnly",
          });
          await expect
            .poll(readNativeTail)
            .toMatchObject({ threadId, status: "idle", turn: { status: "completed" } });
          for (const page of [first, second]) await expect(bubble(page, prompt)).toHaveCount(1);
          const readRetained = async () => {
            const snapshot = (await invokeIpc(
              second,
              "codex:thread:snapshot:request",
              threadId,
            )) as IpcApi["codex:thread:snapshot:request"]["result"];
            return residentConversationTurns(snapshot?.canonicalState).find(
              (turn) => turn.params.clientUserMessageId === clientUserMessageId,
            )?.params;
          };
          await expect.poll(readRetained).toMatchObject({
            useAppServerPermissionDefault: entry.context?.useAppServerPermissionDefault,
            serviceTier: entry.fields.serviceTier,
            permissions: entry.expected.permissions,
            ...entry.settings,
            multiAgentMode: "explicitRequestOnly",
          });
          if (entry.name === "full-collaboration") {
            await expect.poll(readOwnerExecutionState).toMatchObject({
              latestModel: ownerStateBefore.latestModel,
              latestReasoningEffort: null,
              latestCollaborationMode: entry.settings.collaborationMode,
              latestThreadSettings: ownerStateBefore.latestThreadSettings,
            });
          }
          permissionPreparations.push({
            admission,
            response,
            nativeRequest: accepted?.params,
            retainedParams: await readRetained(),
            ownerStateBefore,
            ownerStateAfter: await readOwnerExecutionState(),
          });
        } finally {
          await invokeIpc(second, "codex:turn:native:release", clientUserMessageId);
        }
      }
      expect(peerErrors).toEqual([]);
    } finally {
      peer.dispose();
      await endpoint.dispose();
    }
    await test.info().attach("reconnect-evidence.json", {
      body: JSON.stringify(
        {
          before,
          after,
          pid,
          staleOutcome,
          heldConfigOutcome,
          native,
          mainSnapshot,
          durable,
          selectedCwd,
          resumeContexts,
          optionPreparations,
          permissionPreparations,
          prompts: prompts(),
          requests: readLog(),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } catch (error) {
    failure = error;
    await test.info().attach("reconnect-renderer-diagnostics.json", {
      body: JSON.stringify(
        {
          rendererErrors,
          windows: await Promise.all(
            pages.map(async (page) => ({
              alerts: await page
                .getByRole("alert")
                .allTextContents()
                .catch(() => []),
              connection: await connection(page).catch(() => null),
            })),
          ),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    await test.info().attach("reconnect-runtime.log", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    await test.info().attach("reconnect-requests.json", {
      body: JSON.stringify(readLog(), null, 2),
      contentType: "application/json",
    });
    throw error;
  } finally {
    try {
      await harness.close();
    } catch (error) {
      if (!failure) throw error;
      // oxlint-disable-next-line eslint/preserve-caught-error -- Preserve the workflow and cleanup failures.
      throw new AggregateError([failure, error], "Reconnect workflow and cleanup failed", {
        cause: error,
      });
    }
  }
});
