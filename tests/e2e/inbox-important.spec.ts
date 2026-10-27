import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";

const DAY_MS = 24 * 60 * 60 * 1000;
const PRICING = "Rethink onboarding pricing before the Q4 review";
const LEARNING = "Draft the yearly learning plan: what to go deep on next";
const EVERYDAY = [
  "Book a dentist appointment",
  "Look into why CI is slow on the arm runners",
  "Reply to Mei about the conference talk",
  "Idea: a shortcut to jump between Inbox and History",
  "Check the renewal date for the domain",
  "Try async IO in Postgres 18 on the staging box",
  "Pick up the dry cleaning",
  "Read the speculative decoding paper someone shared",
  LEARNING,
  "Ask design for the empty-state illustration",
  "Fix the flaky upload test",
  "Groceries: oat milk, eggs, coffee beans",
  "Send the September invoice",
  "Benchmark the Board with 5k cards",
  "Renew the passport before December",
  "Look up a good bike shop for a tune-up",
  "Move the team sync to Thursday",
  "Write release notes for the Board drag fix",
  "Return the borrowed camera lens",
  "Check whether the backup job ran last night",
];

const inView = async (page: Page, message: Locator) => {
  const stream = await page.getByTestId("inbox-stream").boundingBox();
  const box = await message.boundingBox();
  return !!stream && !!box && box.y + box.height > stream.y && box.y < stream.y + stream.height;
};

