import { readCoreRuntimeConnection } from "../../src/main/core-client/runtime-descriptor";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { invokeIpc } from "./support/agent-smoke-harness";

const exec = promisify(execFile);

test("the real Desktop binds plain nodex to its connected Profile and task Project", async ({}, testInfo) => {
  const harness = await ElectronScenarioHarness.create({
    label: "cli-turn-context",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
    },
  });
  try {
    prepareScenarioCodexAppServerRuntimeSync(
      harness.profile.runRoot,
      path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
    );
    const page = await harness.launch();
    const seed = new RendererIpcSeedAdapter(page);
    const manifest = await materializeScenario(
      "agent/cli-workflow",
      seed,
      harness.profile.initialProjectsDirectory,
    );
    expect(
      await invokeIpc(page, "codex:permission:mode:set", manifest.projectId, "full-access"),
    ).toMatchObject({ mode: "full-access" });
    await page
      .getByRole("button", { name: "Start new chat in Agent CLI Lab", exact: true })
      .click();
    const composer = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .last();
    const send = page.getByRole("button", { name: "Send prompt", exact: true });
    await expect(async () => {
      await composer.fill("Hold the active turn for CLI context verification");
      await expect(composer).toHaveText("Hold the active turn for CLI context verification", {
        timeout: 1_000,
      });
      await expect(send).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await send.click();
    const log = path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl");
    let threadId: string | undefined;
    let shellEnvironment: Record<string, string> | undefined;
    let connection: string | undefined;
    await expect
      .poll(async () => {
        const rows = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const launch = rows.find((row) => row.method === "launch");
        shellEnvironment = launch
          ? Object.fromEntries(
              launch.params.args
                .filter((arg: string) => arg.startsWith("shell_environment_policy.set."))
                .map((arg: string) => {
                  const equal = arg.indexOf("=");
                  return [
                    arg.slice("shell_environment_policy.set.".length, equal),
                    JSON.parse(arg.slice(equal + 1)),
                  ];
                }),
            )
          : undefined;
        const request = rows.find(
          (row) => row.method === "rpc" && row.params.method === "turn/start",
        );
        const context = request?.params.params.additionalContext?.["nodex-cli"]?.value as
          | string
          | undefined;
        connection = context;
        threadId = request?.params.params.threadId;
        return connection;
      })
      .toBeTruthy();
    expect(threadId, connection).toBeDefined();
    expect(shellEnvironment?.PATH).toBeDefined();
    const result = await exec("/bin/zsh", ["-lc", "nodex context"], {
      cwd: harness.profile.runRoot,
      env: {
        ...shellEnvironment,
        CODEX_THREAD_ID: threadId,
        NODEX_HOME: "/unavailable/other-profile",
      },
    });
    const resolved = JSON.parse(result.stdout).result;
    expect(resolved.project.id).toBe(manifest.projectId);
    expect(resolved.profile.id).toBe(
      readCoreRuntimeConnection(harness.profile.nodexHome).descriptor.profile_id,
    );
    await page.getByRole("button", { name: "Stop", exact: true }).click();
  } finally {
    await testInfo.attach("requests", {
      body: await readFile(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl")).catch(
        () => Buffer.from("No requests"),
      ),
      contentType: "application/jsonl",
    });
    await harness.close();
  }
});
