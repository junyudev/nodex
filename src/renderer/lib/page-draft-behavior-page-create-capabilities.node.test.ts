import { describe, expect, test, afterEach, beforeEach, it } from "vite-plus/test";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../shared/database-identities";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import { testPropertySemantics } from "../../shared/testing/database-property-record";
import {
  gatePageCreateInputByCapabilities,
  resolvePageCreatePropertyCapabilities,
} from "./page-create-capabilities";
import {
  materializePageDocument,
  populateBlockDocumentBodyFromMarkdown,
} from "../../shared/block-documents/block-document-codec";
import {
  buildPageCreateInput,
  capturePageCreateDraftSnapshot,
  createEmptyPageCreateDraftSnapshot,
  createPageCreateDescriptionDraft,
  pageCreateDraftSnapshotsEqual,
  resolvePageCreateTagNames,
} from "./page-create-draft";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
  type MaitaiStore,
  type ScopeHandle,
} from "./maitai/maitai-store";
import {
  getPageCreateTarget,
  registerPageCreateTarget,
  unregisterPageCreateTarget,
  type PageCreateTarget,
} from "./page-create-target-registry";
import {
  clearPageDraftOverlay,
  getPageDraftOverlay,
  mergePageDraftOverlay,
  resetPageDraftStoreForTest,
  setPageDraftOverlay,
} from "./page-draft-store";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./query-keys";
import { invalidateCachedPageFileQueries } from "./page-file-query-cache";
import { buildPageFileTree, type PageFileTreeFile } from "./page-file-tree";
import {
  describeFileFormat,
  pageFileHasSourceView,
  resolvePageFileViewKind,
} from "./page-file-view-kind";
import { groupPageInsertItems } from "./page-insert-menu";

describe("page create capabilities", () => {
  const property = (
    propertyId: string,
    valueType: DataSourcePropertyRecordV2["valueType"],
  ): DataSourcePropertyRecordV2 => ({
    propertyId: parseDataSourcePropertyId(propertyId),
    dataSourceId: parseDataSourceId("source-test"),
    name: propertyId,
    ...testPropertySemantics(
      valueType,
      valueType === "select" || valueType === "multi_select" ? 1 : 0,
    ),
    valueType,
    config: {},
    rankKey: propertyId,
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  });

  describe("Page create property capabilities", () => {
    test("exposes only canonical built-ins with their required value types", () => {
      const priority = property("priority", "select");
      const invalidEstimate = property("estimate", "number");
      const tags = property("tags", "multi_select");
      const customSelect = property("p_AAAAAAAA", "select");

      expect(
        resolvePageCreatePropertyCapabilities([priority, invalidEstimate, tags, customSelect]),
      ).toEqual({
        priorityProperty: priority,
        estimateProperty: null,
        tagsProperty: tags,
      });
    });

    test("uses the same capabilities to remove stale values from the create payload", () => {
      const tags = property("tags", "multi_select");
      const capabilities = resolvePageCreatePropertyCapabilities([tags]);

      expect(
        gatePageCreateInputByCapabilities(
          {
            title: "Schema-safe Page",
            priority: "p1-high",
            estimate: "m",
            tagOptions: [{ optionId: "o_AAAAAAAA", name: "Product" }],
          },
          capabilities,
        ),
      ).toEqual({
        title: "Schema-safe Page",
        priority: undefined,
        estimate: undefined,
        tagOptions: [{ optionId: "o_AAAAAAAA", name: "Product" }],
      });
    });
  });
});

