import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  AGENT_RUNTIME_CODEX_THREAD_SOURCE,
  type AgentSubagentOverview,
} from "@nodex/agent-runtime/contracts";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";

import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import {
  responses,
  standardCodexBackgroundExchanges,
  type ScriptedModelRequest,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  createAgentSmokeDraft,
  invokeIpc,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForAgentThreadExecutionProfile,
  waitForFinalMarker,
  readRuntimeConversation,
  sendAgentFollowUp,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";
import { startBrowserHttpFixture } from "./support/browser-http-fixture";
import { openNewChatDraft, waitForDraftScene } from "./support/new-chat-draft";
import { openSubagentsPanel } from "./support/subagents-panel";

const repositoryRoot = process.cwd();

const assertRequestModel = (request: ScriptedModelRequest, expectedModel: string): void => {
  if (request.body.model === expectedModel) return;
  throw new Error(
    `Scripted Agent request selected ${String(request.body.model)}; expected ${expectedModel}`,
  );
};

/** The words of the newest user message, which identify the Turn a request starts. */
const latestUserText = (request: ScriptedModelRequest): string => {
  const latest = request
    .inputItems()
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "message" &&
        (item as Record<string, unknown>).role === "user",
    )
    .at(-1);
  return JSON.stringify(latest?.content ?? null);
};

const hasInputImage = (request: ScriptedModelRequest): boolean =>
  JSON.stringify(request.inputItems()).includes('"input_image"');

/** The images of the newest user message, which are the ones its Turn was given. */
const latestUserImages = (request: ScriptedModelRequest): readonly string[] => {
  const latest = request
    .inputItems()
    .filter(
      (item): item is { readonly content?: unknown } =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "message" &&
        (item as Record<string, unknown>).role === "user",
    )
    .at(-1);
  return (Array.isArray(latest?.content) ? (latest.content as Record<string, unknown>[]) : [])
    .filter((part) => part.type === "input_image")
    .map((part) => String(part.image_url));
};

