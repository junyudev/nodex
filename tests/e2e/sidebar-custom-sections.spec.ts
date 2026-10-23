import { expect, test, type Locator, type Page } from "@playwright/test";

import { invokeIpc, requireIpcValue } from "./support/editor-scenario";
import { nativeReadOnlyBenchmarkEnvironment } from "./support/native-transcript-benchmark-preflight";
import { createNativeTranscriptFixtureClient } from "./support/native-transcript-benchmark-client";
import { resolveNativeVisualizationFixtureRuntime } from "./support/native-visualization-history-fixture";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";

import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
  withElectronScenario,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { inspectScenario, materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import type { ScenarioFacts } from "../../scripts/scenarios/contracts";
import {
  requireSidebarCustomSectionsFacts,
  SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/sidebar-custom-sections";

const sidebarSection = (page: Page, heading: string) =>
  page.locator(`[data-app-action-sidebar-section-heading="${heading}"]:visible`);
const workSection = (page: Page) => sidebarSection(page, "Work");
const projectsSection = (page: Page) => sidebarSection(page, "Projects");
const sectionToggle = (section: Locator) =>
  section.locator('[data-app-action-sidebar-section-toggle=""]');
const threadRow = (scope: Page | Locator, title: string) =>
  scope.locator(`[data-app-action-sidebar-thread-title="${title}"]`);
const containerFeedback = (target: Locator) =>
  target.locator('xpath=ancestor-or-self::*[@data-sidebar-drop-target="true"]');

async function dragSidebarRow(
  source: Locator,
  target: Locator,
  feedback: Locator,
  targetYRatio = 0.35,
) {
  await source.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => {
      const box = await source.boundingBox();
      if (!box) return false;
      return await source.evaluate(
        (element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit !== null && (hit === element || element.contains(hit));
        },
        { x: box.x + box.width * 0.55, y: box.y + box.height / 2 },
      );
    })
    .toBe(true);
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error("Sidebar drag source is not visible");
  const sourceX = sourceBox.x + sourceBox.width * 0.55;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const page = source.page();
  const mouse = page.mouse;
  let pointerReleased = false;
  await mouse.move(sourceX, sourceY);
  await mouse.down();
  try {
    await mouse.move(sourceX, sourceY + 8, { steps: 3 });
    await expect(
      page.locator('[aria-pressed="true"][aria-roledescription="sortable"]'),
    ).toHaveCount(1);

    // Keep the real pointer gesture active while traversing the pressure list.
    // Resolve the target after activation because empty lanes can appear on drag.
    await expect
      .poll(
        async () => {
          const targetBox = await target.boundingBox();
          const scroll = await page
            .locator('[data-app-action-sidebar-scroll=""]:visible')
            .evaluate((element) => {
              const box = element.getBoundingClientRect();
              return {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                top: element.scrollTop,
                max: element.scrollHeight - element.clientHeight,
              };
            });
          if (!targetBox) return false;
          const targetY = targetBox.y + targetBox.height * targetYRatio;
          const top = scroll.y + 2;
          const bottom = scroll.y + scroll.height - 2;
          const middle = (top + bottom) / 2;
          const atScrollBoundary =
            targetY < middle ? scroll.top <= 1 : scroll.top >= scroll.max - 1;
          if (
            targetY >= top &&
            targetY <= bottom &&
            (Math.abs(targetY - middle) < scroll.height * 0.3 || atScrollBoundary)
          )
            return true;
          await mouse.move(scroll.x + scroll.width / 2, middle);
          const delta = targetY - middle;
          await mouse.wheel(0, Math.sign(delta) * Math.min(Math.abs(delta), 600));
          return false;
        },
        { intervals: [100, 200], timeout: 10_000 },
      )
      .toBe(true);
    const scrollBox = await page
      .locator('[data-app-action-sidebar-scroll=""]:visible')
      .boundingBox();
    if (!scrollBox) throw new Error("Sidebar scroll region is not visible");
    await mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
    let previousScrollTop: number | null = null;
    let settledSamples = 0;
    await expect
      .poll(
        async () => {
          const scrollTop = await page
            .locator('[data-app-action-sidebar-scroll=""]:visible')
            .evaluate((element) => element.scrollTop);
          settledSamples = scrollTop === previousScrollTop ? settledSamples + 1 : 0;
          previousScrollTop = scrollTop;
          return settledSamples >= 3;
        },
        { intervals: [50, 100] },
      )
      .toBe(true);
    const targetBox = await target.boundingBox();
    if (!targetBox) throw new Error("Sidebar drag target is not visible");
    const targetX = targetBox.x + targetBox.width * 0.55;
    const targetY = targetBox.y + targetBox.height * targetYRatio;
    await mouse.move(targetX, targetY, { steps: 12 });
    await mouse.move(targetX, targetY + 1, { steps: 2 });
    await expect(feedback).toHaveCount(1);
    if ((await feedback.getAttribute("role")) === "presentation") {
      const targetElement = await target.elementHandle();
      try {
        await expect
          .poll(() =>
            feedback.evaluate((indicator, targetRow) => {
              const next = indicator.nextElementSibling;
              return Boolean(next && targetRow && (next === targetRow || next.contains(targetRow)));
            }, targetElement),
          )
          .toBe(true);
      } catch (error) {
        await test.info().attach("sidebar-drop-boundary", {
          body: Buffer.from(
            JSON.stringify(
              await feedback.evaluate((indicator, targetRow) => {
                const next = indicator.nextElementSibling;
                const previous = indicator.previousElementSibling;
                return {
                  indicator: indicator.outerHTML,
                  next: next?.outerHTML,
                  previous: previous?.outerHTML,
                  target: targetRow?.outerHTML,
                  targetRect: targetRow?.getBoundingClientRect().toJSON(),
                  indicatorRect: indicator.getBoundingClientRect().toJSON(),
                  dragAnnouncements: Array.from(
                    document.querySelectorAll('[id^="DndLiveRegion"]'),
                    (element) => element.textContent,
                  ),
                };
              }, targetElement),
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });
        await test.info().attach("sidebar-drop-boundary-preview", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        throw error;
      } finally {
        await targetElement?.dispose();
      }
    }
    await mouse.up();
    pointerReleased = true;
  } finally {
    if (!pointerReleased) {
      await page.keyboard.press("Escape");
      await mouse.up();
    }
  }
}

test("moves draft and attached Chats through Section boundaries and built-in destinations", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const runtime = await resolveNativeVisualizationFixtureRuntime(process.cwd());
  const harness = await ElectronScenarioHarness.create({
    label: "sidebar-custom-sections-dnd",
    cwd: process.cwd(),
    prepareAgentRuntime: false,
    // Native catalog reads require an account; this synthetic key never executes a Turn.
    codexApiKey: "nodex-sidebar-metadata-test-key",
    environment: nativeReadOnlyBenchmarkEnvironment(process.env),
  });
  let page: Page | null = null;
  let facts: ScenarioFacts | null = null;
  try {
    // Create durable native metadata before Main owns this isolated Agent home.
    const creator = await createNativeTranscriptFixtureClient({
      executable: runtime.executable,
      codexHome: harness.profile.codexHome,
      cwd: harness.profile.initialProjectsDirectory,
    });
    let started: Awaited<ReturnType<typeof creator.call<"thread/start">>>;
    try {
      started = await creator.call(
        "thread/start",
        {
          cwd: harness.profile.initialProjectsDirectory,
          ephemeral: false,
          approvalPolicy: "never",
          sandbox: "workspace-write",
        },
        "sidebar-empty-thread",
      );
      await creator.call(
        "thread/name/set",
        {
          threadId: started.thread.id,
          name: "Inbox chat",
        },
        "sidebar-thread-title",
      );
    } finally {
      await creator.close();
    }
    page = await harness.launch();
    const application = harness.application;
    const seed = new RendererIpcSeedAdapter(page);
    const manifest = await materializeScenario(
      SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
      seed,
      harness.profile.initialProjectsDirectory,
    );
    facts = await inspectScenario(manifest, seed);
    const observed = requireSidebarCustomSectionsFacts(facts);
    // Keep scenario facts intact while giving the outbound Chat enumerable native history.
    await invokeIpc(page, "project-session-threads:detach", observed.inboxSessionId);
    await invokeIpc(page, "project-session-threads:attach", {
      sessionId: observed.inboxSessionId,
      projectId: observed.inboxProjectId,
      threadId: started.thread.id,
      threadSource: "user",
      threadName: "Inbox chat",
      threadPreview: "Move this chat into the custom Section",
      backendBinding: { kind: "codex" },
      statusType: "idle",
      statusActiveFlags: [],
      createdAt: started.thread.createdAt * 1000,
      updatedAt: started.thread.updatedAt * 1000,
    });
    const anchorSessionId = createUuidV7();
    requireIpcValue(
      await invokeIpc(page, "project-sessions:create", {
        operationId: createBoundedOperationId("sidebar.dnd.pinned-anchor.create"),
        payload: {
          sessionId: anchorSessionId,
          input: {
            projectId: null,
            noThreadFallbackTitle: "Pinned anchor",
            initialPageIds: [],
          },
        },
      }),
      "Pinned anchor creation",
    );
    requireIpcValue(
      await invokeIpc(page, "project-sessions:set-pinned", {
        operationId: createBoundedOperationId("sidebar.dnd.pinned-anchor.pin"),
        payload: { sessionId: anchorSessionId, pinned: true },
      }),
      "Pinned anchor placement",
    );
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
    });

    const projects = projectsSection(page);
    const work = workSection(page);
    await expect(work).toBeVisible();
    await work.getByRole("button", { name: "Show more" }).click();
    await expect(projects.getByRole("button", { name: "New section" })).toHaveCount(0);

    const inboxProject = projects.locator(
      '[data-app-action-sidebar-project-label="Inbox Project"]',
    );
    await inboxProject.hover();
    await inboxProject.getByRole("button", { name: "Expand project" }).click();
    const inboxChat = projects.locator('[data-app-action-sidebar-thread-title="Inbox chat"]');
    const sectionProject = work.locator(
      '[data-app-action-sidebar-project-label="Section Project"]',
    );
    await expect(inboxChat).toBeVisible();
    const inboxProjectLabel = projects.getByRole("button", {
      name: "Open Inbox Project",
      exact: true,
    });
    await dragSidebarRow(inboxProjectLabel, sectionProject, work.locator('[role="presentation"]'));
    const movedProjectGroup = work.getByRole("listitem", {
      name: "Inbox Project",
      exact: true,
    });
    const movedProject = movedProjectGroup.locator(
      '[data-app-action-sidebar-project-label="Inbox Project"]',
    );
    await expect(movedProject).toBeVisible();
    await expect(inboxProjectLabel).toHaveCount(0);
    await expect(movedProject.getByRole("button", { name: "Collapse project" })).toBeAttached();
    await expect(
      movedProject.getByRole("button", { name: "Project actions for Inbox Project" }),
    ).toBeAttached();
    await expect(
      movedProject.getByRole("button", { name: "Start new chat in Inbox Project" }),
    ).toBeAttached();
    await expect(
      movedProject.getByRole("button", { name: "Open Inbox Project", exact: true }),
    ).toBeAttached();
    await expect(movedProject.locator('[data-app-action-sidebar-project-marker=""]')).toHaveCount(
      1,
    );
    await expect(
      movedProjectGroup.locator('[data-app-action-sidebar-thread-title="Inbox chat"]'),
    ).toBeVisible();

    // Project centers accept a Chat into the Project; its top edge remains the
    // mixed Section boundary immediately before that Project.
    const movedProjectChat = movedProjectGroup.locator(
      '[data-app-action-sidebar-thread-title="Inbox chat"]',
    );
    await expect(movedProjectChat).toHaveAttribute(
      "data-app-action-sidebar-thread-grouped",
      "true",
    );
    const directSectionChat = work.locator(
      '[data-app-action-sidebar-thread-title="Section draft 03"]',
    );
    await dragSidebarRow(
      movedProjectChat,
      directSectionChat,
      work.locator('[role="presentation"]'),
      0.1,
    );
    const movedChat = work.locator('[data-app-action-sidebar-thread-title="Inbox chat"]');
    await expect(movedChat).toBeVisible();
    await expect(movedChat).toHaveAttribute("data-app-action-sidebar-thread-grouped", "false");
    await expect(
      movedProjectGroup.locator('[data-app-action-sidebar-thread-title="Inbox chat"]'),
    ).toHaveCount(0);
    await movedChat.hover();
    await expect(movedChat.getByRole("button", { name: "Pin chat" })).toBeVisible();
    await expect(movedChat.getByRole("button", { name: "Archive chat" })).toBeVisible();

    const later = sidebarSection(page, "Later");
    const laterToggle = sectionToggle(later);
    const draftTitle = "Section draft 01";
    const workDraft = threadRow(work, draftTitle);
    await expect(later.getByRole("list", { name: "Later items" })).toBeVisible();
    await dragSidebarRow(workDraft, laterToggle, containerFeedback(later));
    await expect(threadRow(later, draftTitle)).toBeVisible();
    await expect(workDraft).toHaveCount(0);

    // A collapsed Section is still a destination, and a drop preserves disclosure.
    await laterToggle.click();
    await expect(laterToggle).toHaveAttribute("aria-expanded", "false");
    await dragSidebarRow(movedChat, laterToggle, containerFeedback(later));
    await expect(movedChat).toHaveCount(0);
    await expect(laterToggle).toHaveAttribute("aria-expanded", "false");
    await laterToggle.click();
    const laterChat = threadRow(later, "Inbox chat");
    const laterDraft = threadRow(later, draftTitle);
    await expect(laterChat).toBeVisible();
    await expect(laterDraft).toBeVisible();

    await dragSidebarRow(laterDraft, directSectionChat, work.locator('[role="presentation"]'), 0.1);
    await expect(workDraft).toBeVisible();
    await expect(laterDraft).toHaveCount(0);
    const reorderedTitles = await work
      .locator("[data-app-action-sidebar-thread-title]")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-app-action-sidebar-thread-title")),
      );
    expect(reorderedTitles.indexOf("Section draft 03")).toBe(
      reorderedTitles.indexOf(draftTitle) + 1,
    );

    const pinned = sidebarSection(page, "Pinned");
    await expect(threadRow(pinned, "Pinned anchor")).toBeVisible();
    await sectionToggle(work).click();

    const chats = sidebarSection(page, "Chats");
    await dragSidebarRow(laterChat, sectionToggle(chats), containerFeedback(chats));
    const ungroupedChat = threadRow(chats, "Inbox chat");
    await expect(ungroupedChat).toBeVisible();
    await expect(ungroupedChat).toHaveAttribute("data-app-action-sidebar-thread-grouped", "false");
    await expect(laterChat).toHaveCount(0);

    await dragSidebarRow(ungroupedChat, laterToggle, containerFeedback(later));
    await expect(laterChat).toBeVisible();
    await expect(ungroupedChat).toHaveCount(0);
    await sectionToggle(work).click();
    await work.getByRole("button", { name: "Show more" }).click();
    await dragSidebarRow(laterChat, movedProject, containerFeedback(movedProject), 0.5);
    await expect(movedProjectChat).toBeVisible();
    await expect(movedProjectChat).toHaveAttribute(
      "data-app-action-sidebar-thread-grouped",
      "true",
    );
    await expect(laterChat).toHaveCount(0);

    await dragSidebarRow(movedProjectChat, laterToggle, containerFeedback(later));
    await expect(laterChat).toBeVisible();
    await expect(movedProjectChat).toHaveCount(0);
    await dragSidebarRow(laterChat, sectionToggle(pinned), containerFeedback(pinned));
    const pinnedChat = threadRow(pinned, "Inbox chat");
    await expect(pinnedChat).toBeVisible();
    await expect(pinnedChat).toHaveAttribute("data-app-action-sidebar-thread-pinned", "true");
    await expect(laterChat).toHaveCount(0);

    const pinnedTitles = await pinned
      .locator("[data-app-action-sidebar-thread-title]")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-app-action-sidebar-thread-title")),
      );
    const restartedPage = await harness.restart();
    page = restartedPage;
    const restoredPinned = sidebarSection(restartedPage, "Pinned");
    await expect(threadRow(restoredPinned, "Inbox chat")).toBeVisible();
    await expect
      .poll(() =>
        restoredPinned
          .locator("[data-app-action-sidebar-thread-title]")
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute("data-app-action-sidebar-thread-title")),
          ),
      )
      .toEqual(pinnedTitles);
    const restoredWork = workSection(restartedPage);
    await restoredWork.getByRole("button", { name: "Show more" }).click();
    const restoredTitles = await restoredWork
      .locator("[data-app-action-sidebar-thread-title]")
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-app-action-sidebar-thread-title")),
      );
    expect(restoredTitles.indexOf(draftTitle)).toBeGreaterThanOrEqual(0);
    expect(restoredTitles.indexOf("Section draft 03")).toBe(restoredTitles.indexOf(draftTitle) + 1);
    await expect(threadRow(sidebarSection(restartedPage, "Later"), "Inbox chat")).toHaveCount(0);
  } catch (error) {
    if (page && facts) {
      const observed = requireSidebarCustomSectionsFacts(facts);
      const session = await invokeIpc(page, "project-sessions:get", observed.inboxSessionId);
      const chats = await invokeIpc(page, "workspace:tasks:list", null, {
        placementScope: "builtin",
      });
      const placement = await invokeIpc(page, "sidebar-sections:item:placement", {
        kind: "session",
        sessionId: observed.inboxSessionId,
      });
      const sections = await page
        .locator("[data-app-action-sidebar-section-heading]")
        .evaluateAll((elements) =>
          elements.map((element) => ({
            heading: element.getAttribute("data-app-action-sidebar-section-heading"),
            rows: Array.from(
              element.querySelectorAll("[data-app-action-sidebar-thread-title]"),
            ).map((row) => ({
              title: row.getAttribute("data-app-action-sidebar-thread-title"),
              pinned: row.getAttribute("data-app-action-sidebar-thread-pinned"),
            })),
          })),
        );
      await testInfo.attach("sidebar-custom-sections-dnd-state", {
        body: Buffer.from(JSON.stringify({ session, chats, placement, sections }, null, 2)),
        contentType: "application/json",
      });
    }
    await testInfo.attach("sidebar-custom-sections-dnd-runtime-logs", {
      body: Buffer.from(await readBoundedElectronRuntimeLogs(harness.profile)),
      contentType: "text/plain",
    });
    const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
    if (screenshot) {
      await testInfo.attach("sidebar-custom-sections-dnd-failure", {
        body: screenshot,
        contentType: "image/png",
      });
    }

    throw error;
  } finally {
    await harness.close();
  }
});

