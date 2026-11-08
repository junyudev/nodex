import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { FileTree } from "./file-tree";
import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";
import {
  applyTypographyPreferences,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
} from "@/lib/typography-preferences";
import "../../globals.css";

installRendererThemeFixture();

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
function findRow(container: HTMLElement, path: string): HTMLElement | null {
  return getTreeRoot(container).querySelector<HTMLElement>(
    `[role="treeitem"][data-item-path="${path}"]:not([data-file-tree-sticky-row])`,
  );
}
function getRow(container: HTMLElement, path: string): HTMLElement {
  const row = findRow(container, path);
  if (!row) throw new Error(`Missing file tree row: ${path}`);
  return row;
}

/** Folder listings that arrive a moment after the folder expands, as workspace reads do. */
const LISTINGS: Record<string, readonly string[]> = {
  "": ["outer/", "readme.md"],
  outer: ["outer/inner/", "outer/x.ts"],
  "outer/inner": ["outer/inner/y.ts"],
};
function LazyTree({
  sorted,
  onExpanded,
}: {
  sorted: boolean;
  onExpanded?: (paths: readonly string[]) => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<readonly string[]>([]);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set([""]));
  const pending = expandedPaths.filter((path) => !loaded.has(path));
  useEffect(() => {
    if (pending.length === 0) return;
    const timer = setTimeout(() => setLoaded((current) => new Set([...current, ...pending])), 150);
    return () => clearTimeout(timer);
  }, [pending]);
  return (
    <div style={{ height: 240, width: 280 }}>
      <FileTree
        ariaLabel="Files"
        appearance="workspace"
        paths={["", ...expandedPaths]
          .filter((path) => loaded.has(path))
          .flatMap((path) => LISTINGS[path] ?? [])}
        expandedPaths={expandedPaths}
        loadingDirectoryPaths={pending}
        selectedPath={null}
        {...(sorted ? { sort: () => 0 } : {})}
        onExpandedPathsChange={(paths) => {
          onExpanded?.(paths);
          setExpandedPaths(paths);
        }}
      />
    </div>
  );
}
const loadSettled = async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await settle();
};

