import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { compactNumber } from "../../src/renderer/features/insights/insights-format";
import { insightsTestRates, writeInsightsTranscripts } from "./support/insights-transcripts";

const pngSize = (bytes: Buffer) => ({
  signature: bytes.subarray(1, 4).toString("ascii"),
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

const tab = (page: Page, list: string, name: string) =>
  page.getByRole("tablist", { name: list }).getByRole("tab", { name, exact: true });

test("reads agent history into Insights and makes a card to share", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const artifacts =
    process.env.NODEX_INSIGHTS_ARTIFACT_DIR ?? testInfo.outputPath("insights-review");
  await mkdir(artifacts, { recursive: true });
  const homes = await mkdtemp(path.join(tmpdir(), "nodex-insights-e2e-"));
  const claudeHome = path.join(homes, "claude");
  await mkdir(claudeHome, { recursive: true });

  try {
    await withElectronScenario(
      {
        label: "insights",
        scenarioId: null,
        environment: { CLAUDE_CONFIG_DIR: claudeHome },
      },
      async ({ application, page, profile }) => {
        await page.setViewportSize({ width: 1440, height: 1320 });
        // Each scenario Profile has its own Codex home; history appears there as it would at home.
        const totals = await writeInsightsTranscripts({
          claudeHome,
          codexHome: profile.codexHome,
          nowMs: Date.now(),
        });
        const stateDirectory = path.join(profile.nodexHome, "agent-runtime", "userdata");
        await mkdir(stateDirectory, { recursive: true });
        await writeFile(
          path.join(stateDirectory, "usage-model-rates.json"),
          JSON.stringify({ ...insightsTestRates, fetchedAtMs: Date.now() }),
        );

        await test.step("nothing is read before it is asked for", async () => {
          await page.getByRole("button", { name: "Insights", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Insights", exact: true })).toBeVisible();
          // The first read waits for the Agent Runtime to start.
          await expect(page.getByText("See everything your agents have done")).toBeVisible({
            timeout: 90_000,
          });
          await page.screenshot({ path: path.join(artifacts, "1-consent.png") });
        });

        await test.step("history fills the page", async () => {
          await page.getByRole("button", { name: "Read my agent history", exact: true }).click();
          await tab(page, "Period", "All time").click();
          const hero = page.locator("[data-insights-tokens]");
          await expect(hero).toHaveText(compactNumber(totals.tokens), { timeout: 120_000 });
          await expect(page.getByText("Messages sent", { exact: true })).toBeVisible();
          await expect(
            page
              .locator("div", { hasText: /^Messages sent$/ })
              .locator("xpath=following-sibling::div[1]"),
          ).toHaveText(totals.messages.toLocaleString("en-US"));
          await expect(page.getByRole("cell", { name: "Claude Opus 5.5" })).toBeVisible();
          await expect(page.getByRole("cell", { name: "GPT-6.1 Sol" })).toBeVisible();
          await expect(page.getByText(/at API list price/)).toBeVisible();
          await tab(page, "Period", "12 months").click();
          await expect(page.getByRole("img", { name: "Daily tokens" })).toBeVisible();
          await page.screenshot({ path: path.join(artifacts, "2-insights-light.png") });
          await page.emulateMedia({ colorScheme: "dark" });
          // The shell eases between themes; the picture is of where it lands.
          await page.waitForTimeout(600);
          await page.screenshot({ path: path.join(artifacts, "2-insights-dark.png") });
          await page.emulateMedia({ colorScheme: null });
        });

        await test.step("Nodex only leaves out other agents' history", async () => {
          // A scenario Profile's Codex home is its own Agent home, so only Codex counts as Nodex's.
          const hero = page.locator("[data-insights-tokens]");
          await tab(page, "Agents", "Nodex only").click();
          await expect(hero).toHaveText(compactNumber(totals.codexTokens));
          await tab(page, "Agents", "All agents").click();
          await expect(hero).toHaveText(compactNumber(totals.tokens));
        });

        await test.step("a card previews and exports exactly", async () => {
          await page.getByRole("button", { name: "Share", exact: true }).click();
          const preview = page.getByRole("img", { name: /card:/ });
          await expect(preview).toBeVisible();
          await expect
            .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
            .toBe(1080);
          await page.screenshot({ path: path.join(artifacts, "3-share-skyline.png") });

          const save = async (name: string) => {
            const destination = path.join(artifacts, name);
            await application.evaluate(({ dialog }, target) => {
              dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
            }, destination);
            await page.getByRole("button", { name: "Save PNG", exact: true }).click();
            await expect(page.getByText("Card saved").first()).toBeVisible();
            return pngSize(await readFile(destination));
          };

          expect(await save("card-skyline-12m.png")).toEqual({
            signature: "PNG",
            width: 2160,
            height: 2700,
          });

          await tab(page, "Card", "Receipt").click();
          await page.screenshot({ path: path.join(artifacts, "4-share-receipt.png") });
          expect((await save("card-receipt-12m.png")).width).toBe(2160);

          await tab(page, "Card period", "7 days").click();
          await tab(page, "Card", "Skyline").click();
          await save("card-skyline-7d.png");

          await tab(page, "Card period", "12 months").click();
          await page.getByLabel("Name on card").fill("Ada");
          await page.getByRole("switch", { name: "Show cost" }).click();
          await save("card-skyline-named-no-cost.png");
          await tab(page, "Card", "Receipt").click();
          await save("card-receipt-named-no-cost.png");

          await page.getByRole("button", { name: "Copy image", exact: true }).click();
          await expect(page.getByText("Image copied", { exact: true })).toBeVisible();
          const hasImage = await application.evaluate(async ({ clipboard }) =>
            (await clipboard.read()).some((item) => item.types.includes("image/png")),
          );
          expect(hasImage).toBe(true);
          await page.keyboard.press("Escape");
        });

        await test.step("Go to Insights works from the keyboard", async () => {
          await page.getByRole("button", { name: "Home", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Insights", exact: true })).toHaveCount(0);
          await page.keyboard.press("g");
          await page.keyboard.press("i");
          await expect(page.getByRole("heading", { name: "Insights", exact: true })).toBeVisible();
        });

        await test.step("stopping forgets what was read", async () => {
          await page.getByRole("button", { name: "Stop reading history", exact: true }).click();
          await page.getByRole("button", { name: "Keep reading", exact: true }).click();
          await expect(page.locator("[data-insights-tokens]")).toBeVisible();
          await page.getByRole("button", { name: "Stop reading history", exact: true }).click();
          await page.getByRole("button", { name: "Stop and forget", exact: true }).click();
          await expect(page.getByText("See everything your agents have done")).toBeVisible();
        });
      },
    );
  } finally {
    await rm(homes, { recursive: true, force: true });
  }
});
