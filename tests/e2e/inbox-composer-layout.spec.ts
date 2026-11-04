import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { invokeIpc } from "./support/editor-scenario";

const SHORT_DRAFT = "Ship the release notes";
const LONG_DRAFT = Array.from(
  { length: 18 },
  (_, index) =>
    `${index + 1}. A paragraph long enough to wrap, so the draft outgrows the room the composer gives its text and has to scroll.`,
).join("\n");

interface ComposerParts {
  readonly surface: Locator;
  readonly prompt: Locator;
  /** The element that writes into `prompt`, which is itself for a text field. */
  readonly field: Locator;
  readonly leading: Locator;
  readonly primary: Locator;
}

// A 192 by 96 PNG, so a loaded thumbnail reports real pixels.
const SCREENSHOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAMAAAABgCAIAAADEouq+AAABBklEQVR4nO3SQQkAIADAQMMaxzgGtIN7iHBwAfbYmGvDtfG8gK8ZiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEcgBRsybr72+iHwAAAABJRU5ErkJggg==";

const pasteImage = async (field: Locator, name: string) => {
  await field.evaluate(
    (element, { base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    { base64: SCREENSHOT_PNG, name },
  );
};

const attachmentGeometry = async (surface: Locator) => {
  await expect(surface.locator("[data-composer-image-attachment-id]").first()).toBeVisible();
  return await surface.evaluate((surface) => {
    const edge = surface.getBoundingClientRect();
    const element = surface.querySelector("[data-composer-image-attachment-id]")!;
    const box = element.getBoundingClientRect();
    return {
      top: Math.round(box.top - edge.top),
      left: Math.round(box.left - edge.left),
      size: Math.round(box.width),
      radius: getComputedStyle(element).borderTopLeftRadius,
      surfaceHeight: Math.round(edge.height),
    };
  });
};

/** Starts a real drag's events over the target, then captures it with room for the mark. */
const dragImageOver = async (page: Page, target: Locator, screenshot: string) => {
  const transfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137])], "dragged.png", { type: "image/png" }));
    return transfer;
  });
  await target.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(target).toHaveAttribute("data-file-drop-active", "true");
  await page.mouse.move(4, 4);
  const box = (await target.boundingBox())!;
  await page.screenshot({
    path: screenshot,
    clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 },
  });
  await target.dispatchEvent("dragleave", { dataTransfer: transfer });
  await expect(target).toHaveAttribute("data-file-drop-active", "false");
};

const composerGeometry = async (parts: ComposerParts) => {
  const surface = await parts.surface.elementHandle();
  const prompt = await parts.prompt.elementHandle();
  const leading = await parts.leading.elementHandle();
  const primary = await parts.primary.elementHandle();
  return await parts.surface.page().evaluate(
    ([surface, prompt, leading, primary]) => {
      const edge = surface!.getBoundingClientRect();
      const inset = (element: Element) => {
        const box = element.getBoundingClientRect();
        return {
          top: Math.round(box.top - edge.top),
          left: Math.round(box.left - edge.left),
          right: Math.round(edge.right - box.right),
          bottom: Math.round(edge.bottom - box.bottom),
        };
      };
      const promptStyle = getComputedStyle(prompt!);
      const surfaceStyle = getComputedStyle(surface!);
      const primaryStyle = getComputedStyle(primary!);
      return {
        surface: {
          width: Math.round(edge.width),
          height: Math.round(edge.height),
          background: surfaceStyle.backgroundColor,
          radius: surfaceStyle.borderTopLeftRadius,
          shadow: surfaceStyle.boxShadow,
        },
        prompt: {
          ...inset(prompt!),
          color: promptStyle.color,
          fontFamily: promptStyle.fontFamily,
          fontSize: promptStyle.fontSize,
          lineHeight: promptStyle.lineHeight,
          // Its shade follows the pointer; both using the app's scrollbar is the shared layout.
          appScrollbar: promptStyle.scrollbarColor !== "auto",
          scrolls: prompt!.scrollHeight > prompt!.clientHeight,
          scrollbarOverlapsControls:
            prompt!.getBoundingClientRect().bottom > primary!.getBoundingClientRect().top,
        },
        leading: inset(leading!),
        primary: {
          ...inset(primary!),
          size: Math.round(primary!.getBoundingClientRect().width),
          background: primaryStyle.backgroundColor,
          color: primaryStyle.color,
        },
      };
    },
    [surface, prompt, leading, primary] as const,
  );
};

const measure = async (
  page: Page,
  artifacts: string,
  name: string,
  parts: ComposerParts,
  fill: (text: string) => Promise<void>,
) => {
  const capture = async (state: string) => {
    await page.mouse.move(4, 4);
    await parts.surface.screenshot({ path: path.join(artifacts, `${name}-${state}.png`) });
    return await composerGeometry(parts);
  };
  const empty = await capture("empty");
  await fill(SHORT_DRAFT);
  const short = await capture("short");
  await fill(LONG_DRAFT);
  await expect.poll(() => composerGeometry(parts).then((g) => g.prompt.scrolls)).toBe(true);
  await parts.prompt.evaluate((element) => (element.scrollTop = 0));
  const long = await capture("long");
  // The scrollbar shows while the pointer is over the text it scrolls.
  await parts.field.hover();
  await parts.surface.screenshot({ path: path.join(artifacts, `${name}-long-hover.png`) });
  await page.screenshot({ path: path.join(artifacts, `${name}-window.png`) });
  return { empty, short, long };
};

