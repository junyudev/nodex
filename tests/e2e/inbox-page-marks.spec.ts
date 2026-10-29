import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  INBOX_TRIAGE_SCENARIO_ID,
  requireInboxTriageScenarioFacts,
} from "../../scripts/scenarios/scenarios/inbox-triage";
import { invokeIpc } from "./support/editor-scenario";

const marksOf = (row: Locator) => row.getByTestId("inbox-page-marks");
const chatMarkOf = (row: Locator) => row.locator('[data-page-chat-activity-control="true"]');

/** The stream's newest messages, which the scenario gives these marks, framed for review. */
const streamShot = async (page: Page, stream: Locator, file: string) => {
  const box = await stream.boundingBox();
  if (!box) throw new Error("The Inbox stream is not on screen");
  await page.screenshot({ path: file, clip: box });
};

test("an Inbox message shows where its Page already stands and opens its chats", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const artifacts =
    process.env.NODEX_INBOX_PAGE_MARKS_ARTIFACT_DIR ?? testInfo.outputPath("inbox-page-marks");
  await mkdir(artifacts, { recursive: true });
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  await withElectronScenario(
    { label: "inbox-page-marks", scenarioId: INBOX_TRIAGE_SCENARIO_ID, seedThrough: "core" },
    async ({ application, facts, page }) => {
      const seeded = requireInboxTriageScenarioFacts(facts);
      // Nothing here asks an Agent for advice; the seeded suggestions are already settled.
      await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 860 });
      });
      const inbox = page.locator('[data-inbox-scope="project"]:visible');
      const stream = inbox.getByTestId("inbox-stream");
      const row = (pageId: string) => inbox.locator(`[data-inbox-page-id="${pageId}"]`);
      const openProjectInbox = async () => {
        await page.locator('[data-app-action-sidebar-project-label="Nodex"]').click();
        await expect(inbox).toBeVisible();
      };

      let status: "passed" | "failed" = "failed";
      let failure: string | null = null;
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 860 },
      });
      try {
        await openProjectInbox();
        const moved = row(seeded.inboxMovedWithChat.pageId);
        const review = row(seeded.inboxMovedNoChat.pageId);
        const plain = row(seeded.inboxPlainTriage.pageId);
        const twoChats = row(seeded.inboxTriageTwoChats.pageId);
        const unread = row(seeded.inboxTriageOneIdleChat.pageId);
        await expect(moved).toBeVisible();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(artifacts, "1-project-inbox.png") });
        await streamShot(page, stream, path.join(artifacts, "2-marks.png"));

        claim(
          "A Page moved to Build shows its status and its working chat",
          ["Status: Build", true],
          [
            await moved.getByRole("img", { name: /^Status:/ }).getAttribute("aria-label"),
            /working chat/.test((await chatMarkOf(moved).getAttribute("aria-label")) ?? ""),
          ],
        );
        claim(
          "A Page moved to Review with no chat shows only its status",
          ["Status: Review", 0],
          [
            await review.getByRole("img", { name: /^Status:/ }).getAttribute("aria-label"),
            await chatMarkOf(review).count(),
          ],
        );
        claim("A message only waiting in Triage shows no marks", 0, await marksOf(plain).count());
        claim(
          "A Triage Page linked to chats shows the chats but no status",
          [0, 1],
          [
            await twoChats.getByRole("img", { name: /^Status:/ }).count(),
            await chatMarkOf(twoChats).count(),
          ],
        );

        // The marks open the message's first line inside its bubble, and stay put on hover.
        const unit = moved.getByTestId("inbox-message-unit");
        // Where the marks sit within the bubble, whatever the stream's scroll.
        const marksInBubble = async () => {
          const [marks, bubble] = await Promise.all([
            marksOf(moved).boundingBox(),
            unit.boundingBox(),
          ]);
          if (!marks || !bubble) throw new Error("The moved message is not on screen");
          return { x: marks.x - bubble.x, y: marks.y - bubble.y };
        };
        const atRest = await marksInBubble();
        claim(
          "The marks sit inside the bubble, at the start of its first line",
          true,
          atRest.x > 0 && atRest.x < 16 && atRest.y > 0 && atRest.y < 16,
        );
        await unit.hover();
        await page.waitForTimeout(1_600);
        await expect(moved.getByRole("button", { name: "Open page" })).toBeVisible();
        claim("Hovering shows the time without moving the marks", atRest, await marksInBubble());
        await streamShot(page, stream, path.join(artifacts, "3-hover-time.png"));

        // Several chats are listed; one is opened directly.
        await chatMarkOf(twoChats).click();
        const linked = page.getByRole("dialog").filter({ hasText: "Linked chats" });
        await expect(linked).toBeVisible();
        claim(
          "Several linked chats are listed to choose from",
          ["Search focus behavior", "Search keyboard review"],
          (await linked.locator("[data-related-chat-session-id]").allInnerTexts())
            .map((text) => text.split("\n")[0]!.trim())
            .toSorted(),
        );
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(artifacts, "4-linked-chats.png") });
        await page.keyboard.press("Escape");
        await expect(linked).toBeHidden();

        // Escape hands focus back to the mark; the dark capture shows the marks at rest.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.emulateMedia({ colorScheme: "dark" });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
        await streamShot(page, stream, path.join(artifacts, "5-dark.png"));
        await page.emulateMedia({ colorScheme: "light" });

        await chatMarkOf(unread).click();
        await expect(
          page
            .locator('[data-app-action-sidebar-thread-row][aria-current="page"]')
            .filter({ hasText: "Export preview review" }),
        ).toHaveCount(1);
        claim("A single linked chat opens directly", true, await inbox.isHidden());
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(artifacts, "6-chat-opened.png") });

        await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
        const library = page.locator('[data-inbox-scope="library"]:visible');
        const libraryMoved = library.locator(
          `[data-inbox-page-id="${seeded.libraryInboxMovedWithChat.pageId}"]`,
        );
        await expect(libraryMoved).toBeVisible();
        claim(
          "The Library Inbox shows a Library Page's status and chats too",
          ["Status: Build", 1],
          [
            await libraryMoved.getByRole("img", { name: /^Status:/ }).getAttribute("aria-label"),
            await chatMarkOf(libraryMoved).count(),
          ],
        );
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
        await streamShot(
          page,
          library.getByTestId("inbox-stream"),
          path.join(artifacts, "7-library-inbox.png"),
        );
        status = "passed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
        throw error;
      } finally {
        await page.screencast.stop();
        await writeFile(
          path.join(artifacts, "result.json"),
          `${JSON.stringify({ status, fixture: "fresh disposable Electron Profile seeded with inbox/triage; suggestions disabled", claims, failure }, null, 2)}\n`,
        );
      }
    },
  );
});
