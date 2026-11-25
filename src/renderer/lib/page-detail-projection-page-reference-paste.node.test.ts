import { describe, expect, test } from "vite-plus/test";
import { resolvePageDeepLinkPasteIntent } from "./page-reference-paste";
import {
  readPageStageContentWidthPreference,
  readPageStageShowRawContentPreference,
  writePageStageContentWidthPreference,
  writePageStageShowRawContentPreference,
} from "./page-stage-layout";
import { parseDataSourcePropertyId, parseDataSourceId } from "../../shared/database-identities";
import type { PageDetail } from "../../shared/page-detail";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import { buildPageDetailFixtureResult } from "@/test/page-detail-fixture";
import { buildPageStageFixturePage } from "@/test/page-stage-fixture";
import { projectPageDetailToStageModel } from "./page-stage-page";
import {
  hasPageStageScheduleCapability,
  readPageDetailWorkflowStatus,
  type PageStageDataSourceProperty,
} from "./page-stage-properties";
import {
  pageStagePropertyRows,
  advancePageStagePropertyDisclosure,
  revealPageStageProperty,
  type PageStagePropertyDisclosureEntry,
  type PageStagePropertyDisclosureState,
  isPageStagePropertyHiddenByLayout,
  isPageStagePropertyValueEmpty,
} from "./page-stage-property-layout";
import type { DatabasePropertyValueType } from "../../shared/database-kernel";
import {
  advancePageStageQuietPropertiesState,
  createPageStageQuietPropertiesState,
  formatPageStageQuietPropertyCountLabel,
  resolveLinkedChatsPropertySignal,
  resolvePageFilesPropertySignal,
  type PageStageQuietPropertiesInput,
} from "./page-stage-quiet-properties";
import type { Project, ProjectSession } from "./types";
import {
  presentPageStageRelatedChatCandidates,
  selectLinkableChatCandidates,
} from "./page-stage-related-chat-candidates";

describe("page reference paste", () => {
  const base = {
    plainText: "nodex://pages/page-1",
    hasStructuredClipboard: false,
    hasFiles: false,
    hasTextSelection: false,
    currentBlockType: "paragraph",
  } as const;

  describe("resolvePageDeepLinkPasteIntent", () => {
    test("only converts qualified links from the current Space into relative references", () => {
      expect(
        resolvePageDeepLinkPasteIntent({
          ...base,
          plainText: `${base.plainText}?spaceId=test-space`,
        }),
      ).toEqual({ kind: "mention", pageId: "page-1" });
      expect(
        resolvePageDeepLinkPasteIntent({
          ...base,
          plainText: `${base.plainText}?spaceId=another-space`,
        }),
      ).toBeNull();
    });
    test("maps one canonical Page deeplink by editor context", () => {
      expect(resolvePageDeepLinkPasteIntent({ ...base, hasTextSelection: true })).toEqual({
        kind: "link",
        href: base.plainText,
        pageId: "page-1",
      });
      expect(resolvePageDeepLinkPasteIntent(base)).toEqual({
        kind: "mention",
        pageId: "page-1",
      });
      for (const currentBlockType of ["paragraph", "heading", "bulletListItem", "table"]) {
        expect(resolvePageDeepLinkPasteIntent({ ...base, currentBlockType })).toEqual({
          kind: "mention",
          pageId: "page-1",
        });
      }
    });

    test("keeps code, rich clipboard, files, and non-canonical text literal", () => {
      expect(
        resolvePageDeepLinkPasteIntent({
          ...base,
          currentBlockType: "codeBlock",
        }),
      ).toBeNull();
      expect(
        resolvePageDeepLinkPasteIntent({
          ...base,
          hasStructuredClipboard: true,
        }),
      ).toBeNull();
      expect(resolvePageDeepLinkPasteIntent({ ...base, hasFiles: true })).toBeNull();
      expect(
        resolvePageDeepLinkPasteIntent({
          ...base,
          plainText: " nodex://pages/page-1",
        }),
      ).toBeNull();
      expect(
        resolvePageDeepLinkPasteIntent({
          ...base,
          plainText: "nodex:/pages/page-1",
        }),
      ).toBeNull();
    });
  });
});

