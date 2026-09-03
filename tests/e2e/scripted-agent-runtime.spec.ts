import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import {
  responses,
  type ScriptedModelRequest,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  collectRecords,
  createAgentSmokeDraft,
  invokeIpc,
  isRecord,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForAgentThreadExecutionProfile,
  waitForCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";
import { startBrowserHttpFixture } from "./support/browser-http-fixture";

const repositoryRoot = process.cwd();

const assertRequestModel = (request: ScriptedModelRequest, expectedModel: string): void => {
  if (request.body.model === expectedModel) return;
  throw new Error(
    `Scripted Agent request selected ${String(request.body.model)}; expected ${expectedModel}`,
  );
};

const scriptedCodexConfig = (baseUrl: string): string => `
model_provider = "openai"
openai_base_url = ${JSON.stringify(`${baseUrl}/v1`)}
request_max_retries = 0
stream_max_retries = 0

[features]
respect_system_proxy = false
`;

const scriptedCollaborationCodexConfig = (baseUrl: string): string => `
${scriptedCodexConfig(baseUrl)}
code_mode = false
code_mode_only = false
multi_agent = true

[features.multi_agent_v2]
enabled = true
max_concurrent_threads_per_session = 4
min_wait_timeout_ms = 10000
default_wait_timeout_ms = 30000
max_wait_timeout_ms = 3600000
tool_namespace = "collaboration"
hide_spawn_agent_metadata = false
expose_spawn_agent_model_overrides = true
wait_agent_enabled = true
non_code_mode_only = true

[agents]
enabled = true
`;

for (const { rendererCpuRate, unversioned } of [
  { rendererCpuRate: 1, unversioned: false },
  { rendererCpuRate: 12, unversioned: false },
  { rendererCpuRate: 1, unversioned: true },
]) {
  test(`restores a durable Thread after quitting Electron and continues the same conversation (CPU ×${rendererCpuRate}${unversioned ? ", unversioned host" : ""})`, async ({}, testInfo) => {
    test.setTimeout(150_000);
    const token = randomUUID();
    const firstPrompt = `Remember the restart marker ${token}`;
    const firstReply = `Saved restart marker ${token}`;
    const nextPrompt = `Continue the restored conversation ${token}`;
    const nextReply = `Restored conversation continued ${token}`;

    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "first durable turn",
            match: (request) => request.hasInputText(firstPrompt),
            respond: responses.stream([
              responses.created(`response_before_${token}`),
              responses.assistantMessage(`message_before_${token}`, firstReply, "final_answer"),
              responses.completed(`response_before_${token}`, true),
            ]),
          },
          {
            name: "follow-up retains the conversation across process restart",
            match: (request) => request.hasInputText(nextPrompt),
            respond: (request) => {
              expect(request.hasInputText(firstPrompt)).toBe(true);
              expect(request.hasInputText(firstReply)).toBe(true);
              return responses.stream([
                responses.created(`response_after_${token}`),
                responses.assistantMessage(`message_after_${token}`, nextReply, "final_answer"),
                responses.completed(`response_after_${token}`, true),
              ]);
            },
          },
        ],
      },
      async (modelServer) => {
        const harness = await ElectronScenarioHarness.create({
          label: `scripted-thread-restart-${rendererCpuRate}`,
          ...(unversioned ? {} : { cwd: repositoryRoot }),
          prepareAgentRuntime: false,
          environment: {
            ...modelServer.loopbackEnvironment(),
            NODEX_LOG_CONSOLE: "0",
            NODEX_LOG_FILE: "1",
            NODEX_LOG_FILE_LEVEL: "debug",
            OPENAI_API_KEY: "nodex-scripted-model-test-key",
            ...(unversioned
              ? {
                  NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
                  NODEX_TEST_NATIVE_CODEX_EXECUTABLE: path.join(
                    repositoryRoot,
                    ".generated/codex-runtime/agent-runtime/bin/codex-app-server",
                  ),
                }
              : {}),
          },
        });
        if (unversioned) {
          prepareScenarioCodexAppServerRuntimeSync(
            harness.profile.runRoot,
            path.join(repositoryRoot, "tests/e2e/fixtures/codex-unversioned-proxy.mjs"),
          );
        }
        fs.writeFileSync(
          path.join(harness.profile.codexHome, "config.toml"),
          scriptedCodexConfig(modelServer.baseUrl),
          { encoding: "utf8", mode: 0o600 },
        );
        try {
          const page = await harness.launch();
          await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
          const draft = await createAgentSmokeDraft(
            page,
            harness.profile.initialProjectsDirectory,
            "Thread restart",
          );
          const threadId = await sendAgentPrompt(page, draft.projectSessionId, firstPrompt);
          await waitForCompletedAgentTurn(page, threadId);
          await waitForFinalMarker(page, firstReply);
          if (rendererCpuRate > 1) {
            await page.getByRole("button", { name: "New chat", exact: true }).first().click();
            await expect(page.locator("[data-new-thread-home-main='true']")).toBeVisible();
          }

          const previousPid = harness.application.process().pid;
          const reopened = await harness.restart();
          expect(harness.application.process().pid).not.toBe(previousPid);
          if (rendererCpuRate > 1) {
            await expect(reopened.locator("[data-new-thread-home-main='true']")).toBeVisible();
            const cdp = await reopened.context().newCDPSession(reopened);
            try {
              // Cold renderer scheduling must not turn successful history hydration into failure.
              await cdp.send("Emulation.setCPUThrottlingRate", { rate: rendererCpuRate });
              await reopened.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
              await expect(reopened.getByText(firstReply, { exact: true }).last()).toBeVisible({
                timeout: 30_000,
              });
            } finally {
              await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
              await cdp.detach();
            }
          }
          await expect(reopened.getByText(firstReply, { exact: true }).last()).toBeVisible({
            timeout: 30_000,
          });
          await expect(
            reopened.getByText("Thread could not be restored", { exact: true }),
          ).toHaveCount(0);
          const composer = reopened.locator("[data-codex-composer='true']").first();
          await expect(composer).toBeEditable();
          await composer.fill(nextPrompt);
          await composer.press("Enter");
          await waitForFinalMarker(reopened, nextReply, 30_000);
          const session = await invokeIpc(reopened, "project-sessions:get", draft.projectSessionId);
          expect(session).toMatchObject({ thread: { threadId } });
          const snapshot = await waitForCompletedAgentTurn(reopened, threadId);
          expect(isRecord(snapshot) ? snapshot.turns : null).toHaveLength(2);
        } finally {
          try {
            const screenshotPath = testInfo.outputPath("thread-restart.png");
            await harness.page.screenshot({ path: screenshotPath });
            await testInfo.attach("thread-restart.png", {
              path: screenshotPath,
              contentType: "image/png",
            });
            await testInfo.attach("thread-restart-runtime.log", {
              body: await readBoundedElectronRuntimeLogs(harness.profile, 256_000),
              contentType: "text/plain",
            });
          } finally {
            await harness.close();
          }
        }
      },
    );
  });
}

