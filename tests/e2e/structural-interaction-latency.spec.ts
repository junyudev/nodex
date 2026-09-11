import { invokeIpc } from "./support/editor-scenario";
import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveCoreExecutable } from "../../src/main/core-client/core-launcher";
import os from "node:os";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  STRUCTURAL_INTERACTIONS_SCENARIO_ID,
  STRUCTURAL_INTERACTIONS_PRESSURE_SCENARIO_ID,
  requireStructuralInteractionsFacts,
} from "../../scripts/scenarios/scenarios/structural-interactions";
import { dragBlockFromEditorWithMouse } from "./support/drag-block-with-mouse";
import { openBoardPageFromCard } from "./support/open-board-page";
import { selectEditorBlockRange } from "./support/select-editor-block-range";

interface GestureTiming {
  readonly event: "drop" | "cut";
  readonly eventReceived: boolean;
  readonly nativeEvents: readonly string[];
  readonly dispatchTurnMs: number | null;
  readonly feedbackPaintMs: number | null;
  readonly sourceDomMs: number | null;
  readonly targetDomMs: number | null;
  readonly pendingObserved: boolean;
  readonly sourcePendingObserved: boolean;
  readonly targetPendingObserved: boolean;
  readonly longTasksMs: readonly number[];
}

/** Observe native events and painted DOM; no synthetic transfer or clipboard event. */
const observeGesture = async (
  page: Page,
  sourceRootId: string,
  event: "drop" | "cut",
  targetSelector: string,
) => {
  await page.evaluate(
    ({ sourceRootId, event, targetSelector }) => {
      const initialPages = new Set(
        [...document.querySelectorAll(targetSelector)].map(
          (element) =>
            element.getAttribute("data-board-uuid-v7") ??
            element.getAttribute("data-database-view-page-id"),
        ),
      );
      const nativeEvents: string[] = [];
      const trackNative = (event: Event) => {
        if (nativeEvents.length >= 32) return;
        const target = event.target instanceof Element ? event.target : null;
        nativeEvents.push(
          `${event.type}:${target?.tagName}:${target?.getAttribute("draggable")}:${target?.isConnected}`,
        );
      };
      const nativeTypes = ["pointerdown", "dragstart", "dragend", "pointercancel", "drop"];
      for (const type of nativeTypes) window.addEventListener(type, trackNative, true);
      let started: number | null = null;
      let dispatchTurnMs: number | null = null;
      let feedbackPaintMs: number | null = null;
      let sourceDomMs: number | null = null;
      let targetDomMs: number | null = null;
      let paintScheduled = false;
      let pendingObserved = false;
      let sourcePendingObserved = false;
      let targetPendingObserved = false;
      const longTasksMs: number[] = [];
      const check = () => {
        if (started === null) return;
        const elapsed = performance.now() - started;
        if (
          !document.querySelector(`.ProseMirror .bn-block[data-id="${CSS.escape(sourceRootId)}"]`)
        )
          sourceDomMs ??= elapsed;
        const sourcePending = document.querySelector("[data-nfm-pending-removal]");
        const targetPending = document.querySelector("[data-pending-promotion]");
        sourcePendingObserved ||= sourcePending !== null;
        targetPendingObserved ||= targetPending !== null;
        const pending = sourcePending ?? targetPending;
        pendingObserved ||= pending !== null;
        if (
          event === "drop" &&
          [...document.querySelectorAll(targetSelector)].some((element) => {
            const id =
              element.getAttribute("data-board-uuid-v7") ??
              element.getAttribute("data-database-view-page-id");
            return id !== null && !initialPages.has(id);
          })
        )
          targetDomMs ??= elapsed;
        if (paintScheduled || (!pending && sourceDomMs === null && targetDomMs === null)) return;
        paintScheduled = true;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            feedbackPaintMs = performance.now() - started!;
          }),
        );
      };
      const begin = () => {
        started = performance.now();
        // Microtasks may run between native event listeners. This timer is an
        // upper bound on the dispatch turn; the development span times the handler itself.
        setTimeout(() => {
          dispatchTurnMs = performance.now() - started!;
          check();
        });
      };
      window.addEventListener(event, begin, { capture: true, once: true });
      const mutations = new MutationObserver(check);
      mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
      const tasks = new PerformanceObserver((list) => {
        if (started === null) return;
        for (const entry of list.getEntries())
          if (entry.startTime + entry.duration > started && longTasksMs.length < 256)
            longTasksMs.push(Math.min(entry.duration, entry.startTime + entry.duration - started));
      });
      tasks.observe({ type: "longtask" });
      (
        window as unknown as { structuralGestureProbe: { finish(): GestureTiming } }
      ).structuralGestureProbe = {
        finish: () => {
          for (const type of nativeTypes) window.removeEventListener(type, trackNative, true);
          mutations.disconnect();
          tasks.disconnect();
          window.removeEventListener(event, begin, true);
          return {
            event,
            eventReceived: started !== null,
            nativeEvents,
            dispatchTurnMs,
            feedbackPaintMs,
            sourceDomMs,
            targetDomMs,
            pendingObserved,
            sourcePendingObserved,
            targetPendingObserved,
            longTasksMs,
          };
        },
      };
    },
    { sourceRootId, event, targetSelector },
  );
};
const finishGesture = async (page: Page): Promise<GestureTiming> => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return await page.evaluate(() =>
    (
      window as unknown as { structuralGestureProbe: { finish(): GestureTiming } }
    ).structuralGestureProbe.finish(),
  );
};