test("keeps important messages within reach while newer ones bury them", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const artifacts =
    process.env.NODEX_INBOX_IMPORTANT_ARTIFACT_DIR ?? testInfo.outputPath("inbox-important-review");
  await mkdir(artifacts, { recursive: true });
  const claims: { name: string; expected: unknown; actual: unknown }[] = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  await withElectronScenario(
    { label: "inbox-important", scenarioId: null },
    async ({ page, seed }) => {
      await invokeIpc(page, "settings:inbox:update", { suggestionsEnabled: false });
      for (const text of [PRICING, ...EVERYDAY]) await seed.sendInboxMessage(text);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      await expect(page.locator('[data-inbox-scope="library"]')).toBeVisible();
      let status: "passed" | "failed" = "failed";
      let failure: string | null = null;
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 800 },
      });
      await page.screencast.showActions({
        position: "bottom",
        style: { title: "font-size: 14px" },
      });
      try {
        const message = (text: string) =>
          page.getByTestId("inbox-message").filter({ hasText: text });
        const bar = page.getByTestId("inbox-important-bar");
        const star = (text: string) =>
          message(text).getByRole("button", { name: "Unmark important", exact: true });
        const rest = async () => {
          // The pointer rests on the sidebar, so no message is hovered.
          await page.mouse.move(180, 450);
          await page.waitForTimeout(400);
        };
        const shown = (locator: Locator) =>
          locator.evaluate((element) => {
            let opacity = 1;
            for (let node: Element | null = element; node; node = node.parentElement) {
              opacity *= Number(getComputedStyle(node).opacity);
              if (node.matches("[data-testid='inbox-message']")) break;
            }
            return opacity;
          });
        const openMenu = async (text: string) => {
          const row = message(text);
          await row.scrollIntoViewIfNeeded();
          await row.getByTestId("inbox-message-unit").hover();
          await row.getByRole("button", { name: "Message actions", exact: true }).click();
        };
        // Only the message menu marks a message.
        for (const text of [PRICING, LEARNING, "Fix the flaky upload test"]) {
          await openMenu(text);
          await page.getByRole("menuitem", { name: "Mark important", exact: true }).click();
          await expect(star(text)).toBeVisible();
        }
        await rest();
        await page.screenshot({ path: path.join(artifacts, "1-marked.png") });
        const bubble = await message(LEARNING).getByTestId("inbox-message-unit").boundingBox();
        const mark = await star(LEARNING).boundingBox();
        claim(
          "The star rests just left of the user's bubble",
          true,
          !!bubble && !!mark && mark.x + mark.width <= bubble.x && bubble.x - mark.x < 40,
        );
        const timeGap = async (text: string) => {
          const time = await message(text).getByLabel("Open page").boundingBox();
          const card = await message(text).getByTestId("inbox-message-unit").boundingBox();
          return !time || !card ? null : Math.round(card.x - (time.x + time.width));
        };

        // Coming to act on an important message: the star stays, the checkbox joins beside it,
        // and after a moment the time shows beneath them.
        await message(LEARNING).getByTestId("inbox-message-unit").hover();
        await page.waitForTimeout(1_400);
        const checkbox = message(LEARNING).getByRole("checkbox", { name: "Select message" });
        const [starBox, checkboxBox] = [
          await star(LEARNING).boundingBox(),
          await checkbox.boundingBox(),
        ];
        claim(
          "While hovered, the star stays and the checkbox sits beside it",
          { star: 1, checkbox: true, overlap: false },
          {
            star: await shown(star(LEARNING)),
            checkbox: (await shown(checkbox)) > 0,
            overlap: !!starBox && !!checkboxBox && checkboxBox.x + checkboxBox.width > starBox.x,
          },
        );
        const starredGap = await timeGap(LEARNING);
        // Measured first: taking a screenshot lets the hover go.
        await page.screenshot({ path: path.join(artifacts, "1b-hover-important.png") });

        // Any other message shows no star, and its time sits in the same place.
        const PLAIN = "Ask design for the empty-state illustration";
        await message(PLAIN).getByTestId("inbox-message-unit").hover();
        await page.waitForTimeout(1_400);
        claim(
          "A hovered message without the mark shows no star, and its time keeps its place",
          { stars: 0, sameGap: true },
          {
            stars: await message(PLAIN)
              .getByRole("button", { name: /important/ })
              .count(),
            sameGap: starredGap !== null && starredGap === (await timeGap(PLAIN)),
          },
        );
        await page.screenshot({ path: path.join(artifacts, "1c-hover-plain.png") });

        // The menu holds only what the row does not already offer.
        await openMenu(PLAIN);
        await expect(page.getByRole("menuitem", { name: "Open page", exact: true })).toBeVisible();
        const entries = await page.getByRole("menuitem").allInnerTexts();
        claim(
          "The menu leaves out Mark done and Handle manually, which the row shows",
          { markDone: false, handleManually: false, markImportant: true },
          {
            markDone: entries.some((entry) => entry.includes("Mark done")),
            handleManually: entries.some((entry) => entry.includes("Handle manually")),
            markImportant: entries.some((entry) => entry.includes("Mark important")),
          },
        );
        await page.screenshot({ path: path.join(artifacts, "1d-menu.png") });
        // A pointer closes the menu, so no keyboard focus ring lingers on its trigger.
        await page.mouse.click(560, 300);
        await expect(page.getByRole("menuitem")).toHaveCount(0);

        // Once it shows, the time is the message's link to its Page.
        await message(PLAIN).getByTestId("inbox-message-unit").hover();
        await page.waitForTimeout(1_400);
        const timeLink = message(PLAIN).getByRole("button", { name: "Open page", exact: true });
        await timeLink.hover();
        await page.waitForTimeout(1_000);
        claim(
          "Under the pointer the time reads as a link",
          "underline",
          await timeLink.evaluate((element) => getComputedStyle(element).textDecorationLine),
        );
        const around = await message(PLAIN).boundingBox();
        await page.screenshot({
          path: path.join(artifacts, "1e-time-link.png"),
          ...(around
            ? {
                clip: {
                  x: around.x + around.width - 480,
                  y: around.y - 50,
                  width: 490,
                  height: around.height + 110,
                },
              }
            : {}),
        });
        await message(PLAIN).getByRole("button", { name: "Open page", exact: true }).click();
        const sceneTabs = page.locator("[data-panel-tab-row]").getByRole("tab");
        await expect(sceneTabs.and(page.getByRole("tab", { selected: true }))).toContainText(
          "Ask design for the empty-state",
        );
        claim(
          "Choosing the time opens the message's Page beside the Inbox",
          2,
          await sceneTabs.count(),
        );
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(artifacts, "1f-page-opened.png") });
        await sceneTabs.filter({ hasText: /^Inbox$/ }).click();
        await expect(message(PLAIN)).toBeVisible();

        // The gold star takes the mark off again.
        await message("Fix the flaky upload test").getByTestId("inbox-message-unit").hover();
        await star("Fix the flaky upload test").click();
        await expect(star("Fix the flaky upload test")).toHaveCount(0);
        const summary = await invokeIpc(page, "inbox:summary", { scope: { kind: "library" } });
        claim(
          "Unmarking leaves the other two, oldest first",
          [PRICING, "Draft the yearly learning plan: what to go deep…"],
          summary.important.map((marked) => marked.title),
        );

        // Newer messages bury them: a send always shows the newest.
        const composer = page.getByRole("textbox", { name: "Message your Inbox" });
        await composer.fill("Call the landlord about the heater");
        await composer.press("Enter");
        await expect(message("Call the landlord about the heater")).toBeVisible();
        await expect(bar).toBeVisible();
        claim(
          "Burying both marks points at the longest-waiting one",
          true,
          (await bar.innerText()).includes("Rethink onboarding pricing"),
        );
        claim(
          "The pill counts every important message",
          true,
          (await bar.innerText()).includes("1/2"),
        );
        claim(
          "Both are out of view",
          [false, false],
          [await inView(page, message(PRICING)), await inView(page, message(LEARNING))],
        );

        // Only reads from here: the renderer clock moves four days on to show the wait.
        // Only Date moves: animation frames keep real time, so motion still plays.
        await page.evaluate(
          (offsetMs) => {
            const now = Date.now.bind(Date);
            Date.now = () => now() + offsetMs;
          },
          4 * DAY_MS + 3 * 60 * 60 * 1000,
        );
        const views = page.getByRole("tablist", { name: "Inbox view" });
        // The reader settles at the newest messages before the view changes and back.
        await page.mouse.move(900, 450);
        await page.mouse.wheel(0, 4_000);
        await page.waitForTimeout(600);
        await views.getByRole("tab", { name: /History/ }).click();
        await views.getByRole("tab", { name: /Inbox/ }).click();
        await expect(bar).toContainText("4d");
        await page.mouse.move(180, 450);
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(artifacts, "2-buried.png") });
        // Under the pointer the pill stays solid, so its words stay legible over the stream.
        await bar.hover();
        await page.waitForTimeout(300);
        claim(
          "The pill keeps an opaque surface under the pointer",
          true,
          await bar.evaluate((element) => {
            const color = getComputedStyle(element).backgroundColor;
            const alpha =
              /\/\s*([\d.]+)\s*\)$/.exec(color) ?? /^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/.exec(color);
            return !alpha || Number(alpha[1]) === 1;
          }),
        );
        await page.screenshot({ path: path.join(artifacts, "2b-pill-hover.png") });

        await bar.click();
        await page.waitForTimeout(1_000);
        await page.screenshot({ path: path.join(artifacts, "3-arrived.png") });
        // The stream holds its first messages still; the ring still plays inside it.
        claim(
          "The message it arrives at is ringed in gold",
          true,
          await message(PRICING).evaluate((row) => {
            const ring = row.querySelector(
              "[data-testid='inbox-message-unit'] > span[aria-hidden]",
            );
            return ring ? Number(getComputedStyle(ring).opacity) > 0.5 : false;
          }),
        );
        claim(
          "Choosing the pill brings the message into view",
          true,
          await inView(page, message(PRICING)),
        );
        await expect(bar).toContainText("Draft the yearly learning plan");
        claim(
          "Arriving at one points at the next out of view",
          true,
          (await bar.innerText()).includes("2/2"),
        );

        await page.waitForTimeout(1_500);
        await bar.click();
        await page.waitForTimeout(1_000);
        await page.screenshot({ path: path.join(artifacts, "4-next.png") });
        claim("The next one arrives in turn", true, await inView(page, message(LEARNING)));

        await page.waitForTimeout(1_500);
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(artifacts, "5-dark.png") });
        await page.emulateMedia({ colorScheme: "light" });
        status = "passed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => undefined);
        throw error;
      } finally {
        await page.screencast.stop();
        await writeFile(
          path.join(artifacts, "result.json"),
          `${JSON.stringify({ status, fixture: "fresh disposable Electron Profile; suggestions disabled; 22 synthetic Inbox messages; renderer Date.now advanced 4 days only for the read-only screenshots", claims, failure }, null, 2)}\n`,
        );
        await writeFile(
          path.join(artifacts, "README.md"),
          `# Important Inbox messages verification\n\nStatus: **${status}**\n\nA fresh disposable Electron Profile holds 22 synthetic messages. Three messages are marked important from the message menu, the only place a mark is made, and one gold star then takes its mark off again. Hovering shows the star staying beside the checkbox, a plain message without any star, the shorter menu, and the time as the link that opens a message's Page. A new send buries the other two, and the pill at the top of the stream names the longest-waiting one, how long it has waited, and its place among them. Choosing it brings that message into view with a gold ring, and the pill moves on to the next important message out of view. Only the renderer's Date.now is moved four days on, after every write, to show the waiting time. Exact expected and actual values are in result.json.\n\n1. 1-marked.png: each gold star rests just left of its bubble.\n1b. 1b-hover-important.png: hovering keeps the star; the checkbox and, after a moment, the time appear beside and beneath it.\n1c. 1c-hover-plain.png: a message without the mark shows no star; its time sits in the same place.\n1d. 1d-menu.png: the menu leaves out what the row shows.\n1e. 1e-time-link.png: the time, once shown, is the link to the Page (close-up).\n1f. 1f-page-opened.png: choosing it opens the Page beside the Inbox.\n2. 2-buried.png: newer messages bury them; the pill points back to the oldest.\n2b. 2b-pill-hover.png: under the pointer the pill stays solid and legible.\n3. 3-arrived.png: choosing the pill brings it into view, ringed in gold; the pill names the next.\n4. 4-next.png: the next one arrives in turn.\n5. 5-dark.png: the same marks in the dark theme.\n\nRecording: review.webm.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
        );
      }
    },
  );
});