describe("page-stage layout", () => {
  function withMockLocalStorage(run: () => void): void {
    const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });

    try {
      run();
    } finally {
      if (originalLocalStorageDescriptor) {
        Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
        return;
      }

      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }

  test("defaults to limiting the main content width", () => {
    withMockLocalStorage(() => {
      expect(readPageStageContentWidthPreference()).toBe(true);
    });
  });

  test("persists the width preference", () => {
    withMockLocalStorage(() => {
      writePageStageContentWidthPreference(false);

      expect(readPageStageContentWidthPreference()).toBe(false);
    });
  });

  test("defaults to hiding raw content mode", () => {
    withMockLocalStorage(() => {
      expect(readPageStageShowRawContentPreference()).toBe(false);
    });
  });

  test("persists the raw content preference without clobbering width", () => {
    withMockLocalStorage(() => {
      writePageStageContentWidthPreference(false);
      writePageStageShowRawContentPreference(true);

      expect(readPageStageContentWidthPreference()).toBe(false);
      expect(readPageStageShowRawContentPreference()).toBe(true);
    });
  });
});

describe("page stage properties", () => {
  const detail = (): PageDetail => {
    const result = buildPageDetailFixtureResult("project-1", buildPageStageFixturePage());
    if (!result.ok) throw new Error("Expected Page Detail fixture");
    return result.value;
  };

  const withoutProperty = (source: PageDetail, propertyId: string): PageDetail => {
    if (source.dataSourceContext.kind !== "member") return source;
    const { [propertyId]: _removed, ...values } = source.dataSourceContext.values;
    void _removed;
    return {
      ...source,
      dataSourceContext: {
        ...source.dataSourceContext,
        properties: source.dataSourceContext.properties.filter(
          (property) => property.propertyId !== propertyId,
        ),
        values,
      },
    };
  };

  describe("Page Stage properties", () => {
    test("reads workflow Status for compact Page presentation", () => {
      expect(readPageDetailWorkflowStatus(detail())).toBe("doing");
      expect(
        readPageDetailWorkflowStatus({
          ...detail(),
          dataSourceContext: { kind: "standalone" },
        }),
      ).toBeNull();
      expect(readPageDetailWorkflowStatus(null)).toBeNull();
    });

    test.each(["assignee", "due_date", "priority", "tags"])(
      "keeps the remaining Property rows when %s is removed",
      (removedPropertyId) => {
        const source = detail();
        const originalPropertyCount =
          source.dataSourceContext.kind === "member"
            ? source.dataSourceContext.properties.length
            : 0;
        const model = projectPageDetailToStageModel(withoutProperty(source, removedPropertyId));
        expect(model.databaseContext.kind).toBe("member");
        if (model.databaseContext.kind !== "member") return;
        expect(model.databaseContext.properties).toHaveLength(originalPropertyCount - 1);
        expect(
          model.databaseContext.properties.some(
            (item) => item.property.propertyId === removedPropertyId,
          ),
        ).toBe(false);
        expect(model.databaseContext.semanticProperties.status?.value).toBe("doing");
      },
    );

    test("projects custom typed properties in schema order", () => {
      const source = detail();
      if (source.dataSourceContext.kind !== "member") return;
      const customId = parseDataSourcePropertyId("p_0123abcd");
      const model = projectPageDetailToStageModel({
        ...source,
        dataSourceContext: {
          ...source.dataSourceContext,
          properties: [
            ...source.dataSourceContext.properties,
            {
              propertyId: customId,
              dataSourceId: source.dataSourceContext.dataSource.dataSourceId,
              name: "Risk score",
              ...testPropertySemantics("number"),
              valueType: "number",
              config: {},
              rankKey: "zz",
              lifecycle: "active",
              revision: 1,
              createdAt: source.page.createdAt,
              updatedAt: source.page.updatedAt,
            },
          ],
          values: {
            ...source.dataSourceContext.values,
            [customId]: {
              propertyId: customId,
              valueType: "number",
              value: 8,
              revision: 2,
            },
          },
        },
      });
      if (model.databaseContext.kind !== "member") return;
      expect(model.databaseContext.properties.at(-1)).toMatchObject({
        property: { propertyId: customId, name: "Risk score" },
        value: 8,
        valueRevision: 2,
        error: null,
      });
    });

    test("presents a valid schedule pair as one Schedule row", () => {
      const model = projectPageDetailToStageModel(detail());
      if (model.databaseContext.kind !== "member") throw new Error("Expected a Database Page");
      const rowKeys = pageStagePropertyRows(
        model.databaseContext.properties,
        model.databaseContext.semanticProperties,
      ).map((row) => row.key);
      expect(rowKeys.filter((key) => key === "schedule")).toHaveLength(1);
      expect(rowKeys).not.toContain("scheduled_start");
      expect(rowKeys).not.toContain("scheduled_end");
    });

    test("degrades a partial schedule pair to ordinary independent rows", () => {
      const model = projectPageDetailToStageModel(withoutProperty(detail(), "scheduled_end"));
      if (model.databaseContext.kind !== "member") return;
      expect(hasPageStageScheduleCapability(model.databaseContext.semanticProperties)).toBe(false);
      const rowKeys = pageStagePropertyRows(
        model.databaseContext.properties,
        model.databaseContext.semanticProperties,
      ).map((row) => row.key);
      expect(rowKeys).toContain("scheduled_start");
      expect(rowKeys).not.toContain("schedule");
    });

    test("degrades a corrupt schedule pair so the local error remains visible", () => {
      const source = detail();
      if (source.dataSourceContext.kind !== "member") return;
      const model = projectPageDetailToStageModel({
        ...source,
        dataSourceContext: {
          ...source.dataSourceContext,
          values: {
            ...source.dataSourceContext.values,
            scheduled_start: {
              propertyId: parseDataSourcePropertyId("scheduled_start"),
              valueType: "datetime",
              value: "not-a-datetime",
              revision: 9,
            },
          },
        },
      });
      if (model.databaseContext.kind !== "member") return;
      expect(hasPageStageScheduleCapability(model.databaseContext.semanticProperties)).toBe(false);
      expect(
        pageStagePropertyRows(
          model.databaseContext.properties,
          model.databaseContext.semanticProperties,
        ).map((row) => row.key),
      ).toEqual(expect.arrayContaining(["scheduled_start", "scheduled_end"]));
    });

    test("isolates a corrupt value to its Property item", () => {
      const source = detail();
      if (source.dataSourceContext.kind !== "member") return;
      const model = projectPageDetailToStageModel({
        ...source,
        dataSourceContext: {
          ...source.dataSourceContext,
          values: {
            ...source.dataSourceContext.values,
            due_date: {
              propertyId: parseDataSourcePropertyId("due_date"),
              valueType: "date",
              value: "2026-02-30",
              revision: 4,
            },
          },
        },
      });
      if (model.databaseContext.kind !== "member") return;
      expect(
        model.databaseContext.properties.find((item) => item.property.propertyId === "due_date")
          ?.error,
      ).toBe("Expected an ISO date");
      expect(model.databaseContext.semanticProperties.dueDate?.value).toBeNull();
      expect(model.databaseContext.semanticProperties.status?.value).toBe("doing");
    });

    test("does not grant built-in semantics to a wrong-type reserved Property", () => {
      const source = detail();
      if (source.dataSourceContext.kind !== "member") return;
      const model = projectPageDetailToStageModel({
        ...source,
        dataSourceContext: {
          ...source.dataSourceContext,
          properties: source.dataSourceContext.properties.map((property) =>
            property.propertyId === "due_date"
              ? {
                  ...property,
                  ...testPropertySemantics("text"),
                  valueType: "text" as const,
                }
              : property,
          ),
          values: {
            ...source.dataSourceContext.values,
            due_date: {
              propertyId: parseDataSourcePropertyId("due_date"),
              valueType: "text",
              value: "2026-02-30",
              revision: 4,
            },
          },
        },
      });
      if (model.databaseContext.kind !== "member") return;
      expect(model.databaseContext.semanticProperties.dueDate).toBeNull();
    });
  });
});