test("runs a real shell tool through the scripted model boundary", async () => {
  test.setTimeout(120_000);
  const token = randomUUID();
  const promptMarker = `SCRIPTED_FILE_PROMPT_${token}`;
  const finalMarker = `SCRIPTED_FILE_OK_${token}`;
  const fileContents = `NODEX_SCRIPTED_FILE_${token}\n`;
  const filePath = path.join("/tmp", `nodex-scripted-file-${token}.txt`);
  const callId = `call_file_${token.replaceAll("-", "")}`;

  try {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "model requests the exact file write",
            match: (request) => request.hasInputText(promptMarker),
            respond: (request) => {
              assertRequestModel(request, "gpt-5.5");
              const command = `printf %b ${JSON.stringify(fileContents)} > ${JSON.stringify(filePath)} && od -An -t x1 ${JSON.stringify(filePath)}`;
              if (request.namedTool("exec_command")) {
                return responses.stream([
                  responses.created(`response_file_tool_${token}`),
                  responses.functionCall(callId, "exec_command", {
                    cmd: command,
                    yield_time_ms: 10_000,
                  }),
                  responses.completed(`response_file_tool_${token}`),
                ]);
              }

              const invocation = request.toolInvocation("functions", "exec");
              if (!invocation) {
                throw new Error(
                  `Real app-server request did not advertise a shell-capable tool:\n${request.diagnosticSummary()}`,
                );
              }
              const code = `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)}, yield_time_ms: 10000 });\ntext(result.output);`;
              return responses.stream([
                responses.created(`response_file_tool_${token}`),
                responses.customToolCall(callId, invocation.name, code, invocation.namespace),
                responses.completed(`response_file_tool_${token}`),
              ]);
            },
          },
          {
            name: "model finishes after the real shell output",
            match: (request) => request.hasToolCallOutput(callId),
            respond: responses.stream([
              responses.created(`response_file_final_${token}`),
              responses.assistantMessage(`message_file_${token}`, finalMarker, "final_answer"),
              responses.completed(`response_file_final_${token}`, true),
            ]),
          },
        ],
      },
      async (modelServer) => {
        const harness = await ElectronScenarioHarness.create({
          label: "scripted-agent-file",
          cwd: repositoryRoot,
          prepareAgentRuntime: false,
          retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
          environment: {
            ...modelServer.loopbackEnvironment(),
            NODEX_LOG_CONSOLE: "0",
            NODEX_LOG_FILE: "1",
            OPENAI_API_KEY: "nodex-scripted-model-test-key",
          },
        });
        fs.writeFileSync(
          path.join(harness.profile.codexHome, "config.toml"),
          scriptedCodexConfig(modelServer.baseUrl),
          { encoding: "utf8", mode: 0o600 },
        );
        try {
          const page = await harness.launch();
          const selectedProfile = await setAgentExecutionProfile(page, {
            preferredModelId: "gpt-5.5",
          });
          const draft = await createAgentSmokeDraft(
            page,
            harness.profile.initialProjectsDirectory,
            "Scripted Agent file smoke",
          );
          const freshPermissionState = await invokeIpc(
            page,
            "codex:permission:state:get",
            draft.projectId,
          );
          if (
            !isRecord(freshPermissionState) ||
            freshPermissionState.mode !== "guardian-approvals"
          ) {
            throw new Error(
              `Fresh Profile did not resolve Approve for me:\n${JSON.stringify(freshPermissionState, null, 2)}`,
            );
          }
          expect(freshPermissionState).toMatchObject({
            mode: "guardian-approvals",
            effectivePreset: "guardian-approvals",
            approvalsReviewer: "auto_review",
            autoReviewAvailable: true,
          });
          const threadId = await sendAgentPrompt(
            page,
            draft.projectSessionId,
            `${promptMarker}: create the requested deterministic fixture`,
          );
          await waitForAgentThreadExecutionProfile(page, threadId, selectedProfile);
          await modelServer.waitForRequest((request) => request.hasToolCallOutput(callId));
          const snapshot = await waitForCompletedAgentTurn(page, threadId);
          if (!JSON.stringify(snapshot).includes(finalMarker)) {
            throw new Error(
              `Completed file turn omitted the final assistant marker:\n${JSON.stringify(snapshot, null, 2)}`,
            );
          }
          await waitForFinalMarker(page, finalMarker);

          expect(fs.readFileSync(filePath, "utf8")).toBe(fileContents);
          const snapshotRecord = isRecord(snapshot) ? snapshot : null;
          expect(Array.isArray(snapshotRecord?.turns) ? snapshotRecord.turns : []).toHaveLength(1);
          expect(
            collectRecords(snapshot).some(
              (record) => record.type === "commandExecution" && record.status === "completed",
            ),
          ).toBe(true);
        } catch (error) {
          const logs = await readBoundedElectronRuntimeLogs(harness.profile);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n\nElectron runtime logs:\n${logs}`,
            { cause: error },
          );
        } finally {
          await harness.close();
        }
      },
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("opens a loopback page through the real in-app Browser runtime", async () => {
  test.setTimeout(120_000);
  const token = randomUUID();
  const promptMarker = `SCRIPTED_BROWSER_PROMPT_${token}`;
  const pageMarker = `SCRIPTED_BROWSER_PAGE_${token}`;
  const finalMarker = `SCRIPTED_BROWSER_OK_${token}`;
  const searchCallId = `search_browser_${token.replaceAll("-", "")}`;
  const callId = `call_browser_${token.replaceAll("-", "")}`;
  const fixture = await startBrowserHttpFixture(pageMarker);
  let releaseBrowserStart: () => void = () => undefined;
  let browserStartReleased = false;
  const browserStartGate = new Promise<void>((resolve) => {
    releaseBrowserStart = () => {
      if (browserStartReleased) return;
      browserStartReleased = true;
      resolve();
    };
  });
  let releaseFinalResponse: () => void = () => undefined;
  let finalResponseReleased = false;
  const finalResponseGate = new Promise<void>((resolve) => {
    releaseFinalResponse = () => {
      if (finalResponseReleased) return;
      finalResponseReleased = true;
      resolve();
    };
  });
  const browserClientPath = path.join(
    repositoryRoot,
    ".generated/codex-runtime/agent-runtime/browser-runtime/marketplace/plugins/browser/scripts/browser-client.mjs",
  );
  const browserCode = `
const { setupBrowserRuntime } = await import(${JSON.stringify(browserClientPath)});
const agent = await setupBrowserRuntime();
const iab = await agent.browsers.get("iab");
const tab = await iab.tabs.new();
await tab.goto(${JSON.stringify(fixture.url)});
nodeRepl.write(JSON.stringify({ title: await tab.title(), url: await tab.url() }));
`;

  try {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "model discovers the deferred Browser tool",
            match: (request) => request.hasInputText(promptMarker),
            respond: async (request) => {
              assertRequestModel(request, "gpt-5.5");
              if (!request.hasToolType("tool_search")) {
                throw new Error(
                  `Real app-server request did not advertise tool_search: ${request.diagnosticSummary(8_000)}`,
                );
              }
              await browserStartGate;
              return responses.stream([
                responses.created(`response_browser_search_${token}`),
                responses.toolSearchCall(searchCallId, {
                  query: "browser node repl javascript navigate page",
                  limit: 8,
                }),
                responses.completed(`response_browser_search_${token}`),
              ]);
            },
          },
          {
            name: "model opens the Browser fixture",
            match: (request) => request.toolSearchOutput(searchCallId) !== null,
            respond: (request) => {
              const invocation =
                request.toolInvocation("mcp__node_repl", "js") ??
                request.toolInvocation("mcp__node_repl__", "js");
              if (!invocation) {
                throw new Error(
                  `Real app-server request did not advertise the node_repl js tool: ${request.diagnosticSummary(8_000)}`,
                );
              }
              return responses.stream([
                responses.created(`response_browser_tool_${token}`),
                responses.functionCall(
                  callId,
                  invocation.name,
                  { code: browserCode, timeout_ms: 30_000 },
                  invocation.namespace,
                ),
                responses.completed(`response_browser_tool_${token}`),
              ]);
            },
          },
          {
            name: "model finishes after Browser output",
            match: (request) => request.hasToolCallOutput(callId),
            respond: async (request) => {
              const output = request.toolCallOutput(callId);
              if (!JSON.stringify(output).includes(pageMarker)) {
                throw new Error(`Browser output did not contain ${pageMarker}`);
              }
              await finalResponseGate;
              return responses.stream([
                responses.created(`response_browser_final_${token}`),
                responses.assistantMessage(`message_browser_${token}`, finalMarker),
                responses.completed(`response_browser_final_${token}`),
              ]);
            },
          },
        ],
      },
      async (modelServer) => {
        const harness = await ElectronScenarioHarness.create({
          label: "scripted-agent-browser",
          cwd: repositoryRoot,
          prepareAgentRuntime: false,
          retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
          environment: {
            ...modelServer.loopbackEnvironment(),
            NODEX_LOG_CONSOLE: "0",
            NODEX_LOG_FILE: "1",
            OPENAI_API_KEY: "nodex-scripted-model-test-key",
          },
        });
        fs.writeFileSync(
          path.join(harness.profile.codexHome, "config.toml"),
          scriptedCodexConfig(modelServer.baseUrl),
          { encoding: "utf8", mode: 0o600 },
        );
        try {
          const page = await harness.launch();
          const selectedProfile = await setAgentExecutionProfile(page, {
            preferredModelId: "gpt-5.5",
          });
          const draft = await createAgentSmokeDraft(
            page,
            harness.profile.initialProjectsDirectory,
            "Scripted Agent Browser smoke",
          );
          await invokeIpc(page, "browser-use-policy-update-origin-rule", {
            action: "add",
            kind: "allowed",
            origin: new URL(fixture.url).origin,
            resource: "origin",
          });
          const initialRequest = modelServer.waitForRequest(
            (request) => request.hasInputText(promptMarker),
            30_000,
          );
          const threadIdPromise = sendAgentPrompt(
            page,
            draft.projectSessionId,
            `${promptMarker}: open the supplied loopback page in the in-app Browser`,
          );
          await initialRequest;
          await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          });
          await page.keyboard.press("g");
          await page.keyboard.press("p");
          await expect(page.getByTestId("pages-primary-surface")).toHaveCount(1);
          releaseBrowserStart();
          const threadId = await threadIdPromise;
          await waitForAgentThreadExecutionProfile(page, threadId, selectedProfile);
          await modelServer.waitForRequest((request) => request.hasToolCallOutput(callId), 30_000);
          await expect(
            page.locator(
              '[data-browser-sidebar-webview-manager-root][data-browser-sidebar-webview-host-kind="retained"]',
            ),
          ).toHaveCount(1);
          await expect(
            page.locator(
              '[data-browser-sidebar-webview-manager-root][data-browser-sidebar-webview-host-kind="panel"]',
            ),
          ).toHaveCount(0);
          await expect(page.getByTestId("pages-primary-surface")).toHaveCount(1);
          releaseFinalResponse();
          const snapshot = await waitForCompletedAgentTurn(page, threadId, 30_000);
          if (!JSON.stringify(snapshot).includes(finalMarker)) {
            throw new Error(
              `Completed Browser turn omitted the final assistant marker:\n${JSON.stringify(snapshot, null, 2)}`,
            );
          }

          expect(fixture.requests).toContain("/browser-smoke");
          const browserItems = collectRecords(snapshot).filter((record) => {
            if (record.type !== "mcpToolCall" || !isRecord(record.mcpToolCall)) return false;
            const source = record.mcpToolCall.source;
            return isRecord(source) && source.kind === "browserUse" && source.backend === "iab";
          });
          expect(browserItems).toHaveLength(1);
        } catch (error) {
          const logs = await readBoundedElectronRuntimeLogs(harness.profile);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n\nElectron runtime logs:\n${logs}`,
            { cause: error },
          );
        } finally {
          await harness.close();
        }
      },
    );
  } finally {
    releaseBrowserStart();
    releaseFinalResponse();
    await fixture.close();
  }
});

