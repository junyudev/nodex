import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import type { IpcApi } from "../../src/shared/ipc-api";
import { waitForDraftScene } from "./support/new-chat-draft";

const FANOUT = 24;
/** One execution process; generous enough for a loaded host, far below a per-child process. */
const ENGINE_RSS_CEILING_MIB = 512;

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

interface NativeRecord {
  readonly event?: string;
  readonly method?: string;
  readonly threadId?: string | null;
  readonly prompt?: string;
  readonly taskId?: string;
  readonly taskIds?: readonly string[];
  readonly text?: string;
}

/** The execution process and the Codex app-servers it owns, found from the Electron main pid. */
const executionProcesses = (mainPid: number) => {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,args="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              rssKiB: Number(match[3]),
              args: match[4]!,
            },
          ]
        : [];
    });
  const descendants = (roots: ReadonlySet<number>) => {
    const owned = new Set(roots);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows)
        if (owned.has(row.ppid) && !owned.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
    }
    return rows.filter((row) => owned.has(row.pid) && !roots.has(row.pid));
  };
  const engines = descendants(new Set([mainPid])).filter((row) =>
    /agent-runtime\/entry\.mjs/u.test(row.args),
  );
  const providers = descendants(new Set(engines.map((row) => row.pid))).filter((row) =>
    /\bapp-server\b/u.test(row.args),
  );
  return { engines, providers };
};

