import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import type { IpcApi } from "../../src/shared/ipc-api";

const invoke = <Channel extends keyof IpcApi>(
  page: Page,
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<IpcApi[Channel]["result"]> =>
  page.evaluate(
    async ({ channel, args }) => {
      const bridge = window.api as unknown as {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      };
      return await bridge.invoke(channel, ...args);
    },
    { channel, args: args as unknown as unknown[] },
  ) as Promise<IpcApi[Channel]["result"]>;

const connection = (page: Page) => invoke(page, "agent-runtime:connection:read");

// A launch that has nothing to resume must cost no execution process, even after a short session.
test("relaunching a quiet Profile lists models without starting execution", async () => {
  test.setTimeout(120_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-runtime-quiet-launch-"));
  const codex = path.join(fixture, "codex");
  const body = fs
    .readFileSync(path.resolve("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs"), "utf8")
    .replace(/^#![^\n]*\n/u, "");
  fs.writeFileSync(codex, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
  const harness = await ElectronScenarioHarness.create({
    label: "agent-runtime-quiet-launch",
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
  try {
    let page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    // A fresh Profile knows no models yet, so its first listing starts execution once.
    const live = await invoke(page, "agent-runtime:providers:read");
    expect(live.some((provider) => provider.instanceId === "codex")).toBe(true);
    await expect.poll(async () => (await connection(page)).status).toBe("ready");
    // Quitting while a read is still being answered keeps the stop quiet.
    void invoke(page, "agent-runtime:providers:read").catch(() => undefined);
    await harness.stopElectron();

    page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    const kept = await invoke(page, "agent-runtime:providers:read");
    expect(kept.map((provider) => provider.instanceId)).toEqual(
      live.map((provider) => provider.instanceId),
    );
    // Launch resume and execution-move recovery run right after startup; give them time to act.
    await page.waitForTimeout(3_000);
    expect(await connection(page)).toEqual({ status: "idle" });
  } finally {
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
