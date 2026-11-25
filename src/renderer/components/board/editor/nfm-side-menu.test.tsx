import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
import { useMemo, useState, type ReactNode } from "react";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import type { BoardSummary, DatabasePageSummary, Project } from "@/lib/types";
import { plainTextToPortableRichText } from "../../../../shared/block-documents/portable-rich-text";
import { NfmMoveToMenuSurface } from "./nfm-move-to-menu";
import type { NfmMoveToDestination } from "./nfm-move-to-menu-model";
import {
  buildNfmSideMenuSections,
  filterNfmSideMenuSections,
  flattenNfmSideMenuRows,
  type NfmSideMenuSubmenuKey,
} from "./nfm-side-menu-model";
import {
  NfmSideMenuSurface,
  resolveNfmSideMenuReturnFocusElement,
  shouldConsumeNfmSideMenuOutsidePointerTarget,
  shouldKeepNfmSideMenuFormattingToolbarSuppression,
  shouldReturnFocusAfterNfmSideMenuClose,
} from "./nfm-side-menu";

vi.mock("@/lib/interactive-page-search", () => ({
  useInteractivePageSearch: ({ query }: { readonly query: string }) => ({
    rows:
      query === "targt car"
        ? [
            {
              projectId: "default",
              pageId: "target-card",
              pageKey: null,
              title: "Target card",
              status: "triage",
              priority: null,
              tags: [],
              assignee: null,
              locationLabel: "Default / Triage",
              titleParts: [],
              excerpt: null,
              excerptParts: [],
              matches: [],
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ]
        : [],
    enrichment: "loading",
    queryRevision: query,
  }),
}));

const TEST_DATE = new Date("2026-01-01T00:00:00.000Z");

function renderWithQuery(children: ReactNode) {
  return render(<TestQueryProvider>{children}</TestQueryProvider>);
}

function makeProject(id: string, name: string, icon?: string): Project {
  return {
    id,
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name,
    description: "",
    appearance: icon
      ? { color: "black", marker: { kind: "emoji", emoji: icon } }
      : { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: TEST_DATE,
    updated: TEST_DATE,
  };
}

function makeCard(
  id: string,
  title: string,
  status: DatabasePageSummary["status"],
  order: number,
): DatabasePageSummary {
  return {
    id,
    pageKey: null,
    status,
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    tags: [],
    created: TEST_DATE,
    order,
    revision: 1,
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
  };
}

const MOVE_TO_PROJECTS = [
  makeProject("default", "Default", "🔥"),
  makeProject("renderer", "Renderer parity", "🧭"),
];

const MOVE_TO_BOARD_MAP = new Map<string, BoardSummary>([
  [
    "default",
    {
      columns: [
        {
          id: "triage",
          name: "Triage",
          cards: [
            makeCard("source-card", "Source card", "triage", 0),
            makeCard("target-card", "Target card", "triage", 1),
          ],
        },
      ],
    },
  ],
  [
    "renderer",
    {
      columns: [
        {
          id: "plan",
          name: "Plan",
          cards: [makeCard("runtime", "Runtime polish", "plan", 0)],
        },
      ],
    },
  ],
]);

function renderSideMenuSurface({
  initialQuery = "",
  initialFocusedIndex = -1,
  selectionTitle = "Text",
  selectedTopLevelBlockCount = 1,
  footerPrimary = "Last edited locally",
  footerSecondary = "Now",
}: {
  initialQuery?: string;
  initialFocusedIndex?: number;
  selectionTitle?: string;
  selectedTopLevelBlockCount?: number;
  footerPrimary?: string | null;
  footerSecondary?: string | null;
} = {}) {
  const calls = {
    rows: [] as string[],
    queries: [] as string[],
    clipboardCommands: [] as Array<"copy" | "cut">,
    close: 0,
  };
  let query = initialQuery;
  let focusedIndex = initialFocusedIndex;
  let activeSubmenu: NfmSideMenuSubmenuKey | null = null;
  const baseSections = buildNfmSideMenuSections({
    currentBlockId: "block-1",
    currentBlockType: "paragraph",
    selectionTitle,
    selectedTopLevelBlockCount,
    isEditable: true,
    canUseColor: true,
    canSendBlocks: true,
    isTableBlock: false,
    canUseTableHeaders: false,
  });

  const renderSurface = () => {
    const sections = filterNfmSideMenuSections(baseSections, query);
    const flatRows = flattenNfmSideMenuRows(sections);
    return (
      <NfmSideMenuSurface
        sections={sections}
        query={query}
        focusedIndex={focusedIndex}
        activeSubmenu={activeSubmenu}
        listboxId="side-menu-listbox"
        comboboxId="side-menu-combobox"
        activeDescendantId={
          focusedIndex >= 0 ? `side-menu-listbox-option-${focusedIndex}` : undefined
        }
        turnIntoItems={[{ key: "paragraph", label: "Text", type: "paragraph", enabled: true }]}
        colorOptions={[
          { color: "default", label: "Default" },
          { color: "blue", label: "Blue" },
        ]}
        canUseTextColor={true}
        canUseBackgroundColor={true}
        canSendBlocks={true}
        sourceProjectId="default"
        sourcePageId="source-card"
        textColor="default"
        backgroundColor="default"
        codeLanguageId="typescript"
        footerPrimary={footerPrimary}
        footerSecondary={footerSecondary}
        onQueryChange={(nextQuery) => {
          calls.queries.push(nextQuery);
          query = nextQuery;
          focusedIndex = nextQuery ? 0 : -1;
        }}
        onFocusIndexChange={(nextFocusedIndex) => {
          focusedIndex = nextFocusedIndex;
        }}
        onMoveFocus={(direction) => {
          focusedIndex = direction > 0 ? 0 : flatRows.length - 1;
        }}
        onActivateFocused={() => {
          const row = flatRows[focusedIndex]?.row;
          if (!row || !row.enabled) return;
          calls.rows.push(row.key);
        }}
        onClose={() => {
          calls.close += 1;
        }}
        onAction={(row) => {
          calls.rows.push(row.key);
        }}
        onSubmenuChange={(submenu) => {
          activeSubmenu = submenu;
        }}
        onTurnInto={() => undefined}
        onColor={() => undefined}
        onCodeLanguageChange={() => undefined}
        onClipboardCommand={(command) => {
          calls.clipboardCommands.push(command);
          return true;
        }}
        onMoveBlocksToDestination={() => undefined}
      />
    );
  };

  const view = renderWithQuery(renderSurface());
  return { calls, view };
}

const ignoreBlockMove = (): void => undefined;

function StatefulSideMenuSurface({
  onMoveBlocksToDestination = ignoreBlockMove,
  moveToLoading = false,
  moveToError = null,
}: {
  onMoveBlocksToDestination?: (destination: NfmMoveToDestination) => Promise<void> | void;
  moveToLoading?: boolean;
  moveToError?: string | null;
} = {}) {
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [activeSubmenu, setActiveSubmenu] = useState<NfmSideMenuSubmenuKey | null>(null);
  const baseSections = useMemo(
    () =>
      buildNfmSideMenuSections({
        currentBlockId: "block-1",
        currentBlockType: "paragraph",
        selectionTitle: "Text",
        selectedTopLevelBlockCount: 1,
        isEditable: true,
        canUseColor: true,
        canSendBlocks: true,
        isTableBlock: false,
        canUseTableHeaders: false,
      }),
    [],
  );
  const sections = useMemo(
    () => filterNfmSideMenuSections(baseSections, query),
    [baseSections, query],
  );
  const flatRows = useMemo(() => flattenNfmSideMenuRows(sections), [sections]);

  return (
    <NfmSideMenuSurface
      sections={sections}
      query={query}
      focusedIndex={focusedIndex}
      activeSubmenu={activeSubmenu}
      listboxId="stateful-side-menu-listbox"
      comboboxId="stateful-side-menu-combobox"
      activeDescendantId={
        focusedIndex >= 0 ? `stateful-side-menu-listbox-option-${focusedIndex}` : undefined
      }
      turnIntoItems={[{ key: "paragraph", label: "Text", type: "paragraph", enabled: true }]}
      colorOptions={[
        { color: "default", label: "Default" },
        { color: "blue", label: "Blue" },
      ]}
      canUseTextColor={true}
      canUseBackgroundColor={true}
      canSendBlocks={true}
      sourceProjectId="default"
      sourcePageId="source-card"
      textColor="default"
      backgroundColor="default"
      codeLanguageId="typescript"
      footerPrimary="Last edited locally"
      footerSecondary="Now"
      onQueryChange={(nextQuery) => {
        setQuery(nextQuery);
        setFocusedIndex(nextQuery ? 0 : -1);
      }}
      onFocusIndexChange={setFocusedIndex}
      onMoveFocus={(direction) => {
        setFocusedIndex((currentIndex) => {
          if (direction > 0)
            return currentIndex < 0 ? 0 : Math.min(currentIndex + 1, flatRows.length - 1);
          return currentIndex <= 0 ? flatRows.length - 1 : currentIndex - 1;
        });
      }}
      onActivateFocused={() => {
        const row = flatRows[focusedIndex]?.row;
        if (row?.submenu) setActiveSubmenu(row.submenu);
      }}
      onClose={() => undefined}
      onAction={(row) => {
        if (row.submenu) setActiveSubmenu(row.submenu);
      }}
      onSubmenuChange={setActiveSubmenu}
      onTurnInto={() => undefined}
      onColor={() => undefined}
      onCodeLanguageChange={() => undefined}
      onMoveBlocksToDestination={onMoveBlocksToDestination}
      renderMoveToMenu={(props) => (
        <NfmMoveToMenuSurface
          {...props}
          projects={MOVE_TO_PROJECTS}
          pageBoardMap={MOVE_TO_BOARD_MAP}
          loading={moveToLoading}
          loadError={moveToError}
          enableRemotePageSearch
        />
      )}
    />
  );
}

describe("markdown side menu surface", () => {
  test("consumes same-editor outside pointer dismissals while returning focus to the editor", () => {
    const returnFocusElement = document.createElement("div");
    const editorRoot = document.createElement("div");
    const editorBlank = document.createElement("div");
    const outsideElement = document.createElement("button");
    editorRoot.append(editorBlank);

    expect(
      shouldReturnFocusAfterNfmSideMenuClose({
        reason: "outside-pointer",
        returnFocusElement,
      }),
    ).toBe(false);
    expect(
      shouldReturnFocusAfterNfmSideMenuClose({
        reason: "editor-outside-pointer",
        returnFocusElement,
      }),
    ).toBe(true);
    expect(
      shouldReturnFocusAfterNfmSideMenuClose({
        reason: "escape",
        returnFocusElement,
      }),
    ).toBe(true);
    expect(
      shouldReturnFocusAfterNfmSideMenuClose({
        reason: "clipboard-command",
        returnFocusElement,
      }),
    ).toBe(true);
    expect(
      shouldReturnFocusAfterNfmSideMenuClose({
        reason: "action",
        returnFocusElement,
      }),
    ).toBe(true);
    expect(
      resolveNfmSideMenuReturnFocusElement({
        reason: "editor-outside-pointer",
        returnFocusElement,
        editorRoot,
      }),
    ).toBe(editorRoot);
    expect(
      resolveNfmSideMenuReturnFocusElement({
        reason: "clipboard-command",
        returnFocusElement,
        editorRoot,
      }),
    ).toBe(editorRoot);
    expect(
      resolveNfmSideMenuReturnFocusElement({
        reason: "escape",
        returnFocusElement,
        editorRoot,
      }),
    ).toBe(returnFocusElement);
    expect(
      shouldConsumeNfmSideMenuOutsidePointerTarget({
        target: editorBlank,
        editorRoot,
      }),
    ).toBe(true);
    expect(
      shouldConsumeNfmSideMenuOutsidePointerTarget({
        target: outsideElement,
        editorRoot,
      }),
    ).toBe(false);
    expect(
      shouldConsumeNfmSideMenuOutsidePointerTarget({
        target: editorBlank,
        editorRoot: null,
      }),
    ).toBe(false);
  });

  test("keeps dismissed toolbar suppression only while the current selection range matches", () => {
    expect(
      shouldKeepNfmSideMenuFormattingToolbarSuppression({
        selectionRange: { from: 4, to: 10 },
        suppressionRange: { from: 4, to: 10 },
      }),
    ).toBe(true);
    expect(
      shouldKeepNfmSideMenuFormattingToolbarSuppression({
        selectionRange: { from: 4, to: 11 },
        suppressionRange: { from: 4, to: 10 },
      }),
    ).toBe(false);
    expect(
      shouldKeepNfmSideMenuFormattingToolbarSuppression({
        selectionRange: { from: 4, to: 10 },
        suppressionRange: null,
      }),
    ).toBe(false);
  });

  test("delegates Copy and Cut from Search actions without claiming Paste", () => {
    const { calls, view } = renderSideMenuSurface();
    const searchInput = view.getByRole("combobox");
    const clipboardData = {
      getData: vi.fn(() => ""),
      setData: vi.fn(),
    };

    expect(fireEvent.copy(searchInput, { clipboardData })).toBe(false);
    expect(fireEvent.cut(searchInput, { clipboardData })).toBe(false);
    expect(fireEvent.paste(searchInput, { clipboardData })).toBe(true);
    expect(calls.clipboardCommands).toEqual(["copy", "cut"]);
  });

  test("opens a DB-only Page in picker from Turn into", async () => {
    const calls = {
      destinations: [] as NfmMoveToDestination[],
    };
    const originalConsoleError = console.error;
    const consoleErrors: string[] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    try {
      const view = renderWithQuery(
        <StatefulSideMenuSurface
          onMoveBlocksToDestination={(destination) => {
            calls.destinations.push(destination);
          }}
        />,
      );

      fireEvent.click(view.getByRole("option", { name: /Turn into/ }));
      await view.findByRole("dialog", { name: "Turn into" });
      fireEvent.pointerEnter(view.getByRole("menuitem", { name: "Page in" }));

      const pageInDialog = await view.findByRole("dialog", { name: "Page in" });
      expect(pageInDialog.getAttribute("data-nfm-side-menu-submenu")).toBe("true");
      expect(view.getByRole("combobox", { name: "Page in destination" })).not.toBeNull();
      expect(view.getByPlaceholderText("Page in…")).not.toBeNull();
      expect(view.getByText("DB")).not.toBeNull();
      expect(view.queryByText("Page")).toBe(null);
      expect(view.queryByText("Target card")).toBe(null);

      const rendererDbRow = view
        .getAllByRole("option", { name: /Renderer parity/ })
        .find((row) => row.getAttribute("data-nfm-move-to-row-kind") === "db");
      if (!rendererDbRow) throw new Error("Renderer DB row not found.");

      fireEvent.click(rendererDbRow);
      expect(calls.destinations.length).toBe(0);

      const backlogColumnRow = view
        .getAllByRole("option", { name: "Plan" })
        .find((row) => row.getAttribute("data-nfm-move-to-project-id") === "renderer");
      if (!backlogColumnRow) throw new Error("Plan column row not found.");

      fireEvent.click(backlogColumnRow);

      await waitFor(() => {
        expect(calls.destinations[0]).toEqual({
          kind: "db-column",
          projectId: "renderer",
          columnId: "plan",
        });
      });
      expect(consoleErrors.length).toBe(0);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("shows the exact async move failure and exposes it as an alert", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = renderWithQuery(
        <NfmMoveToMenuSurface
          projects={MOVE_TO_PROJECTS}
          pageBoardMap={MOVE_TO_BOARD_MAP}
          sourceProjectId="default"
          sourcePageId="source-card"
          loading={false}
          loadError={null}
          onAccept={async () => {
            throw new Error("The destination Page changed. Try again.");
          }}
          onClose={() => undefined}
        />,
      );

      fireEvent.click(view.getByRole("option", { name: /Target card/ }));

      await waitFor(() => {
        expect(view.getByRole("alert").textContent).toBe(
          "The destination Page changed. Try again.",
        );
      });
      expect(log).toHaveBeenCalledWith(
        "[nfm-move-to:accept]",
        expect.objectContaining({
          destination: expect.objectContaining({ kind: "page" }),
          error: expect.any(Error),
        }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