/** Pastes an image into a Composer or the editor of a sent message, as the clipboard would. */
const pasteImage = (field: Locator, base64: string, name: string) =>
  field.evaluate(
    (element, image) => {
      const bytes = Uint8Array.from(atob(image.base64), (character) => character.charCodeAt(0));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([bytes], image.name, { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    },
    { base64, name },
  );

/** A small opaque PNG, encoded so the Composer receives it as a pasted image. */
const swatchPngBase64 = (color: readonly [number, number, number] = [0xd0, 0x10, 0x10]): string => {
  const size = 8;
  const rows = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from(color))]),
    ),
  );
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
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
  const tag = rendererCpuRate === 1 && !unversioned ? " @automatic" : "";
  test(`restores a durable Thread after quitting Electron and continues the same conversation (CPU ×${rendererCpuRate}${unversioned ? ", unversioned host" : ""})${tag}`, async ({}, testInfo) => {
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
            match: (request) =>
              request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
              request.hasUserInputText(firstPrompt),
            respond: responses.stream([
              responses.created(`response_before_${token}`),
              responses.assistantMessage(`message_before_${token}`, firstReply, "final_answer"),
              responses.completed(`response_before_${token}`, true),
            ]),
          },
          {
            name: "follow-up retains the conversation across process restart",
            match: (request) =>
              request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
              request.hasUserInputText(nextPrompt),
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
          retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
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
                    ".generated/codex-runtime/agent-runtime/bin/codex",
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
            harness.profile.projectsDirectory,
            "Thread restart",
          );
          const threadId = await sendAgentPrompt(page, draft.projectSessionId, firstPrompt);
          const target = { sessionId: draft.projectSessionId, threadId };
          await waitForRuntimeCompletedAgentTurn(page, target);
          await waitForFinalMarker(page, firstReply);
          let coldDraftSessionId: string | null = null;
          if (rendererCpuRate > 1) {
            const draftScene = await openNewChatDraft(page);
            const owner = await draftScene.getAttribute("data-workbench-scene-owner");
            coldDraftSessionId = owner?.startsWith("session:")
              ? owner.slice("session:".length)
              : null;
            if (!coldDraftSessionId) throw new Error("Cold draft Scene returned no Session owner");
          }

          const previousPid = harness.application.process().pid;
          const reopened = await harness.restart();
          expect(harness.application.process().pid).not.toBe(previousPid);
          if (rendererCpuRate > 1) {
            if (!coldDraftSessionId)
              throw new Error("Cold restart lost its draft Session identity");
            await waitForDraftScene(reopened, coldDraftSessionId);
            const cdp = await reopened.context().newCDPSession(reopened);
            try {
              // Cold renderer scheduling must not turn successful history hydration into failure.
              await cdp.send("Emulation.setCPUThrottlingRate", { rate: rendererCpuRate });
              // Started chats expose their execution Thread identity in the sidebar.
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
          expect(session).toMatchObject({ executionRef: { threadId } });
          // The follow-up continues the same Thread as its second Run.
          const restored = await waitForRuntimeCompletedAgentTurn(reopened, target);
          expect(restored.snapshot.projection.runs.at(-1)).toMatchObject({
            ordinal: 2,
            status: "completed",
          });
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

test("runs a real shell tool through the scripted model boundary @automatic", async () => {
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
            match: (request) =>
              request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
              request.hasUserInputText(promptMarker),
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
            match: (request) =>
              request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
              request.hasToolCallOutput(callId),
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
            harness.profile.projectsDirectory,
            "Scripted Agent file smoke",
          );
          const threadId = await sendAgentPrompt(
            page,
            draft.projectSessionId,
            `${promptMarker}: create the requested deterministic fixture`,
          );
          const target = { sessionId: draft.projectSessionId, threadId };
          await waitForAgentThreadExecutionProfile(page, target, selectedProfile);
          await modelServer.waitForRequest((request) => request.hasToolCallOutput(callId));
          await waitForRuntimeCompletedAgentTurn(page, target);
          const snapshot = await readRuntimeConversation(page, target);
          if (!JSON.stringify(snapshot).includes(finalMarker)) {
            throw new Error(
              `Completed file turn omitted the final assistant marker:\n${JSON.stringify(snapshot, null, 2)}`,
            );
          }
          await waitForFinalMarker(page, finalMarker);

          expect(fs.readFileSync(filePath, "utf8")).toBe(fileContents);
          expect(snapshot.snapshot.projection.runs).toHaveLength(1);
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

test("edits an earlier message and continues from it without the later Turns", async () => {
  test.setTimeout(150_000);
  const token = randomUUID();
  const first = `Remember the first note ${token}`;
  const firstReply = `First note saved ${token}`;
  const second = `Keep this swatch with the second note ${token}`;
  const secondReply = `Second note saved ${token}`;
  const third = `Add a third note ${token}`;
  const thirdReply = `Third note saved ${token}`;
  const rewritten = `Describe the swatch instead ${token}`;
  const rewrittenReply = `Rewritten note answered ${token}`;
  const reply = (name: string, text: string) =>
    responses.stream([
      responses.created(`response_${name}_${token}`),
      responses.assistantMessage(`message_${name}_${token}`, text, "final_answer"),
      responses.completed(`response_${name}_${token}`, true),
    ]);
  const turn = (
    name: string,
    words: string,
    text: string,
    check?: (request: ScriptedModelRequest) => void,
  ) => ({
    name,
    match: (request: ScriptedModelRequest) =>
      request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
      latestUserText(request).includes(words),
    respond: (request: ScriptedModelRequest) => {
      check?.(request);
      return reply(name, text);
    },
  });

  await withScriptedModelServer(
    {
      exchanges: [
        turn("first message", first, firstReply),
        turn("second message with its image", second, secondReply, (request) => {
          expect(hasInputImage(request)).toBe(true);
        }),
        turn("third message", third, thirdReply),
        turn("rewritten second message", rewritten, rewrittenReply, (request) => {
          // The first Turn survives the rewind; the original words and the later Turn do not,
          // and the rewritten message still carries the image it was sent with.
          expect(request.hasInputText(first)).toBe(true);
          expect(request.hasInputText(firstReply)).toBe(true);
          expect(request.hasInputText(second)).toBe(false);
          expect(request.hasInputText(secondReply)).toBe(false);
          expect(request.hasInputText(third)).toBe(false);
          expect(request.hasInputText(thirdReply)).toBe(false);
          expect(hasInputImage(request)).toBe(true);
        }),
        ...standardCodexBackgroundExchanges(),
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "scripted-agent-edit",
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
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.projectsDirectory,
          "Scripted Agent edit",
        );
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, first);
        const target = { sessionId: draft.projectSessionId, threadId };
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, firstReply);

        const composer = page
          .locator('[data-codex-composer="true"][aria-label="Ask for follow-up changes"]')
          .first();
        await composer.fill(second);
        await pasteImage(composer, swatchPngBase64(), "swatch.png");
        await expect(page.getByRole("img", { name: "User attachment" })).toHaveCount(1);
        await page.getByRole("button", { name: "Send prompt" }).click();
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, secondReply);
        await sendAgentFollowUp(page, third);
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, thirdReply);

        const bubbles = page.locator("[data-user-message-bubble='true']");
        await expect(page.getByRole("button", { name: "Edit message" })).toHaveCount(3);
        const secondTurn = page.locator("[data-thread-turn-id]", {
          has: bubbles.filter({ hasText: second }),
        });
        // A real scroll releases latest-submission placement before choosing an earlier Turn.
        await page.getByRole("region", { name: "Conversation", exact: true }).hover();
        await page.mouse.wheel(0, -600);
        await expect(secondTurn.getByRole("button", { name: "Edit message" })).toBeInViewport();
        await secondTurn.locator("[data-user-message-bubble='true']").hover();
        await secondTurn.getByRole("button", { name: "Edit message" }).click();
        const editor = page.getByRole("textbox", { name: "Edit message" });
        await expect(editor).toBeFocused();
        await expect(editor).toHaveValue(second);
        await editor.fill(rewritten);
        await editor.press("Enter");
        await expect(editor).toHaveCount(0);

        await modelServer.waitForRequest((request) => latestUserText(request).includes(rewritten));
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, rewrittenReply);
        await expect(bubbles).toHaveText([first, rewritten]);
        await expect(page.getByText(thirdReply)).toHaveCount(0);
        const rewrittenTurn = page.locator("[data-thread-turn-id]", {
          has: bubbles.filter({ hasText: rewritten }),
        });
        await expect(rewrittenTurn.getByRole("img")).not.toHaveCount(0);
        await expect(page.getByRole("button", { name: "Edit message" })).toHaveCount(2);
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
});

test("gives the model attached context as data and shows only the user's words", async () => {
  test.setTimeout(150_000);
  const token = randomUUID();
  const opening = `Open the conversation ${token}`;
  const openingReply = `Conversation open ${token}`;
  const words = `Compare this with the plan ${token}`;
  const wordsReply = `Compared with the plan ${token}`;
  const title = `Plan page ${token}`;
  const reply = (name: string, text: string) =>
    responses.stream([
      responses.created(`response_${name}_${token}`),
      responses.assistantMessage(`message_${name}_${token}`, text, "final_answer"),
      responses.completed(`response_${name}_${token}`, true),
    ]);
  const isThread = (request: ScriptedModelRequest) =>
    request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE);

  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "opening message",
          match: (request) => isThread(request) && latestUserText(request).includes(opening),
          respond: reply("opening", openingReply),
        },
        {
          name: "message with attached context",
          match: (request) => isThread(request) && latestUserText(request).includes(words),
          respond: (request) => {
            const delivered = latestUserText(request);
            expect(delivered).toContain("<nodex_context>");
            expect(delivered).toContain("nodex-page-reference");
            expect(delivered).toContain(title);
            expect(delivered.indexOf(words)).toBeLessThan(delivered.indexOf("<nodex_context>"));
            return reply("context", wordsReply);
          },
        },
        ...standardCodexBackgroundExchanges(),
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "scripted-agent-context",
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
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.projectsDirectory,
          "Scripted Agent context",
        );
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, opening);
        const target = { sessionId: draft.projectSessionId, threadId };
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, openingReply);

        await invokeIpc(page, "agent-runtime:session:message", {
          ...target,
          message: {
            messageId: randomUUID(),
            text: words,
            context: {
              version: 1,
              records: [
                {
                  kind: "nodex-page-reference",
                  label: title,
                  payload: {
                    pageId: "page-plan",
                    title,
                    url: "nodex://pages/page-plan",
                    selectedBlockIds: [],
                  },
                },
              ],
            },
          },
        });
        await modelServer.waitForRequest((request) => latestUserText(request).includes(words));
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, wordsReply);

        // The context stays out of what the person reads and what a later Agent reads back.
        await expect(page.locator("[data-user-message-bubble='true']")).toHaveText([
          opening,
          words,
        ]);
        const conversation = await readRuntimeConversation(page, target);
        expect(JSON.stringify(conversation.snapshot.projection)).not.toContain("<nodex_context>");
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
});

