import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { invokeIpc } from "./support/editor-scenario";

// A 192 by 96 PNG, so a loaded thumbnail reports real pixels.
const SCREENSHOT_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAMAAAABgCAIAAADEouq+AAABBklEQVR4nO3SQQkAIADAQMMaxzgGtIN7iHBwAfbYmGvDtfG8gK8ZiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEcgBRsybr72+iHwAAAABJRU5ErkJggg==",
    "base64",
  ),
);

test("an Inbox message shows its Markdown and the images in its Page", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const artifacts =
    process.env.NODEX_MESSAGE_CONTENT_ARTIFACT_DIR ?? testInfo.outputPath("message-content-review");
  await mkdir(artifacts, { recursive: true });
  await withElectronScenario(
    { label: "message-content", scenarioId: null },
    async ({ page, seed }) => {
      await invokeIpc(page, "settings:inbox:update", { suggestionsEnabled: false });
      const project = await seed.createProject({ name: "Message content", sources: [] });
      const fileId = createUuidV7();
      await seed.createLibraryFile({
        projectId: project.id,
        operationId: createUuidV7(),
        fileId,
        defaultName: "settings-toolbar.png",
        mimeType: "image/png",
        bytes: SCREENSHOT_PNG,
      });
      const { pageId } = await seed.sendInboxMessage(
        [
          "Settings buttons have **no accessible labels**:",
          "- the gear in the toolbar",
          "- the close button on dialogs",
          "Keep a \\< b as typed.",
          `<image source="nodex://files/${fileId}">Settings toolbar</image>`,
        ].join("\n"),
      );

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      const message = page.locator(`[data-inbox-page-id="${pageId}"]`);
      await expect(message).toBeVisible();
      await expect(message.getByText("no accessible labels", { exact: true })).toBeVisible();
      await expect(message.getByRole("listitem")).toHaveText([
        "the gear in the toolbar",
        "the close button on dialogs",
      ]);
      await expect(message).toContainText("Keep a < b as typed.");
      await expect(message).not.toContainText("**");

      // The thumbnail is read through the message Page's own access to its Library File.
      const thumbnail = message.getByRole("img", { name: "Settings toolbar" });
      await expect
        .poll(() =>
          thumbnail.evaluate((image: HTMLImageElement) =>
            image.complete ? image.naturalWidth : 0,
          ),
        )
        .toBe(192);
      await page.screenshot({ path: path.join(artifacts, "message.png") });

      await message.getByRole("button", { name: "Open image preview" }).click();
      await expect(
        page.getByRole("dialog").getByRole("img", { name: "Settings toolbar" }),
      ).toBeVisible();
      await page.screenshot({ path: path.join(artifacts, "preview.png") });
    },
  );
});
