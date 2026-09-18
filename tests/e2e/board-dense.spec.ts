import { expect, test, type Locator, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  focusBoardDenseProjectHome,
  focusBoardDenseUi,
  observeBoardDenseUi,
} from "../../scripts/scenarios/scenarios/board-dense-ui";
import {
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/board-dense";
import { dragBlockFromEditorWithMouse } from "./support/drag-block-with-mouse";

const primaryShortcut = (key: string): string =>
  `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

const focusEditableBlockEnd = async (page: Page, block: Locator): Promise<void> => {
  const point = await block.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let editableText: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[contenteditable="false"]')) continue;
      editableText = node as Text;
    }
    if (!editableText) throw new Error("Block has no editable text boundary");
    const range = document.createRange();
    const offset = Math.max(0, editableText.data.length - 1);
    range.setStart(editableText, offset);
    range.setEnd(editableText, editableText.data.length);
    const rect = range.getBoundingClientRect();
    return { x: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("End");
};

const focusEditableBlockAfterPageMention = async (block: Locator): Promise<void> => {
  await block.evaluate((element) => {
    element.closest<HTMLElement>('.ProseMirror[contenteditable="true"]')?.focus();
    const mentionRoot = element.querySelector<HTMLElement>('[data-mention-inline-root="true"]');
    if (!mentionRoot) throw new Error("Block has no page mention boundary");
    const mentionNodeView =
      mentionRoot.closest<HTMLElement>(".bn-ic-react-node-view-renderer") ?? mentionRoot;

    const range = document.createRange();
    range.setStartAfter(mentionNodeView);
    range.collapse(true);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
};

const readPageMentionHighlight = async (mention: Locator) => {
  return mention.evaluate((element) => {
    const style = globalThis.getComputedStyle(element, "::before");
    return {
      opacity: style.opacity,
      backgroundColor: style.backgroundColor,
      left: style.left,
      right: style.right,
      top: style.top,
      bottom: style.bottom,
    };
  });
};

const readOpaqueSurfaceStyle = async (surface: Locator) => {
  return surface.evaluate((element) => {
    const style = globalThis.getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
    };
  });
};

interface LocatorGeometry {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

const requireLocatorGeometry = async (
  locator: Locator,
  label: string,
): Promise<LocatorGeometry> => {
  let geometry: LocatorGeometry | null = null;
  await expect(async () => {
    geometry = await locator.boundingBox();
    expect(geometry, `${label} geometry is unavailable`).not.toBeNull();
  }).toPass({ timeout: 10_000 });
  if (!geometry) throw new Error(`${label} geometry is unavailable`);
  return geometry;
};

const revealWithHover = async (target: Locator, revealed: Locator): Promise<void> => {
  await expect(async () => {
    await target.hover({ timeout: 2_000 });
    await expect(revealed).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
};

const clearQueryAndCloseCommandPalette = async ({
  page,
  dialog,
  search,
}: {
  readonly page: Page;
  readonly dialog: Locator;
  readonly search: Locator;
}): Promise<void> => {
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
};

const setBoardCardPriority = async ({
  page,
  pageId,
  optionName,
}: {
  readonly page: Page;
  readonly pageId: string;
  readonly optionName: string;
}): Promise<void> => {
  const card = page.locator(`[data-board-uuid-v7="${pageId}"]`);
  await expect(card).toBeVisible();
  await card.locator('[data-card-context-menu-trigger="true"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /Priority/u }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
};

const dragBoardCardWithMouse = async ({
  page,
  source,
  target,
  expectPropertyChangeIndicator = false,
}: {
  readonly page: Page;
  readonly source: Locator;
  readonly target: Locator;
  readonly expectPropertyChangeIndicator?: boolean;
}): Promise<void> => {
  const sourceBox = await requireLocatorGeometry(source, "Board drag source");
  const targetBox = await requireLocatorGeometry(target, "Board drag target");
  const sourcePoint = {
    x: sourceBox.x + 3,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const targetPoint = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + Math.max(24, targetBox.height - 18),
  };
  let released = false;
  try {
    await page.mouse.move(sourcePoint.x, sourcePoint.y);
    await page.mouse.down();
    await page.mouse.move(sourcePoint.x + 12, sourcePoint.y, { steps: 4 });
    await expect(source).toHaveAttribute("data-database-view-page-drag-active", "true");
    await expect(source).toHaveCSS("opacity", "0.45");
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 30 });
    await page.mouse.move(targetPoint.x + 1, targetPoint.y + 1);
    await page.mouse.move(targetPoint.x + 2, targetPoint.y + 2);
    await expect(page.locator('[data-board-drop-indicator="true"]')).toBeVisible();
    if (expectPropertyChangeIndicator) {
      await expect(page.locator('[data-board-property-change-indicator="true"]')).toBeVisible();
    } else {
      await expect(page.locator('[data-board-property-change-indicator="true"]')).toHaveCount(0);
    }
    await page.mouse.up();
    released = true;
    if (expectPropertyChangeIndicator) {
      await expect(page.locator('[data-board-drop-indicator="true"]')).toHaveCount(0);
      await expect(page.locator('[data-board-property-change-indicator="true"]')).toHaveCount(0);
    }
  } finally {
    if (!released) await page.mouse.up().catch(() => undefined);
  }
};

const observeSortedBoardContinuity = async ({
  page,
  columnId,
  pageIds,
}: {
  readonly page: Page;
  readonly columnId: string;
  readonly pageIds: readonly string[];
}): Promise<void> => {
  await page.evaluate(
    ({ columnId: observedColumnId, pageIds: observedPageIds }) => {
      const surface = document.querySelector<HTMLElement>('[data-database-board-scroll="true"]');
      if (!surface) throw new Error("Board continuity surface is missing");
      const trackedNodes = new Map(
        observedPageIds.map((pageId) => [
          pageId,
          document.querySelector<HTMLElement>(`[data-board-uuid-v7="${pageId}"]`),
        ]),
      );
      const samples: Array<{
        readonly sameSurface: boolean;
        readonly sameTrackedNodes: boolean;
        readonly order: readonly string[];
      }> = [];
      const sample = (): void => {
        const currentSurface = document.querySelector<HTMLElement>(
          '[data-database-board-scroll="true"]',
        );
        const column = document.querySelector<HTMLElement>(
          `[data-board-column-root][data-board-column-id="${observedColumnId}"]`,
        );
        const order = Array.from(
          column?.querySelectorAll<HTMLElement>("[data-board-uuid-v7]") ?? [],
        ).flatMap((element) => {
          const pageId = element.dataset.boardUuidV7;
          return pageId && observedPageIds.includes(pageId) ? [pageId] : [];
        });
        samples.push({
          sameSurface: currentSurface === surface,
          sameTrackedNodes: observedPageIds.every(
            (pageId) =>
              column?.querySelector(`[data-board-uuid-v7="${pageId}"]`) ===
              trackedNodes.get(pageId),
          ),
          order,
        });
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { childList: true, subtree: true });
      sample();
      (
        globalThis as typeof globalThis & {
          __nodexSortedBoardContinuity?: {
            readonly observer: MutationObserver;
            readonly samples: typeof samples;
          };
        }
      ).__nodexSortedBoardContinuity = { observer, samples };
    },
    { columnId, pageIds },
  );
};

const finishSortedBoardContinuityObservation = async (page: Page) =>
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const state = (
      globalThis as typeof globalThis & {
        __nodexSortedBoardContinuity?: {
          readonly observer: MutationObserver;
          readonly samples: ReadonlyArray<{
            readonly sameSurface: boolean;
            readonly sameTrackedNodes: boolean;
            readonly order: readonly string[];
          }>;
        };
      }
    ).__nodexSortedBoardContinuity;
    if (!state) throw new Error("Board continuity observation was not started");
    state.observer.disconnect();
    return state.samples;
  });

const dragDatabasePageToEditorWithMouse = async ({
  page,
  source,
  editor,
}: {
  readonly page: Page;
  readonly source: Locator;
  readonly editor: Locator;
}): Promise<void> => {
  await source.scrollIntoViewIfNeeded();
  const editorSurface = editor.locator('.ProseMirror[contenteditable="true"]').first();
  await editorSurface.scrollIntoViewIfNeeded();
  const sourceBox = await requireLocatorGeometry(source, "Database Page drag source");
  const editorBox = await requireLocatorGeometry(editorSurface, "Database Page drag target");
  const sourcePoint = {
    x: sourceBox.x + Math.min(12, sourceBox.width / 2),
    y: sourceBox.y + sourceBox.height / 2,
  };
  const viewport = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  const editorViewport = {
    left: Math.max(editorBox.x + 16, 16),
    right: Math.min(editorBox.x + editorBox.width - 16, viewport.width - 16),
    top: Math.max(editorBox.y + 16, 16),
    bottom: Math.min(editorBox.y + editorBox.height - 16, viewport.height - 16),
  };
  if (editorViewport.right <= editorViewport.left || editorViewport.bottom <= editorViewport.top) {
    throw new Error("Database Page editor has no visible drop surface");
  }
  const targetPoint = {
    x: Math.min(editorViewport.left + 160, editorViewport.right),
    y: Math.min(editorViewport.top + 64, editorViewport.bottom),
  };
  let released = false;
  try {
    await page.mouse.move(sourcePoint.x, sourcePoint.y);
    await page.mouse.down();
    await page.mouse.move(sourcePoint.x + 12, sourcePoint.y, { steps: 4 });
    await expect(source).toHaveAttribute("data-database-view-page-drag-active", "true");
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 30 });
    await page.mouse.move(targetPoint.x + 1, targetPoint.y + 1);
    await page.mouse.move(targetPoint.x + 2, targetPoint.y + 2);
    await expect(editor.locator("[data-block-transfer-drop-indicator]")).toBeVisible();
    await page.mouse.up();
    released = true;
  } finally {
    if (!released) await page.mouse.up().catch(() => undefined);
  }
};

test("moves Board cards and List rows into NFM as real Page blocks", async () => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "database-view-page-to-editor",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
    },
    async ({ application, page, manifest }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      await focusBoardDenseUi(page, manifest);
      await page
        .locator('[data-page-stage-surface="true"]:visible')
        .getByRole("link", { name: "Open projection notes" })
        .click();
      await expect(
        page.getByRole("tab", { name: "Keep projection updates bounded" }),
      ).toHaveAttribute("aria-selected", "true");
      const referenceTab = page.getByRole("tab", { name: "Keep projection updates bounded" });
      await referenceTab.dblclick();
      await expect(referenceTab).not.toHaveAttribute("data-app-shell-tab-preview", "true");
      await referenceTab.click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Move to (?:right|bottom) panel$/u }).click();
      await page.getByRole("tab", { name: "Project Home" }).click();

      const primaryPageId = manifest.pageIdsByKey.boundedProjection;
      const boardSourcePageId = manifest.pageIdsByKey.offlineRecovery;
      const listSourcePageId = manifest.pageIdsByKey.sceneOwnership;
      if (!primaryPageId || !boardSourcePageId || !listSourcePageId) {
        throw new Error("board/dense Page transfer fixtures are missing");
      }
      const editor = page
        .locator(`[data-page-stage-page-id="${primaryPageId}"]:visible .nfm-editor`)
        .first();
      await expect(editor).toBeVisible();

      const boardSource = page.locator(`[data-board-uuid-v7="${boardSourcePageId}"]:visible`);
      await expect(boardSource).toBeVisible();
      await dragDatabasePageToEditorWithMouse({ page, source: boardSource, editor });
      await expect(
        editor.locator(`[data-page-outliner-target="${boardSourcePageId}"]`),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`[data-board-uuid-v7="${boardSourcePageId}"]`)).toHaveCount(0, {
        timeout: 15_000,
      });

      await page
        .getByRole("tablist", { name: "Database views" })
        .getByRole("tab", { name: "List", exact: true })
        .click();
      const list = page.getByRole("grid", { name: /List$/ });
      await expect(list).toBeVisible({ timeout: 15_000 });
      const listSource = list.locator(
        `[data-list-row="true"][data-database-view-page-id="${listSourcePageId}"]`,
      );
      await expect(listSource).toBeVisible();
      await dragDatabasePageToEditorWithMouse({
        page,
        source: listSource.locator('[data-database-view-page-drag-handle="true"]'),
        editor,
      });
      await expect(editor.locator(`[data-page-outliner-target="${listSourcePageId}"]`)).toBeVisible(
        { timeout: 15_000 },
      );
      await expect(listSource).toHaveCount(0, { timeout: 15_000 });
    },
  );
});

test("round-trips a Board Page through a Subpage without stale presentation", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "database-view-page-to-editor",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
    },
    async ({ application, page, manifest }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      await focusBoardDenseUi(page, manifest);
      await page
        .locator('[data-page-stage-surface="true"]:visible')
        .getByRole("link", { name: "Open projection notes" })
        .click();
      await expect(
        page.getByRole("tab", { name: "Keep projection updates bounded" }),
      ).toHaveAttribute("aria-selected", "true");
      const referenceTab = page.getByRole("tab", { name: "Keep projection updates bounded" });
      await referenceTab.dblclick();
      await expect(referenceTab).not.toHaveAttribute("data-app-shell-tab-preview", "true");
      await referenceTab.click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Move to (?:right|bottom) panel$/u }).click();
      await page.getByRole("tab", { name: "Project Home" }).click();

      const primaryPageId = manifest.pageIdsByKey.boundedProjection;
      const boardSourcePageId = manifest.pageIdsByKey.offlineRecovery;
      if (!primaryPageId || !boardSourcePageId) {
        throw new Error("board/dense Page transfer fixtures are missing");
      }
      const editor = page
        .locator(`[data-page-stage-page-id="${primaryPageId}"]:visible .nfm-editor`)
        .first();
      await expect(editor).toBeVisible();

      const boardSource = page.locator(`[data-board-uuid-v7="${boardSourcePageId}"]:visible`);
      await expect(boardSource).toBeVisible();
      const boardSourceTitle = (
        await boardSource.locator('[data-database-view-page-open="true"]').first().textContent()
      )?.trim();
      if (!boardSourceTitle) throw new Error("Board Page title is missing");
      await dragDatabasePageToEditorWithMouse({ page, source: boardSource, editor });
      await expect(
        editor.locator(`[data-page-outliner-target="${boardSourcePageId}"]`),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`[data-board-uuid-v7="${boardSourcePageId}"]`)).toHaveCount(0, {
        timeout: 15_000,
      });

      const subpageBlock = editor.locator(`.bn-block[data-id="${boardSourcePageId}"]`);
      await expect(subpageBlock).toBeVisible({ timeout: 30_000 });
      const triageColumn = page.locator(
        '[data-board-column-root][data-board-column-id="triage"]:visible',
      );
      await page.evaluate(
        ({ pageId }) => {
          type RoundTripSample = {
            readonly at: number;
            readonly predictedText: string | null;
            readonly canonicalText: string | null;
            readonly canonicalOpacity: string | null;
            readonly canonicalClassName: string | null;
            readonly canonicalAriaSelected: string | null;
            readonly canonicalDragActive: string | null;
          };
          const state = {
            samples: [] as RoundTripSample[],
            predictedTextsSeen: [] as string[],
            dropped: false,
            settled: false,
            stableCanonicalFrames: 0,
          };
          (
            globalThis as typeof globalThis & {
              __nodexSubpageBoardRoundTrip?: typeof state;
            }
          ).__nodexSubpageBoardRoundTrip = state;

          const recordPredictedNode = (node: Node): void => {
            if (!state.dropped || !(node instanceof Element)) return;
            const candidates = [
              ...(node.matches(`[data-predicted-page="${pageId}"]`) ? [node] : []),
              ...node.querySelectorAll(`[data-predicted-page="${pageId}"]`),
            ];
            for (const candidate of candidates) {
              const text = candidate.textContent?.trim();
              if (text) state.predictedTextsSeen.push(text);
            }
          };
          const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              if (mutation.type !== "childList") continue;
              mutation.addedNodes.forEach(recordPredictedNode);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });

          const sample = (): void => {
            if (!state.dropped || state.settled) {
              requestAnimationFrame(sample);
              return;
            }
            const predicted = document.querySelector<HTMLElement>(
              `[data-predicted-page="${pageId}"]`,
            );
            const canonical = document.querySelector<HTMLElement>(
              `[data-board-uuid-v7="${pageId}"]`,
            );
            state.samples.push({
              at: performance.now(),
              predictedText: predicted?.textContent?.trim() ?? null,
              canonicalText: canonical?.textContent?.trim() ?? null,
              canonicalOpacity: canonical ? getComputedStyle(canonical).opacity : null,
              canonicalClassName: canonical?.className ?? null,
              canonicalAriaSelected: canonical?.getAttribute("aria-selected") ?? null,
              canonicalDragActive:
                canonical?.getAttribute("data-database-view-page-drag-active") ?? null,
            });
            state.stableCanonicalFrames =
              canonical && !predicted ? state.stableCanonicalFrames + 1 : 0;
            if (state.stableCanonicalFrames >= 4) {
              state.settled = true;
              observer.disconnect();
              return;
            }
            requestAnimationFrame(sample);
          };
          document.addEventListener(
            "drop",
            () => {
              state.dropped = true;
            },
            { capture: true, once: true },
          );
          requestAnimationFrame(sample);
        },
        { pageId: boardSourcePageId },
      );

      await dragBlockFromEditorWithMouse({
        page,
        sourceBlock: subpageBlock,
        sourceEditor: editor,
        target: triageColumn,
      });
      await expect
        .poll(
          async () =>
            page.evaluate(
              () =>
                (
                  globalThis as typeof globalThis & {
                    __nodexSubpageBoardRoundTrip?: { readonly settled: boolean };
                  }
                ).__nodexSubpageBoardRoundTrip?.settled ?? false,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      const roundTrip = await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __nodexSubpageBoardRoundTrip?: {
                readonly predictedTextsSeen: readonly string[];
                readonly samples: ReadonlyArray<{
                  readonly at: number;
                  readonly predictedText: string | null;
                  readonly canonicalText: string | null;
                  readonly canonicalOpacity: string | null;
                  readonly canonicalClassName: string | null;
                  readonly canonicalAriaSelected: string | null;
                  readonly canonicalDragActive: string | null;
                }>;
              };
            }
          ).__nodexSubpageBoardRoundTrip ?? { predictedTextsSeen: [], samples: [] },
      );
      await testInfo.attach("subpage-board-round-trip-frames", {
        body: JSON.stringify(roundTrip, null, 2),
        contentType: "application/json",
      });
      expect(roundTrip.predictedTextsSeen).not.toContain("Untitled");
      if (roundTrip.predictedTextsSeen.length > 0) {
        expect(roundTrip.predictedTextsSeen).toContain(boardSourceTitle);
      }
      const canonicalFrames = roundTrip.samples.filter(
        (sample) => sample.canonicalOpacity !== null,
      );
      expect(canonicalFrames.length).toBeGreaterThan(0);
      expect(canonicalFrames.map((sample) => sample.canonicalOpacity)).toEqual(
        canonicalFrames.map(() => "1"),
      );
      await expect(page.locator(`[data-board-uuid-v7="${boardSourcePageId}"]`)).toContainText(
        boardSourceTitle,
      );
    },
  );
});

test("keeps the canonical Board while grouping and dragging by Priority", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "board-dense-priority-grouping",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("priority-grouped-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("priority-grouped-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ application, page, manifest }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
      });
      await focusBoardDenseProjectHome(page, manifest);
      const sourcePageId = manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY];
      const targetPageId = manifest.pageIdsByKey.boundedProjection;
      if (!sourcePageId || !targetPageId) {
        throw new Error("board/dense priority grouping Pages are missing");
      }
      await setBoardCardPriority({ page, pageId: sourcePageId, optionName: "P1 - High" });
      await setBoardCardPriority({ page, pageId: targetPageId, optionName: "P1 - High" });

      await page.getByRole("button", { name: "Sort View", exact: true }).click();
      await page.getByRole("button", { name: "Priority", exact: true }).click();
      await expect(page.getByTestId("database-view-rules-bar")).toBeVisible();
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Database settings", exact: true }).click();
      const settings = page.getByRole("complementary", { name: "Database settings" });
      await settings.getByRole("button", { name: /^Group\b/u }).click();
      const groupBy = settings.getByRole("button", { name: "Group by", exact: true });
      await groupBy.click();
      await page.getByRole("option", { name: "Priority", exact: true }).click();
      await expect(groupBy).toContainText("Priority");
      await settings.getByRole("button", { name: "Close settings", exact: true }).click();

      const highColumn = page.locator('[data-board-column-root][data-board-column-id="p1-high"]');
      await expect(highColumn.locator(`[data-board-uuid-v7="${sourcePageId}"]`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(highColumn.locator(`[data-board-uuid-v7="${targetPageId}"]`)).toBeVisible({
        timeout: 15_000,
      });
      const initialManualOrder = await highColumn.locator("[data-board-uuid-v7]").evaluateAll(
        (elements, pageIds) =>
          elements
            .map((element) => element.getAttribute("data-board-uuid-v7"))
            .filter((pageId): pageId is string => Boolean(pageId))
            .filter((pageId) => pageIds.includes(pageId)),
        [sourcePageId, targetPageId],
      );
      expect(initialManualOrder).toHaveLength(2);
      const [manualSourcePageId, manualTargetPageId] = initialManualOrder;
      if (!manualSourcePageId || !manualTargetPageId) {
        throw new Error("Board manual-order Pages are missing");
      }
      const unchangedSourceCard = highColumn.locator(
        `[data-board-uuid-v7="${manualSourcePageId}"]`,
      );
      const unchangedTargetCard = highColumn.locator(
        `[data-board-uuid-v7="${manualTargetPageId}"]`,
      );
      await observeSortedBoardContinuity({
        page,
        columnId: "p1-high",
        pageIds: initialManualOrder,
      });
      await dragBoardCardWithMouse({
        page,
        source: unchangedSourceCard,
        target: unchangedTargetCard,
      });
      await expect
        .poll(
          async () =>
            await highColumn.locator("[data-board-uuid-v7]").evaluateAll(
              (elements, pageIds) =>
                elements
                  .map((element) => element.getAttribute("data-board-uuid-v7"))
                  .filter((pageId): pageId is string => Boolean(pageId))
                  .filter((pageId) => pageIds.includes(pageId)),
              initialManualOrder,
            ),
          {
            timeout: 15_000,
          },
        )
        .toEqual([manualTargetPageId, manualSourcePageId]);
      await page.waitForTimeout(500);
      const continuity = await finishSortedBoardContinuityObservation(page);
      const finalManualOrder = [manualTargetPageId, manualSourcePageId];
      expect(
        continuity.flatMap((sample, index) => (sample.sameSurface ? [] : [{ index, ...sample }])),
      ).toEqual([]);
      expect(
        continuity.flatMap((sample, index) =>
          sample.sameTrackedNodes ? [] : [{ index, ...sample }],
        ),
      ).toEqual([]);
      expect(
        continuity.every(
          (sample) =>
            JSON.stringify(sample.order) === JSON.stringify(initialManualOrder) ||
            JSON.stringify(sample.order) === JSON.stringify(finalManualOrder),
        ),
      ).toBe(true);
      const firstFinalSample = continuity.findIndex(
        (sample) => JSON.stringify(sample.order) === JSON.stringify(finalManualOrder),
      );
      expect(firstFinalSample).toBeGreaterThanOrEqual(0);
      expect(
        continuity
          .slice(firstFinalSample)
          .every((sample) => JSON.stringify(sample.order) === JSON.stringify(finalManualOrder)),
      ).toBe(true);

      await setBoardCardPriority({ page, pageId: targetPageId, optionName: "P3 - Low" });

      const lowColumn = page.locator('[data-board-column-root][data-board-column-id="p3-low"]');
      const sourceCard = highColumn.locator(`[data-board-uuid-v7="${sourcePageId}"]`);
      await expect(sourceCard).toBeVisible({ timeout: 15_000 });
      const targetCard = lowColumn.locator(`[data-board-uuid-v7="${targetPageId}"]`);
      await expect(targetCard).toBeVisible();
      await expect(sourceCard).toHaveAttribute("data-database-board-card", "true");
      await expect(sourceCard.locator('[data-database-view-property-id="priority"]')).toHaveCount(
        0,
      );

      await dragBoardCardWithMouse({
        page,
        source: sourceCard,
        target: targetCard,
        expectPropertyChangeIndicator: true,
      });
      await expect
        .poll(
          async () =>
            await page
              .locator(`[data-board-uuid-v7="${sourcePageId}"]`)
              .evaluate(
                (element) =>
                  element.closest<HTMLElement>("[data-board-column-root]")?.dataset.boardColumnId ??
                  "missing",
              ),
          { timeout: 15_000 },
        )
        .toBe("p3-low");
      await expect(highColumn.locator(`[data-board-uuid-v7="${sourcePageId}"]`)).toHaveCount(0);

      await testInfo.attach("priority-grouped-board", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    },
  );
});

test("opens an unopened Page with Enter from Command Palette", async ({}, testInfo) => {
  test.setTimeout(60_000);
  await withElectronScenario(
    {
      label: "board-dense-command-palette-page",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("runtime-logs-at-failure", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        if (!page) return;
        await testInfo.attach("renderer-at-failure", {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      },
    },
    async ({ page, manifest }) => {
      if (!manifest) throw new Error("board/dense did not materialize");

      const rendererErrors: Error[] = [];
      let resolveFirstRendererError!: (error: Error) => void;
      const firstRendererError = new Promise<Error>((resolve) => {
        resolveFirstRendererError = resolve;
      });
      page.on("pageerror", (error) => {
        rendererErrors.push(error);
        resolveFirstRendererError(error);
      });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        if (!/(?:Maximum update depth exceeded|Minified React error #185)/u.test(message.text())) {
          return;
        }
        const error = new Error(message.text());
        rendererErrors.push(error);
        resolveFirstRendererError(error);
      });

      await focusBoardDenseUi(page, manifest);
      const targetTab = page.getByRole("tab", { name: "Keep projection updates bounded" });
      await expect(targetTab).toHaveCount(0);

      await page.keyboard.press(primaryShortcut("P"));
      const commandPalette = page.getByRole("dialog", { name: "Command palette" });
      await expect(commandPalette).toBeVisible();
      await page.locator('input[aria-label="Command palette search"]:visible').fill("causal");

      const targetOption = page.getByRole("option", {
        name: /Keep projection updates bounded/u,
      });
      await expect(targetOption).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(commandPalette).toHaveCount(0);
      await Promise.race([
        expect(targetTab).toHaveAttribute("aria-selected", "true"),
        firstRendererError.then((error) => Promise.reject(error)),
      ]);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      expect(rendererErrors).toEqual([]);
    },
  );
});

test("creates a new collaborative Page Block with Enter", async () => {
  await withElectronScenario(
    {
      label: "board-dense-enter-regression",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
    },
    async ({ page, manifest }) => {
      if (!manifest) throw new Error("board/dense did not materialize");
      await focusBoardDenseUi(page, manifest);
      const sourcePageId = manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY];
      if (!sourcePageId) throw new Error("board/dense source Page is missing");
      const editor = page
        .locator(`[data-page-stage-page-id="${sourcePageId}"]:visible`)
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]')
        .first();
      const blocks = editor.locator(".bn-block[data-id]");
      const originalCount = await blocks.count();
      const sourceBlock = blocks
        .filter({ hasText: "Keep Board and Page views convergent" })
        .first();
      const sourceIndex = (await blocks.allTextContents()).findIndex((text) =>
        text.includes("Keep Board and Page views convergent"),
      );
      if (sourceIndex < 0) throw new Error("board/dense Enter source Block is missing");
      const originalText = (await sourceBlock.innerText()).replace(/\s+/gu, " ").trim();

      await sourceBlock.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");

      await expect(blocks).toHaveCount(originalCount + 1);
      await expect
        .poll(async () => {
          const splitTexts = await Promise.all(
            [sourceIndex, sourceIndex + 1].map(async (index) =>
              (await blocks.nth(index).innerText()).replace(/\s+/gu, " ").trim(),
            ),
          );
          return splitTexts.join("");
        })
        .toBe(originalText);
    },
  );
});

test("materializes and opens the authoritative board/dense environment", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withElectronScenario(
    {
      label: "board-dense-ui",
      scenarioId: BOARD_DENSE_SCENARIO_ID,
      onFailure: async ({ facts, manifest, page, readRuntimeLogs }) => {
        await testInfo.attach("scenario-state-at-failure", {
          body: Buffer.from(`${JSON.stringify({ facts, manifest }, null, 2)}\n`),
          contentType: "application/json",
        });
        await testInfo.attach("runtime-logs-at-failure", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("scenario-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ harness, application, page, manifest, facts, readRuntimeLogs }) => {
      if (!manifest || !facts) throw new Error("board/dense did not materialize");
      await testInfo.attach("scenario-facts", {
        body: Buffer.from(`${JSON.stringify(facts, null, 2)}\n`),
        contentType: "application/json",
      });
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.setContentSize(1440, 960);
      });
      await page.emulateMedia({ colorScheme: "light" });
      await expect
        .poll(() =>
          page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          })),
        )
        .toEqual({ width: 1440, height: 960 });
      await focusBoardDenseProjectHome(page, manifest);
      const stickyHeader = page.locator('[data-database-board-sticky-header="true"]');
      await expect(stickyHeader).toHaveCSS("position", "sticky");
      await expect
        .poll(
          async () =>
            await stickyHeader.evaluate((element) => {
              const style = globalThis.getComputedStyle(element);
              const background = style.backgroundColor.match(/[\d.]+/gu)?.map(Number) ?? [];
              return {
                opaque: background.length < 4 || background[3] === 1,
                zIndex: Number(style.zIndex),
              };
            }),
        )
        .toEqual({ opaque: true, zIndex: 20 });
      const buildHeader = page
        .locator('[data-database-board-column-header="true"]')
        .filter({ hasText: "Build" });
      await buildHeader.hover();
      const moreOptions = buildHeader.getByRole("button", {
        name: "More options for Build",
      });
      await expect(moreOptions).toHaveCSS("opacity", "1");
      const labelBox = await requireLocatorGeometry(
        buildHeader.locator('[data-database-board-column-label="true"]'),
        "Board Column label",
      );
      const countBox = await requireLocatorGeometry(
        buildHeader.locator('[data-database-board-column-count="true"]'),
        "Board Column count",
      );
      expect(countBox.x - (labelBox.x + labelBox.width)).toBeLessThanOrEqual(8);
      await moreOptions.click();
      await page.getByRole("button", { name: "Collapse column", exact: true }).click();
      const buildColumn = page.locator('[data-board-column-root][data-board-column-id="build"]');
      await expect(buildColumn).toHaveAttribute("data-board-column-collapsed", "true");
      await expect.poll(async () => (await buildColumn.boundingBox())?.width ?? null).toBe(52);
      await expect(buildHeader.locator('[data-database-board-collapsed-label="true"]')).toHaveText(
        "Build",
      );
      const collapsedHeaderUnderlay = page
        .locator('[data-database-board-collapsed-header-underlay="true"]')
        .filter({ hasText: "Build" });
      await expect
        .poll(
          async () =>
            await collapsedHeaderUnderlay.evaluate((element) => {
              const background =
                globalThis
                  .getComputedStyle(element)
                  .backgroundColor.match(/[\d.]+/gu)
                  ?.map(Number) ?? [];
              return background.length < 4 || background[3] === 1;
            }),
        )
        .toBe(true);
      const collapsedIconBox = await requireLocatorGeometry(
        buildHeader.locator("svg").first(),
        "Collapsed Board Column icon",
      );
      const collapsedLabelBox = await requireLocatorGeometry(
        buildHeader.locator('[data-database-board-collapsed-label="true"]'),
        "Collapsed Board Column label",
      );
      expect(
        collapsedLabelBox.y - (collapsedIconBox.y + collapsedIconBox.height),
      ).toBeLessThanOrEqual(10);
      await buildColumn.getByRole("button", { name: "Expand Build" }).click();
      await expect(buildColumn).toHaveAttribute("data-board-column-collapsed", "false");
      const headerBox = await requireLocatorGeometry(buildHeader, "Board Column header");
      const buildBodyBox = await requireLocatorGeometry(
        page.locator('[data-board-column-root][data-board-column-id="build"]'),
        "Board Column body",
      );
      expect(Math.abs(headerBox.y + headerBox.height - buildBodyBox.y)).toBeLessThanOrEqual(1);
      const boardScreenshot = testInfo.outputPath("board-project-home.png");
      await page.screenshot({ path: boardScreenshot, fullPage: true });
      await focusBoardDenseUi(page, manifest);
      const observation = await observeBoardDenseUi(page);
      expect(observation).toEqual({
        totalCards: 10,
        cardsByStatus: { triage: 3, plan: 2, build: 3, review: 1, ship: 1 },
        pageStageVisible: true,
        editorVisible: true,
      });
      const sourcePageId = manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY];
      if (!sourcePageId) throw new Error("board/dense source Page is missing");
      const pageStage = page.locator(`[data-page-stage-page-id="${sourcePageId}"]:visible`);
      await expect(pageStage.getByRole("heading", { name: "Rendering contract" })).toBeVisible();
      await expect(pageStage.getByText("Use the authoritative Database projection")).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);

      const referenceTargetPageId = manifest.pageIdsByKey.boundedProjection;
      if (!referenceTargetPageId) throw new Error("board/dense reference target is missing");
      const seededPageLink = pageStage.getByRole("link", {
        name: "Open projection notes",
      });
      await seededPageLink.click();
      await expect(
        page.getByRole("tab", { name: "Keep projection updates bounded" }),
      ).toHaveAttribute("aria-selected", "true");
      const targetStage = page.locator(
        `[data-page-stage-page-id="${referenceTargetPageId}"]:visible`,
      );
      const referencedBy = targetStage.getByRole("button", { name: /Referenced by 1/u });
      await expect(referencedBy).toBeVisible();
      await referencedBy.click();
      const sourceRows = targetStage.getByRole("button", {
        name: /Unify Database View rendering/u,
      });
      await expect(sourceRows).toHaveCount(3);
      await expect(sourceRows.filter({ hasText: "Mention" })).toHaveCount(1);
      await expect(sourceRows.filter({ hasText: "Embed" })).toHaveCount(1);
      await expect(sourceRows.filter({ hasText: "Link" })).toHaveCount(1);
      await sourceRows.filter({ hasText: "Mention" }).click();
      const sourceTab = page.getByRole("tab", { name: "Unify Database View rendering" });
      await expect(sourceTab).toHaveAttribute("aria-selected", "true");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const anchor = globalThis.getSelection()?.anchorNode;
            const element = anchor instanceof Element ? anchor : anchor?.parentElement;
            return (
              element?.closest(".bn-block[data-id]")?.textContent?.replace(/\s+/gu, " ").trim() ??
              ""
            );
          }),
        )
        .toContain("Related Page");
      await expect(page.getByText("Change Page…", { exact: true })).toHaveCount(0);
      await sourceTab.click();
      await page.keyboard.press(primaryShortcut("P"));
      const commandPalette = page.getByRole("dialog", { name: "Command palette" });
      const commandPaletteSearch = page.locator(
        'input[aria-label="Command palette search"]:visible',
      );
      await expect(commandPalette).toBeVisible();
      await commandPaletteSearch.fill("causal");
      const bodySearchResult = page.getByRole("option", {
        name: /Keep projection updates bounded/u,
      });
      await expect(bodySearchResult).toBeVisible();
      await expect(bodySearchResult.getByText("causal", { exact: true })).toBeVisible();

      await commandPaletteSearch.fill("isolated");
      await page.getByRole("button", { name: "Filter pages" }).click();
      await page.getByRole("button", { name: "Ship", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByText("No matching pages.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Filter pages" }).click();
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("option", {
          name: /Ship the isolated UI workflow/u,
        }),
      ).toBeVisible();
      const paletteScreenshot = testInfo.outputPath("command-palette-page-search.png");
      await page.screenshot({ path: paletteScreenshot, fullPage: true });
      await clearQueryAndCloseCommandPalette({
        page,
        dialog: commandPalette,
        search: commandPaletteSearch,
      });

      await page.getByRole("tab", { name: "Keep projection updates bounded" }).click();
      const targetTitle = targetStage.getByRole("textbox", { name: "Page title" });
      await targetTitle.fill("Immediate searchable projection");
      await sourceTab.click();
      await expect(
        page.getByRole("tab", { name: "Immediate searchable projection" }),
      ).toBeVisible();
      await page.keyboard.press(primaryShortcut("P"));
      await commandPaletteSearch.fill("Immediate searchable");
      await expect(
        page.getByRole("option", {
          name: /Immediate searchable projection/u,
        }),
      ).toBeVisible();
      await clearQueryAndCloseCommandPalette({
        page,
        dialog: commandPalette,
        search: commandPaletteSearch,
      });

      await page.getByRole("tab", { name: "Immediate searchable projection" }).click();
      await targetTitle.fill("Keep projection updates bounded");
      await sourceTab.click();
      await expect(
        page.getByRole("tab", { name: "Keep projection updates bounded" }),
      ).toBeVisible();

      const sourceStage = page.locator(`[data-page-stage-page-id="${sourcePageId}"]:visible`);
      const sourceEditor = sourceStage
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]')
        .first();
      const linkBlock = sourceEditor
        .locator(".bn-block[data-id]")
        .filter({
          hasText: "Open projection notes",
        })
        .first();
      const editorPageLink = linkBlock.getByRole("link", {
        name: "Open projection notes",
      });
      const editorPageLinkStyle = await editorPageLink.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        const editor = element
          .closest<HTMLElement>(".nfm-editor")
          ?.querySelector<HTMLElement>(".bn-editor");
        const expectedColorProbe = document.createElement("span");
        expectedColorProbe.style.color =
          "color-mix(in srgb, var(--color-token-text-link-foreground) 80%, var(--color-token-foreground) 20%)";
        document.body.append(expectedColorProbe);
        const expectedColor = globalThis.getComputedStyle(expectedColorProbe).color;
        expectedColorProbe.remove();
        return {
          color: style.color,
          expectedColor,
          editorColor: editor ? globalThis.getComputedStyle(editor).color : null,
          fontWeight: style.fontWeight,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          textDecorationLine: style.textDecorationLine,
        };
      });
      expect(editorPageLinkStyle.color).toBe(editorPageLinkStyle.expectedColor);
      expect(editorPageLinkStyle.color).not.toBe(editorPageLinkStyle.editorColor);
      expect(editorPageLinkStyle.fontWeight).toBe("500");
      expect(editorPageLinkStyle.paddingLeft).toBe("0px");
      expect(editorPageLinkStyle.paddingRight).toBe("0px");
      expect(editorPageLinkStyle.textDecorationLine).toBe("none");
      const linkToolbar = page.getByRole("toolbar", { name: "Link actions" });
      await revealWithHover(editorPageLink, linkToolbar);
      await expect(linkToolbar.getByRole("button", { name: "Edit" })).toBeVisible();
      await expect(linkToolbar.getByRole("button", { name: "Clear" })).toBeVisible();
      await expect(linkToolbar.getByRole("button", { name: "Copy" })).toBeVisible();
      await expect(linkToolbar.getByRole("button", { name: "Open" })).toBeVisible();
      await expect(
        linkToolbar.getByRole("button", { name: "Copy" }).getByText("Copy", { exact: true }),
      ).toHaveCount(0);
      await expect(
        linkToolbar.getByRole("button", { name: "Open" }).getByText("Open", { exact: true }),
      ).toHaveCount(0);
      const compactToolbarSurface = await readOpaqueSurfaceStyle(linkToolbar);
      expect(compactToolbarSurface.backgroundImage).toBe("none");
      expect(compactToolbarSurface.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      const compactToolbarBox = await requireLocatorGeometry(linkToolbar, "Link toolbar");
      const editorPageLinkBox = await requireLocatorGeometry(editorPageLink, "Editor link");
      expect(compactToolbarBox.y).toBeGreaterThanOrEqual(
        editorPageLinkBox.y + editorPageLinkBox.height,
      );
      await linkToolbar.getByRole("button", { name: "Edit" }).click();
      const editToolbar = page.getByRole("toolbar", { name: "Edit link" });
      await expect(editToolbar).toBeVisible();
      await expect(
        editToolbar.getByRole("textbox", { name: "Type or paste a link" }),
      ).toBeVisible();
      await expect(editToolbar.getByRole("button", { name: "Apply link" })).toBeVisible();
      await expect(editToolbar.getByRole("textbox", { name: "Link title" })).toHaveCount(0);
      const editToolbarSurface = await readOpaqueSurfaceStyle(editToolbar);
      expect(editToolbarSurface.backgroundImage).toBe("none");
      expect(editToolbarSurface.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      const applyButton = editToolbar.getByRole("button", { name: "Apply link" });
      const applyButtonStyle = await applyButton.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          padding: style.padding,
        };
      });
      expect(applyButtonStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(applyButtonStyle.borderRadius).not.toBe("0px");
      expect(applyButtonStyle.padding).toBe("0px");
      const editApplyIconBox = await requireLocatorGeometry(
        applyButton.locator("svg"),
        "Link apply icon",
      );
      expect(editApplyIconBox.width).toBeCloseTo(12, 0);
      expect(editApplyIconBox.height).toBeCloseTo(12, 0);
      const editToolbarBox = await requireLocatorGeometry(editToolbar, "Link edit toolbar");
      expect(editToolbarBox.height).toBeCloseTo(compactToolbarBox.height, 0);
      await page.keyboard.press("Escape");
      await revealWithHover(editorPageLink, linkToolbar);
      const editorPageLinkHoverStyle = await editorPageLink.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        return {
          textDecorationLine: style.textDecorationLine,
          textDecorationStyle: style.textDecorationStyle,
          textDecorationThickness: style.textDecorationThickness,
          textUnderlineOffset: style.textUnderlineOffset,
        };
      });
      expect(editorPageLinkHoverStyle).toEqual({
        textDecorationLine: "underline",
        textDecorationStyle: "dashed",
        textDecorationThickness: "0.5px",
        textUnderlineOffset: "2px",
      });
      await page.mouse.move(0, 0);
      await linkBlock.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Review /mention a page");
      await page.getByRole("option", { name: /Mention a page/u }).click();
      const mentionDraftBlock = sourceEditor
        .locator(".bn-block[data-id]")
        .filter({
          hasText: "Review @",
        })
        .first();
      await expect(mentionDraftBlock).toBeVisible();
      const mentionMenu = page.getByRole("listbox");
      const dateSection = mentionMenu.getByText("Date", { exact: true });
      const pageSection = mentionMenu.getByText("Mention a page", { exact: true });
      await expect(dateSection).toBeVisible();
      await expect(pageSection).toBeVisible();
      const dateSectionBox = await requireLocatorGeometry(dateSection, "Date mention section");
      const pageSectionBox = await requireLocatorGeometry(pageSection, "Page mention section");
      expect(dateSectionBox.y).toBeLessThan(pageSectionBox.y);
      const pageRows = mentionMenu.locator('[role="option"][data-mention-kind="page"]');
      const pageMoreRow = mentionMenu.locator(
        '[role="option"][data-mention-kind="page"][data-mention-utility="expand_section"]',
      );
      await expect(pageMoreRow).toBeVisible();
      const pageRowsBeforeExpansion = await pageRows.count();
      const hiddenPageCount = Number.parseInt(await pageMoreRow.innerText(), 10);
      expect(hiddenPageCount).toBeGreaterThan(0);
      await pageMoreRow.click();
      await expect(mentionMenu).toBeVisible();
      await expect(pageMoreRow).toHaveCount(0);
      await expect(pageRows).toHaveCount(pageRowsBeforeExpansion - 1 + hiddenPageCount);
      await page.keyboard.type("zzzz");
      await expect(mentionMenu).toBeVisible();
      await expect(mentionMenu.getByRole("option", { name: "New “zzzz” sub-page" })).toBeVisible();
      await expect(mentionMenu.getByRole("option", { name: /New “zzzz” page in/u })).toBeVisible();
      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press("Backspace");
      }
      await expect(mentionMenu.getByText("Mention a page", { exact: true })).toBeVisible();
      await page.keyboard.type("caus");
      const causalMentionOption = page.getByRole("option", {
        name: /Keep projection updates bounded/u,
      });
      await expect(causalMentionOption.locator(".text-xs")).toContainText("causal coverage");
      await expect(causalMentionOption.locator(".text-xs .font-medium")).toHaveText("causal");
      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.type("presrve");
      const fuzzyMentionOption = page.getByRole("option", {
        name: /Preserve local-first identity/u,
      });
      await expect(fuzzyMentionOption).toBeVisible();
      await expect(fuzzyMentionOption.locator(".font-medium")).toHaveText("Preserve");
      for (let index = 0; index < 7; index += 1) {
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.type("Keep projection updates bounded");
      const targetMentionOption = page.getByRole("option", {
        name: "Keep projection updates bounded",
        exact: true,
      });
      await expect(targetMentionOption).toContainText("Keep projection updates bounded");
      await expect(targetMentionOption.locator(".font-medium")).toHaveCount(4);
      await expect(targetMentionOption.locator("svg")).toHaveAttribute(
        "style",
        /status-build-dot/u,
      );
      await targetMentionOption.click();
      await page.keyboard.type("tomorrow");
      const insertedMentionBlock = sourceEditor
        .locator(".bn-block[data-id]")
        .filter({
          hasText: /Review.*tomorrow/u,
        })
        .first();
      await expect(insertedMentionBlock).toBeVisible();
      const insertedMention = insertedMentionBlock.getByRole("link", {
        name: "Open Page Keep projection updates bounded",
      });
      await expect(insertedMention).toBeVisible();
      await expect(insertedMention).toHaveAttribute("tabindex", "0");
      await expect(insertedMention).toHaveAttribute("contenteditable", "false");
      await expect(insertedMention).toHaveAttribute("data-page-mention-inline-anchor", "true");
      const insertedMentionStyle = await insertedMention.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        const editor = element
          .closest<HTMLElement>(".nfm-editor")
          ?.querySelector<HTMLElement>(".bn-editor");
        return {
          color: style.color,
          editorColor: editor ? globalThis.getComputedStyle(editor).color : null,
          opacity: style.opacity,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
        };
      });
      expect(insertedMentionStyle.color).toBe(insertedMentionStyle.editorColor);
      expect(insertedMentionStyle.opacity).toBe("1");
      expect(insertedMentionStyle.paddingLeft).toBe("0px");
      expect(insertedMentionStyle.paddingRight).toBe("0px");
      await expect(insertedMention.locator("svg")).toHaveAttribute("style", /status-build-dot/u);
      const mentionLabel = insertedMention
        .locator("span")
        .filter({
          hasText: "Keep projection updates bounded",
        })
        .last();
      const mentionRestUnderlineStyle = await mentionLabel.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        return {
          color: style.color,
          textDecorationLine: style.textDecorationLine,
          textDecorationStyle: style.textDecorationStyle,
          textDecorationColor: style.textDecorationColor,
          textDecorationThickness: style.textDecorationThickness,
          textUnderlineOffset: style.textUnderlineOffset,
        };
      });
      expect(mentionRestUnderlineStyle).toMatchObject({
        textDecorationLine: "underline",
        textDecorationStyle: "solid",
        textUnderlineOffset: "10%",
      });
      expect(Number.parseFloat(mentionRestUnderlineStyle.textDecorationThickness)).toBeGreaterThan(
        0,
      );
      expect(mentionRestUnderlineStyle.textDecorationColor).not.toBe(
        mentionRestUnderlineStyle.color,
      );
      await insertedMention.hover();
      const mentionHoverUnderlineStyle = await mentionLabel.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        return {
          color: style.color,
          textDecorationLine: style.textDecorationLine,
          textDecorationStyle: style.textDecorationStyle,
          textDecorationColor: style.textDecorationColor,
          textDecorationThickness: style.textDecorationThickness,
          textUnderlineOffset: style.textUnderlineOffset,
        };
      });
      expect(mentionHoverUnderlineStyle).toMatchObject({
        textDecorationLine: "underline",
        textDecorationStyle: "solid",
        textUnderlineOffset: "10%",
      });
      expect(Number.parseFloat(mentionHoverUnderlineStyle.textDecorationThickness)).toBeGreaterThan(
        0,
      );
      expect(mentionHoverUnderlineStyle.textDecorationColor).toBe(
        mentionRestUnderlineStyle.textDecorationColor,
      );
      const mentionTooltip = page.locator('[role="tooltip"] [data-page-mention-tooltip="true"]');
      await expect(mentionTooltip).toContainText("Keep projection updates bounded");
      await expect(mentionTooltip).not.toContainText("Database Page");
      await expect(mentionTooltip).toContainText("preserving causal coverage");
      const hoverHighlight = await readPageMentionHighlight(insertedMention);
      expect(hoverHighlight.opacity).toBe("1");
      expect(Number.parseFloat(hoverHighlight.left)).toBeLessThan(0);
      expect(Number.parseFloat(hoverHighlight.right)).toBeLessThan(0);
      expect(Number.parseFloat(hoverHighlight.top)).toBeLessThan(0);
      expect(Number.parseFloat(hoverHighlight.bottom)).toBeLessThan(0);
      await page.mouse.move(0, 0);
      await focusEditableBlockAfterPageMention(insertedMentionBlock);
      await page.keyboard.press("ArrowLeft");
      await expect
        .poll(() => insertedMention.getAttribute("data-mention-token-selected"))
        .toBe("true");
      const mentionFocusAffordance = page.locator('[data-mention-inline-focus-affordance="true"]');
      await expect(mentionFocusAffordance).toBeVisible();
      await expect(mentionFocusAffordance).toHaveText("Open page↵");
      const mentionBounds = await requireLocatorGeometry(insertedMention, "Page mention");
      const affordanceBounds = await requireLocatorGeometry(
        mentionFocusAffordance,
        "Mention focus affordance",
      );
      expect(affordanceBounds.y).toBeGreaterThanOrEqual(mentionBounds.y + mentionBounds.height - 1);
      expect(
        Math.abs(
          affordanceBounds.x + affordanceBounds.width / 2 - (mentionBounds.x + mentionBounds.width),
        ),
      ).toBeLessThan(2);
      const selectedHighlight = await readPageMentionHighlight(insertedMention);
      expect(selectedHighlight).toEqual(hoverHighlight);
      const pageMentionSelection = await insertedMentionBlock.evaluate((element) => {
        const mentionRoot = element.querySelector<HTMLElement>('[data-mention-inline-root="true"]');
        const editor = mentionRoot?.closest<HTMLElement>('.ProseMirror[contenteditable="true"]');
        const mentionChip = mentionRoot?.querySelector<HTMLElement>(
          '[data-mention-inline-chip="true"]',
        );
        return {
          editorOwnsFocus: Boolean(editor?.contains(document.activeElement)),
          mentionIsSelected: mentionChip?.dataset.mentionTokenSelected === "true",
          nativeTextSelectionHidden: editor?.classList.contains("ProseMirror-hideselection"),
        };
      });
      expect(pageMentionSelection).toEqual({
        editorOwnsFocus: true,
        mentionIsSelected: true,
        nativeTextSelectionHidden: true,
      });
      const mentionFocusUnderlineStyle = await mentionLabel.evaluate((element) => {
        const style = globalThis.getComputedStyle(element);
        return {
          color: style.color,
          textDecorationLine: style.textDecorationLine,
          textDecorationStyle: style.textDecorationStyle,
          textDecorationColor: style.textDecorationColor,
          textDecorationThickness: style.textDecorationThickness,
          textUnderlineOffset: style.textUnderlineOffset,
        };
      });
      expect(mentionFocusUnderlineStyle).toMatchObject({
        textDecorationLine: "underline",
        textDecorationStyle: "solid",
        textUnderlineOffset: "10%",
      });
      expect(mentionFocusUnderlineStyle.textDecorationColor).toBe(mentionFocusUnderlineStyle.color);
      await page.keyboard.press("Enter");
      await expect(
        page.locator(
          'button[role="tab"][aria-label="Keep projection updates bounded"][aria-selected="true"]',
        ),
      ).toHaveCount(1);
      await page.getByRole("tab", { name: "Unify Database View rendering" }).click();
      await expect(
        page.getByRole("tab", { name: "Unify Database View rendering" }),
      ).toHaveAttribute("aria-selected", "true");

      await focusEditableBlockEnd(page, insertedMentionBlock);
      await expect
        .poll(() =>
          insertedMentionBlock.evaluate((element) => {
            const selection = globalThis.getSelection();
            const focusElement =
              selection?.focusNode instanceof Element
                ? selection.focusNode
                : selection?.focusNode?.parentElement;
            return {
              focusInside: Boolean(focusElement && element.contains(focusElement)),
              mentionSelected: Boolean(
                element.querySelector('[data-mention-token-selected="true"]'),
              ),
              selectedText: selection?.toString() ?? "",
            };
          }),
        )
        .toEqual({ focusInside: true, mentionSelected: false, selectedText: "" });
      const blockCountBeforeEmbed = await sourceEditor.locator(".bn-block[data-id]").count();
      await page.keyboard.press("Enter");
      await expect(sourceEditor.locator(".bn-block[data-id]")).toHaveCount(
        blockCountBeforeEmbed + 1,
      );
      await page.keyboard.type("/embed page");
      await page.getByRole("option", { name: /Embed page/u }).click();
      await page.getByRole("option", { name: /Keep projection updates bounded/u }).click();
      const targetEmbeds = sourceEditor.locator(
        `[data-page-outliner-target="${referenceTargetPageId}"]`,
      );
      await expect(targetEmbeds).toHaveCount(2);
      const insertedEmbed = targetEmbeds.last();
      await expect(insertedEmbed).toHaveAttribute("data-page-outliner-expanded", "false");
      await insertedEmbed
        .getByRole("button", {
          name: "Expand Keep projection updates bounded",
        })
        .click();
      await expect(insertedEmbed).toHaveAttribute("data-page-outliner-expanded", "true");
      await expect(insertedEmbed.locator("[data-page-outliner-body]")).toContainText(
        "affected projection window",
      );

      await focusEditableBlockEnd(page, insertedMentionBlock);
      const blockCountBeforeSubpage = await sourceEditor.locator(".bn-block[data-id]").count();
      await page.keyboard.press("Enter");
      await expect(sourceEditor.locator(".bn-block[data-id]")).toHaveCount(
        blockCountBeforeSubpage + 1,
      );
      await page.keyboard.type("/subpage");
      await page.getByRole("option", { name: /^Subpage/u }).click();
      await page.keyboard.type("Reference model child");
      await page.getByRole("option", { name: /Reference model child/u }).click();
      await expect(
        sourceEditor.getByRole("button", {
          name: "Edit Reference model child title",
        }),
      ).toBeVisible({ timeout: 15_000 });
      const childSearch = await page.evaluate(
        async ({ projectId }) => {
          return await window.api?.invoke(
            "library-module:read",
            {
              kind: "project",
              projectId,
            },
            {
              read: {
                mode: "page_reference_candidates",
                query: "Reference model child",
                limit: 5,
              },
            },
          );
        },
        {
          projectId: manifest.projectId,
        },
      );
      expect(childSearch).toMatchObject({
        ok: true,
        value: {
          value: {
            kind: "page_reference_candidates",
            items: [
              {
                title: "Reference model child",
                locationLabel: expect.stringContaining("Unify Database View rendering"),
              },
            ],
          },
        },
      });

      const reopenedPage = await harness.restart();
      const reopenedPrimaryTab = reopenedPage.getByRole("tab", {
        name: "Unify Database View rendering",
      });
      await expect(reopenedPrimaryTab).toBeVisible();
      await reopenedPrimaryTab.click();
      await expect(reopenedPrimaryTab).toHaveAttribute("aria-selected", "true");
      const reopenedSourceStage = reopenedPage
        .locator(`[data-page-stage-page-id="${sourcePageId}"]:visible`)
        .first();
      await expect(reopenedSourceStage).toBeVisible();
      const reopenedEditor = reopenedSourceStage
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]')
        .first();
      await expect(
        reopenedEditor.locator(".bn-block[data-id]").filter({
          hasText: /Review.*tomorrow/u,
        }),
      ).toBeVisible();
      await expect(
        reopenedEditor.locator(`[data-page-outliner-target="${referenceTargetPageId}"]`),
      ).toHaveCount(2);
      await expect(
        reopenedEditor.getByRole("button", {
          name: "Edit Reference model child title",
        }),
      ).toBeVisible();

      const pageScreenshot = testInfo.outputPath("page-stage-open.png");
      await reopenedPage.screenshot({ path: pageScreenshot, fullPage: true });
      await testInfo.attach("page-stage-open", {
        path: pageScreenshot,
        contentType: "image/png",
      });
      await testInfo.attach("board-project-home", {
        path: boardScreenshot,
        contentType: "image/png",
      });
      await testInfo.attach("command-palette-page-search", {
        path: paletteScreenshot,
        contentType: "image/png",
      });
      await testInfo.attach("runtime-logs", {
        body: Buffer.from(await readRuntimeLogs()),
        contentType: "text/plain",
      });
    },
  );
});