test("the Inbox composer shares a chat composer's layout, and long text scrolls only its text", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const artifacts =
    process.env.NODEX_INBOX_COMPOSER_ARTIFACT_DIR ?? testInfo.outputPath("inbox-composer-review");
  await mkdir(artifacts, { recursive: true });

  await withElectronScenario(
    { label: "inbox-composer-layout", scenarioId: null },
    async ({ page }) => {
      await invokeIpc(page, "settings:inbox:update", { suggestions: "off" });
      await page.setViewportSize({ width: 1280, height: 800 });

      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      const inboxField = page.getByRole("textbox", { name: "Message your Inbox" });
      await expect(inboxField).toBeVisible();
      const inboxSurface = page.getByTestId("inbox-composer");
      const inbox = await measure(
        page,
        artifacts,
        "inbox",
        {
          surface: inboxSurface,
          prompt: inboxField,
          field: inboxField,
          leading: inboxSurface.getByRole("button", { name: "Add photos" }),
          primary: inboxSurface.getByRole("button", { name: "Send to Inbox" }),
        },
        (text) => inboxField.fill(text),
      );

      await page.getByRole("button", { name: "New chat", exact: true }).first().click();
      const threadField = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
      await expect(threadField).toBeVisible();
      const thread = await measure(
        page,
        artifacts,
        "thread",
        {
          surface: page.locator(".composer-surface-chrome").filter({ has: threadField }),
          prompt: page.locator('[data-composer-prompt-frame="true"]'),
          field: threadField,
          leading: page.locator('[data-add-context-trigger="true"]'),
          primary: page.locator('[data-composer-footer-trailing="true"] button').last(),
        },
        (text) => threadField.fill(text),
      );

      await writeFile(
        path.join(artifacts, "geometry.json"),
        JSON.stringify({ inbox, thread }, null, 2),
      );

      // One layout: every state of the Inbox composer measures as a chat's does.
      expect(inbox).toEqual(thread);
      // The text scrolls within its own row, clear of the controls beneath it.
      expect(inbox.long.prompt.scrolls).toBe(true);
      expect(inbox.long.prompt.scrollbarOverlapsControls).toBe(false);

      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page
        .locator(".composer-surface-chrome")
        .filter({ has: threadField })
        .screenshot({ path: path.join(artifacts, "thread-long-dark.png") });
      await page.getByTestId("sidebar-inbox-row-wrapper").getByRole("button").click();
      await expect(inboxField).toBeVisible();
      await inboxSurface.screenshot({ path: path.join(artifacts, "inbox-long-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

      // The controls' row refuses selection; the text in the row above it still takes a drag.
      await inboxField.evaluate((element) => (element.scrollTop = 0));
      const text = (await inboxField.boundingBox())!;
      await page.mouse.move(text.x + 4, text.y + 10);
      await page.mouse.down();
      await page.mouse.move(text.x + 160, text.y + 10, { steps: 6 });
      await page.mouse.up();
      expect(
        await inboxField.evaluate(
          (element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart,
        ),
      ).toBeGreaterThan(0);

      await dragImageOver(page, inboxSurface, path.join(artifacts, "inbox-drop.png"));

      await inboxField.fill(SHORT_DRAFT);
      await pasteImage(inboxField, "pasted.png");
      await expect(inboxSurface.getByRole("button", { name: "pasted.png" })).toBeVisible();
      const inboxAttachment = await attachmentGeometry(inboxSurface);
      await page.mouse.move(4, 4);
      await inboxSurface.screenshot({ path: path.join(artifacts, "inbox-image.png") });
      await inboxField.fill(LONG_DRAFT);

      await page.getByRole("button", { name: "New chat", exact: true }).first().click();
      await expect(threadField).toBeVisible();
      await dragImageOver(
        page,
        page.locator("[data-file-drop-active]").filter({ has: threadField }),
        path.join(artifacts, "thread-drop.png"),
      );
      // A chat takes images once its Agent is known.
      await expect(page.locator('[data-composer-footer-trailing="true"]')).not.toContainText(
        "Choose model",
        { timeout: 30_000 },
      );
      await threadField.fill(SHORT_DRAFT);
      await pasteImage(threadField, "pasted.png");
      const threadSurface = page.locator(".composer-surface-chrome").filter({ has: threadField });
      expect(inboxAttachment).toEqual(await attachmentGeometry(threadSurface));
      await page.mouse.move(4, 4);
      await threadSurface.screenshot({ path: path.join(artifacts, "thread-image.png") });

      // Over the current place, the capture keeps its title above text that scrolls.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("c");
      const capture = page.getByRole("dialog", { name: "Capture to Inbox" });
      const captureField = capture.getByRole("textbox", { name: "Message your Inbox" });
      await expect(captureField).toBeFocused();
      await capture.getByRole("button", { name: "Add title" }).click();
      const title = capture.getByRole("textbox", { name: "Message title" });
      await page.keyboard.type("Release notes");
      await expect(captureField).toHaveValue(LONG_DRAFT);
      const scrolled = await captureField.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return {
          top: element.scrollTop,
          height: element.clientHeight,
          limit: window.innerHeight / 4,
        };
      });
      expect(scrolled.top).toBeGreaterThan(0);
      expect(scrolled.height).toBeLessThanOrEqual(scrolled.limit);
      await expect(title).toBeInViewport();
      const [titleBox, fieldBox] = await Promise.all([
        title.boundingBox(),
        captureField.boundingBox(),
      ]);
      expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(fieldBox!.y);
      await page.mouse.move(4, 4);
      await page.screenshot({ path: path.join(artifacts, "quick-capture.png") });
    },
  );
});