test("rewrites a message with exactly the images its editor holds", async () => {
  test.setTimeout(180_000);
  const token = randomUUID();
  const first = `Remember the first note ${token}`;
  const firstReply = `First note saved ${token}`;
  const second = `Compare these swatches ${token}`;
  const secondReply = `Swatches compared ${token}`;
  const rewritten = `Compare the kept and the added swatch ${token}`;
  const rewrittenReply = `Kept and added swatch compared ${token}`;
  const stripped = `Forget the swatches ${token}`;
  const strippedReply = `No swatches left ${token}`;
  const removed = swatchPngBase64([0xd0, 0x10, 0x10]);
  const kept = swatchPngBase64([0x10, 0xd0, 0x10]);
  const added = swatchPngBase64([0x10, 0x10, 0xd0]);
  const dataUrl = (base64: string) => `data:image/png;base64,${base64}`;
  const turn = (
    name: string,
    words: string,
    text: string,
    check: (request: ScriptedModelRequest) => void,
  ) => ({
    name,
    match: (request: ScriptedModelRequest) =>
      request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
      latestUserText(request).includes(words),
    respond: (request: ScriptedModelRequest) => {
      check(request);
      return responses.stream([
        responses.created(`response_${name}_${token}`),
        responses.assistantMessage(`message_${name}_${token}`, text, "final_answer"),
        responses.completed(`response_${name}_${token}`, true),
      ]);
    },
  });

  await withScriptedModelServer(
    {
      exchanges: [
        turn("first", first, firstReply, () => {}),
        turn("second", second, secondReply, (request) => {
          expect(latestUserImages(request)).toEqual([dataUrl(removed), dataUrl(kept)]);
        }),
        turn("rewritten", rewritten, rewrittenReply, (request) => {
          expect(latestUserImages(request)).toEqual([dataUrl(kept), dataUrl(added)]);
          expect(request.hasInputText(firstReply)).toBe(true);
          expect(request.hasInputText(second)).toBe(false);
          expect(JSON.stringify(request.inputItems())).not.toContain(removed);
        }),
        turn("stripped", stripped, strippedReply, (request) => {
          // Nothing of the images remains, in this message or in the history it continues.
          expect(hasInputImage(request)).toBe(false);
          expect(request.hasInputText(firstReply)).toBe(true);
          expect(request.hasInputText(rewritten)).toBe(false);
        }),
        ...standardCodexBackgroundExchanges(),
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "scripted-agent-edit-images",
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
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.projectsDirectory,
          "Scripted Agent edit images",
        );
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, first);
        const target = { sessionId: draft.projectSessionId, threadId };
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, firstReply);

        const composer = page
          .locator('[data-codex-composer="true"][aria-label="Ask for follow-up changes"]')
          .first();
        await composer.fill(second);
        await pasteImage(composer, removed, "removed.png");
        await expect(page.getByRole("button", { name: "Remove removed.png" })).toBeVisible();
        await pasteImage(composer, kept, "kept.png");
        await expect(page.getByRole("button", { name: "Remove kept.png" })).toBeVisible();
        await page.getByRole("button", { name: "Send prompt" }).click();
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, secondReply);

        const bubbles = page.locator("[data-user-message-bubble='true']");
        const startEdit = async (words: string) => {
          const turn = page.locator("[data-thread-turn-id]", {
            has: bubbles.filter({ hasText: words }),
          });
          await turn.locator("[data-user-message-bubble='true']").hover();
          await turn.getByRole("button", { name: "Edit message" }).click();
          const editor = page.getByRole("textbox", { name: "Edit message" });
          await expect(editor).toBeFocused();
          return { editor, form: page.locator("form", { has: editor }) };
        };

        const { editor, form } = await startEdit(second);
        // The message's images are in the editor, not also above it.
        await expect(form.getByRole("img", { name: "User attachment" })).toHaveCount(2);
        await form
          .getByRole("button", { name: /^Remove /u })
          .first()
          .click();
        await expect(form.getByRole("img", { name: "User attachment" })).toHaveCount(1);
        await expect(editor).toBeFocused();
        await pasteImage(editor, added, "added.png");
        await expect(form.getByRole("button", { name: "Remove added.png" })).toBeVisible();
        await expect(form.getByRole("img", { name: "User attachment" })).toHaveCount(2);
        await editor.fill(rewritten);
        await editor.press("Enter");
        await expect(editor).toHaveCount(0);
        await modelServer.waitForRequest((request) => latestUserText(request).includes(rewritten));
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, rewrittenReply);
        await expect(bubbles).toHaveText([first, rewritten]);
        const rewrittenTurn = page.locator("[data-thread-turn-id]", {
          has: bubbles.filter({ hasText: rewritten }),
        });
        await expect(rewrittenTurn.getByRole("img", { name: "User attachment" })).toHaveCount(2);

        const again = await startEdit(rewritten);
        const remove = again.form.getByRole("button", { name: /^Remove /u });
        await expect(remove).toHaveCount(2);
        await remove.first().click();
        await remove.first().click();
        await expect(remove).toHaveCount(0);
        await again.editor.fill(stripped);
        await again.editor.press("Enter");
        await expect(again.editor).toHaveCount(0);
        await modelServer.waitForRequest((request) => latestUserText(request).includes(stripped));
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, strippedReply);
        await expect(bubbles).toHaveText([first, stripped]);
        const strippedTurn = page.locator("[data-thread-turn-id]", {
          has: bubbles.filter({ hasText: stripped }),
        });
        await expect(strippedTurn.getByRole("img", { name: "User attachment" })).toHaveCount(0);
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
});

