import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  collectRecords,
  invokeIpc,
  createAgentSmokeDraft,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";
import { createConvergencePage, createConvergenceProject } from "./support/editor-scenario";

const shellOutput = async (page: Page): Promise<string[]> => {
  const activity = page.getByRole("button", { name: /^Worked for/u });
  if ((await activity.getAttribute("aria-expanded")) !== "true") await activity.click();
  const commands = page.getByRole("button", { name: "Ran commands", exact: true });
  if ((await commands.count()) > 0 && (await commands.getAttribute("aria-expanded")) !== "true")
    await commands.click();
  const toggles = page.locator('[data-testid="command-tool-summary-toggle"] > button');
  await expect(toggles).toHaveCount(2);
  for (const toggle of await toggles.all()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  }
  const output = page.locator(".group\\/output code");
  await expect(output).toHaveCount(2);
  return await output.allTextContents();
};

test("real Shell output survives delayed batching and preserves repeated lines after restart", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const token = randomUUID();
  const prompt = `SHELL_OUTPUT_${token}`;
  const final = `SHELL_DONE_${token}`;
  const repeatLine = `same-line-${token}`;
  const queryCall = `query_${token.replaceAll("-", "")}`;
  const repeatCall = `repeat_${token.replaceAll("-", "")}`;
  let queryCommand = "";
  let repeatCommand = `printf '%s\\n' '${repeatLine}'; sleep 0.2; printf '%s\\n' '${repeatLine}'`;
  const capturedToolOutputs: unknown[] = [];
  const toolResponse =
    (callId: string, command: () => string) =>
    (
      request: import("../../scripts/scenarios/runtime/scripted-model-server").ScriptedModelRequest,
    ) => {
      const cmd = command();
      if (request.namedTool("exec_command")) {
        return responses.stream([
          responses.created(`response_${callId}`),
          responses.functionCall(callId, "exec_command", { cmd, yield_time_ms: 10_000 }),
          responses.completed(`response_${callId}`),
        ]);
      }
      const invocation = request.toolInvocation("functions", "exec");
      if (!invocation) throw new Error(`Missing shell tool: ${request.diagnosticSummary()}`);
      return responses.stream([
        responses.created(`response_${callId}`),
        responses.customToolCall(
          callId,
          invocation.name,
          `text((await tools.exec_command({cmd: ${JSON.stringify(cmd)}, yield_time_ms: 10000})).output);`,
          invocation.namespace,
        ),
        responses.completed(`response_${callId}`),
      ]);
    };
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "real CLI SQL query",
          match: (request) => request.hasInputText(prompt),
          respond: toolResponse(queryCall, () => queryCommand),
        },
        {
          name: "two identical native output occurrences",
          match: (request) => request.hasToolCallOutput(queryCall),
          respond: (request) => {
            capturedToolOutputs.push(request.toolCallOutput(queryCall));
            return toolResponse(repeatCall, () => repeatCommand)(request);
          },
        },
        {
          name: "finish after real shell output",
          match: (request) => request.hasToolCallOutput(repeatCall),
          respond: (request) => {
            capturedToolOutputs.push(request.toolCallOutput(repeatCall));
            return responses.stream([
              responses.created(`response_final_${token}`),
              responses.assistantMessage(`message_${token}`, final, "final_answer"),
              responses.completed(`response_final_${token}`, true),
            ]);
          },
        },
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "shell-output",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        environment: {
          ...modelServer.loopbackEnvironment(),
          NODEX_LOG_CONSOLE: "0",
          NODEX_LOG_FILE: "1",
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
        },
      });
      fs.writeFileSync(
        path.join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${modelServer.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
        { mode: 0o600 },
      );
      try {
        const outputGate = path.join(
          harness.profile.initialProjectsDirectory,
          "release-shell-output",
        );
        // Wait for native item start so this test isolates Nodex from early process subscription races.
        repeatCommand = `while [ ! -f '${outputGate}' ]; do sleep 0.02; done; ${repeatCommand}`;
        const page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const project = await createConvergenceProject(
          page,
          "Shell fixture",
          harness.profile.initialProjectsDirectory,
        );
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "Shell output",
        );
        await invokeIpc(page, "codex:permission:mode:set", draft.projectId, "full-access");
        const fixture = await createConvergencePage(
          page,
          { ...project, projectId: draft.projectId },
          "Shell query fixture",
        );
        queryCommand = `nodex sql query 'SELECT title,title_etag,file_manifest_revision,intrinsic_properties FROM pages WHERE page_id=:id' --param 'id="${fixture.pageId}"'`;
        await page.evaluate(() => {
          const scope = window as unknown as { __shellEvents: unknown[] };
          scope.__shellEvents = [];
          // Stretch batching timers to force real native completion to overtake queued output.
          // IPC and native Shell execution remain real; only renderer scheduling is stressed.
          const schedule = window.setTimeout.bind(window);
          window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
            schedule(
              handler,
              timeout === 50 ? 10_000 : timeout,
              ...args,
            )) as typeof window.setTimeout;
          if (!window.api) throw new Error("Electron preload API is unavailable");
          window.api.on("codex:host-message", (message) => scope.__shellEvents.push(message));
        });
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, prompt);
        await expect
          .poll(
            async () =>
              await page.evaluate((callId) => {
                const events = (
                  window as unknown as {
                    __shellEvents: {
                      notification?: { method: string; params: { item?: { id: string } } };
                    }[];
                  }
                ).__shellEvents;
                return events.some(
                  (event) =>
                    event.notification?.method === "item/started" &&
                    event.notification.params.item?.id === callId,
                );
              }, repeatCall),
          )
          .toBe(true);
        fs.writeFileSync(outputGate, "ready");
        await waitForFinalMarker(page, final);
        const liveSnapshot = await waitForCompletedAgentTurn(page, threadId);
        // Let the delayed timer fire: it must not append bytes already included in completion.
        await page.waitForTimeout(11_000);
        const live = await shellOutput(page);
        const hostMessages = await page.evaluate(
          () => (window as unknown as { __shellEvents: unknown[] }).__shellEvents,
        );
        fs.writeFileSync(
          testInfo.outputPath("live-state.json"),
          JSON.stringify({ live, liveSnapshot, capturedToolOutputs, hostMessages }, null, 2),
        );
        const nativeLogs = fs
          .readdirSync(harness.profile.codexHome, { recursive: true })
          .filter((file): file is string => typeof file === "string" && file.endsWith(".jsonl"))
          .map((file) => fs.readFileSync(path.join(harness.profile.codexHome, file), "utf8"));
        fs.writeFileSync(testInfo.outputPath("native-conversation.jsonl"), nativeLogs.join("\n"));
        const query = JSON.parse(live[0] ?? "") as {
          ok: boolean;
          result: { returned_count: number; rows: unknown[][]; snapshot: string };
        };
        expect(query.ok).toBe(true);
        expect(query.result.returned_count).toBe(1);
        expect(query.result.rows).toHaveLength(1);
        expect(query.result.rows[0]?.[0]).toBe("Shell query fixture");
        expect(query.result.snapshot).toMatch(/^query_/u);
        expect(live[1]).toBe(`${repeatLine}\n${repeatLine}\n`);
        const commands = collectRecords(liveSnapshot).filter(
          (record) => record.type === "commandExecution",
        );
        expect(
          commands.some(
            (command) =>
              typeof command.command === "string" &&
              command.command.includes("nodex sql query") &&
              command.aggregatedOutput === live[0],
          ),
        ).toBe(true);
        const reopened = await harness.restart();
        await reopened.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
        await waitForFinalMarker(reopened, final);
        const restored = await shellOutput(reopened);
        expect(restored).toEqual(live);
        await testInfo.attach("shell-output-result.json", {
          body: JSON.stringify(
            {
              status: "passed",
              threadId,
              queryCommand,
              repeatCommand,
              live,
              restored,
              capturedToolOutputs,
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
      } catch (error) {
        await testInfo.attach("runtime.log", {
          body: await readBoundedElectronRuntimeLogs(harness.profile, 256_000),
          contentType: "text/plain",
        });
        await testInfo.attach("dom.txt", {
          body: await harness.page.locator("body").innerText(),
          contentType: "text/plain",
        });
        throw error;
      } finally {
        await harness.close();
      }
    },
  );
});
