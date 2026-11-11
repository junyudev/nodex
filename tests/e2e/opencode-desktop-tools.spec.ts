import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { startScriptedChatCompletionsServer } from "../../scripts/scenarios/runtime/scripted-chat-completions-server";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../src/shared/model-policy";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import { invokeIpc } from "./support/agent-smoke-harness";
import { chooseComposerModel, refreshComposerModels } from "./support/composer-model-picker";
import {
  browserSkillName,
  realChromeHostPointsInto,
  desktopEvidence,
  runDesktopSmoke,
  smokeMarker,
  type DesktopSmokeStep,
} from "./support/desktop-tools-smoke";
import { prepareOpenCodeDesktopToolsBinary } from "./support/opencode-desktop-tools-binary";

for (const scenario of ["browser", "approval", "unavailable"] as const) {
  const available = scenario !== "unavailable";
  test(`OpenCode 2 drives the shared signed Desktop Tools through its native model client (${scenario})`, async () => {
    // oxlint-disable-next-line nodex/no-explicit-test-timeout -- One scenario runs several real Turns, a Stop and an app restart against the signed REPL.
    test.setTimeout(360_000);
    test.skip(
      process.platform !== "darwin" || process.arch !== "arm64",
      "The signed Desktop Tools require macOS Apple Silicon",
    );
    const binaryPath = await prepareOpenCodeDesktopToolsBinary();
    test.skip(!binaryPath, "OpenCode 2.1.4 is uncached and the npm registry is unreachable");
    let runRoot: string | undefined;
    try {
      const harness = await ElectronScenarioHarness.create({
        label: `opencode-desktop-${scenario}`,
        prepareAgentRuntime: !available,
        isolateHostDirectories: true,
        environment: { NODEX_LOG_FILE: "1" },
      });
      runRoot = harness.profile.runRoot;
      let model: Awaited<ReturnType<typeof startScriptedChatCompletionsServer>> | undefined;
      const exchanges: unknown[] = [];
      try {
        await runDesktopSmoke(
          "opencode",
          harness,
          async ({ page, script, title }) => {
            model = await startScriptedChatCompletionsServer((request) => {
              expect(request.model).toBe("nodex-desktop");
              const tools = request.tools?.map(({ function: { name } }) => name) ?? [];
              // Nodex title generation uses a separate provider query with the same prompt excerpt.
              if (
                request.messages.some(
                  ({ content }) =>
                    typeof content === "string" &&
                    content.includes("provide a short title for a task"),
                )
              ) {
                exchanges.push({ auxiliary: "nodex-title" });
                return { text: JSON.stringify({ title: "Desktop Tools smoke" }) };
              }
              // OpenCode can ask the same model for a background title without a tool catalog.
              if (
                tools.length === 0 &&
                request.messages.some(
                  ({ role, content }) => role === "system" && /title/iu.test(String(content)),
                )
              ) {
                exchanges.push({ auxiliary: "title" });
                return { text: "Desktop Tools smoke" };
              }
              const browserSkillAdvertised = JSON.stringify(request).includes(browserSkillName);
              const stepPrompt = request.messages.findLast(
                ({ role, content }) =>
                  role === "user" &&
                  typeof content === "string" &&
                  content.includes("[desktop-smoke:"),
              );
              const step = /\[desktop-smoke:(\w+)\]/u.exec(String(stepPrompt?.content))?.[1] as
                | DesktopSmokeStep
                | undefined;
              exchanges.push({
                step,
                tools,
                browserSkillAdvertised,
                roles: request.messages.map(({ role }) => role),
              });
              if (!step || !Object.hasOwn(script, step)) {
                const input = JSON.stringify(request.messages);
                if (/generat(e|ing).*title|title.*conversation/iu.test(input))
                  return { text: "Desktop Tools smoke" };
                throw new Error("Unexpected OpenCode model exchange without a smoke step");
              }
              const desktopTools = tools.filter((name) => /^node_repl[-_]/u.test(name));
              const js = desktopTools.find((name) => name.endsWith("_js"));
              expect(desktopTools.some((name) => name.includes("turn_ended"))).toBe(false);
              if (step === "unavailable") {
                expect(desktopTools).toEqual([]);
                expect(JSON.stringify(request)).not.toContain(browserSkillName);
                expect(JSON.stringify(request)).not.toContain("the `node_repl` MCP server");
                return { text: smokeMarker(step) };
              }
              expect(js, "OpenCode exposed the direct node_repl js tool").toBeDefined();
              if (step === "browser") expect(JSON.stringify(request)).toContain(browserSkillName);
              const results = script[step].map((_, index) =>
                request.messages.find(
                  ({ role, tool_call_id }) =>
                    role === "tool" && tool_call_id === `call_${step}_${index}`,
                ),
              );
              const next = results.findIndex((result) => !result);
              if (next !== -1) {
                return {
                  tool: js!,
                  id: `call_${step}_${next}`,
                  arguments: script[step][next]!,
                };
              }
              const output = JSON.stringify(results);
              const afterPrompt = request.messages.slice(
                request.messages.lastIndexOf(stepPrompt!) + 1,
              );
              const receivedImage = afterPrompt.some(
                ({ role, content }) =>
                  role === "user" &&
                  Array.isArray(content) &&
                  content.some(
                    (block) =>
                      block?.type === "image_url" &&
                      block.image_url?.url?.startsWith("data:image/"),
                  ),
              );
              exchanges.push({ step, resultCharacters: output.length, receivedImage });
              if (step === "browser") {
                expect(output).toContain(title);
                expect(receivedImage).toBe(true);
              }
              if (step === "memory") expect(output).toContain("DESKTOP_MEMORY_RETAINED");
              if (step === "grant") expect(output).toContain("DESKTOP_CHAT_GRANT");
              if (step === "origin") expect(output).toContain("DESKTOP_UNAPPROVED_ORIGIN");
              if (step === "reset") expect(output).toContain("undefined");
              if (step === "restart") expect(output).toContain("DESKTOP_RESTARTED");
              if (step === "decline") expect(output).toMatch(/denied|declined/u);
              if (step === "stop") return { text: "Stopped" };
              return { text: smokeMarker(step) };
            });
            const profileDirectory = path.join(harness.profile.runRoot, "opencode");
            const config = {
              providers: {
                fixture: {
                  name: "Nodex loopback",
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: { baseURL: model.baseUrl, apiKey: "loopback-fixture" },
                  models: {
                    "nodex-desktop": {
                      name: "Nodex Desktop Fixture",
                      capabilities: { tools: true, input: ["text", "image"] },
                      limit: { context: 64_000, output: 4_000 },
                    },
                  },
                },
              },
            };
            // The settings contract reserves OPENCODE_CONFIG_CONTENT for the managed profile.
            const configDir = path.join(profileDirectory, "config", "opencode");
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify(config));
            await invokeIpc(page, "settings:opencode-agents:update", {
              instances: [
                {
                  id: "opencode-default",
                  displayName: "OpenCode Desktop fixture",
                  enabled: true,
                  binaryPath,
                  profileDirectory,
                  serverUrl: null,
                  environment: Object.entries({
                    OPENCODE_DISABLE_MODELS_FETCH: "true",
                    OPENCODE_DISABLE_FREE_MODELS: "true",
                    OPENCODE_DISABLE_AUTOUPDATE: "true",
                    OPENCODE_DISABLE_FILEWATCHER: "true",
                    NO_PROXY: "*",
                    no_proxy: "*",
                  }).map(([name, value]) => ({ name, value, sensitive: false })),
                },
              ],
            });
            const instanceId = agentRuntimeProviderId({
              kind: "opencode",
              instanceConfigId: "opencode-default",
            });
            if (!instanceId) throw new Error("OpenCode fixture instance has no Runtime identity");
            // A new OpenCode model is off until explicitly enabled in this disposable Profile.
            await invokeIpc(
              page,
              "settings:model-policy:update",
              setModelOn(
                DEFAULT_MODEL_POLICY,
                { instanceId, driver: "opencode2" },
                "fixture/nodex-desktop",
                true,
              ),
            );
            return {
              select: async () => {
                await refreshComposerModels(page);
                await chooseComposerModel(page, "Nodex Desktop Fixture");
              },
              verify: () => expect(model?.errors).toEqual([]),
            };
          },
          scenario,
        );
      } finally {
        desktopEvidence("opencode", `model-${scenario}.json`, {
          exchanges,
          errors: model?.errors,
        });
        await model?.close();
        await harness.close();
      }
    } finally {
      if (runRoot) expect(realChromeHostPointsInto(runRoot)).toBe(false);
    }
  });
}