describe("Page create draft", () => {
  test("starts a blank description with one canonical editable paragraph", () => {
    const draft = createPageCreateDescriptionDraft("request-empty-description");

    expect(materializePageDocument(draft.document)).toMatchObject({
      markdown: "",
      blockTree: [
        {
          type: "paragraph",
          content: [],
          children: [],
        },
      ],
    });
    draft.document.destroy();
  });

  test("materializes one Page lifecycle payload from local title, NFM, and properties", () => {
    const draft = createPageCreateDescriptionDraft("request-1");
    populateBlockDocumentBodyFromMarkdown(
      draft.body,
      "## Context\n\nKeep the creation draft local until submit.",
    );

    const input = buildPageCreateInput({
      title: "  Ship create modal  ",
      descriptionDraft: draft,
      priority: "p1-high",
      estimate: "m",
      selectedTagIds: ["o_AAAAAAAA", "o_BBBBBBBB", "o_CCCCCCCC"],
      tagOptions: [
        { id: "o_AAAAAAAA", name: "UI", color: "blue" },
        { id: "o_BBBBBBBB", name: "Polish", color: "green" },
        { id: "o_CCCCCCCC", name: "Polish", color: "yellow" },
      ],
    });

    expect(input).toEqual({
      title: "Ship create modal",
      description: "## Context\n\nKeep the creation draft local until submit.",
      priority: "p1-high",
      estimate: "m",
      tagOptions: [
        { optionId: "o_AAAAAAAA", name: "UI" },
        { optionId: "o_BBBBBBBB", name: "Polish" },
      ],
    });
    draft.document.destroy();
  });

  test("uses a fresh collaborative identity for each create-more generation", () => {
    const first = createPageCreateDescriptionDraft("request-1", 0);
    const second = createPageCreateDescriptionDraft("request-1", 1);

    expect(first.documentId).not.toBe(second.documentId);
    expect(first.body).not.toBe(second.body);
    expect(second.generation).toBe(1);
    first.document.destroy();
    second.document.destroy();
  });

  test("rejects an empty title and a tag selection that lost its option authority", () => {
    const draft = createPageCreateDescriptionDraft("request-2");

    expect(() =>
      buildPageCreateInput({
        title: "   ",
        descriptionDraft: draft,
        priority: null,
        estimate: null,
        selectedTagIds: [],
        tagOptions: [],
      }),
    ).toThrow("Page title is required");
    expect(() => resolvePageCreateTagNames(["missing"], [])).toThrow(
      "A selected tag is no longer available",
    );
    draft.document.destroy();
  });

  test("captures a pure recoverable snapshot and hydrates it into a fresh document", () => {
    const first = createPageCreateDescriptionDraft("request-restore");
    populateBlockDocumentBodyFromMarkdown(first.body, "Recover this body");
    const snapshot = capturePageCreateDraftSnapshot({
      title: "Recover this Page",
      descriptionDraft: first,
      status: "doing",
      priority: "p1-high",
      estimate: "m",
      selectedTagIds: ["tag-ui"],
      tagOptions: [{ id: "tag-ui", name: "UI", color: "blue" }],
      createMore: true,
      expanded: true,
    });
    const restored = createPageCreateDescriptionDraft(
      "request-restored",
      0,
      snapshot.descriptionMarkdown,
    );

    expect(snapshot).toEqual({
      title: "Recover this Page",
      descriptionMarkdown: "Recover this body",
      status: "doing",
      priority: "p1-high",
      estimate: "m",
      tagNames: ["UI"],
      createMore: true,
      expanded: true,
    });
    expect(restored.documentId).not.toBe(first.documentId);
    expect(
      buildPageCreateInput({
        title: snapshot.title,
        descriptionDraft: restored,
        priority: snapshot.priority,
        estimate: snapshot.estimate,
        selectedTagIds: [],
        tagOptions: [],
      }).description,
    ).toBe("Recover this body");
    expect(pageCreateDraftSnapshotsEqual(snapshot, { ...snapshot })).toBe(true);
    expect(
      pageCreateDraftSnapshotsEqual(
        createEmptyPageCreateDraftSnapshot("doing", {
          priority: "p1-high",
          estimate: "m",
          tagNames: ["UI"],
          createMore: true,
          expanded: true,
        }),
        snapshot,
      ),
    ).toBe(false);
    first.document.destroy();
    restored.document.destroy();
  });

  test("keeps draft recovery closable after a selected tag loses authority", () => {
    const draft = createPageCreateDescriptionDraft("request-stale-tag");

    expect(
      capturePageCreateDraftSnapshot({
        title: "Recover the remaining draft",
        descriptionDraft: draft,
        status: "triage",
        priority: null,
        estimate: null,
        selectedTagIds: ["removed-tag"],
        tagOptions: [],
        createMore: false,
        expanded: false,
      }).tagNames,
    ).toEqual([]);
    draft.document.destroy();
  });
});