describe("page stage property layout", () => {
  const item = (
    valueType: DatabasePropertyValueType,
    value: PageStageDataSourceProperty["value"],
    pageVisibility: PageStageDataSourceProperty["pageVisibility"] = "hide_when_empty",
  ): PageStageDataSourceProperty => ({
    property: {
      propertyId: parseDataSourcePropertyId("p_AAAAAAAA"),
      dataSourceId: parseDataSourceId("source-1"),
      name: "Test",
      ...testPropertySemantics(valueType),
      valueType,
      config: {},
      rankKey: "a",
      lifecycle: "active",
      revision: 1,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    },
    value,
    valueRevision: 0,
    error: null,
    pageVisibility,
  });

  describe("Page layout typed emptiness", () => {
    test("treats null, empty text, and empty multi-select as empty", () => {
      expect(isPageStagePropertyValueEmpty(item("date", null))).toBe(true);
      expect(isPageStagePropertyValueEmpty(item("text", ""))).toBe(true);
      expect(isPageStagePropertyValueEmpty(item("multi_select", []))).toBe(true);
    });

    test("keeps false and zero visible", () => {
      expect(isPageStagePropertyValueEmpty(item("checkbox", false))).toBe(false);
      expect(isPageStagePropertyValueEmpty(item("number", 0))).toBe(false);
    });

    test("separates always-hide from hide-when-empty", () => {
      expect(isPageStagePropertyHiddenByLayout(item("text", "value", "always_hide"))).toBe(true);
      expect(isPageStagePropertyHiddenByLayout(item("text", "value", "hide_when_empty"))).toBe(
        false,
      );
      expect(isPageStagePropertyHiddenByLayout(item("text", "", "always_show"))).toBe(false);
    });
  });

  describe("Page property rows", () => {
    const withId = (
      propertyId: string,
      source: PageStageDataSourceProperty,
    ): PageStageDataSourceProperty => ({
      ...source,
      property: { ...source.property, propertyId: parseDataSourcePropertyId(propertyId) },
    });

    test("keeps layout order and reports which rows the layout shows", () => {
      const rows = pageStagePropertyRows(
        [
          withId("status", item("text", "doing", "hide_when_empty")),
          withId("priority", item("text", null, "hide_when_empty")),
          withId("p_noteNote", item("text", "", "always_show")),
          withId("p_secret00", item("text", "value", "always_hide")),
        ],
        null,
      );
      expect(rows.map((row) => [row.key, row.shownByLayout, row.empty])).toEqual([
        ["status", true, false],
        ["priority", false, true],
        ["p_noteNote", true, true],
        ["p_secret00", false, false],
      ]);
    });
  });

  describe("Page property disclosure", () => {
    const entries = (
      shown: Readonly<Record<string, boolean | "tucked-value">>,
    ): readonly PageStagePropertyDisclosureEntry[] =>
      Object.entries(shown).map(([key, state]) => ({
        key,
        shownByLayout: state === true,
        empty: state !== "tucked-value" && state !== true,
      }));
    const advance = (
      current: PageStagePropertyDisclosureState | null,
      shown: Parameters<typeof entries>[0],
      expanded = false,
      pageId = "page-1",
    ) => advancePageStagePropertyDisclosure(current, { pageId, entries: entries(shown), expanded });

    test("starts from what the layout shows for each Page", () => {
      const first = advance(null, { status: true, priority: false });
      expect([...first.shownKeys]).toEqual(["status"]);

      const next = advance(first, { status: false, priority: true }, false, "page-2");
      expect([...next.shownKeys]).toEqual(["priority"]);
    });

    test("keeps a shown row after its value is cleared", () => {
      const shown = advance(null, { priority: true });
      const cleared = advance(shown, { priority: false });
      expect(cleared).toBe(shown);
      expect(cleared.shownKeys.has("priority")).toBe(true);
    });

    test("opens tucked-away values as rows and leaves empty entries to be chosen", () => {
      const closed = advance(null, { status: true, secret: "tucked-value", tags: false });
      expect([...closed.tuckedRowKeys]).toEqual([]);

      const open = advance(closed, { status: true, secret: "tucked-value", tags: false }, true);
      expect([...open.shownKeys]).toEqual(["status"]);
      expect([...open.tuckedRowKeys]).toEqual(["secret"]);
    });

    test("a chosen entry joins the list and stays after the disclosure closes", () => {
      const open = advance(null, { status: true, tags: false }, true);
      const chosen = revealPageStageProperty(open, "tags");
      expect([...chosen.shownKeys]).toEqual(["status", "tags"]);
      expect(revealPageStageProperty(chosen, "tags")).toBe(chosen);

      const closed = advance(chosen, { status: true, tags: false });
      expect(closed.shownKeys.has("tags")).toBe(true);
    });

    test("holds a tucked row in place while open, whatever happens to its value", () => {
      const open = advance(null, { status: true, files: "tucked-value" }, true);

      const cleared = advance(open, { status: true, files: false }, true);
      expect(cleared).toBe(open);

      const shownByLayout = advance(open, { status: true, files: true }, true);
      expect(shownByLayout).toBe(open);

      const closed = advance(shownByLayout, { status: true, files: true });
      expect([...closed.shownKeys]).toEqual(["status", "files"]);
      expect([...closed.tuckedRowKeys]).toEqual([]);
    });

    test("promotes an entry filled from elsewhere even while open", () => {
      const open = advance(null, { status: true, tags: false }, true);
      const filled = advance(open, { status: true, tags: true }, true);
      expect([...filled.shownKeys]).toEqual(["status", "tags"]);
    });
  });
});

