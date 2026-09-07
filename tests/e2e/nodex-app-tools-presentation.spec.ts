import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
  type ScriptedModelExchange,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  collectRecords,
  createAgentSmokeDraft,
  invokeIpc,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";

const records = (value: unknown) =>
  collectRecords(value).flatMap((item) => {
    if (item.type !== "input_text" || typeof item.text !== "string") return [];
    try {
      return collectRecords(JSON.parse(item.text));
    } catch {
      return [];
    }
  });

test("native presentation tools preserve Session ownership and reveal exact file and Review targets", async () => {
  test.setTimeout(180_000);
  const otherSessionId = createUuidV7();
  let callerSessionId = "";
  let filePath = "";
  let browserUrl = "";
  await withScriptedModelServer(
    {
      exchanges: ["review", "file"].map<ScriptedModelExchange>((phase) => ({
        name: `presentation ${phase}`,
        match: (request) =>
          request.hasUserInputText(`PRESENT_${phase}`) &&
          (phase === "file" || !request.hasUserInputText("PRESENT_file")),
        expectedCalls: 2,
        maximumCalls: 2,
        respond: (request, index) => {
          const callId = `presentation_${phase}`;
          if (index === 0) {
            const tool = request.toolInvocation("functions", "exec");
            expect(tool).not.toBeNull();
            const common = [
              '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 18000}',
              'const unwrap=r=>{const v=typeof r==="string"?JSON.parse(r):r;return v.structuredContent??(v.content?JSON.parse(v.content[0].text):v);};',
              'async function invoke(name,args){for(let i=0;i<3;i++){const result=unwrap(await tools[name](args));if(result.error!=="stale_presentation")return result;}throw new Error("Presentation kept changing");}',
            ];
            const script =
              phase === "review"
                ? [
                    ...common,
                    "text({initial:unwrap(await tools.mcp__nodex_app__get_session_context({}))});",
                    `text({browser:await invoke("mcp__nodex_app__open_in_nodex",{operationId:"open-browser",target:{kind:"browser",url:${JSON.stringify(browserUrl)}}})});`,
                    'let context=unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"}));let tabs=unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:context.presentation.observationId}));const browser=tabs.items.find(t=>t.browserTabId);text({browserAgain:await invoke("mcp__nodex_app__open_in_nodex",{operationId:"reuse-browser",target:{kind:"browser",tabId:browser.browserTabId}})});',
                    'text({terminal:await invoke("mcp__nodex_app__open_in_nodex",{operationId:"open-terminal",placement:"bottom",target:{kind:"terminal"}})});',
                    'context=unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"}));tabs=unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:context.presentation.observationId}));text({terminalTabs:tabs});const terminal=tabs.items.find(t=>t.terminalId);text({terminalAgain:await invoke("mcp__nodex_app__open_in_nodex",{operationId:"reuse-terminal",placement:"bottom",target:{kind:"terminal",terminalId:terminal.terminalId}})});',
                    `text({hidden:await invoke("mcp__nodex_app__open_in_nodex",{operationId:"hidden-file",sessionId:${JSON.stringify(otherSessionId)},target:{kind:"file",path:${JSON.stringify(filePath)},line:12}})});`,
                    `text({navigated:await invoke("mcp__nodex_app__navigate_to_session",{operationId:"navigate-other",sessionId:${JSON.stringify(otherSessionId)}})});`,
                    'text({otherContext:unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"}))});',
                    `text({returned:await invoke("mcp__nodex_app__navigate_to_session",{operationId:"navigate-caller",sessionId:${JSON.stringify(callerSessionId)}})});`,
                    'text({review:await invoke("mcp__nodex_app__open_in_nodex",{operationId:"open-staged",target:{kind:"review",view:"staged",path:"review.ts"}})});',
                    "text({terminalContent:unwrap(await tools.mcp__nodex_app__read_session_terminal({terminalId:terminal.terminalId,maxChars:1024}))});",
                  ]
                : [
                    ...common,
                    `text({file:await invoke("mcp__nodex_app__open_in_nodex",{operationId:"show-line",target:{kind:"file",path:${JSON.stringify(filePath)},line:12}})});`,
                    `text({fileAgain:await invoke("mcp__nodex_app__open_in_nodex",{operationId:"show-line",target:{kind:"file",path:${JSON.stringify(filePath)},line:12}})});`,
                  ];
            return responses.stream([
              responses.created(callId),
              responses.customToolCall(callId, tool!.name, script.join("\n"), tool!.namespace),
              responses.completed(callId),
            ]);
          }
          const outputs = records(request.toolCallOutput(callId));
          const result = (label: string) => outputs.find((item) => item[label])?.[label];
          if (phase === "review") {
            for (const label of ["browser", "browserAgain", "terminal", "terminalAgain", "review"])
              expect(result(label), label).toMatchObject({
                status: "opened",
                error: null,
                sessionId: callerSessionId,
              });
            expect(result("browserAgain")).toMatchObject({
              tabId: (result("browser") as { tabId: string }).tabId,
            });
            expect(result("terminalAgain")).toMatchObject({
              tabId: (result("terminal") as { tabId: string }).tabId,
            });
            expect(result("terminalContent")).toMatchObject({
              status: "available",
              sessionId: callerSessionId,
            });
            expect(result("hidden")).toMatchObject({
              status: "queued",
              error: null,
              sessionId: otherSessionId,
              persisted: true,
            });
            expect(result("navigated")).toMatchObject({
              status: "navigated",
              error: null,
              sessionId: otherSessionId,
            });
            expect(result("otherContext")).toMatchObject({
              sessionId: callerSessionId,
              presentation: {
                reference: { sceneOwner: { kind: "session", sessionId: otherSessionId } },
              },
            });
            expect(result("returned")).toMatchObject({
              status: "navigated",
              error: null,
              sessionId: callerSessionId,
            });
          } else {
            expect(result("file")).toMatchObject({
              status: "opened",
              error: null,
              persisted: true,
            });
            expect(result("fileAgain")).toEqual(result("file"));
          }
          return responses.stream([
            responses.created(`${callId}_final`),
            responses.assistantMessage(`${callId}_answer`, `PRESENT_${phase}_OK`, "final_answer"),
            responses.completed(`${callId}_final`, true),
          ]);
        },
      })),
    },
    async (model) => {
      browserUrl = model.baseUrl;
      const harness = await ElectronScenarioHarness.create({
        label: "native-session-presentation",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        environment: {
          ...model.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
          NODEX_LOG_FILE: "1",
          NODEX_LOG_CONSOLE: "0",
        },
      });
      writeFileSync(
        join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
        { mode: 0o600 },
      );
      let threadId: string | null = null;
      try {
        const workspace = harness.profile.initialProjectsDirectory;
        filePath = join(workspace, "review.ts");
        const original =
          Array.from(
            { length: 40 },
            (_, index) => `export const line${index + 1} = ${index + 1};`,
          ).join("\n") + "\n";
        writeFileSync(filePath, original);
        execFileSync("git", ["init", "--initial-branch=main", workspace]);
        execFileSync("git", ["-C", workspace, "add", "review.ts"]);
        execFileSync("git", [
          "-C",
          workspace,
          "-c",
          "user.name=Nodex Test",
          "-c",
          "user.email=test@nodex.local",
          "commit",
          "-m",
          "Initial content",
        ]);
        writeFileSync(filePath, original.replace("line12 = 12", "line12 = 120"));
        execFileSync("git", ["-C", workspace, "add", "review.ts"]);
        const page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.6-sol" });
        const draft = await createAgentSmokeDraft(page, workspace, "Presentation fixture");
        callerSessionId = draft.projectSessionId;
        await invokeIpc(page, "codex:permission:mode:set", draft.projectId, "full-access");
        await invokeIpc(page, "project-sessions:create", {
          operationId: createBoundedOperationId("e2e.presentation.target"),
          payload: {
            sessionId: otherSessionId,
            input: {
              projectId: draft.projectId,
              noThreadFallbackTitle: "Background target",
              initialPageIds: [],
            },
          },
        });
        threadId = await sendAgentPrompt(page, callerSessionId, "PRESENT_review");
        await waitForFinalMarker(page, "PRESENT_review_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        await expect(page.getByRole("button", { name: "Review source", exact: true })).toHaveText(
          "Staged",
        );
        await expect(
          page.getByRole("button", { name: "Review source", exact: true }),
        ).toBeVisible();
        const composer = page.locator('[data-codex-composer="true"]:visible');
        await composer.fill("PRESENT_file");
        await page.getByRole("button", { name: "Send prompt", exact: true }).click();
        await waitForFinalMarker(page, "PRESENT_file_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        const editor = page.getByRole("region", {
          name: "Source editor for review.ts",
          exact: true,
        });
        await expect(editor).toBeVisible();
        const targetLine = editor.locator('[data-line="12"]');
        await expect(targetLine).toHaveText("export const line12 = 120;");
        await expect
          .poll(async () => {
            const viewport = await editor.boundingBox();
            const line = await targetLine.boundingBox();
            if (!viewport || !line) return false;
            return (
              Math.abs(line.y + line.height / 2 - viewport.y - viewport.height / 2) <
              line.height * 2
            );
          })
          .toBe(true);
      } catch (error) {
        const snapshot = threadId
          ? await invokeIpc(harness.page, "codex:thread:snapshot:request", threadId).catch(
              () => null,
            )
          : null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(snapshot).slice(-36_000)}\n${await readBoundedElectronRuntimeLogs(harness.profile)}`,
          { cause: error },
        );
      } finally {
        await harness.close();
      }
    },
  );
});
