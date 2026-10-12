import { expect, test } from "@playwright/test";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft, sendAgentPrompt } from "./support/agent-smoke-harness";
import { buildTranscriptPerformanceCorpus } from "./support/transcript-performance-corpus";
import {
  installTranscriptPortProbe,
  readTranscriptPortEvidence,
  type TranscriptPortEvidence,
} from "./support/transcript-port-probe";
import { waitForNodexWindowInitialization } from "../../scripts/scenarios/harness/electron-e2e-harness";

test("releases completed item prefixes at the live viewport and reloads through an exclusive anchor", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const artifactDirectory = path.resolve(
    process.env.NODEX_TRANSCRIPT_REVIEW_DIR ?? testInfo.outputPath(),
  );
  await mkdir(artifactDirectory, { recursive: true });
  const prepared = JSON.parse(
    await readFile(".generated/prepared-electron-build.json", "utf8"),
  ) as { source: object; inputDigest: string; generationId: string };
  const harness = await ElectronScenarioHarness.create({
    label: "transcript-viewport-eviction",
    prepareAgentRuntime: false,
    enabledFeatures: ["active-history-eviction", "runtime-metrics"],
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_ROLLOUT_PATH: ".fake-codex/synthetic-rollout.jsonl",
      NODEX_FAKE_CODEX_PRESSURE_PAGE_RELEASE_PATH: ".fake-codex/pressure-page-release",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "120",
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
  let failed: unknown;
  const consoleErrors: string[] = [];
  const anchorScrollSteps: object[] = [];
  try {
    const initial = await harness.launch();
    const draft = await createAgentSmokeDraft(
      initial,
      harness.profile.initialProjectsDirectory,
      "Viewport retention",
    );
    const threadId = await sendAgentPrompt(
      initial,
      draft.projectSessionId,
      "Prepare viewport retention",
    );
    await expect(
      initial.getByText("The task completed successfully.", { exact: true }),
    ).toBeVisible();
    const publicState = JSON.parse(
      await readFile(path.join(stateDirectory, "state.json"), "utf8"),
    ) as { thread: { id: string }; turns: ReturnType<typeof buildTranscriptPerformanceCorpus> };
    expect(publicState.thread.id).toBe(threadId);
    expect(publicState.turns).toHaveLength(1);
    expect(publicState.turns[0].status).toBe("completed");
    const scaledStatePath = path.join(stateDirectory, "scaled-state.tmp");
    await writeFile(
      scaledStatePath,
      JSON.stringify({
        ...publicState,
        turns: [...buildTranscriptPerformanceCorpus(8), ...publicState.turns],
      }),
    );
    await rename(scaledStatePath, path.join(stateDirectory, "state.json"));
    const page = await harness.restart();
    page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await installTranscriptPortProbe(page);
    await page.reload();
    await waitForNodexWindowInitialization(page);
    if (process.env.NODEX_TRANSCRIPT_TRACE === "1")
      await harness.application
        .context()
        .tracing.start({ screenshots: true, snapshots: true, sources: true });
    await expect(page.getByText("The task completed successfully.", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await readTranscriptPortEvidence(page)).resumeStates, {
        timeout: 30_000,
      })
      .toEqual(["resumed"]);
    const pressureStarted = performance.now();
    await appendFile(
      path.join(stateDirectory, "commands.jsonl"),
      `${JSON.stringify({ type: "pressure" })}\n`,
    );
    await expect(page.getByText("Eviction viewport marker.", { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await expect
      .poll(async () => (await readTranscriptPortEvidence(page)).maxPressureItemCount, {
        timeout: 30_000,
      })
      .toBe(1001);
    const pressureReadyMs = performance.now() - pressureStarted;
    const scroll = page.locator("[data-local-conversation-thread-body='true']");
    await scroll.hover();
    await page.mouse.wheel(0, 100_000);
    let retained: TranscriptPortEvidence | undefined;
    await expect
      .poll(
        async () => {
          retained = await readTranscriptPortEvidence(page);
          return retained.evictionFrame?.residentItemCount;
        },
        { timeout: 30_000 },
      )
      .toBe(500);
    expect(retained!.observerErrors).toBe(0);
    expect(retained!.maxPressureItemCount).toBe(1001);
    const evictionFrame = retained!.evictionFrame!;
    expect(evictionFrame.pressureItemIds).toHaveLength(499);
    expect(evictionFrame.pressureSlotItemIds).toHaveLength(499);
    expect(evictionFrame.pressureSlotItemIds).toEqual(evictionFrame.pressureItemIds);
    expect(evictionFrame.pressureItemIds[0]).toBe("pressure-command-0502");
    expect(evictionFrame.pressureItemIds.includes("pressure-command-0000")).toBe(false);
    const metricsAfterEviction = await harness.application.evaluate(({ app }) =>
      app.getAppMetrics().map((entry) => ({ type: entry.type, memory: entry.memory })),
    );
    await writeFile(
      path.join(artifactDirectory, "eviction-preparation.json"),
      JSON.stringify(
        { status: "prepared", pressureReadyMs, retained, metricsAfterEviction },
        null,
        2,
      ),
    );
    const logPath = path.join(stateDirectory, "requests.jsonl");
    const requests = async () =>
      (await readFile(logPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              params: {
                method?: string;
                params?: {
                  turnId?: string;
                  cursor?: { type?: string; itemId?: string };
                  sortDirection?: string;
                };
              };
            },
        );
    await expect
      .poll(
        async () => {
          const anchorRequested = (await requests()).some(
            (entry) =>
              entry.method === "rpc" &&
              entry.params.method === "thread/items/list" &&
              entry.params.params?.turnId === "pressure-turn" &&
              entry.params.params.cursor?.type === "item" &&
              entry.params.params.cursor.itemId === "pressure-command-0502",
          );
          if (anchorRequested) return true;
          const geometry = await page.evaluate(() => {
            let element = document.querySelector<HTMLElement>(
              "[data-local-conversation-thread-body='true']",
            );
            while (element && getComputedStyle(element).overflowY !== "auto")
              element = element.parentElement;
            if (!element) throw new Error("Transcript scroll viewport is missing");
            const viewport = element.getBoundingClientRect();
            return {
              scrollTop: element.scrollTop,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
              gaps: [
                ...element.querySelectorAll<HTMLElement>(
                  '[data-virtualized-turn-content][aria-hidden="true"]',
                ),
              ].map((gap) => {
                const rect = gap.getBoundingClientRect();
                return {
                  top: rect.top - viewport.top,
                  bottom: rect.bottom - viewport.top,
                  height: rect.height,
                };
              }),
            };
          });
          anchorScrollSteps.push(geometry);
          // Keep each wheel within the viewport so its recovery gap cannot be skipped.
          await page.mouse.wheel(0, -Math.min(300, geometry.clientHeight / 2));
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          return false;
        },
        { timeout: 30_000, intervals: [100] },
      )
      .toBe(true);
    let reloaded: TranscriptPortEvidence | undefined;
    await expect
      .poll(
        async () => {
          reloaded = await readTranscriptPortEvidence(page);
          return reloaded.anchorReloadFrame?.pressureItemIds[0];
        },
        { timeout: 30_000 },
      )
      .toBe("pressure-command-0402");
    const anchorReloadFrame = reloaded!.anchorReloadFrame!;
    const reloadedItems = anchorReloadFrame.pressureItemIds;
    expect(anchorReloadFrame.pressureSlotItemIds).toEqual(reloadedItems);
    expect(reloadedItems).toHaveLength(599);
    expect(anchorReloadFrame.pressureSlotItemIds).toHaveLength(599);
    expect(new Set(anchorReloadFrame.pressureSlotItemIds).size).toBe(reloadedItems.length);
    const anchorRequests = (await requests()).filter(
      (entry) =>
        entry.params.method === "thread/items/list" && entry.params.params?.cursor?.type === "item",
    );
    expect(anchorRequests[0]?.params.params).toMatchObject({
      turnId: "pressure-turn",
      sortDirection: "desc",
      cursor: { type: "item", itemId: "pressure-command-0502" },
      limit: 100,
    });
    const barrierWasHeld = (await requests()).some(
      (entry) => entry.method === "pressure-page-held",
    );
    await appendFile(
      path.join(stateDirectory, "commands.jsonl"),
      `${JSON.stringify({ type: "release-pressure-page" })}\n`,
    );
    await expect
      .poll(async () =>
        (await requests()).some(
          (entry) =>
            entry.method === "fixture-command" &&
            (entry.params as { type?: string }).type === "release-pressure-page",
        ),
      )
      .toBe(true);
    if (barrierWasHeld)
      await expect
        .poll(async () => (await readTranscriptPortEvidence(page)).pressureItemIds.length)
        .toBeGreaterThan(599);
    reloaded = await readTranscriptPortEvidence(page);
    await page.screenshot({ path: path.join(artifactDirectory, "eviction-final.png") });
    const result = {
      status: "passed",
      runId: process.env.NODEX_TRANSCRIPT_REVIEW_RUN_ID ?? null,
      preparedBuild: {
        source: prepared.source,
        inputDigest: prepared.inputDigest,
        generationId: prepared.generationId,
      },
      threadId,
      scenario: "synthetic-1001-completed-commands-with-live-viewport",
      claims: [
        {
          claim: "committed normalized item target after configured viewport eviction",
          expected: 500,
          actual: evictionFrame.residentItemCount,
        },
        {
          claim: "removed pressure prefix is absent from normalized subscription identities",
          expected: false,
          actual: evictionFrame.pressureItemIds.includes("pressure-command-0000"),
        },
        {
          claim: "exclusive descending anchor reloads the preceding page",
          expected: "pressure-command-0402",
          actual: reloadedItems[0],
        },
        {
          claim: "reloaded item identities are unique",
          expected: reloadedItems.length,
          actual: new Set(anchorReloadFrame.pressureSlotItemIds).size,
        },
      ],
      anchorRequests,
      anchorScrollSteps,
      pageBoundaryControl: {
        nextOpaqueCursor: "pressure-command-0401",
        barrierWasHeld,
        release: "explicit fixture command after committed599 assertion",
      },
      retained,
      evictionFrame,
      anchorReloadFrame,
      reloaded,
      nativeRequests: await requests(),
      metricsAfterEviction,
      pressureReadyMs,
      measurementLimit:
        "Synthetic Nodex absolute values. Passive normalized MessageChannel identity observation creates no follower or retention interest; raw read-owner cache release is separately covered by its focused behavior suite.",
    };
    await writeFile(
      path.join(artifactDirectory, "eviction-result.json"),
      JSON.stringify(result, null, 2),
    );
    await testInfo.attach("eviction-result", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
  } catch (error) {
    failed = error;
    await writeFile(
      path.join(artifactDirectory, "eviction-failure-state.json"),
      JSON.stringify(
        {
          port: await readTranscriptPortEvidence(harness.page).catch(() => null),
          consoleErrors,
          anchorScrollSteps,
          body: await harness.page
            .locator("body")
            .innerText()
            .catch(() => ""),
        },
        null,
        2,
      ),
    );
    await harness.page
      .screenshot({ path: path.join(artifactDirectory, "eviction-failure.png") })
      .catch(() => {});
    await writeFile(
      path.join(artifactDirectory, "eviction-failure.log"),
      await readBoundedElectronRuntimeLogs(harness.profile),
    );
    await testInfo.attach("native-requests", {
      body: await readFile(path.join(stateDirectory, "requests.jsonl"), "utf8").catch(() => ""),
      contentType: "application/jsonl",
    });
    if (process.env.NODEX_TRANSCRIPT_TRACE === "1")
      await harness.application
        .context()
        .tracing.stop({ path: path.join(artifactDirectory, "eviction-trace.zip") })
        .catch(() => {});
    throw error;
  } finally {
    if (!failed && process.env.NODEX_TRANSCRIPT_TRACE === "1")
      await harness.application
        .context()
        .tracing.stop()
        .catch(() => {});
    try {
      await harness.close();
    } catch (error) {
      if (failed)
        // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains both the scenario and cleanup errors.
        throw new AggregateError([failed, error], "Viewport scenario and cleanup failed", {
          cause: error,
        });
      throw error;
    }
  }
});
