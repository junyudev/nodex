import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { parseBundledAgentRuntimeMetadata } from "../../src/shared/codex-runtime-metadata";
import type { IpcApi } from "../../src/shared/ipc-api";

const repositoryRoot = process.cwd();
const records = (
  file: string,
): Array<{
  type?: string;
  method?: string;
  executable?: string;
  version?: string;
  params?: Record<string, unknown>;
}> => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
const invoke = <Channel extends keyof IpcApi>(
  page: Page,
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<IpcApi[Channel]["result"]> =>
  page.evaluate(
    async ({ channel, args }) => {
      if (!window.api) throw new Error("Fixture renderer bridge is unavailable");
      const invokeBridge = window.api.invoke as (
        channel: string,
        ...args: readonly unknown[]
      ) => Promise<unknown>;
      return await invokeBridge(channel, ...(args as readonly unknown[]));
    },
    { channel, args: args as unknown as unknown[] },
  ) as Promise<IpcApi[Channel]["result"]>;
const session = (page: Page, id: string) => invoke(page, "project-sessions:get", id);

// This starts only owned fixture processes and a fresh writable Profile.
test("preserves Session identity through native execution, selected-Run stop and process restart", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-runtime-session-"));
  const nativeLog = path.join(fixture, "native.jsonl");
  const wireLog = path.join(fixture, "wire.jsonl");
  const processLog = path.join(fixture, "process.log");
  const nodeLauncher = path.join(fixture, "node-runtime");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(
    nodeLauncher,
    `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(path.join(repositoryRoot, "tests/e2e/fixtures/agent-runtime-wire-observer.cjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  const version = "0.145.0-alpha.15";
  const source = fs.readFileSync(
    path.join(repositoryRoot, "tests/e2e/fixtures/codex-queue-app-server.mjs"),
    "utf8",
  );
  const peer = path.join(fixture, "codex.mjs");
  fs.writeFileSync(
    peer,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log(${JSON.stringify(`codex-cli ${version}`)}); process.exit(0); }\n${source.replace(/^#![^\n]*\n/u, "")}`,
  );
  const harness = await ElectronScenarioHarness.create({
    label: "agent-runtime-session",
    prepareAgentRuntime: false,
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
    environment: {
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: nodeLauncher,
      NODEX_FAKE_CODEX_STATE_PATH: path.join(fixture, "native-state.json"),
      NODEX_FAKE_CODEX_LOG_PATH: nativeLog,
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "1500",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_TEST_AGENT_RUNTIME_WIRE_LOG: wireLog,
    },
  });
  const runtime = prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, peer, version);
  const metadata = parseBundledAgentRuntimeMetadata(
    JSON.parse(fs.readFileSync(runtime.metadataPath, "utf8")),
  );
  expect(metadata?.releaseAsset.entrypointSha256).toBe(
    createHash("sha256").update(fs.readFileSync(runtime.executable)).digest("hex"),
  );
  expect(execFileSync(runtime.executable, ["--version"], { encoding: "utf8" }).trim()).toBe(
    `codex-cli ${version}`,
  );
  try {
    let page = await harness.launch({ phase: "first-window" });
    const captureProcessLogs = () => {
      for (const stream of [
        harness.application.process().stdout,
        harness.application.process().stderr,
      ])
        stream?.on("data", (bytes: Buffer) => fs.appendFileSync(processLog, bytes));
    };
    captureProcessLogs();
    await harness.waitForApplicationReady();
    const catalog = await invoke(page, "agent-runtime:providers:read", { refresh: true });
    expect(
      catalog.find((provider) => provider.instanceId === "codex")?.models.length,
    ).toBeGreaterThan(0);
    await page.getByRole("button", { name: "New chat" }).first().click();
    const composer = page.locator('[data-codex-composer="true"]').first();
    await expect(composer).toBeVisible();
    const project = (await invoke(page, "projects:list")).items[0];
    if (!project) throw new Error("Fixture Project missing");
    const tasks = await invoke(page, "workspace:tasks:list", project.id, { first: 50 });
    const draft = tasks.items.find((value) => !value.executionRef && value.thread === null);
    if (!draft) throw new Error("Fixture draft missing");
    const draftId = draft.id;
    const prompt = "Run the Session through its native Agent Runtime";
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect
      .poll(async () => (await session(page, draftId))?.executionRef?.threadId, { timeout: 30_000 })
      .toBeTruthy();
    const bound = await session(page, draftId);
    expect(bound?.id).toBe(draftId);
    expect(bound?.thread).toBeNull();
    const execution = bound!.executionRef!;
    await expect(
      page.locator('[data-user-message-bubble="true"]', { hasText: prompt }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      page.getByText("The task completed successfully.", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    expect(records(wireLog).filter((value) => value.method === "thread.snapshot")).toHaveLength(1);
    expect(records(wireLog).find((value) => value.type === "engine.started")).toMatchObject({
      executable: process.execPath,
      version: process.version,
    });
    expect(records(nativeLog).filter((value) => value.method === "thread/start")).toHaveLength(1);
    await composer.fill("Keep this Run active long enough to stop it");
    await composer.press("Enter");
    const stop = page.getByRole("button", { name: "Stop", exact: true }).first();
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await stop.click();
    await expect
      .poll(() => records(nativeLog).filter((value) => value.method === "turn/interrupt").length)
      .toBe(1);
    await expect
      .poll(async () => {
        const conversation = await invoke(page, "agent-runtime:session:read", {
          sessionId: draftId,
        });
        return conversation?.snapshot.projection.runs.at(-1)?.status;
      })
      .toBe("interrupted");
    await harness.stopElectron();
    page = await harness.launch({ phase: "first-window" });
    captureProcessLogs();
    await harness.waitForApplicationReady();
    expect((await session(page, draftId))?.executionRef).toEqual(execution);
    await expect(
      page.locator('[data-user-message-bubble="true"]', { hasText: prompt }),
    ).toHaveCount(1, { timeout: 30_000 });
    const resumedComposer = page.locator('[data-codex-composer="true"]').first();
    await expect(resumedComposer).toBeVisible();
    await resumedComposer.fill("Continue after the process restart");
    await resumedComposer.press("Enter");
    await expect
      .poll(() => records(nativeLog).filter((value) => value.method === "turn/start").length, {
        timeout: 30_000,
      })
      .toBe(3);
    await expect
      .poll(
        () =>
          records(nativeLog).filter(
            (value) => value.method === "rpc" && value.params?.method === "thread/resume",
          ).length,
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);
    expect((await session(page, draftId))?.id).toBe(draftId);
  } finally {
    await testInfo.attach("runtime-session-process.log", {
      body: fs.existsSync(processLog) ? fs.readFileSync(processLog) : Buffer.from(""),
      contentType: "text/plain",
    });
    await testInfo.attach("runtime-session-main.log", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 250_000)),
      contentType: "text/plain",
    });
    await testInfo.attach("runtime-session-wire.jsonl", {
      body: Buffer.from(fs.existsSync(wireLog) ? fs.readFileSync(wireLog, "utf8") : ""),
      contentType: "application/jsonl",
    });
    await testInfo.attach("runtime-session-native.jsonl", {
      body: Buffer.from(fs.existsSync(nativeLog) ? fs.readFileSync(nativeLog, "utf8") : ""),
      contentType: "application/jsonl",
    });
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
