import { describe, expect, test, vi } from "vite-plus/test";
import { projectCodeTokenStyle, resolveReadonlyCodeLanguage } from "./code-block-presentation";
import {
  DEFAULT_NFM_AUTOLINK_SETTINGS,
  NFM_AUTOLINK_SETTINGS_STORAGE_KEY,
  normalizeNfmAutolinkSettings,
  readNfmAutolinkSettings,
  shouldAutoLinkMatchInText,
  shouldAutoLinkValue,
  writeNfmAutolinkSettings,
} from "./nfm-autolink-settings";
import type {
  DatabaseContainerDescriptorV2,
  DatabaseModuleReadResultV2,
} from "../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../shared/database-identities";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import {
  prepareNfmBlockPromotion,
  type NfmBlockMoveRequest,
  type NfmBlockMoveRuntimeDependencies,
} from "./nfm-block-move-runtime";
import { BlockNoteEditor } from "@blocknote/core";
import { headlessBlockDocumentSchema } from "../../shared/block-documents/headless-blocknote-schema";
import {
  applyLocalNfmTurnInto,
  NFM_TURN_INTO_DEFINITIONS,
  resolvePageMentionEmbedTarget,
} from "./nfm-turn-into-targets";

describe("read-only code language", () => {
  test("uses the catalog label and grammar for catalog aliases", () => {
    expect(resolveReadonlyCodeLanguage("ts")).toEqual({
      id: "typescript",
      label: "TypeScript",
      highlightLanguage: "tsx",
    });
    expect(resolveReadonlyCodeLanguage("coq").label).toBe("Rocq");
  });

  test("keeps grammars outside the catalog under their authored name", () => {
    expect(resolveReadonlyCodeLanguage("zsh")).toEqual({
      id: "zsh",
      label: "zsh",
      highlightLanguage: "zsh",
    });
  });

  test("presents an empty info string as plain text", () => {
    expect(resolveReadonlyCodeLanguage("  ")).toEqual({
      id: "text",
      label: resolveReadonlyCodeLanguage("text").label,
      highlightLanguage: "text",
    });
  });
});

describe("code token paint", () => {
  test("never emits the light theme as inline paint that would mask the dark theme", () => {
    const style = projectCodeTokenStyle({
      htmlStyle: {
        color: "#6F42C1",
        "font-style": "italic",
        "--shiki-dark": "#B392F0",
        "--shiki-dark-font-style": "italic",
      },
    });

    expect(style).toEqual({
      "--shiki-light": "#6F42C1",
      "--shiki-light-font-style": "italic",
      "--shiki-dark": "#B392F0",
      "--shiki-dark-font-style": "italic",
    });
    expect(Object.keys(style).every((property) => property.startsWith("--"))).toBe(true);
  });

  test("projects single-theme token colors into the same light variables", () => {
    expect(projectCodeTokenStyle({ color: "#24292E", bgColor: "#FFFBDD" })).toEqual({
      "--shiki-light": "#24292E",
      "--shiki-light-bg": "#FFFBDD",
    });
  });
});

