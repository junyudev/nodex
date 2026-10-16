import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A point on the row's own surface past its title, where a pointer user grabs or clicks a row.
 * The depth gutter at the List's leading edge can sit under the sidebar's resize edge.
 */
export async function listRowSurfacePoint(row: Locator): Promise<{ x: number; y: number }> {
  const titleBox = await row.locator('[data-list-grid-column="title"]').boundingBox();
  if (!titleBox) throw new Error("List row title cell has no layout box");
  const point = { x: titleBox.x + titleBox.width * 0.75, y: titleBox.y + titleBox.height / 2 };
  const reachable = await row.evaluate((element, { x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return Boolean(
      hit && element.contains(hit) && !hit.closest("button, a, input, [role=checkbox]"),
    );
  }, point);
  if (!reachable) throw new Error("The List row's surface point is covered or interactive");
  return point;
}

export async function dragListRowWithMouse({
  page,
  sourceRow,
  targetRow,
  position,
  expectedOverlayCount = 1,
}: {
  page: Page;
  sourceRow: Locator;
  targetRow: Locator;
  position: "before" | "after" | "center" | "nest";
  expectedOverlayCount?: number;
}): Promise<void> {
  await sourceRow.scrollIntoViewIfNeeded();
  await sourceRow.hover();
  await expect(sourceRow).toHaveAttribute("draggable", "true");
  const sourcePoint = await listRowSurfacePoint(sourceRow);
  const targetBox = await targetRow.boundingBox();
  if (!targetBox) throw new Error("List target row has no layout box");
  const targetRatio = position === "before" ? 0.14 : position === "after" ? 0.86 : 0.5;
  const targetPoint = {
    x: targetBox.x + Math.min(targetBox.width - 24, Math.max(80, targetBox.width * 0.45)),
    y: targetBox.y + targetBox.height * targetRatio,
  };

  let mouseReleased = false;
  let altPressed = false;
  try {
    if (position === "nest") {
      await page.keyboard.down("Alt");
      altPressed = true;
    }
    await page.mouse.move(sourcePoint.x, sourcePoint.y);
    await page.mouse.down();
    await page.mouse.move(sourcePoint.x + 12, sourcePoint.y, { steps: 4 });
    const overlay = page.locator('[data-database-list-drag-overlay="true"]');
    await expect(overlay).toBeVisible();
    if (expectedOverlayCount > 1) {
      await expect(overlay.getByText(String(expectedOverlayCount), { exact: true })).toBeVisible();
    }
    await expect(sourceRow).toHaveCSS("opacity", "0.7");
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 24 });
    await page.mouse.move(targetPoint.x + 1, targetPoint.y);
    await page.mouse.move(targetPoint.x + 2, targetPoint.y);
    if (position !== "nest") {
      await expect(targetRow).toHaveAttribute(
        "data-drop-position",
        position === "before" ? "before" : "after",
      );
    }
    await page.mouse.up();
    mouseReleased = true;
    await expect(overlay).toBeHidden();
  } finally {
    if (!mouseReleased) await page.mouse.up().catch(() => undefined);
    if (altPressed) await page.keyboard.up("Alt").catch(() => undefined);
  }
}