describe("page create target registry", () => {
  const target = (surfaceId: string, projectId: string): PageCreateTarget => ({
    surfaceId,
    panelTabId: `tab:${surfaceId}`,
    project: {
      id: projectId,
      name: projectId,
      appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
    },
    databaseViewId: `view:${surfaceId}`,
    clientSessionId: "session-test",
    routingContext: { kind: "project", projectId },
    properties: [],
    columns: [
      { id: "triage", name: "Triage" },
      { id: "plan", name: "Plan" },
    ],
  });

  describe("Page create target registration", () => {
    let store: MaitaiStore;
    let appHandle: ScopeHandle;

    beforeEach(() => {
      store = createMaitaiStore();
      appHandle = createScopeHandle(getMaitaiRootView(store));
    });

    afterEach(() => disposeMaitaiStore(store));

    test("keeps mounted View targets separate and removes only the unmounted View", () => {
      const left = target("left", "project:alpha");
      const right = target("right", "project:alpha");
      registerPageCreateTarget(appHandle, "left-token", left);
      registerPageCreateTarget(appHandle, "right-token", right);

      expect(getPageCreateTarget(appHandle, left.surfaceId)).toBe(left);
      expect(getPageCreateTarget(appHandle, right.surfaceId)).toBe(right);

      unregisterPageCreateTarget(appHandle, left.surfaceId, "left-token");

      expect(getPageCreateTarget(appHandle, left.surfaceId)).toBeNull();
      expect(getPageCreateTarget(appHandle, right.surfaceId)).toBe(right);
    });

    test("returns the latest target and ignores cleanup from an earlier mount", () => {
      const original = target("view", "project:alpha");
      const updated = { ...original, clientSessionId: "replacement-session" };
      registerPageCreateTarget(appHandle, "original-token", original);
      registerPageCreateTarget(appHandle, "replacement-token", updated);

      unregisterPageCreateTarget(appHandle, original.surfaceId, "original-token");
      expect(getPageCreateTarget(appHandle, original.surfaceId)).toBe(updated);

      unregisterPageCreateTarget(appHandle, original.surfaceId, "replacement-token");
      expect(getPageCreateTarget(appHandle, original.surfaceId)).toBeNull();
    });
  });
});

describe("page draft store", () => {
  test("stores and clears scoped draft overlays", () => {
    resetPageDraftStoreForTest();

    setPageDraftOverlay("default", "page-1", {
      title: "Draft title",
    });

    const stored = getPageDraftOverlay("default", "page-1");
    expect(stored?.title).toBe("Draft title");

    clearPageDraftOverlay("default", "page-1");
    expect(getPageDraftOverlay("default", "page-1")).toBe(null);
  });

  test("isolates opaque Project and Page identities that contain colons", () => {
    resetPageDraftStoreForTest();
    setPageDraftOverlay("project:a", "page", { title: "First" });
    setPageDraftOverlay("project", "a:page", { title: "Second" });

    clearPageDraftOverlay("project:a", "page");

    expect(getPageDraftOverlay("project:a", "page")).toBe(null);
    expect(getPageDraftOverlay("project", "a:page")?.title).toBe("Second");
  });

  test("merges overlays without touching unrelated fields", () => {
    const merged = mergePageDraftOverlay(
      {
        id: "page-1",
        title: "Persisted title",
        description: "Persisted body",
        priority: "p2-medium",
      },
      {
        title: "Draft title",
      },
    );

    expect(merged?.title).toBe("Draft title");
    expect(merged?.description).toBe("Persisted body");
    expect(merged?.priority).toBe("p2-medium");
  });
});

