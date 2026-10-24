import { expect, test, type Page } from "@playwright/test";
import { copyFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus, loadavg, totalmem } from "node:os";
import path from "node:path";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { DevelopmentFeatureSlug } from "../../src/shared/development-features";
import type { CodexRendererHostContext } from "../../src/shared/codex-renderer-resume";
import type {
  NativeSessionCatalogEntry,
  NativeSessionCatalogPage,
} from "../../src/shared/native-session-catalog";
import type { ProjectSession, ProjectSessionSummaryWindow } from "../../src/shared/types";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { installPrivateFile, resolveRegularPrivateFileSource } from "../../scripts/private-file";
import { invokeIpc } from "./support/agent-smoke-harness";
import {
  seedNativeHistoryBinding,
  type SeededNativeHistoryBinding,
} from "./support/native-history-binding";
import {
  installTranscriptPortProbe,
  readTranscriptPortEvidence,
} from "./support/transcript-port-probe";
import { measureTranscriptWheel } from "./support/transcript-read-only-benchmark";
import {
  nativeReadOnlyBenchmarkEnvironment,
  verifyNativeTranscriptBenchmarkInputs,
} from "./support/native-transcript-benchmark-preflight";
import {
  createNativeTranscriptBenchmarkClient,
  type NativeBenchmarkRequestSample,
} from "./support/native-transcript-benchmark-client";

const summary = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
const execFileAsync = promisify(execFile);
interface FindSample {
  readonly queryId: string;
  readonly term: string;
  readonly itemId: string;
  readonly wasInDOM: boolean;
  readonly rawResidentBefore: boolean;
  readonly rawResidentAfter: boolean;
  readonly startedAtEpochMs: number;
  readonly completedAtEpochMs: number;
  readonly fillDurationMs: number;
  readonly markObservedDurationMs: number;
  readonly activeHighlightTwoRafMs: number;
  readonly rendererTwoFramesAtMs: number;
  readonly normalizedChannelsBefore: number;
  readonly residentItemCountBefore: number;
}
interface NativeAttachmentEvidence {
  readonly catalogBefore: NativeSessionCatalogEntry;
  seeded?: SeededNativeHistoryBinding;
  catalogAfter?: NativeSessionCatalogEntry;
  binding?: Pick<ProjectSession, "id" | "projectId" | "thread">;
  boundSessionIds?: readonly string[];
}

