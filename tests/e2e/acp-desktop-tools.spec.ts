import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import type { ScriptedAcpScenario } from "../../scripts/scenarios/runtime/scripted-acp-agent";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc } from "./support/agent-smoke-harness";
import { chooseComposerModel } from "./support/composer-model-picker";
import {
  browserSkillName,
  realChromeHostPointsInto,
  desktopEvidence,
  runDesktopSmoke,
  smokeMarker,
  type DesktopSmokeStep,
} from "./support/desktop-tools-smoke";

interface Observation {
  method: string;
  names?: string[];
  tools?: string[];
  promptText?: string[];
  title?: string;
  isError?: boolean;
  text?: string[];
  contentTypes?: string[];
}

for (const scenario of ["browser", "approval", "unavailable"] as const) {
  const available = scenario !== "unavailable";
  test(`ACP drives the shared signed Desktop Tools through a local stdio agent (${scenario})`, async () => {
    // oxlint-disable-next-line nodex/no-explicit-test-timeout -- One scenario runs several real Turns, a Stop and an app restart against the signed REPL.
    test.setTimeout(360_000);
    test.skip(
      process.platform !== "darwin" || process.arch !== "arm64",
      "The signed Desktop Tools require macOS Apple Silicon",
    );
    let runRoot: string | undefined;
    try {
      const harness = await ElectronScenarioHarness.create({
        label: `acp-desktop-${scenario}`,
        prepareAgentRuntime: !available,
        isolateHostDirectories: true,
        environment: { NODEX_LOG_FILE: "1" },
      });
      runRoot = harness.profile.runRoot;
      const observation = path.join(harness.profile.runRoot, "acp-observation.json");
      const observations = (): Observation[] =>
        fs.existsSync(observation) ? JSON.parse(fs.readFileSync(observation, "utf8")) : [];
      try {
        await runDesktopSmoke(
          "acp",
          harness,
          async ({ page, script, title }) => {
            const instanceId = "acp-desktop-e2e";
            const peerScenario = {
              sessionLifecycle: { load: true },
              sessionConfig: {
                id: "model",
                category: "model",
                currentValue: "default",
                values: ["default"],
              },
              recordPromptText: true,
              desktopTurns: Object.fromEntries(
                Object.entries(script).map(([step, calls]) => [
                  `[desktop-smoke:${step}]`,
                  { calls, reply: smokeMarker(step as DesktopSmokeStep) },
                ]),
              ),
            } satisfies ScriptedAcpScenario;
            await invokeIpc(page, "settings:acp-agents:update", {
              instances: [
                {
                  id: instanceId,
                  agentDefinitionId: "scripted-agent",
                  displayName: "ACP Desktop fixture",
                  enabled: true,
                  source: {
                    kind: "local",
                    executable: process.execPath,
                    args: [path.resolve("scripts/scenarios/runtime/scripted-acp-agent.ts")],
                  },
                  environment: Object.entries({
                    NODEX_SCRIPTED_ACP_SCENARIO: JSON.stringify(peerScenario),
                    NODEX_SCRIPTED_ACP_OBSERVATION: observation,
                  }).map(([name, value]) => ({ name, value, sensitive: false })),
                  customModels: [],
                  credentials: {
                    kind: "isolated-home",
                    home: path.join(harness.profile.runRoot, "acp-home"),
                  },
                  proxy: "isolated",
                },
              ],
            });
            const operationId = createUuidV7();
            const started = (await invokeIpc(page, "acp:connection:start", {
              instanceId,
              operationId,
            })) as { ok: boolean; error?: { message: string } };
            if (!started.ok)
              throw new Error(started.error?.message ?? "Could not start the ACP fixture");
            await expect
              .poll(async () => {
                const result = (await invokeIpc(page, "acp:operation:read", {
                  operationId,
                })) as { ok: boolean; value?: { phase: string } };
                return result.value?.phase;
              })
              .toBe("succeeded");
            return {
              select: () => chooseComposerModel(page, "ACP Desktop fixture"),
              verify: async (step) => {
                const events = observations();
                const servers = events
                  .filter(({ method }) => method === "desktop/servers")
                  .at(-1)?.names;
                const prompt = events
                  .filter(({ method }) => method === "session/prompt")
                  .at(-1)
                  ?.promptText?.join("\n");
                if (step === "unavailable") {
                  expect(servers).toBeDefined();
                  expect(servers).not.toContain("node_repl");
                  expect(prompt).toBeDefined();
                  expect(prompt).not.toContain(browserSkillName);
                  expect(prompt).not.toContain("node_repl");
                  return;
                }
                if (step === "browser") {
                  expect(servers).toContain("node_repl");
                  expect(prompt).toMatch(/\/[^\n]+\/control-in-app-browser\/SKILL\.md/u);
                  const tools = events
                    .filter(({ method }) => method === "node_repl/tools/list")
                    .flatMap(({ tools }) => tools ?? []);
                  expect(tools).toContain("js");
                  expect(tools).not.toContain("turn_ended");
                  expect(
                    events.find(({ title }) => title === script.browser[1]!.title),
                  ).toMatchObject({
                    isError: false,
                    text: expect.arrayContaining([title]),
                    contentTypes: expect.arrayContaining(["image"]),
                  });
                }
                if (step === "stop") {
                  await expect
                    .poll(() => observations().some(({ method }) => method === "session/cancel"))
                    .toBe(true);
                  return;
                }
                const results = events.filter(
                  ({ method, title }) =>
                    method === "node_repl/tools/result" &&
                    script[step].some((call) => call.title === title),
                );
                expect(results).toHaveLength(script[step].length);
                expect(results.map(({ isError }) => isError)).toEqual(
                  script[step].map(() => step === "decline"),
                );
                const output = results.flatMap(({ text }) => text ?? []).join("\n");
                if (step === "memory") expect(output).toContain("DESKTOP_MEMORY_RETAINED");
                if (step === "origin") expect(output).toContain("DESKTOP_UNAPPROVED_ORIGIN");
                if (step === "reset") expect(output).toContain("undefined");
                if (step === "restart") expect(output).toContain("DESKTOP_RESTARTED");
                if (step === "decline") expect(output).toMatch(/denied|declined/u);
              },
            };
          },
          scenario,
        );
      } finally {
        desktopEvidence("acp", `peer-${scenario}.json`, observations());
        await harness.close();
      }
    } finally {
      if (runRoot) expect(realChromeHostPointsInto(runRoot)).toBe(false);
    }
  });
}
