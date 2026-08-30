import { expect, test, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT,
  DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT,
  DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/database-context-menu-performance";

const sampleCount = 12;

const percentile95 = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
};

const waitForProjectHome = async (page: Page, pageId: string): Promise<void> => {
  const target = page.locator(`[data-database-view-page-menu-target="${pageId}"]`);
  if (await target.isVisible().catch(() => false)) return;
  await page
    .getByRole("button", {
      name: "Open Context Menu Performance",
      exact: true,
    })
    .evaluate((element) => (element as HTMLElement).click());
  await page.getByRole("tab", { name: "Project Home" }).waitFor();
  await target.waitFor();
};

const measureRootOpen = async (page: Page, pageId: string): Promise<number> =>
  await page.evaluate(async (targetPageId) => {
    const target = document.querySelector<HTMLElement>(
      `[data-database-view-page-menu-target="${targetPageId}"]`,
    );
    if (!target) throw new Error("Context menu performance target is missing");
    const startedAt = performance.now();
    const appeared = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("Context menu root did not appear"));
      }, 1_000);
      const observer = new MutationObserver(() => {
        if (!document.querySelector("[data-slot='context-menu-content']")) return;
        window.clearTimeout(timer);
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 12,
        clientY: rect.top + 12,
        button: 2,
      }),
    );
    await appeared;
    return performance.now() - startedAt;
  }, pageId);

const measureCopySubmenuOpen = async (page: Page): Promise<number> =>
  await page.evaluate(async () => {
    const triggers = [
      ...document.querySelectorAll<HTMLElement>("[data-nodex-context-menu-subtrigger='true']"),
    ];
    const trigger = triggers.find((element) => element.textContent?.trim().startsWith("Copy"));
    if (!trigger) throw new Error("Copy submenu trigger is missing");
    const startedAt = performance.now();
    const appeared = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("Copy submenu did not appear"));
      }, 1_000);
      const observer = new MutationObserver(() => {
        if (!document.querySelector("[data-slot='context-menu-subcontent']")) return;
        window.clearTimeout(timer);
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    trigger.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerType: "mouse",
      }),
    );
    await appeared;
    return performance.now() - startedAt;
  });

const measureSiblingSubmenuSwitch = async (page: Page): Promise<number> => {
  const copyTrigger = page
    .locator("[data-nodex-context-menu-subtrigger='true']")
    .filter({ hasText: "Copy" });
  const moveTrigger = page
    .locator("[data-nodex-context-menu-subtrigger='true']")
    .filter({ hasText: "Move" });
  const [copyBox, moveBox] = await Promise.all([
    copyTrigger.boundingBox(),
    moveTrigger.boundingBox(),
  ]);
  if (!copyBox || !moveBox) throw new Error("Context menu submenu trigger geometry is missing");

  await page.mouse.move(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height / 2, {
    steps: 4,
  });
  await expect(
    page.locator("[data-slot='context-menu-subcontent'][data-state='open']", {
      hasText: "Copy title",
    }),
  ).toBeVisible();

  const measurement = page.evaluate(async () => {
    const trigger = [
      ...document.querySelectorAll<HTMLElement>("[data-nodex-context-menu-subtrigger='true']"),
    ].find((element) => element.textContent?.trim().startsWith("Move"));
    if (!trigger) throw new Error("Move-to submenu trigger is missing");

    return await new Promise<number>((resolve, reject) => {
      let startedAt: number | null = null;
      const timer = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error("Sibling submenu switch did not complete"));
      }, 1_000);
      const finishIfOpen = (): void => {
        const openedAt = startedAt;
        if (openedAt === null) return;
        const openMoveSubmenu = Boolean(
          document.querySelector<HTMLInputElement>(
            '[role="combobox"][aria-label^="Move "][aria-label$=" to"]',
          ),
        );
        if (!openMoveSubmenu) return;
        window.clearTimeout(timer);
        observer.disconnect();
        requestAnimationFrame(() => resolve(performance.now() - openedAt));
      };
      const observer = new MutationObserver(finishIfOpen);
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["data-state"],
      });
      trigger.addEventListener(
        "pointerenter",
        () => {
          startedAt = performance.now();
          finishIfOpen();
        },
        { once: true },
      );
    });
  });

  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2, {
    steps: 4,
  });
  return await measurement;
};

test("keeps production-scale Database context menus inside the interaction budget @performance", async ({}, testInfo) => {
  test.setTimeout(300_000);
  await withElectronScenario(
    {
      label: "database-context-menu-performance",
      scenarioId: DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID,
    },
    async ({ application, page, manifest, facts }) => {
      if (!manifest || !facts)
        throw new Error("Context menu performance scenario did not materialize");
      expect(facts).toMatchObject({
        totalRows: DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT,
        propertyCount: DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT,
      });
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 960);
      });
      const pageId = manifest.pageIdsByKey["page-001"];
      if (!pageId) throw new Error("Context menu performance target Page is missing");
      await waitForProjectHome(page, pageId);

      await page.evaluate(() => {
        const samples: number[] = [];
        (
          window as typeof window & { __nodexContextMenuLongTasks?: number[] }
        ).__nodexContextMenuLongTasks = samples;
        new PerformanceObserver((entries) => {
          samples.push(...entries.getEntries().map((entry) => entry.duration));
        }).observe({ entryTypes: ["longtask"] });
      });

      const rootSamples: number[] = [];
      const submenuSamples: number[] = [];
      const siblingSwitchSamples: number[] = [];
      for (let index = 0; index < sampleCount; index += 1) {
        rootSamples.push(await measureRootOpen(page, pageId));
        submenuSamples.push(await measureCopySubmenuOpen(page));
        siblingSwitchSamples.push(await measureSiblingSubmenuSwitch(page));
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-slot='context-menu-content']")).toHaveCount(0);
      }
      const longTasks = await page.evaluate(
        () =>
          (window as typeof window & { __nodexContextMenuLongTasks?: number[] })
            .__nodexContextMenuLongTasks ?? [],
      );
      const evidence = {
        rootSamples,
        submenuSamples,
        siblingSwitchSamples,
        rootP95: percentile95(rootSamples),
        submenuP95: percentile95(submenuSamples),
        siblingSwitchP95: percentile95(siblingSwitchSamples),
        longTasks,
      };
      await testInfo.attach("database-context-menu-performance", {
        body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
        contentType: "application/json",
      });

      if (process.env.NODEX_SKIP_PERFORMANCE_GATES === "1") return;
      expect(evidence.rootP95).toBeLessThanOrEqual(50);
      expect(evidence.submenuP95).toBeLessThanOrEqual(32);
      expect(evidence.siblingSwitchP95).toBeLessThanOrEqual(32);
      expect(longTasks.filter((duration) => duration >= 100)).toEqual([]);
    },
  );
});