async function measureFind(page: Page, corpus: "short" | "long", failurePath: string) {
  await page.keyboard.press("ControlOrMeta+f");
  const input = page.getByPlaceholder("Search chat…");
  await expect(input).toBeVisible();
  const samples: FindSample[] = [];
  for (let index = 0; index < 30; index++) {
    const target = corpus === "short" ? 5 + (index % 2) : 5_000 + index;
    const term = `Synthetic history ${String(target).padStart(4, "0")}`;
    const itemId = `history-user-${target}`;
    const wasInDOM = (await page.getByText(term, { exact: true }).count()) > 0;
    const before = await readTranscriptPortEvidence(page);
    const rawResidentBefore = before.residentItemIds.includes(itemId);
    const queryId = `${corpus}-ui-find-${index}`;
    const startedAtEpochMs = Date.now();
    const startedAt = performance.now();
    await input.fill(term);
    const fillCompletedAtMs = performance.now();
    await page
      .waitForFunction(
        (term) =>
          [...document.querySelectorAll("mark.codex-thread-find-active")].some((mark) => {
            if (mark.textContent !== term) return false;
            const rect = mark.getBoundingClientRect();
            const viewport = mark
              .closest("[data-local-conversation-thread-body=true]")
              ?.getBoundingClientRect();
            return (
              viewport &&
              rect.height > 0 &&
              rect.bottom > viewport.top &&
              rect.top < viewport.bottom
            );
          }),
        term,
        { timeout: 60_000 },
      )
      .catch(async (error: unknown) => {
        // Collect only the owned synthetic transcript after failure, outside all latency samples.
        const evidence = await Promise.allSettled([
          readTranscriptPortEvidence(page),
          page.evaluate(() => {
            const root = document.querySelector<HTMLElement>(
              "[data-local-conversation-thread-body=true]",
            );
            const bounds = (element: Element) => {
              const rect = element.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, height: rect.height };
            };
            return {
              inputValue: document.querySelector<HTMLInputElement>(
                'input[placeholder="Search chat…"]',
              )?.value,
              viewport: root
                ? {
                    ...bounds(root),
                    scrollTop: root.scrollTop,
                    scrollHeight: root.scrollHeight,
                    clientHeight: root.clientHeight,
                  }
                : null,
              marks: [...document.querySelectorAll("mark.codex-thread-find-active")].map(
                (mark) => ({ text: mark.textContent, ...bounds(mark) }),
              ),
              units: [...(root?.querySelectorAll("[data-content-search-unit-key]") ?? [])]
                .slice(0, 80)
                .map((unit) => ({
                  id: unit.getAttribute("data-content-search-unit-key"),
                  turnKey: unit
                    .closest("[data-content-search-turn-key]")
                    ?.getAttribute("data-content-search-turn-key"),
                  text: unit.textContent?.slice(0, 96),
                  ...bounds(unit),
                })),
            };
          }),
        ]);
        await writeFile(
          failurePath,
          `${JSON.stringify({ queryId, term, itemId, before, completedSamples: samples, evidence }, null, 2)}\n`,
        );
        throw error;
      });
    const markObservedAtMs = performance.now();
    const rendererTwoFramesAtMs = await page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))),
        ),
    );
    const completedAtMs = performance.now();
    const after = await readTranscriptPortEvidence(page);
    samples.push({
      queryId,
      term,
      itemId,
      wasInDOM,
      rawResidentBefore,
      rawResidentAfter: after.residentItemIds.includes(itemId),
      startedAtEpochMs,
      completedAtEpochMs: Date.now(),
      fillDurationMs: fillCompletedAtMs - startedAt,
      markObservedDurationMs: markObservedAtMs - startedAt,
      activeHighlightTwoRafMs: completedAtMs - startedAt,
      rendererTwoFramesAtMs,
      normalizedChannelsBefore: before.normalizedChannels,
      residentItemCountBefore: before.residentItemCount,
    });
  }
  await page.getByRole("button", { name: "Close find", exact: true }).click();
  const cohort = (select: (sample: (typeof samples)[number]) => boolean) =>
    summary(samples.filter(select).map((sample) => sample.activeHighlightTwoRafMs));
  return {
    samples,
    ...summary(samples.map((sample) => sample.activeHighlightTwoRafMs)),
    domPresent: cohort((sample) => sample.wasInDOM),
    domAbsent: cohort((sample) => !sample.wasInDOM),
    rawResident: cohort((sample) => sample.rawResidentBefore),
    rawCold: cohort((sample) => !sample.rawResidentBefore),
  };
}

async function processEvidence(harness: ElectronScenarioHarness) {
  const rootPid = harness.application.process().pid;
  if (!rootPid) throw new Error("Missing owned Electron PID");
  const table = (await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,rss=,%cpu=,comm="])).stdout
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rssBytes: Number(match[3]) * 1024,
            lifetimeCpuPercent: Number(match[4]),
            executable: match[5],
          }
        : null;
    })
    .filter((row) => row !== null);
  const owned = new Set([rootPid]);
  for (let priorSize = 0; priorSize !== owned.size;) {
    priorSize = owned.size;
    for (const row of table) if (owned.has(row.ppid)) owned.add(row.pid);
  }
  const processes = table.filter((row) => owned.has(row.pid));
  return {
    rootPid,
    processes,
    rssTotalBytes: processes.reduce((total, row) => total + row.rssBytes, 0),
    loadAverage: loadavg(),
    scope:
      "Owned Electron descendants from PID/PPID; detached services reparented outside this tree are excluded. ps CPU is lifetime average.",
  };
}