test("keeps message editing at the exact rewind point across a failed Run", async () => {
  test.setTimeout(150_000);
  const token = randomUUID();
  const first = `Remember the first note ${token}`;
  const firstReply = `First note saved ${token}`;
  const second = `Reject the second note ${token}`;
  const third = `Add a third note ${token}`;
  const thirdReply = `Third note saved ${token}`;
  const rewritten = `Replace the second note ${token}`;
  const rewrittenReply = `Rewritten note answered ${token}`;
  const turn = (
    name: string,
    words: string,
    text: string,
    check?: (request: ScriptedModelRequest) => void,
  ) => ({
    name,
    match: (request: ScriptedModelRequest) =>
      request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
      latestUserText(request).includes(words),
    respond: (request: ScriptedModelRequest) => {
      check?.(request);
      return responses.stream([
        responses.created(`response_${name}_${token}`),
        responses.assistantMessage(`message_${name}_${token}`, text, "final_answer"),
        responses.completed(`response_${name}_${token}`, true),
      ]);
    },
  });
  const captureEvidence = async (page: Page, name: string) => {
    const directory = process.env.NODEX_E2E_EVIDENCE_DIR;
    if (!directory) return;
    const conversation = page.getByRole("region", { name: "Conversation", exact: true });
    await expect(conversation).toBeVisible();
    const clip = await conversation.boundingBox();
    if (!clip) throw new Error("The conversation has no screenshot bounds");
    fs.mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, name), clip, animations: "disabled" });
  };

  await withScriptedModelServer(
    {
      exchanges: [
        turn("first", first, firstReply),
        {
          name: "second message fails without retrying",
          match: (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            latestUserText(request).includes(second),
          // Codex uses WebSocket here; closing it with an HTTP-only fixture would trigger retries.
          respond: responses.stream([
            {
              type: "error",
              status: 400,
              error: {
                message: "The scripted second message is invalid.",
                type: "invalid_request_error",
                param: null,
                code: "invalid_request_error",
              },
            },
          ]),
        },
        turn("third", third, thirdReply),
        turn("rewritten", rewritten, rewrittenReply, (request) => {
          expect(request.hasInputText(first)).toBe(true);
          expect(request.hasInputText(firstReply)).toBe(true);
          expect(request.hasInputText(second)).toBe(false);
          expect(request.hasInputText(third)).toBe(false);
          expect(request.hasInputText(thirdReply)).toBe(false);
        }),
        ...standardCodexBackgroundExchanges(),
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "scripted-agent-edit-eligibility",
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
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.projectsDirectory,
          "Scripted Agent edit eligibility",
        );
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, first);
        const target = { sessionId: draft.projectSessionId, threadId };
        await waitForRuntimeCompletedAgentTurn(page, target);
        await waitForFinalMarker(page, firstReply);

        await sendAgentFollowUp(page, second);
        await modelServer.waitForRequest((request) => latestUserText(request).includes(second));
        await expect
          .poll(
            async () =>
              (await readRuntimeConversation(page, target)).snapshot.projection.runs.at(-1)?.status,
          )
          .toBe("failed");
        await expect(page.getByRole("status").filter({ hasText: "Request failed" })).toBeVisible();

        await sendAgentFollowUp(page, third);
        await waitForFinalMarker(page, thirdReply);
        await waitForRuntimeCompletedAgentTurn(page, target);

        const bubbles = page.locator("[data-user-message-bubble='true']");
        await expect(bubbles).toHaveText([first, second, third]);
        await expect(page.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(
          2,
        );
        const [firstTurn, secondTurn, thirdTurn] = [first, second, third].map((words) =>
          page.locator("[data-thread-turn-id]", { has: bubbles.filter({ hasText: words }) }),
        );
        await firstTurn.locator("[data-user-message-bubble='true']").hover();
        await expect(
          firstTurn.getByRole("button", { name: "Edit message", exact: true }),
        ).toBeVisible();
        await secondTurn.locator("[data-user-message-bubble='true']").hover();
        await expect(
          secondTurn.getByRole("button", { name: "Edit message", exact: true }),
        ).toBeVisible();
        await captureEvidence(page, "edit-eligibility-hover-message-2.png");
        await thirdTurn.locator("[data-user-message-bubble='true']").hover();
        await expect(
          thirdTurn.getByRole("button", { name: "Edit message", exact: true }),
        ).toHaveCount(0);
        await captureEvidence(page, "edit-eligibility-hover-message-3.png");

        await secondTurn.locator("[data-user-message-bubble='true']").hover();
        await secondTurn.getByRole("button", { name: "Edit message", exact: true }).click();
        const editor = page.getByRole("textbox", { name: "Edit message", exact: true });
        await expect(editor).toBeFocused();
        await expect(editor).toHaveValue(second);
        await editor.fill(rewritten);
        await editor.press("Enter");
        await expect(editor).toHaveCount(0);

        await modelServer.waitForRequest((request) => latestUserText(request).includes(rewritten));
        await waitForFinalMarker(page, rewrittenReply);
        await waitForRuntimeCompletedAgentTurn(page, target);
        await expect(bubbles).toHaveText([first, rewritten]);
        await expect(page.getByText(thirdReply, { exact: true })).toHaveCount(0);
        await bubbles.first().scrollIntoViewIfNeeded();
        await captureEvidence(page, "edit-after-rewrite.png");
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
});

test("keeps a pasted image visible when steering a running Turn and after restart", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const token = randomUUID();
  const prompt = `Start reviewing the note ${token}`;
  const steer = `Use this swatch for the note ${token}`;
  const final = `Swatch received ${token}`;
  let releaseInitialResponse = () => {};
  const initialResponse = new Promise<void>((resolve) => {
    releaseInitialResponse = resolve;
  });
  let releaseSteeredResponse = () => {};
  const steeredResponse = new Promise<void>((resolve) => {
    releaseSteeredResponse = resolve;
  });
  const expectImage = async (page: Page) => {
    const image = page.locator("[data-thread-turn-id]").getByRole("img");
    await expect(image).toHaveCount(1);
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
  };

  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "hold the initial generation while the user steers",
          match: (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(prompt) &&
            !request.hasUserInputText(steer),
          respond: async () => {
            await initialResponse;
            return responses.stream([
              responses.created(`response_initial_${token}`),
              responses.assistantMessage(
                `message_initial_${token}`,
                "Reviewing the note.",
                "commentary",
              ),
              responses.completed(`response_initial_${token}`, true),
            ]);
          },
        },
        {
          name: "receive the steering message and its image in the same Run",
          match: (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(steer),
          respond: async (request) => {
            expect(hasInputImage(request)).toBe(true);
            await steeredResponse;
            return responses.stream([
              responses.created(`response_steer_${token}`),
              responses.assistantMessage(`message_steer_${token}`, final, "final_answer"),
              responses.completed(`response_steer_${token}`, true),
            ]);
          },
        },
        ...standardCodexBackgroundExchanges(),
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "scripted-agent-steer-image",
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
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.projectsDirectory,
          "Steering with an image",
        );
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, prompt);
        const target = { sessionId: draft.projectSessionId, threadId };
        // The first generation includes native Agent startup, rather than just a loopback hop.
        await modelServer.waitForRequest(
          (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(prompt),
          30_000,
        );
        await expect
          .poll(
            async () =>
              (await readRuntimeConversation(page, target)).snapshot.projection.runs.at(-1)?.status,
          )
          .toBe("running");
        const composer = page
          .locator('[data-codex-composer="true"][aria-label="Ask for follow-up changes"]')
          .first();
        await composer.fill(steer);
        await pasteImage(composer, swatchPngBase64(), "swatch.png");
        await expect(page.getByRole("img", { name: "User attachment" })).toHaveCount(1);
        if (await page.getByRole("button", { name: "Queue follow-up" }).isVisible()) {
          await composer.press("ControlOrMeta+Enter");
        } else {
          await page.getByRole("button", { name: "Steer follow-up" }).click();
        }
        // A click starts asynchronous image preparation. Wait for admission before
        // releasing the initial response, or it could finish and start a second Run.
        await expect(composer).toHaveText("", { timeout: 20_000 });
        const bubble = page.locator("[data-user-message-bubble='true']", { hasText: steer });
        await expect(bubble).toBeVisible();
        await expectImage(page);
        const admitted = await readRuntimeConversation(page, target);
        expect(admitted.snapshot.projection.runs).toHaveLength(1);
        expect(admitted.snapshot.projection.runs[0]?.status).toBe("running");
        releaseInitialResponse();
        await modelServer.waitForRequest(
          (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(steer),
          30_000,
        );
        const active = await readRuntimeConversation(page, target);
        expect(active.snapshot.projection.runs).toHaveLength(1);
        expect(active.snapshot.projection.runs[0]?.status).toBe("running");
        releaseSteeredResponse();
        const completed = await waitForRuntimeCompletedAgentTurn(page, target);
        expect(completed.snapshot.projection.runs).toHaveLength(1);
        await waitForFinalMarker(page, final);
        await expect(bubble).toBeVisible();
        await expectImage(page);
        await testInfo.attach("steered-image", {
          body: await page.screenshot(),
          contentType: "image/png",
        });

        const reopened = await harness.restart();
        await expect(reopened.getByText(final, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        await expect(
          reopened.locator("[data-user-message-bubble='true']", { hasText: steer }),
        ).toBeVisible();
        await expectImage(reopened);
      } catch (error) {
        const logs = await readBoundedElectronRuntimeLogs(harness.profile);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n\nElectron runtime logs:\n${logs}`,
          { cause: error },
        );
      } finally {
        releaseInitialResponse();
        releaseSteeredResponse();
        await harness.close();
      }
    },
  );
});

const runScriptedBrowserTurn = async (
  testInfo: TestInfo,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly codexConfigSuffix?: string;
    readonly verifyRuntimeLogs?: (logs: string) => void;
  } = {},
): Promise<void> => {
  const token = randomUUID();
  const promptMarker = `SCRIPTED_BROWSER_PROMPT_${token}`;
  const pageMarker = `SCRIPTED_BROWSER_PAGE_${token}`;
  const finalMarker = `SCRIPTED_BROWSER_OK_${token}`;
  const toolTitle = "Open the page and show a color swatch";
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
await nodeRepl.emitImage(Buffer.from(${JSON.stringify(swatchPngBase64())}, "base64"));
nodeRepl.write(JSON.stringify({ title: await tab.title(), url: await tab.url() }));
`;

  try {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "model discovers the deferred Browser tool",
            match: (request) =>
              request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
              request.hasUserInputText(promptMarker),
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
            match: (request) =>
              request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
              request.toolSearchOutput(searchCallId) !== null,
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
                  { code: browserCode, title: toolTitle, timeout_ms: 30_000 },
                  invocation.namespace,
                ),
                responses.completed(`response_browser_tool_${token}`),
              ]);
            },
          },
          {
            name: "model finishes after Browser output",
            match: (request) =>
              request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
              request.hasToolCallOutput(callId),
            respond: async (request) => {
              const output = request.toolCallOutput(callId);
              if (!JSON.stringify(output).includes(pageMarker)) {
                throw new Error(
                  `Browser output did not contain ${pageMarker}: ${JSON.stringify(output).slice(0, 4_000)}`,
                );
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
            ...options.environment,
          },
        });
        fs.writeFileSync(
          path.join(harness.profile.codexHome, "config.toml"),
          `${scriptedCodexConfig(modelServer.baseUrl)}${options.codexConfigSuffix ?? ""}`,
          { encoding: "utf8", mode: 0o600 },
        );
        try {
          const page = await harness.launch();
          const selectedProfile = await setAgentExecutionProfile(page, {
            preferredModelId: "gpt-5.5",
          });
          const draft = await createAgentSmokeDraft(
            page,
            harness.profile.projectsDirectory,
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
          await expect(page.getByTestId("library-primary-surface")).toHaveCount(1);
          releaseBrowserStart();
          const threadId = await threadIdPromise;
          const target = { sessionId: draft.projectSessionId, threadId };
          await waitForAgentThreadExecutionProfile(page, target, selectedProfile);
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
          await expect(page.getByTestId("library-primary-surface")).toHaveCount(1);
          releaseFinalResponse();
          await waitForRuntimeCompletedAgentTurn(page, target, 30_000);
          const snapshot = await readRuntimeConversation(page, target);
          if (!JSON.stringify(snapshot).includes(finalMarker)) {
            throw new Error(
              `Completed Browser turn omitted the final assistant marker:\n${JSON.stringify(snapshot, null, 2)}`,
            );
          }

          expect(fixture.requests.filter((request) => request === "/browser-smoke")).toHaveLength(
            1,
          );
          await page
            .getByRole("navigation", { name: "App navigation" })
            .getByRole("button", {
              name: "Home",
              exact: true,
            })
            .click();
          await page.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
          await waitForFinalMarker(page, finalMarker);
          const activity = page.getByRole("button", { name: /^Worked for/u });
          if (
            (await activity.count()) > 0 &&
            (await activity.getAttribute("aria-expanded")) !== "true"
          )
            await activity.click();
          const groupBody = page.getByTestId("agent-activity-group-body");
          if (
            (await groupBody.count()) > 0 &&
            (await groupBody.getAttribute("aria-hidden")) === "true"
          )
            await groupBody.locator("..").getByRole("button").first().click();
          const tool = page.getByRole("button", {
            name: toolTitle,
            exact: true,
          });
          await expect(tool, await page.locator("body").ariaSnapshot()).toBeVisible();
          await tool.click();
          const image = page.getByRole("img", { name: "Tool output", exact: true });
          await expect(image).toHaveCount(1);
          await expect(image).toBeVisible();
          await expect
            .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
            .toBeGreaterThan(0);
          await testInfo.attach("javascript-tool-result", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          if (options.verifyRuntimeLogs) {
            options.verifyRuntimeLogs(
              await readBoundedElectronRuntimeLogs(harness.profile, 256_000),
            );
          }
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
};

test("opens a loopback page through the real in-app Browser runtime", async ({}, testInfo) => {
  await runScriptedBrowserTurn(testInfo);
});

test("opens the real in-app Browser without contacting another desktop host's access endpoint", async ({}, testInfo) => {
  // macOS Unix-domain socket paths must stay below roughly 104 bytes.
  const socketDirectory = fs.mkdtempSync("/tmp/nodex-access-");
  const socketPath = path.join(socketDirectory, "access.sock");
  const { publicKey } = generateKeyPairSync("ed25519");
  const verifyingIdentity = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const accessEnvironment = {
    BROWSER_USE_ACCESS_EXECUTOR_ID: JSON.stringify([randomUUID(), "native-browser-plugin"]),
    BROWSER_USE_ACCESS_PIPE_PATH: socketPath,
    BROWSER_USE_ACCESS_VERIFYING_IDENTITY: verifyingIdentity,
  };
  const accessConfig = Object.entries(accessEnvironment)
    .map(([name, value]) => `${name} = ${JSON.stringify(value)}`)
    .join("\n");
  let acceptedConnections = 0;
  const server = net.createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await runScriptedBrowserTurn(testInfo, {
      environment: {
        ...accessEnvironment,
        CODEX_APP_TOOLS_PIPE_PATH: path.join(socketDirectory, "missing-app-tools.sock"),
        CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY: verifyingIdentity,
      },
      // These tables follow the scripted provider's [features] table without reopening it.
      codexConfigSuffix: `
[mcp_servers.node_repl]
command = ${JSON.stringify(path.join(socketDirectory, "missing-foreign-node-repl"))}
args = []
env_vars = ${JSON.stringify(Object.keys(accessEnvironment))}

[mcp_servers.node_repl.env]
${accessConfig}
SKY_CUA_SERVICE_PATH = ${JSON.stringify(path.join(socketDirectory, "foreign-cua"))}

[shell_environment_policy.set]
${accessConfig}
NODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(JSON.stringify({ browser: path.join(socketDirectory, "foreign-service.mjs") }))}
`,
      verifyRuntimeLogs: (logs) => {
        expect(logs).toContain(
          "Ignored Desktop Tool bindings inherited from the launching environment",
        );
        expect(logs).not.toContain(verifyingIdentity);
        expect(logs).not.toContain(socketPath);
      },
    });
    expect(acceptedConnections, "Foreign Browser access host connections").toBe(0);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nForeign Browser access host accepted ${acceptedConnections} connections`,
      { cause: error },
    );
  } finally {
    try {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      fs.rmSync(socketDirectory, { recursive: true, force: true });
    }
  }
});

test("keeps a real collaboration subagent Active until completion, then converges to Done", async () => {
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
          match: (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(promptMarker),
          respond: (request) => {
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
          match: (request) =>
            request.isThreadSource("subagent") && request.hasFunctionCallOutput(childGateCallId),
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
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasFunctionCallOutput(spawnCallId) &&
            !request.isSubagentRequest(),
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
          match: (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasFunctionCallOutput(waitCallId),
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
        const selectedProfile = await setAgentExecutionProfile(page);
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.projectsDirectory,
          "Scripted Agent subagent smoke",
        );
        const threadId = await sendAgentPrompt(
          page,
          draft.projectSessionId,
          `${promptMarker}: delegate one bounded task and wait for it`,
        );
        const target = { sessionId: draft.projectSessionId, threadId };
        await waitForAgentThreadExecutionProfile(page, target, selectedProfile);
        const [childRequest, rootRequest] = await Promise.all([
          modelServer.waitForRequest(
            (request) => request.isSubagentRequest() && request.hasInputText(childPromptMarker),
            30_000,
          ),
          modelServer.waitForRequest(
            (request) =>
              request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
              request.hasUserInputText(promptMarker),
            30_000,
          ),
          modelServer.waitForRequest(
            (request) => request.hasFunctionCallOutput(spawnCallId) && !request.isSubagentRequest(),
            30_000,
          ),
        ]);
        assertRequestModel(rootRequest, selectedProfile.modelId);
        assertRequestModel(childRequest, selectedProfile.modelId);

        const overview = async () =>
          (await invokeIpc(
            page,
            "agent-runtime:session:overview",
            target,
          )) as AgentSubagentOverview;
        await expect
          .poll(async () => {
            const current = await overview();
            return { active: current.active.items.length, done: current.terminal.items.length };
          })
          .toEqual({ active: 1, done: 0 });
        const childThreadId = (await overview()).active.items[0]?.childThreadId;
        expect(typeof childThreadId).toBe("string");

        await openSubagentsPanel(page);
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
        await waitForRuntimeCompletedAgentTurn(page, target, 30_000);
        await waitForFinalMarker(page, finalMarker);

        await expect(active.getByRole("heading", { name: "Active · 0" })).toBeVisible({
          timeout: 30_000,
        });
        const done = panel.locator('[data-subagent-overview-section="done"]');
        await expect(done.getByRole("heading", { name: "Done · 1" })).toBeVisible({
          timeout: 30_000,
        });
        await expect(done.locator('[aria-label^="Open subagent "]')).toHaveCount(1);

        // The root conversation records the child it created.
        const conversation = await readRuntimeConversation(page, target);
        expect(
          conversation.snapshot.projection.visibleTurnItems.some(
            ({ item }) =>
              (item.type === "subagent" && item.childThreadId === childThreadId) ||
              (item.type === "thread_created" && item.targetThreadId === childThreadId),
          ),
        ).toBe(true);
        expect((await overview()).terminal.items).toEqual([
          expect.objectContaining({
            childThreadId,
            threadId,
            status: "completed",
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