describe("shared file tree navigation", () => {
  test("updates shadow-root filename typography with UI preferences without remounting rows", async () => {
    const preferences = {
      ...DEFAULT_TYPOGRAPHY_PREFERENCES,
      fonts: {
        ...DEFAULT_TYPOGRAPHY_PREFERENCES.fonts,
        light: { ui: "Arial", content: "Georgia", code: "monospace" },
      },
    };
    applyTypographyPreferences(document.documentElement, document.body, preferences, "light");
    const view = render(
      <div style={{ height: 200, width: 280 }}>
        <FileTree
          ariaLabel="Files"
          appearance="workspace"
          paths={["one.ts"]}
          expandedPaths={[]}
          selectedPath={null}
        />
      </div>,
    );
    try {
      await act(settle);
      const row = getRow(view.container, "one.ts");
      expect(getComputedStyle(row).fontSize).toBe("13px");
      expect(getComputedStyle(row).fontFamily).toContain("Arial");
      await act(async () => {
        applyTypographyPreferences(
          document.documentElement,
          document.body,
          { ...preferences, uiFontSize: 16 },
          "light",
        );
        await settle();
      });
      expect(getComputedStyle(row).fontSize).toBe("15px");
      expect(getRow(view.container, "one.ts")).toBe(row);
    } finally {
      view.unmount();
      document.body.removeAttribute("style");
    }
  });

  test("preserves folder focus through controlled expansion and opens files from the keyboard", async () => {
    const selections: string[][] = [];
    function Harness() {
      const [expandedPaths, setExpandedPaths] = useState<readonly string[]>(["src"]);
      return (
        <div style={{ height: 200, width: 280 }}>
          <FileTree
            ariaLabel="Files"
            appearance="workspace"
            paths={["src/one.ts", "src/two.ts"]}
            expandedPaths={expandedPaths}
            selectedPath={null}
            onExpandedPathsChange={setExpandedPaths}
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

  for (const sorted of [false, true])
    test(`collapses a folder that contains an expanded folder${sorted ? " with sorted sections" : ""}`, async () => {
      const reported: (readonly string[])[] = [];
      const view = render(
        <LazyTree sorted={sorted} onExpanded={(paths) => reported.push(paths)} />,
      );
      await act(settle);
      await act(async () => userEvent.click(getRow(view.container, "outer/")));
      await act(loadSettled);
      await act(async () => userEvent.click(getRow(view.container, "outer/inner/")));
      await act(loadSettled);
      expect(getRow(view.container, "outer/inner/y.ts")).toBeDefined();

      await act(async () => userEvent.click(getRow(view.container, "outer/")));
      await act(loadSettled);
      expect(getRow(view.container, "outer/").getAttribute("aria-expanded")).toBe("false");
      expect(findRow(view.container, "outer/inner/")).toBeNull();
      // The child keeps its own expansion, and comes back open with its parent.
      expect(reported.at(-1)).toEqual(["outer/inner"]);
      await act(async () => userEvent.click(getRow(view.container, "outer/")));
      await act(loadSettled);
      expect(getRow(view.container, "outer/inner/").getAttribute("aria-expanded")).toBe("true");
      expect(getRow(view.container, "outer/inner/y.ts")).toBeDefined();
    });

  test("shows an inert placeholder row while an expanded folder loads", async () => {
    const view = render(<LazyTree sorted={false} />);
    await act(settle);
    await act(async () => userEvent.click(getRow(view.container, "outer/")));
    await act(settle);
    const placeholder = getRow(view.container, "outer/.nodex-loading");
    expect(placeholder.hasAttribute("data-file-tree-loading")).toBe(true);
    expect(placeholder.getAttribute("aria-label")).toBe("Loading directory entries…");
    expect(view.getByRole("status").textContent).toBe("Loading directory entries…");
    await act(loadSettled);
    expect(findRow(view.container, "outer/.nodex-loading")).toBeNull();
    expect(getRow(view.container, "outer/x.ts")).toBeDefined();
    expect(view.queryByRole("status")).toBeNull();
  });

  test("describes the keyboard-focused row in full and stops on pointer input", async () => {
    const view = render(
      <div style={{ height: 200, width: 280 }}>
        <FileTree
          ariaLabel="Files"
          appearance="workspace"
          paths={["src/a-file-with-a-long-name.ts"]}
          expandedPaths={["src"]}
          selectedPath={null}
          describePath={(path) => `/workspace/${path}`}
        />
      </div>,
    );
    await act(settle);
    await act(async () => userEvent.click(getRow(view.container, "src/")));
    expect(view.queryByRole("tooltip")).toBeNull();
    await act(async () => userEvent.keyboard("{ArrowRight}{ArrowDown}"));
    await act(settle);
    const row = getRow(view.container, "src/a-file-with-a-long-name.ts");
    expect((await view.findByRole("tooltip")).textContent).toBe(
      "/workspace/src/a-file-with-a-long-name.ts",
    );
    expect(row.getAttribute("aria-description")).toBe("/workspace/src/a-file-with-a-long-name.ts");
    await act(async () => userEvent.click(getRow(view.container, "src/")));
    await waitFor(() => expect(view.queryByRole("tooltip")).toBeNull());
    expect(row.hasAttribute("aria-description")).toBe(false);
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
          onScrollTopChange={(scrollTop) => {
            saved = scrollTop;
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
      applyRendererThemeForTest(theme);
      const marker = getRow(view.container, "file.ts").querySelector(
        '[data-item-section="git"] > span',
      )!;
      expect(getComputedStyle(marker).color).toBe(
        theme === "light" ? "rgb(146, 59, 15)" : "rgb(255, 133, 73)",
      );
      expect(getComputedStyle(marker, "::before").maskImage).not.toBe("none");
    }
  });
});