test("benchmarks native paginated history without running a model Turn", async ({}, testInfo) => {
  test.skip(
    process.env.NODEX_NATIVE_TRANSCRIPT_BENCHMARK !== "1",
    "Explicit local official-native benchmark",
  );
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "The paired evidence targets the arm64 macOS development stage",
  );
  test.setTimeout(360_000);
  const corpusDirectory = process.env.NODEX_NATIVE_TRANSCRIPT_CORPUS_DIR;
  if (!corpusDirectory)
    throw new Error(
      "Set NODEX_NATIVE_TRANSCRIPT_CORPUS_DIR to the verified immutable rollout corpus",
    );
  const repositoryRoot = path.resolve(".");
  const preflight = await verifyNativeTranscriptBenchmarkInputs(repositoryRoot, corpusDirectory);
  const directory = path.resolve(
    process.env.NODEX_NATIVE_TRANSCRIPT_BENCHMARK_DIR ?? testInfo.outputPath(),
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "preflight.json"),
    `${JSON.stringify(preflight, null, 2)}\n`,
  );
  const order = (process.env.NODEX_NATIVE_TRANSCRIPT_CORPUS_ORDER ?? "short,long").split(",");
  if (order.some((corpus) => corpus !== "short" && corpus !== "long"))
    throw new Error("Invalid native corpus order");
  const activeEvictionSetting = process.env.NODEX_NATIVE_TRANSCRIPT_ACTIVE_EVICTION ?? "0";
  if (activeEvictionSetting !== "0" && activeEvictionSetting !== "1")
    throw new Error("Native transcript active eviction must be explicitly 0 or 1");
  const activeEviction = activeEvictionSetting === "1";
  const timelineSetting = process.env.NODEX_NATIVE_TRANSCRIPT_TIMELINE ?? "0";
  if (timelineSetting !== "0" && timelineSetting !== "1")
    throw new Error("Native transcript timeline history must be explicitly 0 or 1");
  const timelineEnabled = timelineSetting === "1";
  for (const [runIndex, corpusId] of order.entries()) {
    const corpus = preflight.corpora.find((value) => value.corpus === corpusId)!;
    const resultPath = path.join(directory, `${runIndex}-${corpus.corpus}.json`);
    const enabledFeatures: readonly DevelopmentFeatureSlug[] = [
      "runtime-metrics",
      ...(timelineEnabled ? (["thread-timeline-history"] as const) : []),
      ...(activeEviction ? (["active-history-eviction"] as const) : []),
    ];
    const harness = await ElectronScenarioHarness.create({
      label: `native-history-${corpus.corpus}`,
      codex: "empty",
      prepareAgentRuntime: false,
      cwd: repositoryRoot,
      enabledFeatures,
      environment: nativeReadOnlyBenchmarkEnvironment(process.env),
    });
    const nativeSamples: NativeBenchmarkRequestSample[] = [];
    let attachmentEvidence: NativeAttachmentEvidence | null = null;
    const authPath = path.join(harness.profile.codexHome, "auth.json");
    let authCopied = false;
    const profileIdentity = {
      runId: harness.profile.runId,
      isolatedHome: harness.profile.nodexHome,
      isolatedCodexHome: harness.profile.codexHome,
    };
    let ownedElectronPid: number | null = null;
    let lastProcessEvidence: Awaited<ReturnType<typeof processEvidence>> | null = null;
    try {
      const target = path.join(
        harness.profile.codexHome,
        "sessions/2026/10/12",
        path.basename(corpus.rolloutPath),
      );
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(corpus.rolloutPath, target);
      await chmod(target, 0o600);
      expect(
        createHash("sha256")
          .update(await readFile(target))
          .digest("hex"),
      ).toBe(corpus.rolloutSha256);
      // Opt-in retry after an observed login gate; never inspect credential bytes.
      if (process.env.NODEX_NATIVE_TRANSCRIPT_AUTH_FILE) {
        const source = await resolveRegularPrivateFileSource(
          process.env.NODEX_NATIVE_TRANSCRIPT_AUTH_FILE,
          "Authorized benchmark authentication",
        );
        await installPrivateFile(authPath, (temporaryPath) => copyFile(source, temporaryPath));
        authCopied = true;
      }
      const adopter = await createNativeTranscriptBenchmarkClient({
        executable: preflight.runtime.executable,
        codexHome: harness.profile.codexHome,
        cwd: corpus.workspace,
      });
      try {
        const adoption = await adopter.call(
          "thread/resume",
          { threadId: corpus.threadId, path: target, excludeTurns: true },
          "index-adoption",
        );
        expect(adoption.thread.id).toBe(corpus.threadId);
        expect(adoption.thread.turns).toEqual([]);
      } finally {
        nativeSamples.push(...adopter.samples);
        await adopter.close();
      }
      const page = await harness.launch();
      ownedElectronPid = harness.application.process().pid ?? null;
      await harness.application.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length !== 1) throw new Error("Benchmark requires one owned window");
        windows[0]!.setBounds({ x: 0, y: 0, width: 1400, height: 900 });
      });
      const catalog = (await invokeIpc(page, "native-sessions:list", {
        backendKind: "codex",
      })) as NativeSessionCatalogPage;
      expect(path.resolve(catalog.nativeHome)).toBe(path.resolve(harness.profile.codexHome));
      const entry = catalog.entries.find((value) => value.nativeSessionId === corpus.threadId);
      if (!entry) throw new Error("Official native metadata was not adopted into the catalog");
      attachmentEvidence = { catalogBefore: entry };
      const attached = await seedNativeHistoryBinding(harness.profile, catalog.nativeHome, entry);
      attachmentEvidence.seeded = attached;
      expect(attached.threadId).toBe(corpus.threadId);
      const binding = (await invokeIpc(
        page,
        "project-sessions:get",
        attached.sessionId,
      )) as ProjectSession | null;
      if (!binding) throw new Error("Native history fixture did not return a durable Session");
      attachmentEvidence.binding = {
        id: binding.id,
        projectId: binding.projectId,
        thread: binding.thread,
      };
      expect(binding.id).toBe(attached.sessionId);
      expect(binding.projectId).toBe(null);
      expect(binding.thread).toMatchObject({
        sessionId: attached.sessionId,
        projectId: null,
        threadId: corpus.threadId,
        backendBinding: { kind: "codex" },
        executionHostId: "local",
        cwd: corpus.workspace,
      });
      const catalogAfter = (await invokeIpc(page, "native-sessions:list", {
        backendKind: "codex",
      })) as NativeSessionCatalogPage;
      expect(catalogAfter.nativeHome).toBe(catalog.nativeHome);
      const nativeEntries = catalogAfter.entries.filter(
        (value) => value.nativeSessionId === corpus.threadId,
      );
      expect(nativeEntries).toHaveLength(1);
      attachmentEvidence.catalogAfter = nativeEntries[0];
      expect(nativeEntries[0]).toEqual(entry);
      const tasks = (await invokeIpc(page, "workspace:tasks:list", null, {
        first: 50,
        includeArchived: true,
      })) as ProjectSessionSummaryWindow;
      expect(tasks.hasMore).toBe(false);
      attachmentEvidence.boundSessionIds = tasks.items
        .filter((session) => session.thread?.threadId === corpus.threadId)
        .map((session) => session.id);
      expect(attachmentEvidence.boundSessionIds).toEqual([attached.sessionId]);
      await installTranscriptPortProbe(page);
      await page.reload();
      await page.evaluate(() => window.api?.awaitInitialization?.());
      await page.getByText(binding.displayTitle, { exact: true }).first().click();
      const last = `Synthetic history ${String(corpus.turnCount - 1).padStart(4, "0")}`;
      await expect(page.getByText(last, { exact: true })).toBeVisible({ timeout: 60_000 });
      // Existing native history is read in bounded pages; it is never resumed for execution.
      expect((await readTranscriptPortEvidence(page)).resumeStates).not.toContain("resumed");
      const before = await processEvidence(harness);
      lastProcessEvidence = before;
      const geometry = await page
        .locator("[data-local-conversation-thread-body=true]")
        .evaluate((element) => ({
          width: element.clientWidth,
          height: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          dpr: devicePixelRatio,
          flexDirection: getComputedStyle(element).flexDirection,
          windowInnerWidth: innerWidth,
          windowInnerHeight: innerHeight,
        }));
      const hostContext = (await invokeIpc(
        page,
        "codex:app-server:host-context",
        "local",
      )) as CodexRendererHostContext;
      expect(hostContext.supportsThreadTimeline).toBe(true);
      expect(hostContext.historyPolicy?.timeline).toBe(timelineEnabled);
      expect(hostContext.historyPolicy?.activeEviction).toBe(activeEviction);
      if (timelineEnabled) {
        await expect
          .poll(
            async () =>
              (await readTranscriptPortEvidence(page)).itemTimelines.some(
                (timeline) => timeline.present && timeline.itemEntryCount > 0,
              ),
            { timeout: 60_000 },
          )
          .toBe(true);
      }
      const startedResident = await readTranscriptPortEvidence(page);
      expect(startedResident.normalizedChannels).toBeGreaterThan(0);
      const wheel = await measureTranscriptWheel(page, 30);
      const find = await measureFind(page, corpus.corpus, `${resultPath}.find-failure.json`);
      const after = await processEvidence(harness);
      lastProcessEvidence = after;
      const electronPid = harness.application.process().pid;
      await harness.stopElectron();
      // A separate official native process runs only after the app process has closed.
      const apiClient = await createNativeTranscriptBenchmarkClient({
        executable: preflight.runtime.executable,
        codexHome: harness.profile.codexHome,
        cwd: corpus.workspace,
      });
      let verifiedNativeTurnCount = 0;
      let nativeMetadataPages = 0;
      try {
        await apiClient.call(
          "thread/resume",
          { threadId: corpus.threadId, excludeTurns: true },
          "independent-native-prepare",
        );
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          if (nativeMetadataPages > Math.ceil(corpus.turnCount / 100))
            throw new Error("Native metadata exceeded the corpus page bound");
          const metadata: ClientRequestResponsesByMethod["thread/turns/list"] =
            await apiClient.call(
              "thread/turns/list",
              {
                threadId: corpus.threadId,
                limit: 100,
                itemsView: "notLoaded",
                sortDirection: "asc",
                cursor,
              },
              "verify-native-turn-count",
            );
          nativeMetadataPages++;
          for (const turn of metadata.data) {
            expect(turn.id).toBe(
              `history-turn-${String(verifiedNativeTurnCount).padStart(4, "0")}`,
            );
            expect(turn.status).toBe("completed");
            expect(turn.items).toEqual([]);
            verifiedNativeTurnCount++;
          }
          cursor = metadata.nextCursor ?? null;
          if (cursor && cursors.has(cursor)) throw new Error("Native metadata repeated a cursor");
          if (cursor) cursors.add(cursor);
        } while (cursor !== null);
        expect(verifiedNativeTurnCount).toBe(corpus.turnCount);
        for (let index = 0; index < 30; index++) {
          const targetIndex = corpus.corpus === "short" ? 5 + (index % 2) : 5_000 + index;
          const result = await apiClient.call(
            "thread/searchOccurrences",
            {
              threadId: corpus.threadId,
              searchTerm: `Synthetic history ${String(targetIndex).padStart(4, "0")}`,
              limit: 250,
            },
            "independent-native-search",
          );
          expect(result.data).toHaveLength(1);
          expect(result.data[0]?.itemId).toBe(`history-user-${targetIndex}`);
        }
      } finally {
        nativeSamples.push(...apiClient.samples);
        await apiClient.close();
      }
      const preparedBuild = JSON.parse(
        await readFile(
          path.join(repositoryRoot, ".generated/prepared-electron-build.json"),
          "utf8",
        ),
      ) as { inputDigest: string; generationId: string; source: unknown };
      await writeFile(
        resultPath,
        `${JSON.stringify(
          {
            corpus,
            runIndex,
            authCopied,
            attachmentEvidence,
            sourceBuild: preparedBuild,
            runtime: preflight.runtime,
            profileIdentity,
            ownership: { electronPid },
            environment: {
              cpuModel: cpus()[0]?.model,
              cpuCount: cpus().length,
              totalMemoryBytes: totalmem(),
            },
            geometry,
            hostContext,
            effectivePolicy: {
              requestedDevelopmentFeatures: enabledFeatures,
              supportsThreadTimeline: hostContext.supportsThreadTimeline,
              effectiveThreadTimelineReadEnabled:
                hostContext.supportsThreadTimeline && hostContext.historyPolicy?.timeline === true,
              historyPolicy: hostContext.historyPolicy,
              normalizedItemTimelines: startedResident.itemTimelines,
              activeNormalizedViewerChannels: startedResident.normalizedChannels,
              referenceObserved: {
                usesUnifiedTimeline: true,
                retainActiveInterest: true,
                rendererNativeTimelineReadAssignment: false,
                rendererActiveEvictionAssignment: false,
                evidence: "reference-history-policy-20261013-d/metadata.json",
              },
              retentionLimit:
                "Reference active interest is the visible viewer lease, independent of eviction assignment. Packaged ordinary history uses its renderer-local manager; the fresh Ready SDK assignments for native timeline reads and active eviction were both false. Nodex configures both policies explicitly for both corpora; timeline-on runs are separate conformance measurements.",
            },
            before,
            after,
            startedResident,
            wheel,
            find,
            nativeSamples,
            nativeMetadataProof: {
              verifiedNativeTurnCount,
              nativeMetadataPages,
              emptyItemBodies: true,
              additionalModelTurns: 0,
            },
            nativeSearchSummary: summary(
              nativeSamples
                .filter((value) => value.phase === "independent-native-search")
                .map((value) => value.durationMs),
            ),
            limits:
              "Official pinned backend, copied native rollouts, no model Turns or fake runtime. UI includes search debounce, native persisted search, normal restore, DOM, two rAF and automation. Separate raw native search samples have their own process/request IDs, client timestamps and response byte counts; no physical UI-RPC timeline or duration subtraction is claimed. DOM presence and raw residency are separate measured cohorts. Index adoption is separate from steady state.",
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      await writeFile(
        resultPath,
        `${JSON.stringify({ corpus: corpus.corpus, failed: true, authCopied, profileIdentity, ownership: { electronPid: ownedElectronPid, lastProcessEvidence }, attachmentEvidence, error: error instanceof Error ? error.message : String(error), nativeSamples }, null, 2)}\n`,
      );
      throw error;
    } finally {
      await rm(authPath, { force: true });
      await harness.close();
    }
  }
});