const readDevelopmentPhases = async (page: Page) =>
  await page.evaluate(async () => {
    const modulePath = "/lib/renderer-causal-trace.ts";
    const module = await import(modulePath);
    const snapshot = module.rendererCausalTrace.snapshot();
    module.rendererCausalTrace.clear();
    return snapshot;
  });

test("structural gestures preserve Files and hand off source and target independently", async ({}, testInfo) => {
  const scenarioId =
    process.env.NODEX_STRUCTURAL_PRESSURE === "1"
      ? STRUCTURAL_INTERACTIONS_PRESSURE_SCENARIO_ID
      : STRUCTURAL_INTERACTIONS_SCENARIO_ID;
  const warmSamples = Number(process.env.NODEX_STRUCTURAL_SAMPLES ?? "0");
  if (!Number.isInteger(warmSamples) || warmSamples < 0 || warmSamples > 100)
    throw new Error("NODEX_STRUCTURAL_SAMPLES must be 0-100");
  test.setTimeout(240_000 + warmSamples * 40_000);
  // Comparing checkouts requires isolated build directories. Keep this binary fixed during the run.
  const coreExecutable = resolveCoreExecutable({
    isPackaged: false,
    repositoryRoot: process.cwd(),
  });
  const coreSha256 = createHash("sha256")
    .update(await readFile(coreExecutable))
    .digest("hex");
  const initialLoadAverage = os.loadavg();
  const samples: (GestureTiming & {
    readonly settings: boolean;
    readonly temperature: "cold" | "warm";
    readonly iteration: number;
  })[] = [];
  for (const settings of [false, true]) {
    await withElectronScenario(
      {
        label: `structural-interactions-${settings ? "on" : "off"}`,
        scenarioId,
        onFailure: async ({ page, readRuntimeLogs }) => {
          await testInfo.attach("runtime", {
            body: Buffer.from(await readRuntimeLogs()),
            contentType: "text/plain",
          });
          if (page) {
            await testInfo.attach("gesture-state", {
              body: Buffer.from(
                JSON.stringify(
                  await page.evaluate(() => ({
                    active: document.activeElement?.outerHTML.slice(0, 300),
                    probe: (
                      window as unknown as { structuralGestureProbe?: { finish(): GestureTiming } }
                    ).structuralGestureProbe?.finish(),
                  })),
                ),
              ),
              contentType: "application/json",
            });
            const issues = page.getByRole("button", { name: "Content issues", exact: true });
            if (await issues.isVisible()) await issues.click();
            await testInfo.attach("accessibility", {
              body: Buffer.from(await page.locator("body").ariaSnapshot()),
              contentType: "text/plain",
            });
            await testInfo.attach("failure", {
              body: await page.screenshot(),
              contentType: "image/png",
            });
          }
        },
      },
      async ({ page, application, manifest, facts, seed }) => {
        if (!manifest) throw new Error("Structural fixture is missing");
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const fixture = requireStructuralInteractionsFacts(facts);
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.evaluate((enabled) => {
          localStorage.setItem("nodex-copy-file-references-as-local-paths-v1", String(enabled));
          localStorage.setItem("nodex-task-shorthand-page-promotion-v1", String(enabled));
        }, settings);
        await page
          .getByRole("button", { name: "Open Structural Interactions", exact: true })
          .click();
        const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
        await expect(board).toBeVisible();
        await openBoardPageFromCard({
          page,
          card: board.locator(`[data-board-uuid-v7="${fixture.sourcePageId}"]`),
          tabName: "Structural source",
        });
        const sourcePanel = page.getByRole("tabpanel", { name: /Structural source$/ });
        const sourceEditor = sourcePanel.locator(".nfm-editor");
        const sourceSurface = sourceEditor.locator('.ProseMirror[contenteditable="true"]');
        const sourceRoot = sourceSurface.locator(`.bn-block[data-id="${fixture.paragraphRootId}"]`);
        await expect(sourceRoot).toBeVisible();
        if (process.env.ELECTRON_RENDERER_URL) await readDevelopmentPhases(page);
        for (let iteration = 0; iteration <= warmSamples; iteration += 1) {
          const temperature = iteration === 0 ? ("cold" as const) : ("warm" as const);
          const record = !settings && iteration === 0;
          if (record)
            await page.screencast.start({
              path: testInfo.outputPath("review.webm"),
              size: { width: 1440, height: 960 },
              annotate: { position: "bottom", fontSize: 14 },
            });
          try {
            await observeGesture(page, fixture.paragraphRootId, "drop", "[data-board-uuid-v7]");
            await dragBlockFromEditorWithMouse({
              page,
              sourceBlock: sourceRoot,
              sourceEditor,
              target: board,
              targetYRatio: 0.75,
            });
            await expect(sourceRoot).toHaveCount(0, { timeout: 45_000 });
            const result = board.locator(`[data-board-uuid-v7="${fixture.paragraphRootId}"]`);
            await expect(result).toBeVisible({ timeout: 15_000 });
            await expect(result).toContainText(
              settings ? "Structural batch" : "1XL Structural batch",
            );
            await expect(page.locator("[data-pending-promotion]")).toHaveCount(0, {
              timeout: 15_000,
            });
            const timing = await finishGesture(page);
            expect(timing.feedbackPaintMs).not.toBeNull();
            expect(timing.sourceDomMs).not.toBeNull();
            expect(timing.targetDomMs).not.toBeNull();
            samples.push({ ...timing, settings, temperature, iteration });
            await writeFile(
              testInfo.outputPath("partial-metrics.json"),
              JSON.stringify(samples, null, 2),
            );
            if (record) await page.screenshot({ path: testInfo.outputPath("final.png") });
          } finally {
            if (record) await page.screencast.stop();
          }
          await sourceSurface.focus();
          await page.keyboard.press("Meta+Z");
          await expect(sourceRoot).toBeVisible({ timeout: 15_000 });
          await expect(
            board.locator(`[data-board-uuid-v7="${fixture.paragraphRootId}"]`),
          ).toHaveCount(0, { timeout: 15_000 });

          await selectEditorBlockRange({
            page,
            editor: sourceEditor,
            firstBlock: sourceRoot,
            lastBlock: sourceRoot,
          });
          await sourceSurface.focus();
          await observeGesture(page, fixture.paragraphRootId, "cut", "[data-board-uuid-v7]");
          await page.keyboard.press("Meta+X");
          await expect(sourceRoot).toHaveCount(0, { timeout: 45_000 });
          samples.push({ ...(await finishGesture(page)), settings, temperature, iteration });
          if (settings)
            await expect
              .poll(
                () =>
                  application.evaluate(async ({ clipboard }) =>
                    (await clipboard.readText()).includes("nodex://files/"),
                  ),
                { timeout: 15_000 },
              )
              .toBe(false);
          if (iteration === 0) {
            const opened = application.waitForEvent("window");
            expect(await invokeIpc(page, "window:new", {})).toBe(true);
            const targetWindow = await opened;
            targetWindow.on("pageerror", (error) => pageErrors.push(error.message));
            await targetWindow.waitForURL((url) => url.protocol !== "about:");
            await targetWindow.waitForLoadState("domcontentloaded");
            await targetWindow.evaluate(() => window.api?.awaitInitialization?.());
            await targetWindow
              .getByRole("button", { name: "Open Structural Interactions", exact: true })
              .click();
            await openBoardPageFromCard({
              page: targetWindow,
              card: targetWindow.locator(`[data-board-uuid-v7="${fixture.targetPageId}"]`),
              tabName: "Paste target",
            });
            const targetEditor = targetWindow
              .getByRole("tabpanel", { name: /Paste target$/ })
              .locator('.ProseMirror[contenteditable="true"]');
            await targetEditor.getByText("Paste here", { exact: true }).click();
            await targetWindow.keyboard.press("Meta+ArrowRight");
            await targetWindow.keyboard.press("Meta+V");
            const pasted = targetEditor.locator(`.bn-block[data-id="${fixture.paragraphRootId}"]`);
            await expect(pasted).toBeVisible({ timeout: 15_000 });
            const inventory = await seed.readPageFileInventory(
              manifest.projectId,
              fixture.targetPageId,
            );
            expect(inventory.files.map((entry) => entry.file.file_id).sort()).toEqual(
              [fixture.sharedFileId, fixture.secondFileId].sort(),
            );
            await targetEditor.focus();
            await targetWindow.keyboard.press("Meta+Z");
            await expect(pasted).toHaveCount(0, { timeout: 15_000 });
            await expect(sourceRoot).toBeVisible({ timeout: 15_000 });
            await targetWindow.close();
            await page.bringToFront();
          } else {
            await sourceSurface.focus();
            await page.keyboard.press("Meta+Z");
            await expect(sourceRoot).toBeVisible({ timeout: 15_000 });
          }
          if (process.env.ELECTRON_RENDERER_URL) {
            await writeFile(
              testInfo.outputPath(`phases-${settings ? "on" : "off"}-${iteration}.json`),
              JSON.stringify(await readDevelopmentPhases(page), null, 2),
            );
          }
        }
        // One native List gesture reuses the same source and exact command boundary.
        await page.getByRole("tab", { name: "Project Home", exact: true }).click();
        await page
          .getByRole("tablist", { name: "Database views" })
          .locator(`[data-database-view-tab-menu-target="${fixture.listViewId}"]`)
          .click();
        const list = page.getByRole("grid", { name: /List$/ });
        const listTarget = list.locator(
          `[data-list-row="true"][data-database-view-page-id="${fixture.sourcePageId}"]`,
        );
        await expect(listTarget).toBeVisible();
        await dragBlockFromEditorWithMouse({
          page,
          sourceBlock: sourceRoot,
          sourceEditor,
          target: listTarget,
          targetYRatio: 0.25,
        });
        await expect(sourceRoot).toHaveCount(0, { timeout: 45_000 });
        await expect(
          list.locator(
            `[data-list-row="true"][data-database-view-page-id="${fixture.paragraphRootId}"]`,
          ),
        ).toBeVisible({ timeout: 15_000 });
        await expect(list.locator("[data-pending-promotion]")).toHaveCount(0, { timeout: 15_000 });
        await sourceSurface.focus();
        await page.keyboard.press("Meta+Z");
        await expect(sourceRoot).toBeVisible({ timeout: 15_000 });
        if (process.env.ELECTRON_RENDERER_URL) {
          const trace = await readDevelopmentPhases(page);
          await writeFile(
            testInfo.outputPath(`phases-${settings ? "on" : "off"}.json`),
            JSON.stringify(trace, null, 2),
          );
        }
        expect(pageErrors).toEqual([]);
      },
    );
  }
  const summary = (event: GestureTiming["event"], settings: boolean) => {
    const rows = samples.filter(
      (sample) =>
        sample.event === event && sample.settings === settings && sample.temperature === "warm",
    );
    const distribution = (values: readonly (number | null)[]) => {
      const sorted = values
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      return {
        count: sorted.length,
        p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
        p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
        max: sorted.at(-1) ?? null,
        ...(sorted.length >= 100 ? { p99: sorted[Math.ceil(sorted.length * 0.99) - 1] } : {}),
      };
    };
    return {
      event,
      settings,
      feedback: distribution(rows.map((row) => row.feedbackPaintMs)),
      dispatchTurn: distribution(rows.map((row) => row.dispatchTurnMs)),
      source: distribution(rows.map((row) => row.sourceDomMs)),
      target: distribution(rows.map((row) => row.targetDomMs)),
    };
  };
  const packageManifest = JSON.parse(await readFile("package.json", "utf8"));

  expect(
    createHash("sha256")
      .update(await readFile(coreExecutable))
      .digest("hex"),
  ).toBe(coreSha256);
  await writeFile(
    testInfo.outputPath("metrics.json"),
    JSON.stringify(
      {
        status: "passed",
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        dirty:
          execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
        versions: {
          react: packageManifest.dependencies.react,
          blocknote: packageManifest.dependencies["@blocknote/core"],
          electron: packageManifest.devDependencies.electron,
          playwright: packageManifest.devDependencies["@playwright/test"],
        },
        initialLoadAverage,
        scenario: scenarioId,
        scenarioRevision: 1,
        build: process.env.ELECTRON_RENDERER_URL ? "development" : "production",
        coreBuild: "debug",
        coreExecutable,
        coreSha256,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpus: os.cpus().length,
        loadAverage: os.loadavg(),
        warmSamples,
        samples,
        summaries: [
          summary("drop", false),
          summary("drop", true),
          summary("cut", false),
          summary("cut", true),
        ],
      },
      null,
      2,
    ),
  );
});
