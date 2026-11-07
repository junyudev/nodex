import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { withAgentPeers, type NativeRecord } from "./support/agent-peers";
import {
  chooseComposerEffort,
  chooseComposerModel,
  composerModelLabel,
} from "./support/composer-model-picker";

const VIEWPORT = { width: 1440, height: 900 };

test("New chat remembers its own model on any Agent, and a started chat's choice stays its own", async ({}, testInfo) => {
  test.setTimeout(300_000);
  // Setting this directory also records a narrated walkthrough for review.
  const reviewDirectory = process.env.NODEX_E2E_EVIDENCE_DIR;
  const evidence = reviewDirectory ?? testInfo.outputPath("new-chat-model-memory");
  fs.mkdirSync(evidence, { recursive: true });
  await withAgentPeers(
    testInfo,
    "new-chat-memory",
    async ({ harness, page: firstPage, projectName, send, records, models, modelNames }) => {
      let page = firstPage;
      const prompts = (kind: NativeRecord["kind"]) =>
        records()
          .filter((record) => record.kind === kind && record.event === "prompt")
          .map((record) => record.prompt);
      const expectStartsOn = async (model: string, effort?: string) => {
        const label = composerModelLabel(page);
        await expect(label).toContainText(model, { timeout: 60_000 });
        if (effort) await expect(label).toContainText(effort);
      };
      const startNewChat = async () => {
        await page
          .getByRole("button", { name: `Start new chat in ${projectName}`, exact: true })
          .click();
        await expect(page.locator('[data-codex-composer="true"]:visible')).toHaveText("");
      };
      const narrate = async (title: string, description: string) => {
        if (!reviewDirectory) return;
        await page.screencast.showChapter(title, { description, duration: 2_200 });
        await page.waitForTimeout(2_300);
      };
      const capture = async (name: string) => {
        // Assertions own settling; keep a readable frame of each verified state.
        await page.mouse.move(VIEWPORT.width / 2, 120);
        await page.waitForTimeout(reviewDirectory ? 900 : 200);
        const body = await page.screenshot({
          path: path.join(evidence, `${name}.png`),
          animations: "disabled",
        });
        await testInfo.attach(name, { body, contentType: "image/png" });
      };
      const record = async (name: string) => {
        if (!reviewDirectory) return;
        await page.setViewportSize(VIEWPORT);
        await page.screencast.start({ path: path.join(evidence, name), size: VIEWPORT });
        await page.screencast.showActions({
          position: "bottom",
          style: { title: "font-size: 14px" },
        });
      };

      await page.setViewportSize(VIEWPORT);
      await record("1-before-restart.webm");
      try {
        await narrate("1. No choice yet", "The first New Chat starts on Codex's default model.");
        await expectStartsOn(modelNames.codex);
        await capture("01-first-new-chat-on-codex");

        await narrate("2. Choose Claude in New Chat", "A Claude model at High effort, then send.");
        await chooseComposerModel(page, models.claude);
        await chooseComposerEffort(page, "High");
        await page.keyboard.press("Escape");
        await expectStartsOn(modelNames.claude, "High");
        await capture("02-chose-claude-high");
        await send("First message", "Claude child report", 1);
        expect(prompts("claude")).toEqual(["First message"]);

        await narrate(
          "3. Switch models inside the started chat",
          "This choice belongs to that chat alone.",
        );
        await chooseComposerModel(page, models.codex);
        await expectStartsOn(modelNames.codex);
        await capture("03-started-chat-switched-to-codex");

        await narrate(
          "4. Start New Chat",
          "It starts on the last New Chat choice: Claude, not Codex.",
        );
        await startNewChat();
        await expectStartsOn(modelNames.claude, "High");
        await capture("04-next-new-chat-still-claude");

        await narrate("5. Send without choosing", "The message really goes to Claude.");
        await send("Second message", "Claude child report", 1);
        expect(prompts("claude")).toEqual(["First message", "Second message"]);
        expect(prompts("codex")).toEqual([]);

        await narrate(
          "6. Choose Codex in this Project's New Chat",
          "The memory moves, across Projects and projectless chats.",
        );
        await startNewChat();
        await expectStartsOn(modelNames.claude);
        await chooseComposerModel(page, models.codex);
        await expectStartsOn(modelNames.codex);
        await capture("05-project-new-chat-chose-codex");
        // The Chats section reveals this action on hover; keyboard activation needs none.
        const newProjectlessChat = page.getByRole("button", {
          name: "New projectless chat",
          exact: true,
        });
        await newProjectlessChat.focus();
        await newProjectlessChat.press("Enter");
        await expect(page.locator('[data-codex-composer="true"]:visible')).toHaveText("");
        await expectStartsOn(modelNames.codex);
        await capture("06-projectless-new-chat-follows");

        await narrate(
          "7. Choose Claude in the projectless New Chat",
          "The memory moves again, but the unsent Project draft keeps what was chosen in it.",
        );
        await chooseComposerModel(page, models.claude);
        await expectStartsOn(modelNames.claude, "High");
        await startNewChat();
        await expectStartsOn(modelNames.codex);
        await capture("07-project-draft-kept-its-own-choice");
      } finally {
        if (reviewDirectory) await page.screencast.stop();
      }

      page = await harness.restart();
      await record("2-after-restart.webm");
      try {
        await narrate("8. After restarting Nodex", "The unsent draft still has its own choice.");
        await expectStartsOn(modelNames.codex);
        await capture("08-after-restart-draft-kept-codex");

        await narrate(
          "9. Send it, then Start New Chat",
          "The chat runs on Codex; the next New Chat returns to the last choice, Claude at High.",
        );
        const composer = page.locator('[data-codex-composer="true"]:visible');
        await composer.fill("Third message");
        await composer.press("Enter");
        await expect(
          page.getByText("Codex child report", { exact: true }).filter({ visible: true }),
        ).toHaveCount(1, { timeout: 30_000 });
        expect(prompts("codex")).toEqual(["Third message"]);
        await startNewChat();
        await expectStartsOn(modelNames.claude, "High");
        await capture("09-after-restart-new-chat-on-claude");
      } finally {
        if (reviewDirectory) await page.screencast.stop();
      }
    },
  );
});
