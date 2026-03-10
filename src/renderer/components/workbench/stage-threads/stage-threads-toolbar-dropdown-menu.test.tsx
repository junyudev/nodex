import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("stage threads toolbar dropdown menu source", () => {
  test("uses the shared tokenized selector menu surface", async () => {
    const chromeSource = await readFile(new URL("../../ui/selector-menu-chrome.ts", import.meta.url), "utf8");
    const primitivesSource = await readFile(new URL("./selector-popover-primitives.tsx", import.meta.url), "utf8");
    const toolbarSource = await readFile(new URL("./stage-threads-toolbar-dropdown-menu.tsx", import.meta.url), "utf8");

    expect(chromeSource.includes("bg-token-dropdown-background/90")).toBeTrue();
    expect(chromeSource.includes("ring-token-border")).toBeTrue();
    expect(chromeSource.includes("px-[var(--padding-row-x)]")).toBeTrue();
    expect(chromeSource.includes("hover:bg-token-list-hover-background")).toBeTrue();
    expect(primitivesSource.includes("@/components/ui/selector-menu-chrome")).toBeTrue();
    expect(toolbarSource.includes("selectedItemDataAttribute")).toBeTrue();
  });

  test("marks the selected reasoning item for the exact selected state styling", async () => {
    const stageThreadsSource = await readFile(new URL("./stage-threads.tsx", import.meta.url), "utf8");

    expect(stageThreadsSource.includes('selectedItemDataAttribute="data-reasoning-selected"')).toBeTrue();
  });
});