describe("page stage quiet properties", () => {
  const input = (
    overrides: Partial<PageStageQuietPropertiesInput> = {},
  ): PageStageQuietPropertiesInput => ({
    pageId: "page-1",
    files: { signal: "quiet", manifestRevision: 1 },
    linkedChats: { signal: "quiet" },
    ...overrides,
  });

  describe("Page Stage quiet properties", () => {
    test("classifies only unplaced Files and populated linked Chats as informative", () => {
      expect(
        resolvePageFilesPropertySignal({ hasManifest: true, unplacedTotal: 0, hasError: false }),
      ).toBe("quiet");
      expect(
        resolvePageFilesPropertySignal({ hasManifest: true, unplacedTotal: 1, hasError: false }),
      ).toBe("informative");
      expect(resolveLinkedChatsPropertySignal({ count: 0, loading: false, hasError: false })).toBe(
        "quiet",
      );
      expect(resolveLinkedChatsPropertySignal({ count: 1, loading: false, hasError: false })).toBe(
        "informative",
      );
    });

    test("formats the shared quiet-property disclosure label", () => {
      expect(formatPageStageQuietPropertyCountLabel(1, false)).toBe("1 more property");
      expect(formatPageStageQuietPropertyCountLabel(2, true)).toBe("Hide 2 properties");
    });

    test("keeps quiet rows hidden and shows initially informative rows", () => {
      const quiet = createPageStageQuietPropertiesState(input());
      expect(quiet.files.visible).toBe(false);
      expect(quiet.linkedChats.visible).toBe(false);

      const informative = createPageStageQuietPropertiesState(
        input({
          files: { signal: "informative", manifestRevision: 1 },
          linkedChats: { signal: "informative" },
        }),
      );
      expect(informative.files.visible).toBe(true);
      expect(informative.linkedChats.visible).toBe(true);
    });

    test("does not promote Files for a body-placement-only change", () => {
      const quiet = createPageStageQuietPropertiesState(input());
      const placementChanged = advancePageStageQuietPropertiesState(
        quiet,
        input({ files: { signal: "informative", manifestRevision: 1 } }),
      );

      expect(placementChanged.files.visible).toBe(false);
    });

    test("promotes a newly unplaced File and keeps the row stable afterward", () => {
      const quiet = createPageStageQuietPropertiesState(input());
      const added = advancePageStageQuietPropertiesState(
        quiet,
        input({ files: { signal: "informative", manifestRevision: 2 } }),
      );
      const placed = advancePageStageQuietPropertiesState(
        added,
        input({ files: { signal: "quiet", manifestRevision: 2 } }),
      );

      expect(added.files.visible).toBe(true);
      expect(placed.files.visible).toBe(true);
    });

    test("keeps a populated linked Chats row visible after its last relation is removed", () => {
      const quiet = createPageStageQuietPropertiesState(input());
      const linked = advancePageStageQuietPropertiesState(
        quiet,
        input({ linkedChats: { signal: "informative" } }),
      );
      const removed = advancePageStageQuietPropertiesState(
        linked,
        input({ linkedChats: { signal: "quiet" } }),
      );

      expect(linked.linkedChats.visible).toBe(true);
      expect(removed.linkedChats.visible).toBe(true);
    });

    test("surfaces attention and resets sticky visibility for another Page", () => {
      const attention = advancePageStageQuietPropertiesState(
        createPageStageQuietPropertiesState(input()),
        input({
          files: { signal: "attention", manifestRevision: 1 },
          linkedChats: { signal: "attention" },
        }),
      );
      expect(attention.files.visible).toBe(true);
      expect(attention.linkedChats.visible).toBe(true);

      const nextPage = advancePageStageQuietPropertiesState(attention, input({ pageId: "page-2" }));
      expect(nextPage.files.visible).toBe(false);
      expect(nextPage.linkedChats.visible).toBe(false);
    });
  });
});