test("keeps a real collaboration subagent Active until completion, then converges to Done", async () => {
  test.setTimeout(120_000);
  const token = randomUUID();
  const promptMarker = `SCRIPTED_SUBAGENT_PROMPT_${token}`;
  const childPromptMarker = `SCRIPTED_SUBAGENT_CHILD_${token}`;
  const childFinalMarker = `SCRIPTED_SUBAGENT_CHILD_OK_${token}`;
  const finalMarker = `SCRIPTED_SUBAGENT_OK_${token}`;
  const spawnCallId = `call_spawn_${token.replaceAll("-", "")}`;
  const childGateCallId = `call_child_gate_${token.replaceAll("-", "")}`;
  const waitCallId = `call_wait_${token.replaceAll("-", "")}`;
  const releasePath = path.join("/tmp", `nodex-scripted-subagent-release-${token}`);

  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "root model spawns the child",
          match: (request) => request.hasInputText(promptMarker),
          respond: (request) => {
            assertRequestModel(request, "gpt-5.6-sol");
            if (!request.toolInvocation("collaboration", "spawn_agent")) {
              throw new Error(
                `Real app-server request did not advertise collaboration.spawn_agent:\n${request.diagnosticSummary()}`,
              );
            }
            return responses.stream([
              responses.created(`response_subagent_spawn_${token}`),
              responses.functionCall(
                spawnCallId,
                "spawn_agent",
                {
                  task_name: "scripted_child",
                  fork_turns: "none",
                  message: childPromptMarker,
                },
                "collaboration",
              ),
              responses.completed(`response_subagent_spawn_${token}`),
            ]);
          },
        },
        {
          name: "child enters a real shell tool while it remains active",
          match: (request) =>
            request.isSubagentRequest() &&
            request.hasInputText(childPromptMarker) &&
            !request.hasFunctionCallOutput(childGateCallId),
          respond: (request) => {
            const invocation = request.toolInvocation("functions", "exec");
            if (!invocation) {
              throw new Error(
                `Real child request did not advertise functions.exec:\n${request.diagnosticSummary()}`,
              );
            }
            const command = `while [ ! -e ${JSON.stringify(releasePath)} ]; do sleep 0.05; done`;
            const code = `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)}, yield_time_ms: 30000 });\ntext(result.output);`;
            return responses.stream([
              responses.created(`response_subagent_child_gate_${token}`),
              responses.customToolCall(
                childGateCallId,
                invocation.name,
                code,
                invocation.namespace,
              ),
              responses.completed(`response_subagent_child_gate_${token}`),
            ]);
          },
        },
        {
          name: "child finishes after the real shell gate is released",
          match: (request) => request.hasFunctionCallOutput(childGateCallId),
          respond: responses.stream([
            responses.created(`response_subagent_child_${token}`),
            responses.assistantMessage(
              `message_subagent_child_${token}`,
              childFinalMarker,
              "final_answer",
            ),
            responses.completed(`response_subagent_child_${token}`, true),
          ]),
        },
        {
          name: "root waits for the running child",
          match: (request) =>
            request.hasFunctionCallOutput(spawnCallId) && !request.isSubagentRequest(),
          respond: () =>
            responses.stream([
              responses.created(`response_subagent_wait_${token}`),
              responses.functionCall(
                waitCallId,
                "wait_agent",
                { timeout_ms: 30_000 },
                "collaboration",
              ),
              responses.completed(`response_subagent_wait_${token}`),
            ]),
        },
        {
          name: "root finishes after the child completion is delivered",
          match: (request) => request.hasFunctionCallOutput(waitCallId),
          respond: responses.stream([
            responses.created(`response_subagent_final_${token}`),
            responses.assistantMessage(
              `message_subagent_final_${token}`,
              finalMarker,
              "final_answer",
            ),
            responses.completed(`response_subagent_final_${token}`, true),
          ]),
        },
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "scripted-agent-subagent",
        cwd: repositoryRoot,
        prepareAgentRuntime: false,
        retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
        environment: {
          ...modelServer.loopbackEnvironment(),
          NODEX_LOG_CONSOLE: "0",
          NODEX_LOG_FILE: "1",
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
        },
      });
      fs.writeFileSync(
        path.join(harness.profile.codexHome, "config.toml"),
        scriptedCollaborationCodexConfig(modelServer.baseUrl),
        { encoding: "utf8", mode: 0o600 },
      );
      try {
        const page = await harness.launch();
        const selectedProfile = await setAgentExecutionProfile(page, {
          preferredModelId: "gpt-5.6-sol",
        });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "Scripted Agent subagent smoke",
        );
        const threadId = await sendAgentPrompt(
          page,
          draft.projectSessionId,
          `${promptMarker}: delegate one bounded task and wait for it`,
        );
        await waitForAgentThreadExecutionProfile(page, threadId, selectedProfile);
        await Promise.all([
          modelServer.waitForRequest(
            (request) => request.isSubagentRequest() && request.hasInputText(childPromptMarker),
            30_000,
          ),
          modelServer.waitForRequest(
            (request) => request.hasFunctionCallOutput(spawnCallId) && !request.isSubagentRequest(),
            30_000,
          ),
        ]);

        await expect
          .poll(
            async () => {
              const overview = await invokeIpc(page, "codex:subagents:overview:read", {
                rootThreadId: threadId,
                mode: "initial",
              });
              if (!isRecord(overview) || !isRecord(overview.active) || !isRecord(overview.done)) {
                return null;
              }
              return {
                active: overview.active.knownCount,
                done: overview.done.knownCount,
              };
            },
            { timeout: 15_000 },
          )
          .toEqual({ active: 1, done: 0 });

        const liveSnapshot = await invokeIpc(page, "codex:thread:snapshot:request", threadId);
        const liveActivity = collectRecords(liveSnapshot).find(
          (record) => record.type === "subAgentActivity" && record.kind === "started",
        );
        const childThreadId = liveActivity?.agentThreadId;
        expect(typeof childThreadId).toBe("string");

        const openSubagents = page.getByRole("button", { name: "Open subagents" }).first();
        await expect(openSubagents).toBeVisible({ timeout: 30_000 });
        await openSubagents.click();
        const panel = page.locator(`[data-subagents-panel-overview="${threadId}"]`);
        const active = panel.locator('[data-subagent-overview-section="active"]');
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await expect(active.getByRole("heading", { name: "Active · 1" })).toBeVisible({
          timeout: 30_000,
        });
        await expect(active.locator('[aria-label^="Open subagent "]')).toHaveCount(1);

        fs.writeFileSync(releasePath, "", "utf8");
        await modelServer.waitForRequest(
          (request) => request.hasFunctionCallOutput(waitCallId),
          30_000,
        );
        const snapshot = await waitForCompletedAgentTurn(page, threadId, 30_000);
        await waitForFinalMarker(page, finalMarker);

        await expect(active.getByRole("heading", { name: "Active · 0" })).toBeVisible({
          timeout: 30_000,
        });
        const done = panel.locator('[data-subagent-overview-section="done"]');
        await expect(done.getByRole("heading", { name: "Done · 1" })).toBeVisible({
          timeout: 30_000,
        });
        await expect(done.locator('[aria-label^="Open subagent "]')).toHaveCount(1);

        expect(
          collectRecords(snapshot).some(
            (record) =>
              record.type === "subAgentActivity" && record.agentThreadId === childThreadId,
          ),
        ).toBe(true);
        const completedOverview = await invokeIpc(page, "codex:subagents:overview:read", {
          rootThreadId: threadId,
          mode: "expanded",
        });
        const doneRows =
          isRecord(completedOverview) && isRecord(completedOverview.done)
            ? completedOverview.done.rows
            : null;
        expect(doneRows).toEqual([
          expect.objectContaining({
            threadId: childThreadId,
            parentThreadId: threadId,
            status: "done",
          }),
        ]);
      } catch (error) {
        const logs = await readBoundedElectronRuntimeLogs(harness.profile);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n\nElectron runtime logs:\n${logs}`,
          { cause: error },
        );
      } finally {
        fs.writeFileSync(releasePath, "", "utf8");
        await harness.close();
        fs.rmSync(releasePath, { force: true });
      }
    },
  );
});
