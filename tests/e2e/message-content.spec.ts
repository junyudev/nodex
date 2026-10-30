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
      await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
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
          "",
          "- the gear in the toolbar",
          "- the close button on dialogs",
          "",
          "Keep a < b as typed.",
          "",
          `![Settings toolbar](nodex://files/${fileId})`,
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

test("the Inbox composer sends pasted and picked images ahead of the text", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const artifacts =
    process.env.NODEX_MESSAGE_CONTENT_ARTIFACT_DIR ?? testInfo.outputPath("message-content-review");
  await mkdir(artifacts, { recursive: true });
  await withElectronScenario(
    { label: "message-content-composer", scenarioId: null },
    async ({ page }) => {
      await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      const composer = page.getByRole("textbox", { name: "Message your Inbox" });
      // Written as Markdown: two lines of one paragraph, then a list with `*` bullets.
      await composer.fill(
        "The toolbar is cut off on **narrow** windows\nwhen the sidebar is open\n\n* the gear\n* the close button",
      );

      // Paste goes through the real clipboard event path with an image File on it.
      await composer.evaluate((element, base64) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
      }, Buffer.from(SCREENSHOT_PNG).toString("base64"));
      await page.getByTestId("message-image-picker").setInputFiles({
        name: "picked.png",
        mimeType: "image/png",
        buffer: Buffer.from(SCREENSHOT_PNG),
      });
      const form = page.getByTestId("inbox-composer");
      await expect(form.getByRole("button", { name: "pasted.png" })).toBeVisible();
      await expect(form.getByRole("button", { name: "picked.png" })).toBeVisible();
      // A third image, let go of before sending, does not stay behind as an unused File.
      await page.getByTestId("message-image-picker").setInputFiles({
        name: "dropped.png",
        mimeType: "image/png",
        buffer: Buffer.from(SCREENSHOT_PNG),
      });
      await expect(form.getByRole("button", { name: "dropped.png" })).toBeVisible();
      await form.getByRole("button", { name: "Remove dropped.png" }).click();
      await expect(form.getByRole("button", { name: "dropped.png" })).toHaveCount(0);
      await page.screenshot({ path: path.join(artifacts, "composer.png") });

      await composer.press("Enter");
      const message = page
        .getByTestId("inbox-message")
        .filter({ hasText: "The toolbar is cut off" });
      await expect(message).toBeVisible();
      await expect(message.getByText("narrow", { exact: true })).toBeVisible();
      await expect(message.getByRole("listitem")).toHaveText(["the gear", "the close button"]);
      const thumbnails = message.getByRole("button", { name: "Open image preview" });
      await expect(thumbnails).toHaveCount(2);
      await expect
        .poll(() =>
          message
            .getByRole("img")
            .evaluateAll((images) =>
              images.map((image) =>
                (image as HTMLImageElement).complete ? (image as HTMLImageElement).naturalWidth : 0,
              ),
            ),
        )
        .toEqual([192, 192]);
      await expect(form.getByRole("button", { name: "pasted.png" })).toHaveCount(0);

      const [item] = (
        await invokeIpc(page, "inbox:window", { scope: { kind: "library" }, filter: "inbox" })
      ).items;
      expect(item?.body).toMatch(
        /^!\[\]\(nodex:\/\/files\/[^)]+\)\n\n!\[\]\(nodex:\/\/files\/[^)]+\)\n\nThe toolbar is cut off on \*\*narrow\*\* windows\nwhen the sidebar is open\n\n- the gear\n- the close button$/,
      );
      await page.screenshot({ path: path.join(artifacts, "sent.png") });

      const filesIn = async (lifecycle: "live" | "trashed") => {
        const result = await invokeIpc(
          page,
          "library-module:read",
          { kind: "library" },
          { read: { mode: "files", lifecycle, usage: "all", limit: 50 } },
        );
        if (!result.ok || result.value.value.kind !== "files") return [];
        return result.value.value.value.items.map((file) => file.default_name).sort();
      };
      await expect.poll(() => filesIn("trashed")).toEqual(["dropped.png"]);
      expect(await filesIn("live")).toEqual(["pasted.png", "picked.png"]);
    },
  );
});