describe("Page File query cache", () => {
  test("invalidates retained Page File inventories across access contexts", async () => {
    const client = new QueryClient();
    const sourceProject = queryKeys.library.pageFilesWindow(
      { kind: "project", projectId: "project:one" },
      "page:source",
      "",
    );
    const sourceLibrary = queryKeys.library.pageFilesWindow(
      { kind: "library" },
      "page:source",
      "image",
    );
    const unrelated = queryKeys.library.pageFilesWindow(
      { kind: "project", projectId: "project:one" },
      "page:other",
      "",
    );
    client.setQueryData(sourceProject, { revision: 1 });
    client.setQueryData(sourceLibrary, { revision: 1 });
    client.setQueryData(unrelated, { revision: 1 });

    await invalidateCachedPageFileQueries(client, "page:source");

    expect(client.getQueryState(sourceProject)?.isInvalidated).toBe(true);
    expect(client.getQueryState(sourceLibrary)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
  });
});

describe("page file tree", () => {
  const file = (
    fileId: string,
    logicalPath: string | null,
    sourceKey: string | null = "agent:chat",
    attachedAtMs: number | null = 1_000,
  ): PageFileTreeFile<null> => ({
    fileId,
    logicalPath,
    defaultName: logicalPath?.split("/").at(-1) ?? `${fileId}.png`,
    sourceKey,
    attachedAtMs,
    value: null,
  });

  const outline = (rows: ReturnType<typeof buildPageFileTree<null>>["rows"]) =>
    rows.map((row) => {
      const label = `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.name}/` : row.name}`;
      const source = row.kind !== "group" && row.provenance ? ` <${row.provenance.sourceKey}>` : "";
      return `${label}${source}`;
    });

  describe("buildPageFileTree", () => {
    it("states one shared origin in the summary and nowhere else", () => {
      const tree = buildPageFileTree([
        file("trace", "profile/trace.json", "agent:chat", 3_000),
        file("report", "profile/report.html", "agent:chat", 1_000),
        file("flame", "profile/flamegraph.png", "agent:chat", 2_000),
      ]);

      expect(tree.provenance).toEqual({ sourceKey: "agent:chat", latestAttachedAtMs: 3_000 });
      expect(outline(tree.rows)).toEqual([
        "profile/",
        "  flamegraph.png",
        "  report.html",
        "  trace.json",
      ]);
    });

    it("moves origins down to the narrowest folder or File they cover", () => {
      const tree = buildPageFileTree([
        file("report", "profile/report.html", "agent:chat"),
        file("trace", "profile/raw/trace.json", "agent:chat"),
        file("brief", "brief.pdf", "person"),
        file("old", "notes/old.md", "agent:other"),
        file("new", "notes/new.md", "person"),
      ]);

      expect(tree.provenance).toBeNull();
      expect(outline(tree.rows)).toEqual([
        "notes/",
        "  new.md <person>",
        "  old.md <agent:other>",
        "profile/ <agent:chat>",
        "  raw/",
        "    trace.json",
        "  report.html",
        "brief.pdf <person>",
      ]);
    });

    it("folds body-only Files into a trailing group beside attachments", () => {
      const files = [file("report", "profile/report.html"), file("photo", null, null, null)];

      const folded = buildPageFileTree(files);
      expect(folded.provenance).toBeNull();
      expect(outline(folded.rows)).toEqual(["profile/ <agent:chat>", "  report.html", "In page"]);
      expect(folded.rows.at(-1)).toMatchObject({ kind: "group", expanded: false, fileCount: 1 });

      const unfolded = buildPageFileTree(files, { bodyGroupExpanded: true });
      expect(outline(unfolded.rows)).toEqual([
        "profile/ <agent:chat>",
        "  report.html",
        "In page",
        "  photo.png",
      ]);
      expect(unfolded.rows.at(-1)).toMatchObject({ kind: "file", provenance: null });
    });

    it("lists body-only Files plainly when the Page has no attachments", () => {
      const tree = buildPageFileTree([file("b", null, null, null), file("a", null, null, null)]);

      expect(outline(tree.rows)).toEqual(["a.png", "b.png"]);
    });

    it("hides the contents of folded folders but keeps their counts", () => {
      const tree = buildPageFileTree(
        [
          file("a", "profile/a.json"),
          file("b", "profile/raw/b.json"),
          file("c", "c.txt", "person"),
        ],
        { collapsedFolders: new Set(["profile"]) },
      );

      expect(outline(tree.rows)).toEqual(["profile/ <agent:chat>", "c.txt <person>"]);
      expect(tree.rows[0]).toMatchObject({ kind: "folder", expanded: false, fileCount: 2 });
    });

    it("orders folders before Files and names naturally", () => {
      const tree = buildPageFileTree([
        file("10", "run 10.json"),
        file("2", "run 2.json"),
        file("z", "zeta/a.txt"),
        file("A", "Alpha/a.txt"),
      ]);

      expect(outline(tree.rows)).toEqual([
        "Alpha/",
        "  a.txt",
        "zeta/",
        "  a.txt",
        "run 2.json",
        "run 10.json",
      ]);
    });

    it("states an origin without a time when none was recorded", () => {
      const tree = buildPageFileTree([file("a", "a.txt", "external", null)]);

      expect(tree.provenance).toEqual({ sourceKey: "external", latestAttachedAtMs: null });
    });
  });
});

describe("page file view kind", () => {
  const kind = (name: string, mimeType = "application/octet-stream") =>
    resolvePageFileViewKind({ name, mimeType });

  describe("resolvePageFileViewKind", () => {
    it("prefers the recorded MIME type and falls back to the name", () => {
      expect(kind("report", "text/html; charset=utf-8")).toBe("html");
      expect(kind("report.html")).toBe("html");
      expect(kind("flamegraph.png", "image/png")).toBe("image");
      expect(kind("photo.JPG")).toBe("image");
      expect(kind("trace.json", "application/json")).toBe("text");
      expect(kind("notes.md", "text/plain")).toBe("markdown");
      expect(kind("diagram.svg", "image/svg+xml")).toBe("svg");
      expect(kind("brief.pdf")).toBe("pdf");
      expect(kind("call.m4a", "audio/mp4")).toBe("audio");
      expect(kind("demo.webm")).toBe("video");
      expect(kind("events.ndjson")).toBe("text");
      expect(kind("data.geo+json", "application/geo+json")).toBe("text");
    });

    it("does not render formats Chromium cannot show", () => {
      expect(kind("scan.tiff", "image/tiff")).toBe("unsupported");
      expect(kind("archive.zip", "application/zip")).toBe("unsupported");
      expect(kind("binary")).toBe("unsupported");
    });

    it("offers a source view only for rendered text formats", () => {
      expect(pageFileHasSourceView("html")).toBe(true);
      expect(pageFileHasSourceView("markdown")).toBe(true);
      expect(pageFileHasSourceView("svg")).toBe(true);
      expect(pageFileHasSourceView("text")).toBe(false);
      expect(pageFileHasSourceView("image")).toBe(false);
    });
  });

  describe("describeFileFormat", () => {
    it("names a File's format briefly, by kind when the name has no usable extension", () => {
      expect(describeFileFormat({ name: "guide.md", mimeType: "text/markdown" })).toBe("Markdown");
      expect(describeFileFormat({ name: "notes", mimeType: "text/markdown" })).toBe("Markdown");
      expect(describeFileFormat({ name: "trace.json", mimeType: "application/json" })).toBe("JSON");
      expect(describeFileFormat({ name: "Incident note", mimeType: "text/plain" })).toBe("Text");
      expect(describeFileFormat({ name: "scan", mimeType: "application/pdf" })).toBe("PDF");
      expect(describeFileFormat({ name: "blob", mimeType: "application/octet-stream" })).toBe(
        "File",
      );
      expect(describeFileFormat({ name: "v1.2.3-final", mimeType: "text/plain" })).toBe("Text");
      expect(describeFileFormat({ name: "Hello world. Next", mimeType: "text/plain" })).toBe(
        "Text",
      );
    });
  });
});

describe("page insert menu", () => {
  const item = (key: string, group: string) => ({ key, group });

  describe("groupPageInsertItems", () => {
    test("leads with Agent, Pages and Blocks, then other groups in catalog order", () => {
      const sections = groupPageInsertItems(
        [
          item("emoji", "Text"),
          item("divider", "Blocks"),
          item("embed", "Media"),
          item("subpage", "Pages"),
          item("prompt", "Agent"),
          item("table", "Blocks"),
        ],
        new Set(),
      );

      expect(
        sections.map((section) => [section.label, section.items.map((entry) => entry.key)]),
      ).toEqual([
        ["Agent", ["prompt"]],
        ["Pages", ["subpage"]],
        ["Blocks", ["divider", "table"]],
        ["Inline", ["emoji"]],
        ["Media", ["embed"]],
      ]);
    });

    test("drops excluded entries and any section they leave empty", () => {
      const sections = groupPageInsertItems(
        [item("heading", "Text"), item("bullet_list", "Lists"), item("emoji", "Text")],
        new Set(["heading", "bullet_list"]),
      );

      expect(sections).toEqual([{ label: "Inline", items: [item("emoji", "Text")] }]);
    });
  });
});
