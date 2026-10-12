import { expect, test, type Page } from "@playwright/test";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
  waitForNodexWindowInitialization,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft, invokeIpc, sendAgentPrompt } from "./support/agent-smoke-harness";
import {
  buildTranscriptPerformanceCorpus,
  TRANSCRIPT_PERFORMANCE_CORPORA,
} from "./support/transcript-performance-corpus";
import {
  installTranscriptPortProbe as instrumentTranscriptPorts,
  readTranscriptPortEvidence as readPortCounts,
  beginTranscriptReleasedIdleObservation,
} from "./support/transcript-port-probe";

const sampleCount = 30;
const traceEnabled = process.env.NODEX_TRANSCRIPT_TRACE === "1";
const execFileAsync = promisify(execFile);
interface NativeRequest {
  readonly method: string;
  readonly params: { readonly method?: string; readonly params?: Record<string, unknown> };
}
const readRequests = async (logPath: string): Promise<NativeRequest[]> =>
  (await readFile(logPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NativeRequest);

const readViewportEvidence = async (page: Page) =>
  await page.evaluate(() => {
    let element = document.querySelector<HTMLElement>(
      "[data-local-conversation-thread-body='true']",
    );
    const ancestors = [];
    while (element) {
      const overflowY = getComputedStyle(element).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || element.scrollTop > 0) {
        ancestors.push({
          tag: element.tagName,
          overflowY,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        });
      }
      element = element.parentElement;
    }
    return {
      ancestors,
      turnKeys: [...document.querySelectorAll("[data-turn-key]")].map((row) =>
        row.getAttribute("data-turn-key"),
      ),
    };
  });