describe("page stage related chat candidates", () => {
  const session = (overrides: Partial<ProjectSession> = {}): ProjectSession => ({
    id: "session:one",
    projectId: "project:one",
    noThreadFallbackTitle: "Fallback",
    displayTitle: "Chat one",
    activityAt: 0,
    managed: false,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    wokeAt: null,
    pageTurn: null,
    canManage: true,
    canStop: true,
    unread: false,
    thread: null,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
    ...overrides,
  });

  describe("Page Stage related Chat candidates", () => {
    test("keeps threadless Chats, omits archived and repeated Chats, and resolves only useful picker context", () => {
      const projects = [{ id: "project:one", name: "Alpha" }] as Project[];
      expect(
        presentPageStageRelatedChatCandidates(
          [
            session(),
            session({
              id: "session:fallback",
              displayTitle: " ",
              noThreadFallbackTitle: "Planning",
              projectId: null,
            }),
            session({ id: "session:archived", archived: true }),
            session({ displayTitle: "Chat one, detailed" }),
          ],
          projects,
        ),
      ).toEqual([
        { sessionId: "session:one", displayTitle: "Chat one", projectName: "Alpha" },
        { sessionId: "session:fallback", displayTitle: "Planning", projectName: null },
      ]);
    });

    describe("linkable Chats", () => {
      const candidates = [
        { sessionId: "session:recent", displayTitle: "Recent chat", projectName: "Alpha" },
        { sessionId: "session:linked", displayTitle: "Linked chat", projectName: "Alpha" },
        { sessionId: "session:current", displayTitle: "Fix login", projectName: "Beta" },
        { sessionId: "session:loose", displayTitle: "Loose ends", projectName: null },
      ];
      const linkedSessionIds = new Set(["session:linked"]);
      const ids = (currentSessionId: string | null, query = "") =>
        selectLinkableChatCandidates(candidates, { linkedSessionIds, currentSessionId, query }).map(
          (candidate) => candidate.sessionId,
        );

      test("lists the current Chat first and keeps the catalog order for the rest", () => {
        expect(ids("session:current")).toEqual([
          "session:current",
          "session:recent",
          "session:loose",
        ]);
        expect(ids(null)).toEqual(["session:recent", "session:current", "session:loose"]);
      });

      test("never offers a Chat the Page already links to, even the current one", () => {
        expect(ids("session:linked")).toEqual([
          "session:recent",
          "session:current",
          "session:loose",
        ]);
      });

      test("matches the title or Project and keeps the current Chat first among matches", () => {
        expect(ids("session:current", " BETA ")).toEqual(["session:current"]);
        expect(ids("session:current", "chat")).toEqual(["session:recent"]);
        expect(ids("session:recent", "l")).toEqual([
          "session:recent",
          "session:current",
          "session:loose",
        ]);
      });
    });
  });
});
