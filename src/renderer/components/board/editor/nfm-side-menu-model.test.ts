import { describe, expect, test } from "vite-plus/test";
import {
  buildNfmSideMenuSections,
  filterNfmSideMenuSections,
  flattenNfmSideMenuRows,
  getInitialNfmSideMenuFocusIndex,
  getNfmSideMenuSeparatorBeforeKeys,
  moveNfmSideMenuFocus,
  resolveNfmSideMenuScopeTitle,
} from "./nfm-side-menu-model";

function buildDefaultSections(showMockActions = false) {
  return buildNfmSideMenuSections({
    currentBlockId: "block-1",
    currentBlockType: "paragraph",
    selectionTitle: "Text",
    selectedTopLevelBlockCount: 1,
    isEditable: true,
    canUseColor: true,
    canSendBlocks: true,
    isTableBlock: false,
    canUseTableHeaders: false,
    showMockActions,
  });
}

describe("markdown side menu model", () => {
  test("hides reference mock actions from the production action order", () => {
    const sections = buildDefaultSections();
    const rows = flattenNfmSideMenuRows(sections);

    expect(rows.map(({ row }) => row.label).join(",")).toBe(
      "Turn into,Color,Duplicate,Move to,Delete",
    );
    expect(rows.some(({ row }) => row.mockReason !== undefined)).toBe(false);
    expect(rows[3]?.sectionKey).toBe("selection");
    expect(rows[3]?.row.kind).toBe("submenu");
    expect(rows[3]?.row.submenu).toBe("move-to");
  });

  test("prepends the complete single-Code action group without caption support", () => {
    const sections = buildNfmSideMenuSections({
      currentBlockId: "code-1",
      currentBlockType: "codeBlock",
      selectionTitle: "Code",
      selectedTopLevelBlockCount: 1,
      isEditable: true,
      canUseColor: true,
      canSendBlocks: true,
      isTableBlock: false,
      canUseTableHeaders: false,
      showMockActions: false,
      codeBlock: {
        wrapped: true,
        canFormat: true,
        isMermaid: false,
        hasValidDiagram: false,
      },
    });
    const rows = flattenNfmSideMenuRows(sections);

    expect(rows.map(({ row }) => row.label).join(",")).toBe(
      "Copy code,Wrap code,Language,Format code,Turn into,Color,Duplicate,Move to,Delete",
    );
    expect(rows.find(({ row }) => row.key === "wrap-code")?.row.checked).toBe(true);
    expect(rows.find(({ row }) => row.key === "code-language")?.row.submenu).toBe("language");
    expect(rows.some(({ row }) => /caption/iu.test(row.label))).toBe(false);
  });

  test("omits Format code when the current language has no formatter", () => {
    const rows = flattenNfmSideMenuRows(
      buildNfmSideMenuSections({
        currentBlockId: "code-1",
        currentBlockType: "codeBlock",
        selectionTitle: "Code",
        selectedTopLevelBlockCount: 1,
        isEditable: true,
        canUseColor: true,
        canSendBlocks: true,
        isTableBlock: false,
        canUseTableHeaders: false,
        showMockActions: false,
        codeBlock: {
          wrapped: false,
          canFormat: false,
          isMermaid: false,
          hasValidDiagram: false,
        },
      }),
    );

    expect(rows.some(({ row }) => row.key === "format-code")).toBe(false);
  });

  test("keeps diagram actions in the Block menu without duplicating display modes", () => {
    const rows = flattenNfmSideMenuRows(
      buildNfmSideMenuSections({
        currentBlockId: "diagram-1",
        currentBlockType: "codeBlock",
        selectionTitle: "Code",
        selectedTopLevelBlockCount: 1,
        isEditable: true,
        canUseColor: true,
        canSendBlocks: true,
        isTableBlock: false,
        canUseTableHeaders: false,
        showMockActions: false,
        codeBlock: {
          wrapped: false,
          canFormat: false,
          isMermaid: true,
          hasValidDiagram: true,
        },
      }),
    );

    expect(
      rows
        .filter(({ row }) => ["expand-diagram", "download-diagram"].includes(row.key))
        .map(({ row }) => [row.key, row.enabled]),
    ).toEqual([
      ["expand-diagram", true],
      ["download-diagram", true],
    ]);
  });

  test("copies the production action grouping boundaries without copy links", () => {
    const rows = flattenNfmSideMenuRows(buildDefaultSections());
    const separatorKeys = getNfmSideMenuSeparatorBeforeKeys(rows);

    expect(separatorKeys.join(",")).toBe("duplicate");
  });

  test("renames disabled copy-link reference mocks for multi-block selections", () => {
    const sections = buildNfmSideMenuSections({
      currentBlockId: "block-1",
      currentBlockType: "paragraph",
      selectionTitle: "3 blocks",
      selectedTopLevelBlockCount: 3,
      isEditable: true,
      canUseColor: true,
      canSendBlocks: true,
      isTableBlock: false,
      canUseTableHeaders: false,
      showMockActions: true,
    });
    const copyLink = flattenNfmSideMenuRows(sections).find(
      ({ row }) => row.key === "copy-link-to-block",
    )?.row;

    expect(copyLink?.label).toBe("Copy links to all");
    expect(copyLink?.enabled).toBe(false);
    expect(Boolean(copyLink?.mockReason)).toBe(true);
  });

  test("keeps reference mock actions disabled and marked in dev contexts", () => {
    const rows = flattenNfmSideMenuRows(buildDefaultSections(true));
    const copyLink = rows.find(({ row }) => row.key === "copy-link-to-block")?.row;
    const present = rows.find(({ row }) => row.key === "present-from-here")?.row;
    const duplicate = rows.find(({ row }) => row.key === "duplicate")?.row;
    const moveTo = rows.find(({ row }) => row.key === "move-to")?.row;

    expect(copyLink?.enabled).toBe(false);
    expect(Boolean(copyLink?.mockReason)).toBe(true);
    expect(present?.badge).toBe("Beta");
    expect(Boolean(present?.mockReason)).toBe(true);
    expect(duplicate?.enabled).toBe(true);
    expect(duplicate?.mockReason === undefined).toBe(true);
    expect(moveTo?.enabled).toBe(true);
    expect(moveTo?.mockReason === undefined).toBe(true);
  });

  test("keeps Move to visible as a real disabled row when block moves are unavailable", () => {
    const sections = buildNfmSideMenuSections({
      currentBlockId: "block-1",
      currentBlockType: "paragraph",
      selectionTitle: "Text",
      selectedTopLevelBlockCount: 1,
      isEditable: true,
      canUseColor: true,
      canSendBlocks: false,
      isTableBlock: false,
      canUseTableHeaders: false,
      showMockActions: false,
    });
    const rows = flattenNfmSideMenuRows(sections);
    const moveTo = rows.find(({ row }) => row.key === "move-to")?.row;

    expect(moveTo?.key).toBe("move-to");
    expect(moveTo?.enabled).toBe(false);
    expect(moveTo?.mockReason === undefined).toBe(true);
  });

  test("adds table actions for a single table", () => {
    const sections = buildNfmSideMenuSections({
      currentBlockId: "divider-1",
      currentBlockType: "table",
      selectionTitle: "Table",
      selectedTopLevelBlockCount: 1,
      isEditable: true,
      canUseColor: false,
      canSendBlocks: false,
      isTableBlock: true,
      canUseTableHeaders: true,
      showMockActions: false,
    });
    const rows = flattenNfmSideMenuRows(sections);

    expect(rows.length).toBe(7);
    expect(rows[5]?.row.key).toBe("table-header-row");
    expect(rows[6]?.row.key).toBe("table-header-column");
  });

  test("hides Nodex and table special rows for multi-block selections", () => {
    const sections = buildNfmSideMenuSections({
      currentBlockId: "divider-1",
      currentBlockType: "divider",
      selectionTitle: "2 blocks",
      selectedTopLevelBlockCount: 2,
      isEditable: true,
      canUseColor: false,
      canSendBlocks: false,
      isTableBlock: true,
      canUseTableHeaders: true,
      showMockActions: false,
    });
    const rows = flattenNfmSideMenuRows(sections);

    expect(rows.some(({ row }) => row.key === "table-header-row")).toBe(false);
    expect(rows.some(({ row }) => row.key === "table-header-column")).toBe(false);
  });

  test("adds disabled table parity mock rows in mock mode", () => {
    const sections = buildNfmSideMenuSections({
      currentBlockId: "table-1",
      currentBlockType: "table",
      selectionTitle: "Table",
      selectedTopLevelBlockCount: 1,
      isEditable: true,
      canUseColor: true,
      canSendBlocks: true,
      isTableBlock: true,
      canUseTableHeaders: true,
      showMockActions: true,
    });
    const rows = flattenNfmSideMenuRows(sections);
    const fitWidth = rows.find(({ row }) => row.key === "table-fit-width")?.row;
    const createPages = rows.find(({ row }) => row.key === "table-create-cards-from-rows")?.row;

    expect(fitWidth?.enabled).toBe(false);
    expect(typeof fitWidth?.mockReason).toBe("string");
    expect(createPages?.badge).toBe("Nodex");
    expect(createPages?.enabled).toBe(false);
  });

  test("resolves section titles from top-level selected block descriptors", () => {
    expect(resolveNfmSideMenuScopeTitle([])).toBe("Block");
    expect(resolveNfmSideMenuScopeTitle([{ id: "a", type: "paragraph" }])).toBe("Text");
    expect(resolveNfmSideMenuScopeTitle([{ id: "a", type: "codeBlock" }])).toBe("Code");
    expect(resolveNfmSideMenuScopeTitle([{ id: "a", type: "heading", props: { level: 2 } }])).toBe(
      "Heading 2",
    );
    expect(
      resolveNfmSideMenuScopeTitle([
        { id: "a", type: "heading", props: { level: 3, isToggleable: true } },
      ]),
    ).toBe("Toggle heading 3");
    expect(resolveNfmSideMenuScopeTitle([{ id: "a", type: "callout" }])).toBe("Callout");
    expect(resolveNfmSideMenuScopeTitle([{ id: "a", type: "pageRef" }])).toBe("Page reference");
    expect(resolveNfmSideMenuScopeTitle([{ id: "a", type: "unknownType" }])).toBe("Block");
    expect(
      resolveNfmSideMenuScopeTitle([
        { id: "a", type: "paragraph" },
        { id: "b", type: "paragraph" },
        { id: "c", type: "codeBlock" },
      ]),
    ).toBe("3 blocks");
  });

  test("filters by label, shortcut, and keywords", () => {
    const sections = buildDefaultSections();
    const devSections = buildDefaultSections(true);
    const duplicateRows = flattenNfmSideMenuRows(filterNfmSideMenuSections(sections, "⌘D"));
    const productionAiRows = flattenNfmSideMenuRows(
      filterNfmSideMenuSections(sections, "assistant"),
    );
    const devAiRows = flattenNfmSideMenuRows(filterNfmSideMenuSections(devSections, "assistant"));
    const noneRows = flattenNfmSideMenuRows(filterNfmSideMenuSections(sections, "zzzz"));

    expect(duplicateRows.length).toBe(1);
    expect(duplicateRows[0]?.row.key).toBe("duplicate");
    expect(productionAiRows.length).toBe(0);
    expect(devAiRows.length).toBe(1);
    expect(devAiRows[0]?.row.key).toBe("ask-ai");
    expect(noneRows.length).toBe(0);
  });

  test("uses reference focus behavior for search and arrow navigation", () => {
    const rows = flattenNfmSideMenuRows(buildDefaultSections());

    expect(getInitialNfmSideMenuFocusIndex("", rows)).toBe(-1);
    expect(getInitialNfmSideMenuFocusIndex("turn", rows)).toBe(0);
    expect(moveNfmSideMenuFocus(-1, 1, rows)).toBe(0);
    expect(moveNfmSideMenuFocus(0, -1, rows)).toBe(rows.length - 1);
    expect(moveNfmSideMenuFocus(rows.length - 1, 1, rows)).toBe(0);
  });
});