test("fans out, batches completions, times out waits and steers while staying one bounded process", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-runtime-pressure-"));
  const codex = path.join(fixture, "codex");
  const body = fs
    .readFileSync(path.resolve("tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs"), "utf8")
    .replace(/^#![^\n]*\n/u, "");
  fs.writeFileSync(codex, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, "plan.json"), "{}");
  const records = () =>
    fs.existsSync(path.join(fixture, "native.jsonl"))
      ? fs
          .readFileSync(path.join(fixture, "native.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as NativeRecord)
      : [];
  const harness = await ElectronScenarioHarness.create({
    label: "agent-runtime-delegation-pressure",
    prepareAgentRuntime: false,
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: process.execPath,
      NODEX_TEST_CROSS_PROVIDER_HOME: fixture,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, codex, "0.145.0-alpha.15");
  const samples: Array<{ phase: string; engineRssMiB: number[]; providers: number }> = [];
  try {
    const page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    const sample = (phase: string) => {
      const found = executionProcesses(harness.application.process().pid!);
      samples.push({
        phase,
        engineRssMiB: found.engines.map((row) => Math.round(row.rssKiB / 1024)),
        providers: found.providers.length,
      });
    };
    const codexModel = (await invoke(page, "agent-runtime:providers:read", { refresh: true })).find(
      (provider) => provider.instanceId === "codex",
    )?.models[0];
    if (!codexModel) throw new Error("The Codex fixture catalog must be available");
    const target = { providerInstanceId: "codex", model: codexModel.slug };
    fs.writeFileSync(
      path.join(fixture, "plan.json"),
      JSON.stringify({
        "Fan out pressure": { task: "Pressure child", target, fanout: FANOUT },
        "Wait on held pressure child": {
          task: "Hold async pressure report",
          target,
          mode: "wait",
          timeoutMs: 400,
        },
      }),
    );
    const project = (await invoke(page, "projects:list")).items[0];
    if (!project) throw new Error("Fixture Project missing");
    const submit = async (prompt: string) => {
      await page
        .getByRole("button", { name: `Start new chat in ${project.name}`, exact: true })
        .click();
      const receipt = await invoke(page, "project-sessions:ensure-default-draft", {
        operationId: createBoundedOperationId("session.ensure-default-draft"),
        payload: { candidateSessionId: randomUUID(), projectId: project.id },
      });
      if (!("value" in receipt)) throw new Error("Default draft admission failed");
      const scene = await waitForDraftScene(page, receipt.value.id);
      const composer = scene.locator('[data-codex-composer="true"]:visible');
      await composer.fill(prompt);
      await composer.press("Enter");
      await expect
        .poll(
          async () => (await invoke(page, "project-sessions:get", receipt.value.id))?.executionRef,
        )
        .toBeTruthy();
      return receipt.value.id;
    };
    const overviewTaskIds = async (sessionId: string) => {
      const ids: string[] = [];
      for (const lane of ["active", "terminal"] as const) {
        let cursor: string | undefined;
        do {
          const overview = await invoke(page, "agent-runtime:session:overview", {
            sessionId,
            ...(cursor === undefined
              ? {}
              : lane === "active"
                ? { activeCursor: cursor }
                : { terminalCursor: cursor }),
          });
          ids.push(...overview[lane].items.map((item) => item.id));
          cursor = overview[lane].nextCursor ?? undefined;
        } while (cursor !== undefined);
      }
      return ids;
    };

    // Many children: every result reaches the parent exactly once.
    const fanout = await submit("Fan out pressure");
    const sampler = setInterval(() => sample("fan-out"), 250);
    try {
      await expect(
        page.getByText(`Codex delegated ${FANOUT} async children`, { exact: true }).first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(() => records().filter((row) => row.event === "task.result-read").length, {
          timeout: 120_000,
        })
        .toBe(FANOUT);
    } finally {
      clearInterval(sampler);
    }
    const delegated = records().find((row) => row.event === "fanout.delegated")?.taskIds ?? [];
    const read = records()
      .filter((row) => row.event === "task.result-read")
      .map((row) => row.taskId);
    expect(delegated).toHaveLength(FANOUT);
    expect(new Set(read)).toEqual(new Set(delegated));
    expect(read).toHaveLength(FANOUT);
    // Results reach the parent as wake turns or, while its Run is active, steered into it.
    const deliveries = records().filter(
      (row) =>
        (row.event === "prompt" && row.prompt?.startsWith("Delegated task")) ||
        (row.event === "steer" && row.text?.startsWith("Delegated task")),
    );
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.length).toBeLessThanOrEqual(FANOUT);
    const listed = await overviewTaskIds(fanout);
    expect(listed).toHaveLength(FANOUT);
    expect(new Set(listed)).toEqual(new Set(delegated));
    await expect
      .poll(
        async () =>
          (await invoke(page, "agent-runtime:session:inspect", { sessionId: fanout })).thread
            .activeRunId,
        { timeout: 30_000 },
      )
      .toBeNull();

    // A waiting delegation returns at its timeout while the child keeps running.
    const waiting = await submit("Wait on held pressure child");
    await expect(page.getByText("Codex received running", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    const held = (await invoke(page, "agent-runtime:session:overview", { sessionId: waiting }))
      .active.items;
    expect(held).toHaveLength(1);
    expect(["pending", "running", "waiting"]).toContain(held[0]!.status);
    fs.writeFileSync(path.join(fixture, "async-release"), "complete");
    await expect(
      page.getByText("Codex received async Codex child report", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // A steer joins the parent's active Run instead of starting another.
    const steered = await submit("Hold child root for steer");
    await expect
      .poll(
        async () =>
          (await invoke(page, "agent-runtime:session:inspect", { sessionId: steered })).thread
            .activeRunId,
      )
      .not.toBeNull();
    const activeRunId = (
      await invoke(page, "agent-runtime:session:inspect", { sessionId: steered })
    ).thread.activeRunId!;
    const nativeRoot = records().find(
      (row) => row.event === "prompt" && row.prompt === "Hold child root for steer",
    )?.threadId;
    await invoke(page, "agent-runtime:session:message", {
      sessionId: steered,
      message: { messageId: randomUUID(), text: "Steer pressure" },
      intent: "steer",
    });
    await expect
      .poll(() =>
        records().some(
          (row) =>
            row.event === "steer" && row.threadId === nativeRoot && row.text === "Steer pressure",
        ),
      )
      .toBe(true);
    expect(
      (await invoke(page, "agent-runtime:session:inspect", { sessionId: steered })).thread
        .activeRunId,
    ).toBe(activeRunId);
    await invoke(page, "agent-runtime:session:stop", { sessionId: steered, runId: activeRunId });
    await expect
      .poll(
        async () =>
          (await invoke(page, "agent-runtime:session:inspect", { sessionId: steered })).thread
            .activeRunId,
      )
      .not.toBe(activeRunId);

    // All of it ran in one execution process with one shared provider process.
    sample("settled");
    const peakEngine = Math.max(...samples.flatMap((row) => row.engineRssMiB));
    expect(samples.every((row) => row.engineRssMiB.length === 1)).toBe(true);
    expect(peakEngine).toBeLessThan(ENGINE_RSS_CEILING_MIB);
    expect(Math.max(...samples.map((row) => row.providers))).toBe(1);
  } finally {
    await testInfo.attach("delegation-pressure-processes.json", {
      body: Buffer.from(JSON.stringify(samples)),
      contentType: "application/json",
    });
    await testInfo.attach("delegation-pressure-main.log", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile, 250_000)),
      contentType: "text/plain",
    });
    await testInfo.attach("delegation-pressure-native.jsonl", {
      body: fs.existsSync(path.join(fixture, "native.jsonl"))
        ? fs.readFileSync(path.join(fixture, "native.jsonl"))
        : Buffer.from(""),
      contentType: "text/plain",
    });
    await harness.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
