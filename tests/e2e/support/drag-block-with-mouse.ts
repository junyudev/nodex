import { expect, type Locator, type Page } from "@playwright/test";

export async function dispatchEditorAncestorScroll({
  page,
  sourceEditor,
}: {
  page: Page;
  sourceEditor: Locator;
}): Promise<void> {
  await sourceEditor.evaluate((editor) => {
    let ancestor: Element | null = editor;
    while (ancestor) {
      ancestor.dispatchEvent(new Event("scroll"));
      ancestor = ancestor.parentElement;
    }
    window.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

export async function dragBlockFromEditorWithMouse({
  page,
  sourceBlock,
  sourceEditor,
  target,
  targetYRatio = 0.7,
  expectedFeedback,
  onFeedback,
  exerciseAncestorScrollLifecycle = false,
}: {
  page: Page;
  sourceBlock: Locator;
  sourceEditor: Locator;
  target: Locator;
  targetYRatio?: number;
  expectedFeedback?: Locator;
  onFeedback?: () => Promise<void>;
  exerciseAncestorScrollLifecycle?: boolean;
}): Promise<void> {
  await sourceBlock.scrollIntoViewIfNeeded();
  const sourceBlockContent = sourceBlock.locator(":scope > .bn-block-content");
  await expect(sourceBlockContent).toBeVisible();
  await sourceBlockContent.hover();

  // A parent Block's outer box includes its children, so hover its direct
  // content to reveal the correct dynamic handle. Keep that same connected node
  // stable for two frames before pressing it; a remount aborts native DnD.
  const dragHandle = sourceEditor.locator(
    '.bn-side-menu button.nfm-side-menu-drag-handle[draggable="true"]:visible',
  );
  await expect(dragHandle).toHaveCount(1);
  await expect(dragHandle).toBeVisible();
  const handleCenter = await dragHandle.evaluate(async (handle) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    if (!handle.isConnected) {
      throw new Error("Block drag handle remounted before mouse down");
    }
    const box = handle.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      throw new Error("Block drag handle has no layout box");
    }
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  });

  await page.mouse.move(handleCenter.x, handleCenter.y);
  await page.mouse.down();
  let mouseReleased = false;
  const pressedHandle = exerciseAncestorScrollLifecycle ? await dragHandle.elementHandle() : null;
  if (exerciseAncestorScrollLifecycle && !pressedHandle) {
    throw new Error("Pressed block drag handle is missing");
  }
  try {
    if (pressedHandle) {
      await dispatchEditorAncestorScroll({ page, sourceEditor });
      expect(await pressedHandle.evaluate((handle) => handle.isConnected)).toBe(true);
    }

    // This first segment crosses both Nodex's click tolerance and Chromium's
    // native drag activation threshold before the long trip to the target.
    await page.mouse.move(handleCenter.x + 12, handleCenter.y, { steps: 4 });

    // Chromium can emit pointercancel once native DnD takes pointer ownership.
    // Scrolling after activation proves that handoff does not release the
    // gesture lease and remount the pressed handle mid-drag.
    if (pressedHandle) {
      await dispatchEditorAncestorScroll({ page, sourceEditor });
      expect(await pressedHandle.evaluate((handle) => handle.isConnected)).toBe(true);
    }

    const targetBox = await target.boundingBox();
    if (!targetBox) throw new Error("Block transfer target has no layout box");
    const dropPoint = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + Math.min(targetBox.height - 4, Math.max(4, targetBox.height * targetYRatio)),
    };
    await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 30 });

    // The first target move may emit only dragenter. Two tiny in-target moves
    // reliably produce the accepted dragover required for an HTML5 drop.
    await page.mouse.move(dropPoint.x + 1, dropPoint.y + 1);
    await page.mouse.move(dropPoint.x + 2, dropPoint.y + 2);
    if (expectedFeedback) await expect(expectedFeedback).toBeVisible();
    await onFeedback?.();
    await page.mouse.up();
    mouseReleased = true;
  } finally {
    // Deliberately do not retry: a failed gesture may already have committed.
    if (!mouseReleased) await page.mouse.up().catch(() => undefined);
  }
}
