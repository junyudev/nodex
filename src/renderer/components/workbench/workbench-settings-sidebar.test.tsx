import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { render, settleAsyncRender } from "@/test/dom";
import type { SettingsSectionId } from "./workbench-settings-sections";
import { SETTINGS_SECTIONS } from "./workbench-settings-sections";
import { SettingsSidebar } from "./workbench-settings-sidebar";

function renderSidebar({
  onSelectSection,
}: {
  onSelectSection?: (sectionId: SettingsSectionId, searchQuery?: string) => void;
} = {}) {
  let selectedSectionId: SettingsSectionId | null = null;
  const view = render(
    <SettingsSidebar
      activeSectionId="general-settings"
      sections={SETTINGS_SECTIONS}
      searchContext={{
        activeProjectName: "Nodex",
        projectNames: ["Nodex", "Docs"],
      }}
      onBack={() => {}}
      onSelectSection={(sectionId, searchQuery) => {
        selectedSectionId = sectionId;
        onSelectSection?.(sectionId, searchQuery);
      }}
    />,
  );

  return {
    ...view,
    selectedSectionId: () => selectedSectionId,
  };
}

async function changeSearchQuery(input: HTMLInputElement, value: string) {
  await act(async () => {
    fireEvent.input(input, { target: { value } });
    await Promise.resolve();
  });
}

async function pressSearchKey(input: HTMLInputElement, key: string) {
  await act(async () => {
    fireEvent.keyDown(input, { key });
    await Promise.resolve();
  });
}

describe("SettingsSidebar search", () => {
  test("exposes canonical section links and a keyboard-native back action", () => {
    const view = renderSidebar();

    const generalLink = view.getByRole("link", { name: "General" });
    expect(generalLink.getAttribute("href")).toBe("/settings/general-settings");
    expect(generalLink.getAttribute("aria-current")).toBe("page");
    expect(generalLink.getAttribute("data-nodex-internal-route")).toBe("settings");
    expect(view.getByRole("button", { name: "Back to app" })).not.toBe(null);
  });

  test("clicking a section link delegates to the in-app route handler", () => {
    const view = renderSidebar();
    const link = view.getByRole("link", { name: "Appearance" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    act(() => {
      link.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(view.selectedSectionId()).toBe("appearance");
  });

  test("renders the settings searchbox", () => {
    const view = renderSidebar();

    const input = view.getByRole("searchbox", { name: "Search settings" });
    expect(input.getAttribute("placeholder")).toBe("Search settings…");
  });

  test("clear button appears only for non-empty query and clears it", async () => {
    const view = renderSidebar();
    const input = view.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;

    expect(view.queryByLabelText("Clear settings search")).toBe(null);

    await changeSearchQuery(input, "key");

    const clearButton = view.queryByLabelText("Clear settings search");
    expect(clearButton === null).toBe(false);
    fireEvent.click(clearButton as Element);

    expect(input.value).toBe("");
    expect(view.queryByLabelText("Clear settings search")).toBe(null);
  });

  test("Cmd/Ctrl+F focuses and selects the search field", async () => {
    const view = renderSidebar();
    const input = view.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;
    let selectCalls = 0;

    input.select = () => {
      selectCalls += 1;
    };
    input.blur();

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(input);
    expect(selectCalls).toBe(1);

    input.blur();

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(input);
    expect(selectCalls).toBe(2);
  });

  test("Escape clears an active query", async () => {
    const view = renderSidebar();
    const input = view.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;

    await changeSearchQuery(input, "key");
    await pressSearchKey(input, "Escape");

    expect(input.value).toBe("");
  });

  test("ArrowDown and ArrowUp highlight rows and scroll highlighted row into view", async () => {
    const elementPrototype = HTMLElement.prototype as unknown as {
      scrollIntoView?: (options?: unknown) => void;
    };
    const originalScrollIntoView = elementPrototype.scrollIntoView;
    const scrollOptions: unknown[] = [];

    elementPrototype.scrollIntoView = function scrollIntoViewMock(options?: unknown) {
      scrollOptions.push(options);
    };

    try {
      const view = renderSidebar();
      const input = view.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;

      await changeSearchQuery(input, "default");
      await pressSearchKey(input, "ArrowDown");

      const resultRows = view.container.querySelectorAll('[data-list-navigation-item="true"]');
      const firstRow = resultRows.item(0);
      expect(firstRow instanceof HTMLElement).toBe(true);
      expect((firstRow as HTMLElement).className.includes("bg-token-list-hover-background")).toBe(
        true,
      );
      expect(JSON.stringify(scrollOptions[0])).toBe(JSON.stringify({ block: "nearest" }));

      await pressSearchKey(input, "ArrowUp");

      const lastRow = resultRows.item(resultRows.length - 1);
      expect(lastRow instanceof HTMLElement).toBe(true);
      expect((lastRow as HTMLElement).className.includes("bg-token-list-hover-background")).toBe(
        true,
      );
      expect(scrollOptions.length).toBe(2);
    } finally {
      if (originalScrollIntoView) {
        elementPrototype.scrollIntoView = originalScrollIntoView;
      } else {
        delete elementPrototype.scrollIntoView;
      }
    }
  });

  test("Enter selects only a highlighted result", async () => {
    const view = renderSidebar();
    const input = view.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;

    await changeSearchQuery(input, "keyboard shortcuts");
    await pressSearchKey(input, "Enter");

    expect(view.selectedSectionId()).toBe(null);

    await pressSearchKey(input, "ArrowDown");
    await pressSearchKey(input, "Enter");

    expect(view.selectedSectionId()).toBe("keyboard-shortcuts");
  });

  test("click selection routes to the matching path and keeps the query", async () => {
    const view = renderSidebar();
    const input = view.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;

    await changeSearchQuery(input, "keyboard shortcuts");
    fireEvent.click(view.getByRole("button", { name: "Keyboard shortcuts, Keyboard shortcuts" }));
    await settleAsyncRender();

    expect(view.selectedSectionId()).toBe("keyboard-shortcuts");
    expect(input.value).toBe("keyboard shortcuts");
  });

  test("forwards the active query for pointer and keyboard search navigation", async () => {
    const selections: { sectionId: SettingsSectionId; query?: string }[] = [];
    const view = renderSidebar({
      onSelectSection: (sectionId, query) => selections.push({ sectionId, query }),
    });
    const input = view.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;
    await changeSearchQuery(input, "Code font size");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Code font size, Appearance" }));
      await Promise.resolve();
    });
    expect(selections.at(-1)).toEqual({ sectionId: "appearance", query: "Code font size" });

    await changeSearchQuery(input, "UI font size");
    await pressSearchKey(input, "ArrowDown");
    await pressSearchKey(input, "Enter");
    expect(selections.at(-1)).toEqual({ sectionId: "appearance", query: "UI font size" });

    await changeSearchQuery(input, "");
    await act(async () => {
      fireEvent.click(view.getByRole("link", { name: "Appearance" }));
      await Promise.resolve();
    });
    expect(selections.at(-1)).toEqual({ sectionId: "appearance", query: undefined });
  });

  test("no-results state renders when the query has no matches", async () => {
    const view = renderSidebar();
    const input = view.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;

    await changeSearchQuery(input, "zzzzzz-unknown");

    expect(view.getByText("No results found").textContent).toBe("No results found");
  });
});
