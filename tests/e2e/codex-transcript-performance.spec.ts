import { expect, test, type Page } from "@playwright/test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
  waitForNodexWindowInitialization,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft, invokeIpc, sendAgentPrompt } from "./support/agent-smoke-harness";

const sampleCount = 30;
const prompt = "Stream the measured reply";

interface StreamScope {
  readonly sibling: Element;
  readonly row: Element | null;
  mutations: number;
  readonly observer: MutationObserver;
}

/** Watches one settled sibling while the reply beside it streams. */
const observeSibling = (page: Page) =>
  page.getByText("Unchanged sibling", { exact: true }).evaluate((element) => {
    const scope: StreamScope = {
      sibling: element,
      row: element.closest("[data-turn-key]"),
      mutations: 0,
      observer: new MutationObserver(() => {
        scope.mutations += 1;
      }),
    };
    scope.observer.observe(element, { subtree: true, childList: true, characterData: true });
    (window as typeof window & { __streamScope?: StreamScope }).__streamScope = scope;
  });

const readSibling = (page: Page) =>
  page.getByText("Unchanged sibling", { exact: true }).evaluate((element) => {
    const scope = (window as typeof window & { __streamScope: StreamScope }).__streamScope;
    scope.observer.disconnect();
    return {
      siblingIdentityPreserved: scope.sibling === element,
      rowIdentityPreserved: scope.row === element.closest("[data-turn-key]"),
      unrelatedTextMutations: scope.mutations,
    };
  });

test("streams an Agent chat reply into one item, across windows, without touching its siblings", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifactDirectory = path.resolve(
    process.env.NODEX_TRANSCRIPT_REVIEW_DIR ?? testInfo.outputPath(),
  );
  await mkdir(artifactDirectory, { recursive: true });
  const harness = await ElectronScenarioHarness.create({
    label: "transcript-streaming",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_CONTROLLED_PROMPT: prompt,
      NODEX_FAKE_CODEX_APP_SERVER_VERSION: "0.162.0-alpha.17.2",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-transcript-performance-app-server.mjs"),
    "0.162.0-alpha.17.2",
  );
  const stateDirectory = path.join(harness.profile.runRoot, ".fake-codex");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    path.join(stateDirectory, "state.json"),
    JSON.stringify({
      thread: null,
      turns: [],
      turnSequence: 0,
      queueSequence: 0,
      queuedSubmissions: [],
    }),
  );
  const command = (value: object) =>
    appendFile(path.join(stateDirectory, "commands.jsonl"), `${JSON.stringify(value)}\n`);
  const samplesMs: number[] = [];
  try {
    const first = await harness.launch();
    const draft = await createAgentSmokeDraft(
      first,
      harness.profile.initialProjectsDirectory,
      "Transcript streaming",
    );
    await sendAgentPrompt(first, draft.projectSessionId, prompt);
    await command({ type: "start" });
    const target = first.locator(
      '[data-message-copy-root*="stream-target"] [data-thread-selected-text-target="true"]',
    );
    await expect(first.getByText("Unchanged sibling", { exact: true })).toBeVisible();
    await expect(target).toContainText("Stream baseline");
    await observeSibling(first);
    // Each sample finishes a paragraph, so the reply reveals it as soon as it arrives.
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = `sample-${index.toString().padStart(3, "0")}`;
      const started = performance.now();
      await command({ type: "delta", delta: `\n\n${sample}\n\n` });
      await expect(target).toContainText(sample);
      samplesMs.push(performance.now() - started);
    }
    expect(await readSibling(first)).toEqual({
      siblingIdentityPreserved: true,
      rowIdentityPreserved: true,
      unrelatedTextMutations: 0,
    });

    // A second window follows the same reply after the first one leaves the chat.
    const opened = harness.application.waitForEvent("window");
    expect(
      await invokeIpc(first, "window:new", {
        activeProjectSessionId: draft.projectSessionId,
        activeProjectId: draft.projectId,
      }),
    ).toBe(true);
    const second = await opened;
    await waitForNodexWindowInitialization(second);
    const follower = second.locator(
      '[data-message-copy-root*="stream-target"] [data-thread-selected-text-target="true"]',
    );
    await expect(follower).toContainText(`sample-${(sampleCount - 1).toString().padStart(3, "0")}`);
    await first
      .getByRole("button", { name: "Start new chat in Transcript streaming", exact: true })
      .click();
    await command({ type: "delta", delta: "\n\nsample-follower\n\n" });
    await expect(follower).toContainText("sample-follower");
    const completionStarted = performance.now();
    await command({ type: "complete" });
    await expect(second.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
    const completionVisibleMs = performance.now() - completionStarted;
    const ordered = [...samplesMs].sort((left, right) => left - right);
    const result = {
      sampleCount,
      completionVisibleMs,
      streamVisibleMs: {
        median: ordered[Math.floor(ordered.length * 0.5)],
        p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
        raw: samplesMs,
      },
      measurementLimit:
        "Visible latency includes fixture file polling, Agent execution's block streaming and Playwright assertion polling.",
    };
    await writeFile(path.join(artifactDirectory, "result.json"), JSON.stringify(result, null, 2));
    await testInfo.attach("streaming-result", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
  } catch (error) {
    const logs = await readBoundedElectronRuntimeLogs(harness.profile);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\nElectron runtime logs:\n${logs}`,
      { cause: error },
    );
  } finally {
    await harness.close();
  }
});