for (const corpus of TRANSCRIPT_PERFORMANCE_CORPORA) {
  test(`keeps ${corpus.id} transcript item streams isolated through history and window lifecycle`, async ({}, testInfo) => {
    test.setTimeout(240_000);
    const artifactDirectory = path.resolve(
      process.env.NODEX_TRANSCRIPT_REVIEW_DIR ?? testInfo.outputPath(),
    );
    await mkdir(artifactDirectory, { recursive: true });
    const harness = await ElectronScenarioHarness.create({
      label: `transcript-performance-${corpus.id}`,
      prepareAgentRuntime: false,
      enabledFeatures: [
        "runtime-metrics",
        ...(corpus.activeHistoryEviction ? ["active-history-eviction"] : []),
      ],
      environment: {
        NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
        NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
        NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
        NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve(
          "tests/e2e/fixtures/codex-queue-app-server.mjs",
        ),
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
    const logPath = path.join(stateDirectory, "requests.jsonl");
    const commandPath = path.join(stateDirectory, "commands.jsonl");
    await mkdir(stateDirectory, { recursive: true });
    const turns = buildTranscriptPerformanceCorpus(corpus.turnCount);
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
    const command = async (value: object) =>
      await appendFile(commandPath, `${JSON.stringify(value)}\n`);
    const memorySamples: unknown[] = [];
    const environment = {
      platform: platform(),
      arch: arch(),
      release: release(),
      cpuModel: cpus()[0]?.model,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      loadAverageAtStart: loadavg(),
    };
    const prepared = JSON.parse(
      await readFile(".generated/prepared-electron-build.json", "utf8"),
    ) as {
      source: object;
      inputDigest: string;
      generationId: string;
    };
    const sampleMemory = async (phase: string) => {
      const processes = await harness.application.evaluate(({ app }) =>
        app.getAppMetrics().map((entry) => ({
          type: entry.type,
          pid: entry.pid,
          memory: entry.memory,
          cpu: entry.cpu,
        })),
      );
      const rss =
        process.platform === "darwin"
          ? await execFileAsync("/bin/ps", [
              "-p",
              processes.map(({ pid }) => pid).join(","),
              "-o",
              "pid=,rss=",
            ])
              .then(({ stdout }) =>
                stdout
                  .trim()
                  .split("\n")
                  .map((line) => {
                    const [pid, rssKiB] = line.trim().split(/\s+/).map(Number);
                    return { pid, rssKiB };
                  }),
              )
              .catch(() => null)
          : null;
      memorySamples.push({ phase, processes, rss, loadAverage: loadavg() });
    };
    let recordingPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    let failed: unknown;
    const samplesMs: number[] = [];
    try {
      const initial = await harness.launch();
      if (traceEnabled)
        await harness.application
          .context()
          .tracing.start({ screenshots: true, snapshots: true, sources: true });
      const draft = await createAgentSmokeDraft(
        initial,
        harness.profile.initialProjectsDirectory,
        `Transcript ${corpus.id}`,
      );
      const threadId = await sendAgentPrompt(
        initial,
        draft.projectSessionId,
        "Prepare the synthetic transcript",
      );
      await expect(
        initial.getByText("The task completed successfully.", { exact: true }),
      ).toBeVisible();
      const publicState = JSON.parse(
        await readFile(path.join(stateDirectory, "state.json"), "utf8"),
      ) as { thread: { id: string }; turns: typeof turns };
      expect(publicState.thread.id).toBe(threadId);
      expect(publicState.turns).toHaveLength(1);
      expect(publicState.turns[0].status).toBe("completed");
      // Scale belongs to cold history, after the authoritative empty-Thread flow.
      const scaledStatePath = path.join(stateDirectory, "scaled-state.tmp");
      await writeFile(
        scaledStatePath,
        JSON.stringify({ ...publicState, turns: [...turns, ...publicState.turns] }),
      );
      await rename(scaledStatePath, path.join(stateDirectory, "state.json"));
      const requestOffset = (await readRequests(logPath)).length;
      if (traceEnabled) await harness.application.context().tracing.stop();
      const coldStarted = performance.now();
      const first = await harness.restart();
      if (traceEnabled)
        await harness.application
          .context()
          .tracing.start({ screenshots: true, snapshots: true, sources: true });
      await instrumentTranscriptPorts(first);
      await first.reload();
      await waitForNodexWindowInitialization(first);
      await expect(
        first.getByText("The task completed successfully.", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      const coldOpenMs = performance.now() - coldStarted;
      const coldRequests = (await readRequests(logPath))
        .slice(requestOffset)
        .filter((entry) => entry.method === "rpc");
      const coldTurnPages = coldRequests.filter(
        (entry) => entry.params.method === "thread/turns/list",
      );
      expect(coldTurnPages[0]?.params.params).toMatchObject({
        cursor: null,
        itemsView: "notLoaded",
        limit: 5,
        sortDirection: "desc",
      });
      expect(
        coldTurnPages.every(
          (entry) =>
            entry.params.params?.itemsView === "notLoaded" &&
            typeof entry.params.params.limit === "number" &&
            entry.params.params.limit <= 100,
        ),
      ).toBe(true);
      expect(
        coldRequests
          .filter((entry) => entry.params.method === "thread/resume")
          .every((entry) => entry.params.params?.excludeTurns === true),
      ).toBe(true);
      expect(
        coldRequests.filter(
          (entry) =>
            entry.params.method === "thread/read" && entry.params.params?.includeTurns === true,
        ),
      ).toEqual([]);
      const host = (await invokeIpc(first, "codex:app-server:host-context", "local")) as {
        historyPolicy: { activeEviction: boolean };
      };
      expect(host.historyPolicy.activeEviction).toBe(corpus.activeHistoryEviction);
      await sampleMemory("cold-history-ready");
      await expect
        .poll(async () => (await readPortCounts(first)).resumeStates, { timeout: 30_000 })
        .toEqual(["resumed"]);
      const beforeControlledStartEvidence = await readPortCounts(first);
      await command({ type: "start" });
      const target = first.locator(
        '[data-message-copy-root*="stream-target"] [data-thread-selected-text-target="true"]',
      );
      const sibling = first.getByText("Unchanged sibling", { exact: true });
      await expect(target).toBeVisible();
      if (!(await sibling.isVisible()))
        await first.getByRole("button", { name: "1 previous message", exact: true }).click();
      await expect(sibling).toBeVisible();
      const initialViewportCursor = `history-turn-${(corpus.turnCount - 5).toString().padStart(4, "0")}`;
      const initialViewportItemIds = Array.from(
        { length: 5 },
        (_, index) => corpus.turnCount - 9 + index,
      ).flatMap((index) => [`history-user-${index}`, `history-answer-${index}`]);
      await expect
        .poll(
          async () =>
            (await readRequests(logPath)).some(
              (entry) =>
                entry.params.method === "thread/turns/list" &&
                entry.params.params?.cursor === initialViewportCursor &&
                entry.params.params?.limit === 5 &&
                entry.params.params?.sortDirection === "desc",
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect
        .poll(
          async () => {
            const resident = (await readPortCounts(first)).residentItemIds;
            return initialViewportItemIds.every((id) => resident.includes(id));
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const beforeStreamEvidence = await readPortCounts(first);
      const beforeStreamViewport = await readViewportEvidence(first);
      await sibling.evaluate((element) => {
        const scope = window as typeof window & {
          __streamScope?: {
            sibling: Element;
            row: Element | null;
            mutations: number;
            observer: MutationObserver;
          };
        };
        const result = {
          sibling: element,
          row: element.closest("[data-turn-key]"),
          mutations: 0,
          observer: new MutationObserver(() => result.mutations++),
        };
        result.observer.observe(element, { subtree: true, childList: true, characterData: true });
        scope.__streamScope = result;
      });
      let expectedText = "Stream baseline";
      for (let index = 0; index < sampleCount; index++) {
        const delta = ` sample-${index.toString().padStart(3, "0")}`;
        const started = performance.now();
        await command({ type: "delta", delta });
        expectedText += delta;
        await expect(target).toHaveText(expectedText);
        samplesMs.push(performance.now() - started);
      }
      const renderScope = await sibling.evaluate((element) => {
        const scope = (
          window as typeof window & {
            __streamScope: {
              sibling: Element;
              row: Element | null;
              mutations: number;
              observer: MutationObserver;
            };
          }
        ).__streamScope;
        scope.observer.disconnect();
        return {
          siblingIdentityPreserved: scope.sibling === element,
          rowIdentityPreserved: scope.row === element.closest("[data-turn-key]"),
          unrelatedTextMutations: scope.mutations,
        };
      });
      await writeFile(
        path.join(artifactDirectory, `${corpus.id}-stream-scope.json`),
        JSON.stringify(
          {
            beforeControlledStart: beforeControlledStartEvidence,
            initialViewportSetup: {
              cursor: initialViewportCursor,
              itemIds: initialViewportItemIds,
            },
            before: beforeStreamEvidence,
            after: await readPortCounts(first),
            beforeViewport: beforeStreamViewport,
            afterViewport: await readViewportEvidence(first),
            renderScope,
          },
          null,
          2,
        ),
      );
      expect(renderScope).toEqual({
        siblingIdentityPreserved: true,
        rowIdentityPreserved: true,
        unrelatedTextMutations: 0,
      });
      const ports = await readPortCounts(first);
      expect(ports.channels).toBeGreaterThan(0);
      expect(ports.sampleMessages).toBeGreaterThanOrEqual(sampleCount);
      expect(ports.normalizedChannels).toBe(1);
      expect(ports.observerErrors).toBe(0);
      await sampleMemory("after-30-item-deltas");
      const opened = harness.application.waitForEvent("window");
      expect(
        await invokeIpc(first, "window:new", {
          activeProjectSessionId: draft.projectSessionId,
          activeProjectId: draft.projectId,
        }),
      ).toBe(true);
      const second = await opened;
      diagnosticPage = second;
      await waitForNodexWindowInitialization(second);
      await instrumentTranscriptPorts(second);
      await second.reload();
      await waitForNodexWindowInitialization(second);
      await expect(second.getByText(expectedText, { exact: true })).toBeVisible();
      if (corpus.id === "long") {
        recordingPage = second;
        await second.screencast.start({
          path: path.join(artifactDirectory, "review.webm"),
          size: { width: 1280, height: 800 },
          annotate: { position: "bottom", fontSize: 14 },
        });
      }
      const beforeRelease = await readPortCounts(first);
      await first
        .getByRole("button", { name: `Start new chat in Transcript ${corpus.id}`, exact: true })
        .click();
      await expect
        .poll(async () => (await readPortCounts(first)).closed)
        .toBeGreaterThanOrEqual(beforeRelease.closed + 2);
      await command({ type: "delta", delta: " sample-follower" });
      expectedText += " sample-follower";
      await expect(second.getByText(expectedText, { exact: true })).toBeVisible();
      const remainingWindowDeltaVisible = await second
        .getByText(expectedText, { exact: true })
        .isVisible();
      const completionStarted = performance.now();
      await command({ type: "complete" });
      await expect
        .poll(
          async () =>
            (await readPortCounts(second)).turnAddressStatuses
              .filter((turn) => turn.turnId === "performance-stream-turn")
              .map((turn) => turn.status),
          { timeout: 30_000 },
        )
        .toEqual(["completed"]);
      const normalizedCompletionMs = performance.now() - completionStarted;
      await expect(second.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
        timeout: 30_000,
      });
      const completionVisibleMs = performance.now() - completionStarted;
      const completionEvidence = await readPortCounts(second);
      const completedStopCount = await second
        .getByRole("button", { name: "Stop", exact: true })
        .count();
      const requestCountBeforeScroll = (await readRequests(logPath)).filter(
        (entry) => entry.params.method === "thread/turns/list",
      ).length;
      if (corpus.id === "long") {
        const scroll = second.locator("[data-local-conversation-thread-body='true']");
        await scroll.hover();
        await second.mouse.wheel(0, -100_000);
        await expect
          .poll(
            async () =>
              (await readRequests(logPath)).filter(
                (entry) => entry.params.method === "thread/turns/list",
              ).length,
          )
          .toBeGreaterThan(requestCountBeforeScroll);
      }
      const historyPageRequestsDelta =
        (await readRequests(logPath)).filter((entry) => entry.params.method === "thread/turns/list")
          .length - requestCountBeforeScroll;
      const beforeSearch = await readPortCounts(second);
      const searchIndex = Math.floor(corpus.turnCount / 2);
      const searchTurnId = turns[searchIndex].id;
      const searchItemId = `history-user-${searchIndex}`;
      const searchTerm = `Synthetic history ${searchIndex.toString().padStart(4, "0")}`;
      const searchTargetWasResident = beforeSearch.residentItemIds.includes(searchItemId);
      if (corpus.id === "long") expect(searchTargetWasResident).toBe(false);
      const searchRequestOffset = (await readRequests(logPath)).length;
      await second.keyboard.press("ControlOrMeta+f");
      const query = second.getByPlaceholder("Search chat…");
      await expect(query).toBeVisible();
      await query.fill(searchTerm);
      const targetMark = second
        .locator("[data-content-search-turn-key] mark")
        .filter({ hasText: searchTerm });
      await expect(targetMark).toHaveText(searchTerm);
      await expect(targetMark).toBeVisible();
      const searchHighlightVisible = await targetMark.isVisible();
      if (corpus.id === "long") {
        await expect
          .poll(
            async () =>
              (await readRequests(logPath))
                .slice(searchRequestOffset)
                .filter(
                  (entry) =>
                    entry.params.method === "thread/searchOccurrences" &&
                    entry.params.params?.searchTerm === searchTerm,
                ).length,
          )
          .toBeGreaterThan(0);
        await expect
          .poll(async () => (await readPortCounts(second)).residentItemIds.includes(searchItemId))
          .toBe(true);
        await expect
          .poll(
            async () =>
              (await readRequests(logPath))
                .slice(searchRequestOffset)
                .filter(
                  (entry) =>
                    entry.params.method === "thread/items/list" &&
                    entry.params.params?.turnId === searchTurnId,
                ).length,
          )
          .toBeGreaterThan(0);
      }
      const searchEvidence = {
        targetTurnId: searchTurnId,
        targetItemId: searchItemId,
        term: searchTerm,
        wasResident: searchTargetWasResident,
        isResident: (await readPortCounts(second)).residentItemIds.includes(searchItemId),
        highlightVisible: searchHighlightVisible,
        nativeRequests: (await readRequests(logPath)).slice(searchRequestOffset),
      };
      await sampleMemory("history-and-search-ready");
      await second.screenshot({
        path: path.join(artifactDirectory, corpus.id === "long" ? "final.png" : "short-final.png"),
      });
      const lastPorts = await readPortCounts(second);
      await second.getByRole("button", { name: "Close find", exact: true }).click();
      await second
        .getByRole("button", { name: `Start new chat in Transcript ${corpus.id}`, exact: true })
        .click();
      await expect
        .poll(async () => (await readPortCounts(second)).closed)
        .toBeGreaterThanOrEqual(lastPorts.closed + 2);
      await sampleMemory("all-transcript-views-released");
      const released = await readPortCounts(second);
      expect(released.normalizedChannels).toBe(0);
      expect(released.residentItemCount).toBe(0);
      if (recordingPage) {
        await recordingPage.screencast.stop();
        recordingPage = undefined;
      }
      await beginTranscriptReleasedIdleObservation(second);
      const idleStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      const idleObservationMs = performance.now() - idleStarted;
      const afterIdle = await readPortCounts(second);
      expect(afterIdle.normalizedChannels).toBe(0);
      expect(afterIdle.residentItemCount).toBe(0);
      expect(afterIdle.observerErrors).toBe(0);
      expect(afterIdle.releasedIdleObservation).toEqual({
        maxNormalizedChannels: 0,
        maxResidentItemCount: 0,
      });
      await sampleMemory("30-second-idle-after-transcript-release");
      const ordered = [...samplesMs].sort((left, right) => left - right);
      const result = {
        status: "passed",
        runId: process.env.NODEX_TRANSCRIPT_REVIEW_RUN_ID ?? null,
        environment: {
          ...environment,
          preparedBuild: {
            source: prepared.source,
            inputDigest: prepared.inputDigest,
            generationId: prepared.generationId,
          },
          loadAverageAtEnd: loadavg(),
          runtimeVersions: await harness.application.evaluate(() => process.versions),
        },
        threadId,
        corpus: {
          ...corpus,
          serializedBytes: Buffer.byteLength(JSON.stringify(turns)),
          samples: sampleCount,
        },
        coldOpenMs,
        completionVisibleMs,
        normalizedCompletionMs,
        completionEvidence,
        searchEvidence,
        idleObservationMs,
        releasedIdleEvidence: afterIdle,
        streamVisibleMs: {
          median: ordered[Math.floor(ordered.length * 0.5)],
          p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
          raw: samplesMs,
        },
        claims: [
          {
            claim: "cold history uses bounded Turn pages without full thread body read",
            expected: { initialPageLimit: 5, turnPages: ">=1", fullBodyReads: 0 },
            actual: {
              initialPageLimit: coldTurnPages[0]?.params.params?.limit,
              turnPages: coldRequests.filter((entry) => entry.params.method === "thread/turns/list")
                .length,
              fullBodyReads: coldRequests.filter(
                (entry) =>
                  entry.params.method === "thread/read" &&
                  entry.params.params?.includeTurns === true,
              ).length,
            },
          },
          {
            claim: "completed live Turn has one normalized entity address",
            expected: ["completed"],
            actual: completionEvidence.turnAddressStatuses
              .filter((turn) => turn.turnId === "performance-stream-turn")
              .map((turn) => turn.status),
          },
          {
            claim: "completed thread hides Stop control",
            expected: 0,
            actual: completedStopCount,
          },
          {
            claim: "remaining window receives item delta after first view releases",
            expected: true,
            actual: remainingWindowDeltaVisible,
          },
          ...(corpus.id === "long"
            ? [
                {
                  claim: "user scrolling requests earlier Turn pages",
                  expected: ">=1",
                  actual: historyPageRequestsDelta,
                },
              ]
            : []),
          {
            claim: "chat search reveals highlighted target",
            expected: true,
            actual: searchHighlightVisible,
          },
          ...(corpus.id === "long"
            ? [
                {
                  claim: "native search hydrates the previously nonresident target item",
                  expected: { wasResident: false, isResident: true },
                  actual: {
                    wasResident: searchEvidence.wasResident,
                    isResident: searchEvidence.isResident,
                  },
                },
              ]
            : []),
          {
            claim: "unrelated item text mutations",
            expected: 0,
            actual: renderScope.unrelatedTextMutations,
          },
          {
            claim: "sibling and Turn DOM identities survive stream",
            expected: true,
            actual: renderScope.siblingIdentityPreserved && renderScope.rowIdentityPreserved,
          },
          {
            claim: "native MessageChannel carries sample text",
            expected: `>=${sampleCount}`,
            actual: ports.sampleMessages,
          },
          {
            claim: "last transcript subscriber closes its ports",
            expected: true,
            actual: (await readPortCounts(second)).closed >= lastPorts.closed + 2,
          },
          {
            claim: "released normalized subscription retains no item identities",
            expected: 0,
            actual: released.residentItemCount,
          },
          {
            claim: "30-second idle keeps released transcript ports and identities absent",
            expected: { maxNormalizedChannels: 0, maxResidentItemCount: 0 },
            actual: {
              ...afterIdle.releasedIdleObservation,
            },
          },
          {
            claim: "configured active history eviction gate",
            expected: corpus.activeHistoryEviction,
            actual: host.historyPolicy.activeEviction,
          },
        ],
        memorySamples,
        coldRequests,
        nativeRequests: await readRequests(logPath),
        measurementLimit:
          "Visible latency includes fixture file polling, full synthetic native state-file read/write, and Playwright assertion polling. DOM mutations do not count React commits. macOS RSS is sampled with ps for the harness-owned Electron app-metrics process IDs; detached Core and fake native processes are excluded. Electron working sets are also recorded. The 30-second idle phase performs no UI interaction or forced GC. Neither establishes a controlled retained-heap comparison.",
      };
      await writeFile(
        path.join(artifactDirectory, `${corpus.id}-result.json`),
        JSON.stringify(result, null, 2),
      );
      await testInfo.attach(`${corpus.id}-result`, {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
    } catch (error) {
      failed = error;
      await writeFile(
        path.join(artifactDirectory, `${corpus.id}-failure-measurements.json`),
        JSON.stringify(
          {
            status: "failed",
            runId: process.env.NODEX_TRANSCRIPT_REVIEW_RUN_ID ?? null,
            corpus,
            rawStreamSamplesMs: samplesMs,
            memorySamples,
            preparedBuild: {
              source: prepared.source,
              inputDigest: prepared.inputDigest,
              generationId: prepared.generationId,
            },
          },
          null,
          2,
        ),
      );
      const failedPage = diagnosticPage ?? harness.page;
      if (process.env.NODEX_TRANSCRIPT_DIAGNOSE === "1") {
        const samples = [];
        for (let index = 0; index < 4; index++) {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
          samples.push({
            afterFailureMs: index * 5_000,
            port: await readPortCounts(failedPage).catch(() => null),
            dom: await failedPage.evaluate(() => {
              const body = document.querySelector("[data-local-conversation-thread-body='true']");
              return {
                scrollTop: body?.scrollTop,
                scrollHeight: body?.scrollHeight,
                clientHeight: body?.clientHeight,
                turnKeys: [...document.querySelectorAll("[data-turn-key]")].map((element) =>
                  element.getAttribute("data-turn-key"),
                ),
                marks: [...document.querySelectorAll("[data-content-search-turn-key] mark")].map(
                  (element) => ({
                    text: element.textContent,
                    turnKey: element
                      .closest("[data-content-search-turn-key]")
                      ?.getAttribute("data-content-search-turn-key"),
                  }),
                ),
              };
            }),
            nativeRequestCount: (await readRequests(logPath)).length,
            viewport: await readViewportEvidence(failedPage),
          });
        }
        await writeFile(
          path.join(artifactDirectory, `${corpus.id}-diagnostic-progression.json`),
          JSON.stringify(samples, null, 2),
        );
      }
      await writeFile(
        path.join(artifactDirectory, `${corpus.id}-failure-ports.json`),
        JSON.stringify({ port: await readPortCounts(failedPage).catch(() => null) }, null, 2),
      );
      await failedPage
        .screenshot({ path: path.join(artifactDirectory, `${corpus.id}-failure.png`) })
        .catch(() => {});
      await writeFile(
        path.join(artifactDirectory, `${corpus.id}-failure-dom.txt`),
        await failedPage
          .locator("body")
          .innerText()
          .catch(() => "No renderer body"),
      );
      const state = JSON.parse(await readFile(path.join(stateDirectory, "state.json"), "utf8")) as {
        thread?: { id?: string };
      };
      if (state.thread?.id)
        await writeFile(
          path.join(artifactDirectory, `${corpus.id}-failure-search.json`),
          JSON.stringify(
            await invokeIpc(
              failedPage,
              "codex:thread:history-search",
              state.thread.id,
              `Synthetic history ${Math.floor(corpus.turnCount / 2)
                .toString()
                .padStart(4, "0")}`,
            ).catch((cause) => ({ error: String(cause) })),
            null,
            2,
          ),
        );
      if (state.thread?.id)
        await writeFile(
          path.join(artifactDirectory, `${corpus.id}-failure-snapshot.json`),
          JSON.stringify(
            await invokeIpc(harness.page, "codex:thread:snapshot:request", state.thread.id).catch(
              () => null,
            ),
            null,
            2,
          ),
        );
      if (traceEnabled)
        await harness.application
          .context()
          .tracing.stop({ path: path.join(artifactDirectory, `${corpus.id}-trace.zip`) })
          .catch(() => {});
      await writeFile(
        path.join(artifactDirectory, `${corpus.id}-failure.log`),
        await readBoundedElectronRuntimeLogs(harness.profile),
      );
      await testInfo.attach("native-requests", {
        body: await readFile(logPath, "utf8").catch(() => ""),
        contentType: "application/jsonl",
      });
      throw error;
    } finally {
      await recordingPage?.screencast.stop().catch(() => {});
      if (!failed && traceEnabled)
        await harness.application
          .context()
          .tracing.stop()
          .catch(() => {});
      try {
        await harness.close();
      } catch (error) {
        if (failed)
          // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains both the scenario and cleanup errors.
          throw new AggregateError([failed, error], "Transcript scenario and cleanup failed", {
            cause: error,
          });
        throw error;
      }
    }
  });
}
