import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  AGENT_CLI_PROJECT_NAME,
  AGENT_CLI_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import type { IpcApi } from "../../src/shared/ipc-api";
import { chooseComposerModel } from "./support/composer-model-picker";

const BATCH_REPLIES = 260;
/** Replies alternate commands and file changes, so two batches cross the 1,000-item window. */
const BATCHES = 2;
const NUDGE_REPLIES = 5;
/** Odd replies write a file, so each of these leaves its body and its path in the heap if retained. */
const RELEASED_REPLIES = [45, 123, 201];
const RESIDENT_REPLY = 501;
/** Further back than one 500-item history page from the oldest resident reply. */
const FAR_BACK_REPLY = 19;

const replyBody = (index: number) => `Long turn reply ${index}\\n\\nAn ordinary`;
const replyParagraph = (index: number) => `"Long turn reply ${index}"`;
const replyFile = (index: number) => `long-turn/${index}.md`;
const replyTraces = (index: number) => [replyBody(index), replyParagraph(index), replyFile(index)];

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

test("a long running Turn holds a bounded window and reads its released history back", async () => {
  test.setTimeout(1_500_000);
  const harness = await ElectronScenarioHarness.create({
    label: "agent-runtime-long-turn-memory",
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
  });
  const nativeHome = path.join(harness.profile.runRoot, "claude-native");
  const workspace = path.join(harness.profile.runRoot, "long-turn-workspace");
  mkdirSync(workspace);
  const binaryPath = path.join(harness.profile.runRoot, "claude");
  const peer = pathToFileURL(path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"));
  writeFileSync(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(peer.href)});\n`, {
    mode: 0o755,
  });
  const signal = (name: string) => path.join(workspace, `.long-turn-${name}`);
  const rendererErrors: string[] = [];
  try {
    const page = await harness.launch();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.waitForApplicationReady();
    await harness.application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
    });
    await materializeScenario(AGENT_CLI_SCENARIO_ID, new RendererIpcSeedAdapter(page), workspace);
    await invoke(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "claude-default",
          displayName: "Claude Code",
          binaryPath,
          configDirectory: nativeHome,
          enabled: true,
          customModels: [],
          environment: [],
        },
      ],
    });
    await page
      .getByRole("button", { name: `Start new chat in ${AGENT_CLI_PROJECT_NAME}`, exact: true })
      .click();
    await chooseComposerModel(page, "Claude Opus 5", "Claude Opus 5");
    const composer = page.locator('[data-codex-composer="true"]:visible').first();
    await expect(composer).toBeEditable();
    await composer.fill("Verify long turn");
    await composer.press("Enter");

    // The opening reply may also appear in a Readback card outside the transcript.
    const transcript = page.locator('[data-local-conversation-transcript="true"]');
    const reply = (index: number) =>
      transcript.getByText(`Long turn reply ${index}`, { exact: true });
    const runBatch = async (batch: number, replies = BATCH_REPLIES, newest = replies - 1) => {
      writeFileSync(signal(`go-${batch}`), String(replies));
      await expect
        .poll(() => existsSync(signal(`done-${batch}`)), { timeout: 300_000, intervals: [100] })
        .toBe(true);
      await expect(reply(newest)).toBeInViewport({ timeout: 600_000 });
    };
    for (let batch = 0; batch < BATCHES; batch += 1)
      await runBatch(batch, BATCH_REPLIES, (batch + 1) * BATCH_REPLIES - 1);
    // Release waits for a reader who has fallen behind the tail, so see it happen first.
    await expect(reply(0)).toHaveCount(0, { timeout: 120_000 });
    // React holds its last render until the next one, so released work stays until then.
    await runBatch(BATCHES, NUDGE_REPLIES, BATCHES * BATCH_REPLIES + NUDGE_REPLIES - 1);

    const cdp = await page.context().newCDPSession(page);
    const heapHolds = async (needles: readonly string[]) => {
      const held = new Set<string>();
      const overlap = Math.max(...needles.map((needle) => needle.length));
      let tail = "";
      const onChunk = ({ chunk }: { readonly chunk: string }) => {
        const text = tail + chunk;
        for (const needle of needles) if (text.includes(needle)) held.add(needle);
        tail = text.slice(-overlap);
      };
      cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
      await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
      return needles.filter((needle) => held.has(needle));
    };
    // Heap totals vary with rendering state; whether released work still exists does not.
    const resident = replyTraces(RESIDENT_REPLY);
    expect(await heapHolds([...RELEASED_REPLIES.flatMap(replyTraces), ...resident])).toEqual(
      resident,
    );

    // Released history reads back in place as the reader scrolls toward it, page after page.
    const box = await reply(BATCHES * BATCH_REPLIES + NUDGE_REPLIES - 1).boundingBox();
    if (!box) throw new Error("The newest reply is not on screen");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -4_000);
          return await reply(FAR_BACK_REPLY).count();
        },
        { timeout: 300_000, intervals: [50] },
      )
      .toBeGreaterThan(0);
    await expect(reply(FAR_BACK_REPLY)).toBeVisible();
    expect(rendererErrors).toEqual([]);

    writeFileSync(signal("finish"), "");
    await expect(transcript.getByText("Long turn finished", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
  } finally {
    await harness.close();
  }
});