test("persists custom Section disclosure and safely restores an Undoable deletion", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withElectronScenario(
    {
      label: "sidebar-custom-sections",
      scenarioId: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
      onFailure: async ({ page, readRuntimeLogs }) => {
        await testInfo.attach("sidebar-custom-sections-runtime-logs", {
          body: Buffer.from(await readRuntimeLogs()),
          contentType: "text/plain",
        });
        const screenshot = await page?.screenshot({ fullPage: true }).catch(() => null);
        if (screenshot) {
          await testInfo.attach("sidebar-custom-sections-failure", {
            body: screenshot,
            contentType: "image/png",
          });
        }
      },
    },
    async ({ application, facts, harness, page }) => {
      if (!facts) throw new Error("Sidebar Section scenario did not materialize");
      const observed = requireSidebarCustomSectionsFacts(facts);
      expect(observed.directItemCount).toBe(53);
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 900 });
      });

      const section = workSection(page);
      await expect(section).toBeVisible();
      const sectionStatus = section.locator('[data-sidebar-section-status="unread"]');
      await expect(sectionStatus).toHaveCount(0);
      await expect(section.getByRole("button", { name: "Show more" })).toBeVisible();
      await section.getByRole("button", { name: "Show more" }).click();
      await expect(section.getByText("Section draft 51", { exact: true })).toBeVisible();

      const disclosure = section.locator('[data-app-action-sidebar-section-toggle=""]');
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(sectionStatus).toBeVisible();
      await page.waitForTimeout(350);

      const restartedPage = await harness.restart();
      const restoredSection = workSection(restartedPage);
      await expect(restoredSection).toBeVisible();
      await expect(
        restoredSection.locator('[data-app-action-sidebar-section-toggle=""]'),
      ).toHaveAttribute("aria-expanded", "false");
      await expect(
        restoredSection
          .locator('[data-sidebar-section-status="unread"]')
          .getByRole("img", { name: "Unread chats", exact: true }),
      ).toBeVisible();

      await restoredSection.getByText("Work", { exact: true }).hover();
      const sectionActions = restoredSection.getByRole("button", {
        name: "Section actions for Work",
      });
      await expect(sectionActions).toBeVisible();
      await sectionActions.click();
      await expect(restartedPage.getByRole("menuitem", { name: "Move section up" })).toHaveCount(0);
      await expect(restartedPage.getByRole("menuitem", { name: "Move section down" })).toHaveCount(
        0,
      );
      await restartedPage.getByRole("menuitem", { name: "Delete section" }).click();
      await expect(workSection(restartedPage)).toHaveCount(0);
      await restartedPage.getByRole("button", { name: "Undo" }).click();
      await expect(workSection(restartedPage)).toBeVisible();
    },
  );
});
