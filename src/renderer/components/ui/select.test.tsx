import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("shared select source", () => {
  test("uses the shared selector chrome and popper positioning by default", async () => {
    const chromeSource = await readFile(new URL("./selector-menu-chrome.ts", import.meta.url), "utf8");
    const selectSource = await readFile(new URL("./select.tsx", import.meta.url), "utf8");

    expect(chromeSource.includes("bg-token-dropdown-background/90")).toBeTrue();
    expect(chromeSource.includes("focus-visible:bg-token-list-hover-background")).toBeTrue();
    expect(chromeSource.includes("SELECTOR_MENU_MATCH_TRIGGER_WIDTH_CLASS_NAME")).toBeTrue();
    expect(chromeSource.includes("min-w-(--radix-select-trigger-width)")).toBeTrue();
    expect(chromeSource.includes("min-w-32")).toBeFalse();
    expect(chromeSource.includes("col-start-2 row-start-1")).toBeTrue();
    expect(selectSource.includes('position = "popper"')).toBeTrue();
    expect(selectSource.includes("SELECTOR_MENU_SELECT_CONTENT_CLASS_NAME")).toBeTrue();
    expect(selectSource.includes("SELECTOR_MENU_ITEM_CLASS_NAME")).toBeTrue();
    expect(selectSource.includes("grid-cols-[minmax(0,1fr)_auto]")).toBeTrue();
    expect(selectSource.includes("ItemText asChild")).toBeTrue();
    expect(selectSource.includes("col-start-1 row-start-1 min-w-0 flex-1 truncate text-left")).toBeTrue();
    expect(selectSource.includes('"p-1"')).toBeFalse();
  });

  test("lets real consumers rely on the shared popper default", async () => {
    const sendBlocksDialogSource = await readFile(
      new URL("../kanban/editor/send-blocks-dialog.tsx", import.meta.url),
      "utf8",
    );

    expect(sendBlocksDialogSource.includes('className="h-8 w-full"')).toBeTrue();
    expect(sendBlocksDialogSource.includes('position="popper"')).toBeFalse();
  });
});
