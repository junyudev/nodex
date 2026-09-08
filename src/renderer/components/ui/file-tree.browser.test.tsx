import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { FileTree, type FileTreeState } from "./file-tree";
import { applyCodexThemeVariant } from "@/lib/codex-theme-variant";
import "../../globals.css";

const settle = async () => {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
};
function getTreeRoot(container: HTMLElement): ShadowRoot {
  const root = container.querySelector("file-tree-container")?.shadowRoot;
  if (!root) throw new Error("Expected a mounted file tree");
  return root;
}
function getRow(container: HTMLElement, path: string): HTMLElement {
  const row = getTreeRoot(container).querySelector<HTMLElement>(
    `[role="treeitem"][data-item-path="${path}"]`,
  );
  if (!row) throw new Error(`Missing file tree row: ${path}`);
  return row;
}

describe("shared file tree navigation", () => {
  test("preserves folder focus through controlled expansion and opens files from the keyboard", async () => {
    const selections: string[][] = [];
    function Harness() {
      const [state, setState] = useState<FileTreeState>({
        expandedPaths: ["src"],
        selectedPath: null,
        scrollTop: 0,
      });
      return (
        <div style={{ height: 200, width: 280 }}>
          <FileTree
            ariaLabel="Files"
            appearance="workspace"
            paths={["src/one.ts", "src/two.ts"]}
            expandedPaths={state.expandedPaths}
            selectedPath={state.selectedPath}
            onStateChange={setState}
            onSelectionChange={(selection) => selections.push([...selection])}
          />
        </div>
      );
    }
    const view = render(<Harness />);
    await act(settle);
    await act(async () => userEvent.click(getRow(view.container, "src/")));
    await act(settle);
    expect(getRow(view.container, "src/").getAttribute("aria-expanded")).toBe("false");
    expect(getTreeRoot(view.container).activeElement).toBe(getRow(view.container, "src/"));
    await act(async () => userEvent.keyboard("{ArrowRight}{ArrowDown}{Enter}"));
    await act(settle);
    expect(getRow(view.container, "src/one.ts").getAttribute("aria-selected")).toBe("true");
    expect(selections.at(-1)).toEqual(["src/one.ts"]);
  });

  test("bounds mounted rows and reveals the requested file in a large tree", async () => {
    const paths = Array.from(
      { length: 2_000 },
      (_, index) => `src/file-${String(index).padStart(4, "0")}.ts`,
    );
    const renderTree = (selectedPath: string | null) => (
      <div style={{ width: 280, height: 240 }}>
        <FileTree
          ariaLabel="Review files"
          appearance="review"
          paths={paths}
          expandedPaths={["src"]}
          selectedPath={selectedPath}
          revealSelectedPath
        />
      </div>
    );
    const view = render(renderTree(null));
    await act(settle);
    expect(getTreeRoot(view.container).querySelectorAll('[role="treeitem"]').length).toBeLessThan(
      40,
    );
    view.rerender(renderTree(paths.at(-1)!));
    await act(settle);
    await waitFor(() =>
      expect(getRow(view.container, paths.at(-1)!).getAttribute("aria-selected")).toBe("true"),
    );
    const scroll = getTreeRoot(view.container).querySelector<HTMLElement>(
      '[data-file-tree-virtualized-scroll="true"]',
    )!;
    expect(scroll.scrollTop).toBeGreaterThan(50_000);
    const selected = getRow(view.container, paths.at(-1)!);
    expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scroll.getBoundingClientRect().bottom + 1,
    );
  });

  test("keeps manual scroll after state persistence and restores it when remounted", async () => {
    const paths = Array.from({ length: 150 }, (_, index) => `file-${index}.ts`);
    let saved = 0;
    const tree = (initialScrollTop: number) => (
      <div style={{ width: 280, height: 200 }}>
        <FileTree
          ariaLabel="Files"
          appearance="workspace"
          paths={paths}
          expandedPaths={[]}
          selectedPath={null}
          initialScrollTop={initialScrollTop}
          onStateChange={(state) => {
            saved = state.scrollTop;
          }}
        />
      </div>
    );
    const view = render(tree(0));
    await act(settle);
    const scroll = getTreeRoot(view.container).querySelector<HTMLElement>(
      '[data-file-tree-virtualized-scroll="true"]',
    )!;
    await act(async () => {
      scroll.scrollTop = 420;
      fireEvent.scroll(scroll);
      await settle();
    });
    expect(saved).toBe(420);
    view.unmount();
    const remounted = render(tree(saved));
    await act(settle);
    expect(
      getTreeRoot(remounted.container).querySelector<HTMLElement>(
        '[data-file-tree-virtualized-scroll="true"]',
      )!.scrollTop,
    ).toBe(420);
  });

  test("resolves change colors in the shadow tree for both runtime themes", async () => {
    const view = render(
      <div style={{ width: 280, height: 200 }}>
        <FileTree
          ariaLabel="Review files"
          appearance="review"
          paths={["file.ts"]}
          expandedPaths={[]}
          selectedPath={null}
          gitStatus={[{ path: "file.ts", status: "modified" }]}
        />
      </div>,
    );
    await act(settle);
    for (const theme of ["light", "dark"] as const) {
      applyCodexThemeVariant(document.documentElement, theme);
      const marker = getRow(view.container, "file.ts").querySelector(
        '[data-item-section="git"] > span',
      )!;
      expect(getComputedStyle(marker).color).toBe(
        theme === "light" ? "rgb(146, 59, 15)" : "rgb(255, 133, 73)",
      );
      expect(getComputedStyle(marker, "::before").maskImage).not.toBe("none");
    }
    document.documentElement.removeAttribute("style");
  });
});