describe("nfm autolink settings", () => {
  const storageMap = new Map<string, string>();

  const mockStorage = {
    getItem(key: string): string | null {
      return storageMap.has(key) ? (storageMap.get(key) ?? null) : null;
    },
    setItem(key: string, value: string): void {
      storageMap.set(key, value);
    },
    removeItem(key: string): void {
      storageMap.delete(key);
    },
    clear(): void {
      storageMap.clear();
    },
  };

  function withMockLocalStorage(run: () => void): void {
    const storageGlobal = globalThis as { localStorage?: typeof mockStorage };
    const previousLocalStorage = storageGlobal.localStorage;
    storageGlobal.localStorage = mockStorage;
    try {
      run();
    } finally {
      if (previousLocalStorage) {
        storageGlobal.localStorage = previousLocalStorage;
        return;
      }
      delete storageGlobal.localStorage;
    }
  }

  describe("markdown autolink settings", () => {
    test("defaults to fully enabled autolink behavior", () => {
      withMockLocalStorage(() => {
        mockStorage.clear();
        const settings = readNfmAutolinkSettings();
        expect(settings.autoLinkWhileTyping).toBe(true);
        expect(settings.autoLinkOnPaste).toBe(true);
        expect(settings.linkifyBareDomains).toBe(true);
      });
    });

    test("persists normalized settings", () => {
      withMockLocalStorage(() => {
        mockStorage.clear();

        const written = writeNfmAutolinkSettings({
          autoLinkWhileTyping: false,
          autoLinkOnPaste: "true",
          linkifyBareDomains: "nope",
        });

        expect(written.autoLinkWhileTyping).toBe(false);
        expect(written.autoLinkOnPaste).toBe(true);
        expect(written.linkifyBareDomains).toBe(true);
        expect(mockStorage.getItem(NFM_AUTOLINK_SETTINGS_STORAGE_KEY)).not.toBeNull();

        const normalized = normalizeNfmAutolinkSettings({
          autoLinkWhileTyping: "false",
          autoLinkOnPaste: "true",
          linkifyBareDomains: true,
        });

        expect(normalized.autoLinkWhileTyping).toBe(false);
        expect(normalized.autoLinkOnPaste).toBe(true);
        expect(normalized.linkifyBareDomains).toBe(true);
      });
    });

    test("recognizes explicit web URLs with the default settings", () => {
      expect(shouldAutoLinkValue("https://example.com/docs", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(
        true,
      );
      expect(shouldAutoLinkValue("www.example.com/docs", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(true);
      expect(shouldAutoLinkValue("mailto:test@example.com", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(
        true,
      );
    });

    test("rejects path-like and filename-like input even when bare-domain recognition is enabled", () => {
      expect(
        shouldAutoLinkValue("nfm-editor-copy-behavior.md", DEFAULT_NFM_AUTOLINK_SETTINGS),
      ).toBe(false);
      expect(
        shouldAutoLinkValue(
          "docs/product-specs/nfm-editor-copy-behavior.md",
          DEFAULT_NFM_AUTOLINK_SETTINGS,
        ),
      ).toBe(false);
      expect(
        shouldAutoLinkValue(
          "./docs/product-specs/nfm-editor-copy-behavior.md",
          DEFAULT_NFM_AUTOLINK_SETTINGS,
        ),
      ).toBe(false);
      expect(
        shouldAutoLinkValue(
          "C:\\repo\\docs\\nfm-editor-copy-behavior.md",
          DEFAULT_NFM_AUTOLINK_SETTINGS,
        ),
      ).toBe(false);
    });

    test("rejects bare domains when the setting is disabled", () => {
      expect(
        shouldAutoLinkValue("example.com", {
          ...DEFAULT_NFM_AUTOLINK_SETTINGS,
          linkifyBareDomains: false,
        }),
      ).toBe(false);
    });

    test("allows bare domains with the default settings", () => {
      expect(shouldAutoLinkValue("example.com", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(true);
      expect(shouldAutoLinkValue("example.co.uk", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(true);
      expect(shouldAutoLinkValue("example.com/docs", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(true);
    });

    test("rejects internal and unsupported explicit values", () => {
      expect(shouldAutoLinkValue("foo.internal", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(false);
      expect(shouldAutoLinkValue("localhost", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(false);
      expect(shouldAutoLinkValue("javascript:alert(1)", DEFAULT_NFM_AUTOLINK_SETTINGS)).toBe(false);
    });

    test("rejects protocol-less matches embedded in path segments on paste", () => {
      expect(
        shouldAutoLinkMatchInText(
          "local/code-block-mock-ui/action-menu-popper.com",
          "local/code-block-mock-ui/".length,
          "action-menu-popper.com",
          DEFAULT_NFM_AUTOLINK_SETTINGS,
        ),
      ).toBe(false);
      expect(
        shouldAutoLinkMatchInText(
          "docs/example.com",
          "docs/".length,
          "example.com",
          DEFAULT_NFM_AUTOLINK_SETTINGS,
        ),
      ).toBe(false);
    });

    test("allows protocol-less matches when surrounded by soft boundaries", () => {
      expect(
        shouldAutoLinkMatchInText(
          "(action-menu-popper.com)",
          1,
          "action-menu-popper.com",
          DEFAULT_NFM_AUTOLINK_SETTINGS,
        ),
      ).toBe(true);
      expect(
        shouldAutoLinkMatchInText(
          " action-menu-popper.com ",
          1,
          "action-menu-popper.com",
          DEFAULT_NFM_AUTOLINK_SETTINGS,
        ),
      ).toBe(true);
    });
  });
});

describe("nfm block move runtime", () => {
  const timestamp = "2026-08-14T00:00:00.000Z";
  const projectId = "project-alpha";
  const storeEpoch = "epoch-alpha";
  const libraryId = "library-alpha";
  const databaseId = parseDatabaseId("database-alpha");
  const dataSourceId = parseDataSourceId("source-alpha");
  const defaultViewId = parseDatabaseViewId("view-default");
  const statusViewId = parseDatabaseViewId("view-status");

  const viewConfig = (groupPropertyId: string | null) =>
    upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view",
      schemaVersion: 2,
      filter: { kind: "group", operator: "and", children: [] },
      sort: [
        {
          field: { kind: "manual" },
          direction: "asc",
          nulls: "last",
        },
      ],
      group: groupPropertyId ? { propertyId: groupPropertyId } : null,
      display: { propertyIds: [], showTitle: true },
    });

  const descriptor = (): DatabaseContainerDescriptorV2 => ({
    database: {
      databaseId,
      libraryId,
      name: "Tasks",
      lifecycle: "active",
      defaultViewId,
      metadataRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    dataSources: [
      {
        dataSourceId,
        libraryId,
        homeDatabaseId: databaseId,
        name: "Pages",
        schemaKey: "nodex.pages",
        schemaRevision: 1,
        lifecycle: "active",
        rankKey: "a",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    views: [
      {
        viewId: defaultViewId,
        databaseId,
        dataSourceId,
        name: "Default",
        layout: "list",
        config: viewConfig(null),
        isDefault: true,
        revision: 1,
        rankKey: "a",
        lifecycle: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        viewId: statusViewId,
        databaseId,
        dataSourceId,
        name: "Workflow",
        layout: "board",
        config: viewConfig("status"),
        isDefault: false,
        revision: 1,
        rankKey: "b",
        lifecycle: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });

  const databaseRead = (): DatabaseModuleReadResultV2 => ({
    ok: true,
    value: {
      projectId,
      libraryId,
      storeEpoch,
      commitSeq: 7,
      value: { kind: "database", value: descriptor() },
    },
  });

  const request = (destination: NfmBlockMoveRequest["destination"]): NfmBlockMoveRequest => ({
    storeEpoch,
    sourcePageId: "page-source",
    sourceDocumentId: "document-source",
    sourceDocumentGeneration: 3,
    rootBlockIds: ["block-a", "block-b"],
    sourceHead: {
      documentId: "document-source",
      storeEpoch,
      generation: 3,
      expectedHeadSeq: 11,
    },
    destination,
  });

  const dependencies = (): NfmBlockMoveRuntimeDependencies => ({
    readDatabase: async () => databaseRead(),
    createOperationId: () => "operation-move",
  });

  describe("NFM Block move runtime", () => {
    test("resolves a real Status-grouped View before moving Blocks to a DB status", async () => {
      const readDatabase = vi.fn<NfmBlockMoveRuntimeDependencies["readDatabase"]>(async () =>
        databaseRead(),
      );
      const intent = await prepareNfmBlockPromotion(
        request({
          kind: "db-column",
          projectId,
          columnId: "done",
        }),
        {
          ...dependencies(),
          readDatabase,
        },
      );

      expect(readDatabase).toHaveBeenCalledWith(projectId, {
        projectId,
        read: { target: { kind: "project_default" }, mode: "database" },
      });
      expect(intent).toMatchObject({
        target: {
          kind: "data_source",
          dataSourceId,
          placement: {
            kind: "direct",
            viewId: statusViewId,
            preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
            groupKey: "done",
          },
        },
        causalDependencies: [
          {
            documentId: "document-source",
            generation: 3,
            expectedHeadSeq: 11,
          },
        ],
      });
    });

    test("rejects a source fence from another generation before compiling a request", async () => {
      const input = request({ kind: "db-column", projectId, columnId: "done" });
      await expect(
        prepareNfmBlockPromotion(
          { ...input, sourceHead: { ...input.sourceHead, generation: 4 } },
          dependencies(),
        ),
      ).rejects.toMatchObject({
        name: "NfmBlockMoveError",
        code: "source.changed",
        reloadRequired: true,
        operationId: "operation-move",
      });
    });

    test("rejects a Board response from outside the destination Project", async () => {
      const readDatabase = vi.fn<NfmBlockMoveRuntimeDependencies["readDatabase"]>(async () =>
        databaseRead(),
      );

      await expect(
        prepareNfmBlockPromotion(
          request({
            kind: "db-column",
            projectId: "project-other",
            columnId: "done",
          }),
          {
            readDatabase,
            createOperationId: () => "operation-move",
          },
        ),
      ).rejects.toMatchObject({
        code: "database.scope_mismatch",
      });
      expect(readDatabase).toHaveBeenCalledWith("project-other", expect.anything());
    });
  });
});

describe("nfm turn into targets", () => {
  const pageId = "roadmap/2026";
  const pageMention = { type: "pageMention" as const, props: { targetPageId: pageId } };
  const pageDeepLinkText = {
    type: "text",
    text: "nodex://pages/roadmap%2F2026",
    styles: {},
  };

  describe("resolvePageMentionEmbedTarget", () => {
    const paragraph = { type: "paragraph", content: [pageMention] };
    const space = { type: "text", text: " " };

    test.each([
      { name: "one mention", block: paragraph },
      {
        name: "a pasted mention followed by a space",
        block: { ...paragraph, children: [], content: [pageMention, space] },
      },
      {
        name: "whitespace on both sides and a trimmed Page ID",
        block: {
          ...paragraph,
          content: [
            { type: "text", text: "\t " },
            { type: "pageMention", props: { targetPageId: ` ${pageId} ` } },
            space,
          ],
        },
      },
    ])("accepts $name", ({ block }) => {
      expect(resolvePageMentionEmbedTarget(block)).toBe(pageId);
    });

    test.each([
      { name: "a heading", block: { ...paragraph, type: "heading" } },
      { name: "a child Block", block: { ...paragraph, children: [{ type: "paragraph" }] } },
      { name: "no content", block: { type: "paragraph" } },
      { name: "non-array content", block: { ...paragraph, content: pageMention } },
      { name: "whitespace without a mention", block: { ...paragraph, content: [space] } },
      {
        name: "non-whitespace text beside a mention",
        block: { ...paragraph, content: [pageMention, { type: "text", text: "hello" }] },
      },
      {
        name: "two mentions of the same Page",
        block: { ...paragraph, content: [pageMention, space, pageMention] },
      },
      {
        name: "a blank target ID",
        block: { ...paragraph, content: [{ type: "pageMention", props: { targetPageId: " " } }] },
      },
      {
        name: "missing mention props",
        block: { ...paragraph, content: [{ type: "pageMention" }] },
      },
      ...["link", "threadMention", "attachment"].map((type) => ({
        name: `a ${type} beside a mention`,
        block: { ...paragraph, content: [pageMention, { type }] },
      })),
      {
        name: "a raw string beside a mention",
        block: { ...paragraph, content: [pageMention, " "] },
      },
    ])("rejects $name", ({ block }) => {
      expect(resolvePageMentionEmbedTarget(block)).toBeNull();
    });
  });

  describe("NFM Turn into target catalog", () => {
    test("exposes the complete lossless target matrix with one typed intent per menu item", () => {
      expect(NFM_TURN_INTO_DEFINITIONS).toHaveLength(16);
      expect(new Set(NFM_TURN_INTO_DEFINITIONS.map((item) => item.key)).size).toBe(16);
      expect(
        NFM_TURN_INTO_DEFINITIONS.filter((item) => item.target.kind === "heading").map((item) => ({
          level: item.target.kind === "heading" ? item.target.level : null,
          toggleable: item.target.kind === "heading" ? item.target.toggleable : null,
        })),
      ).toEqual([
        { level: "one", toggleable: false },
        { level: "two", toggleable: false },
        { level: "three", toggleable: false },
        { level: "one", toggleable: true },
        { level: "two", toggleable: true },
        { level: "three", toggleable: true },
      ]);
      expect(
        NFM_TURN_INTO_DEFINITIONS.map((item) => item.target.kind).filter(
          (kind) => kind !== "heading",
        ),
      ).toEqual([
        "paragraph",
        "bulleted_list",
        "numbered_list",
        "todo_list",
        "toggle_list",
        "quote",
        "callout",
        "prompt",
        "code",
        "equation",
      ]);
    });

    test("turns an ordinary selection inside one editor transaction", () => {
      const calls: string[] = [];
      const editor = {
        schema: { blockSchema: { toggleListItem: { content: "inline" as const } } },
        transact: (callback: () => void) => {
          calls.push("begin");
          callback();
          calls.push("commit");
        },
        updateBlock: (block: unknown) => {
          calls.push(`update:${String(block)}`);
        },
      };

      applyLocalNfmTurnInto(editor, ["one", "two"], { type: "toggleListItem" });

      expect(calls).toEqual(["begin", "update:one", "update:two", "commit"]);
    });
  });

  describe("applyLocalNfmTurnInto", () => {
    test.each([
      { key: "paragraph", type: "paragraph", content: [pageMention] },
      { key: "heading-2", type: "heading", content: [pageMention] },
      { key: "code", type: "codeBlock", content: [pageDeepLinkText] },
      { key: "equation", type: "mathBlock", content: [pageDeepLinkText] },
    ])("preserves a Page Reference target when turning it into $key", ({ key, type, content }) => {
      const editor = BlockNoteEditor.create({
        schema: headlessBlockDocumentSchema,
        initialContent: [{ id: "reference", type: "pageRef", props: { targetBlockId: pageId } }],
      });
      const definition = NFM_TURN_INTO_DEFINITIONS.find((target) => target.key === key);
      if (!definition) throw new Error(`Missing Turn into definition for ${key}`);

      applyLocalNfmTurnInto(editor, editor.document, definition.localPatch);

      expect(editor.getBlock("reference")).toMatchObject({ type, content });
    });

    test("retains an ordinary paragraph's rich text when turning it into a heading", () => {
      const content = [{ type: "text" as const, text: "Heading text", styles: { bold: true } }];
      const editor = BlockNoteEditor.create({
        schema: headlessBlockDocumentSchema,
        initialContent: [{ id: "text", type: "paragraph", content }],
      });

      applyLocalNfmTurnInto(editor, editor.document, { type: "heading", props: { level: 2 } });

      expect(editor.getBlock("text")).toMatchObject({
        type: "heading",
        props: { level: 2 },
        content,
      });
    });
  });
});
