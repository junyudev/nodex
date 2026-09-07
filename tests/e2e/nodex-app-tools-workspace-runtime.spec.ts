import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  collectRecords,
  createAgentSmokeDraft,
  requireRecord,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";

test("native workspace dependency paths generate and reopen document artifacts", async () => {
  test.setTimeout(180_000);
  if (process.arch !== "arm64" && process.arch !== "x64")
    throw new Error("Unsupported runtime architecture");
  const executablePath = process.env.NODEX_E2E_PACKAGED_EXECUTABLE;
  if (!executablePath)
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/materialize-workspace-runtime.ts",
        "--target-arch",
        process.arch,
      ],
      { timeout: 60_000 },
    );
  let artifactDirectory = "";
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "workspace dependencies",
          match: (request) => request.hasUserInputText("DEPENDENCIES"),
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            const callId = "workspace_dependencies";
            if (index === 0) {
              const tool = request.toolInvocation("functions", "exec");
              expect(tool).not.toBeNull();
              return responses.stream([
                responses.created(callId),
                responses.customToolCall(
                  callId,
                  tool!.name,
                  "text(await tools.mcp__nodex_app__load_workspace_dependencies({}));",
                  tool!.namespace,
                ),
                responses.completed(callId),
              ]);
            }
            const records = collectRecords(request.toolCallOutput(callId)).flatMap((record) => {
              if (record.type !== "input_text" || typeof record.text !== "string") return [];
              try {
                return collectRecords(JSON.parse(record.text));
              } catch {
                return [];
              }
            });
            const result = requireRecord(
              records.find((record) => record.status === "available"),
              "workspace runtime",
            );
            const python = requireRecord(result.python, "Python");
            const node = requireRecord(result.node, "Node");
            if (executablePath) {
              expect(String(python.executable)).toContain(
                path.resolve(executablePath, "../../Resources/workspace-runtime"),
              );
            }
            expect(python).toMatchObject({ version: "3.13.15", recommendedArgs: ["-I", "-B"] });
            const nodeVersion = execFileSync(String(node.executable), ["--version"], {
              encoding: "utf8",
            }).trim();
            expect(nodeVersion).toBe(`v${String(node.version)}`);
            const output = execFileSync(
              String(python.executable),
              [
                "-I",
                "-B",
                path.join(process.cwd(), "scripts/fixtures/workspace-runtime/documents.py"),
                artifactDirectory,
              ],
              { encoding: "utf8", timeout: 30_000 },
            );
            expect(JSON.parse(output)).toEqual({
              python: "3.13.15",
              files: ["sample.docx", "sample.pdf", "sample.png", "sample.pptx", "sample.xlsx"],
            });
            return responses.stream([
              responses.created("dependencies_final"),
              responses.assistantMessage("dependencies_answer", "DEPENDENCIES_OK", "final_answer"),
              responses.completed("dependencies_final", true),
            ]);
          },
        },
      ],
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        executablePath,
        label: "workspace-dependencies",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        environment: {
          ...model.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
        },
      });
      try {
        artifactDirectory = path.join(harness.profile.artifactsDirectory, "documents");
        writeFileSync(
          path.join(harness.profile.codexHome, "config.toml"),
          `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
          { mode: 0o600 },
        );
        const page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.6-sol" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "Document dependencies",
        );
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, "DEPENDENCIES");
        await waitForFinalMarker(page, "DEPENDENCIES_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
      } finally {
        await harness.close();
      }
    },
  );
});
