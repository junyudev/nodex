import { openWorkbenchSettings } from "./support/workbench-settings";
import workspaceRuntimeLock from "../../resources/workspace-runtime/workspace-runtime.lock.json";
import { nativeAppToolCall } from "./support/native-app-tools";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
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
  waitForRuntimeCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";

test("native workspace dependency paths generate and reopen document artifacts", async () => {
  if (process.arch !== "arm64" && process.arch !== "x64")
    throw new Error("Unsupported runtime architecture");
  const executablePath = process.env.NODEX_E2E_PACKAGED_EXECUTABLE;
  const usesComponent = !!executablePath || process.env.NODEX_TEST_APP_COMPONENTS === "1";
  // oxlint-disable-next-line nodex/no-explicit-test-timeout -- A fresh Profile can download both Codex and Document Tools before opening the generated files.
  test.setTimeout(usesComponent ? 780_000 : 180_000);
  if (!usesComponent)
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
  let nodexHome = "";
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
                nativeAppToolCall(
                  callId,
                  tool!.name,
                  [
                    '// @exec: {"yield_time_ms": 120000, "max_output_tokens": 4000}',
                    "const result = await app.load_workspace_dependencies({});",
                    'const value = typeof result === "string" ? JSON.parse(result) : result;',
                    "text(value.structuredContent ?? value);",
                  ].join("\n"),
                  tool!.namespace,
                ),
                responses.completed(callId),
              ]);
            }
            const outputRecord = request.toolCallOutput(callId);
            const records = collectRecords(outputRecord).flatMap((record) => {
              if (record.type !== "input_text" || typeof record.text !== "string") return [];
              try {
                return collectRecords(JSON.parse(record.text));
              } catch {
                return [];
              }
            });
            const result = requireRecord(
              records.find((record) => record.status === "available"),
              `workspace runtime from ${JSON.stringify(outputRecord).slice(0, 1000)}`,
            );
            const python = requireRecord(result.python, "Python");
            const node = requireRecord(result.node, "Node");
            if (usesComponent) {
              const asset = workspaceRuntimeLock.release.assets["darwin-arm64"];
              if (!asset?.url)
                throw new Error("Packaged Document Tools require a published archive");
              expect(python.executable).toBe(
                path.join(
                  nodexHome,
                  "components/document-tools",
                  asset.archiveSha256,
                  "python/bin/python3.13",
                ),
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
        nodexHome = harness.profile.nodexHome;
        if (usesComponent)
          appendFileSync(
            harness.profile.settingsPath,
            '\n[components]\ndisabled = ["desktop-tools"]\n',
          );
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
          harness.profile.projectsDirectory,
          "Document dependencies",
        );
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, "DEPENDENCIES");
        // The native call waits up to three minutes for Document Tools to install.
        await waitForFinalMarker(page, "DEPENDENCIES_OK", usesComponent ? 210_000 : undefined);
        await waitForRuntimeCompletedAgentTurn(
          page,
          { sessionId: draft.projectSessionId, threadId },
          60_000,
        );
        if (usesComponent) {
          await openWorkbenchSettings(page);
          await page.getByRole("link", { name: "General", exact: true }).click();
          const section = page.getByRole("region", { name: "Components", exact: true });
          const documentTools = section.locator("[data-app-component-row]").filter({
            has: page.getByRole("switch", { name: "Remove Document Tools", exact: true }),
          });
          await expect(documentTools.getByRole("status")).toHaveText(/^\d+(?:\.\d+)?\s+MB$/u);
        }
      } finally {
        await harness.close();
      }
    },
  );
});
