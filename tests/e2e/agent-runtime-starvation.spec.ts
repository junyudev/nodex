import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import type { AgentRuntimeConnectionState } from "../../src/shared/agent-runtime-api";
import type { IpcApi } from "../../src/shared/ipc-api";
import { openNewChatDraft } from "./support/new-chat-draft";

const repositoryRoot = process.cwd();
const NOTICE = "Agent execution isn't responding";
const PROMPT = "Keep this conversation readable while the computer is busy";

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

const connection = (page: Page): Promise<AgentRuntimeConnectionState> =>
  invoke(page, "agent-runtime:connection:read");
const messageOf = (page: Page) =>
  page.locator('[data-user-message-bubble="true"]', { hasText: PROMPT });
const noticeOf = (page: Page) => page.getByRole("status").filter({ hasText: NOTICE });

/** The exact execution child of this harness's own Electron process, never a name match. */
const executionPid = (electronPid: number): number => {
  const children = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
    .filter((match) => match !== null)
    .filter((match) => Number(match[2]) === electronPid && match[3]!.includes("--home"))
    .filter((match) => match[3]!.includes("--max-semi-space-size="));
  expect(children).toHaveLength(1);
  return Number(children[0]![1]);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Launches a fresh Profile with one finished chat, using only owned fixture processes. */
const withFinishedChat = async (
  options: {
    readonly label: string;
    readonly environment?: (fixture: string) => Readonly<Record<string, string>>;
  },
  body: (input: {
    readonly fixture: string;
    readonly harness: ElectronScenarioHarness;
    readonly page: Page;
    readonly sessionId: string;
  }) => Promise<void>,
) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-runtime-starvation-"));
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
    label: options.label,
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_STATE_PATH: path.join(fixture, "native-state.json"),
      NODEX_FAKE_CODEX_LOG_PATH: path.join(fixture, "native.jsonl"),
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "200",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      ...options.environment?.(fixture),
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, peer, version);
  try {
    const page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    const catalog = await invoke(page, "agent-runtime:providers:read", { refresh: true });
    expect(
      catalog.find((provider) => provider.instanceId === "codex")?.models.length,
    ).toBeGreaterThan(0);
    const composer = (await openNewChatDraft(page)).locator('[data-codex-composer="true"]').first();
    await expect(composer).toBeVisible();
    const project = (await invoke(page, "projects:list")).items[0];
    if (!project) throw new Error("Fixture Project missing");
    const tasks = await invoke(page, "workspace:tasks:list", project.id, { first: 50 });
    const draft = tasks.items.find((value) => !value.executionRef && value.thread === null);
    if (!draft) throw new Error("Fixture draft missing");
    await composer.fill(PROMPT);
    await composer.press("Enter");
    await expect(messageOf(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(
      page.getByText("The task completed successfully.", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await body({ fixture, harness, page, sessionId: draft.id });
  } finally {
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
};

// Stops only the execution process this test started, in a fresh writable Profile. A stopped
// process is what whole-machine starvation looks like from Main: alive, silent, and late.
test("a starved execution process delays a chat without failing it, and Restart replaces it", async ({}, testInfo) => {
  test.skip(process.platform === "win32", "Job control signals are POSIX-only.");
  test.setTimeout(240_000);
  let stopped: number | null = null;
  try {
    await withFinishedChat(
      { label: "agent-runtime-starvation" },
      async ({ harness, page, sessionId }) => {
        const message = messageOf(page);
        const notice = noticeOf(page);
        const failure = page.getByText("Thread could not be restored");
        const first = await connection(page);
        if (first.status !== "ready") throw new Error(`Execution is ${first.status}`);
        const electronPid = harness.application.process().pid!;
        const pid = executionPid(electronPid);

        // Reopening the chat is the read that used to give up at thirty seconds.
        process.kill(pid, "SIGSTOP");
        stopped = pid;
        const stoppedAt = Date.now();
        await page.reload();
        const read = invoke(page, "agent-runtime:session:read", { sessionId }).then(
          (value) => ({ settled: "resolved" as const, value }),
          (cause: unknown) => ({ settled: "rejected" as const, cause }),
        );
        await expect(notice).toBeVisible({ timeout: 45_000 });
        expect(await connection(page)).toEqual({
          status: "unresponsive",
          generation: first.generation,
        });
        await page.screenshot({ path: testInfo.outputPath("unresponsive.png") });
        await page.waitForTimeout(Math.max(0, stoppedAt + 40_000 - Date.now()));
        await expect(failure).toHaveCount(0);

        process.kill(pid, "SIGCONT");
        stopped = null;
        await expect(notice).toBeHidden({ timeout: 30_000 });
        const answered = await read;
        expect(answered.settled).toBe("resolved");
        await expect(message).toHaveCount(1, { timeout: 30_000 });
        await expect(failure).toHaveCount(0);
        expect(await connection(page)).toEqual({ status: "ready", generation: first.generation });
        expect(executionPid(electronPid)).toBe(pid);
        await page.screenshot({ path: testInfo.outputPath("recovered.png") });

        // A process that never answers has one way out, and only the person takes it.
        process.kill(pid, "SIGSTOP");
        stopped = pid;
        const pendingRead = invoke(page, "agent-runtime:session:read", { sessionId }).then(
          () => "resolved",
          () => "rejected",
        );
        await expect(notice).toBeVisible({ timeout: 45_000 });
        await notice.getByRole("button", { name: "Restart" }).click();
        await expect
          .poll(
            async () => {
              const state = await connection(page);
              return state.status === "ready" && state.generation !== first.generation;
            },
            { timeout: 60_000 },
          )
          .toBe(true);
        await expect.poll(() => isAlive(pid), { timeout: 30_000 }).toBe(false);
        stopped = null;
        // The read that was waiting on the old process is answered by its replacement.
        expect(await pendingRead).toBe("resolved");
        await expect(notice).toBeHidden();
        await expect(message).toHaveCount(1, { timeout: 30_000 });
        await expect(failure).toHaveCount(0);
      },
    );
  } finally {
    if (stopped !== null && isAlive(stopped)) process.kill(stopped, "SIGCONT");
  }
});

// The process keeps answering checks, so only the read's own age can reveal it.
test("a read stuck while the process still answers shows the notice instead of a silent wait", async ({}, testInfo) => {
  test.skip(process.platform === "win32", "The held-read launcher is a POSIX shell script.");
  test.setTimeout(300_000);
  const flagOf = (fixture: string) => path.join(fixture, "hold-reads");
  await withFinishedChat(
    {
      label: "agent-runtime-stuck-read",
      environment: (fixture) => {
        const launcher = path.join(fixture, "node-runtime");
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        fs.writeFileSync(
          launcher,
          `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(path.join(repositoryRoot, "tests/e2e/fixtures/agent-runtime-held-reads.cjs"))} "$@"\n`,
          { mode: 0o755 },
        );
        return {
          NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: launcher,
          NODEX_TEST_HELD_READS_FLAG: flagOf(fixture),
        };
      },
    },
    async ({ fixture, page }) => {
      const notice = noticeOf(page);
      const first = await connection(page);
      if (first.status !== "ready") throw new Error(`Execution is ${first.status}`);
      fs.writeFileSync(flagOf(fixture), "");
      await page.reload();

      // Under two minutes a slow read is ordinary; the process is plainly alive.
      await page.waitForTimeout(90_000);
      await expect(notice).toHaveCount(0);
      expect(await connection(page)).toEqual(first);

      await expect(notice).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: testInfo.outputPath("stuck-read.png") });

      fs.rmSync(flagOf(fixture));
      await expect(notice).toBeHidden({ timeout: 30_000 });
      await expect(messageOf(page)).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByText("Thread could not be restored")).toHaveCount(0);
      expect(await connection(page)).toEqual(first);
    },
  );
});
