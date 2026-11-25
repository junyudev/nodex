import { describe, expect, test, vi } from "vite-plus/test";
import {
  buildCommandPaletteCharacterHighlightSegments,
  buildCommandPaletteQueryHighlightPreview,
  buildCommandPaletteRangeHighlightSegments,
  buildCommandPaletteTokenHighlightSegments,
  limitCommandPaletteHighlightSegments,
  type CommandPaletteHighlightSegment,
} from "./command-palette-highlight";
import {
  buildCommandPalettePagesFromSearchResults,
  getCommandPalettePageSearchPlan,
  isCommandPalettePageSearchPending,
  selectCommandPalettePageResults,
} from "./command-palette-page-results";
import type { PageSearchResult, Project, ProjectWindow, DatabasePageSummary } from "./types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";
import { openCommandPaletteProjectFolder } from "./command-palette-projects";
import { findFixture, chatFindHit } from "../test/find-fixture";
import {
  cycleCommandPaletteMode,
  filterCommandPaletteItems,
  getCommandPaletteScopes,
  type CommandPalettePage,
  type CommandPaletteCommand,
  type CommandMenuMode,
} from "./command-palette";
import { buildCommandPaletteSectionsModel } from "./command-palette-sections";
import type { ChatSearchMatch } from "../../shared/chat-search";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import { mergeFuzzyMatchSegments, segmentFuzzyMatch } from "./fuzzy-match-segments";

describe("command palette highlight", () => {
  function highlightedText(segments: readonly CommandPaletteHighlightSegment[]): string {
    return segments
      .filter((segment) => segment.highlight)
      .map((segment) => segment.text)
      .join("");
  }

  function fullText(segments: readonly CommandPaletteHighlightSegment[]): string {
    return segments.map((segment) => segment.text).join("");
  }

  describe("command palette character highlighting", () => {
    test("prefers an exact case-insensitive substring", () => {
      const segments = buildCommandPaletteCharacterHighlightSegments("Open Settings", "SET");

      expect(fullText(segments)).toBe("Open Settings");
      expect(highlightedText(segments)).toBe("Set");
    });

    test("highlights repeated and overlapping query tokens", () => {
      const segments = buildCommandPaletteTokenHighlightSegments("banana bandana", "ana nan ana");

      expect(fullText(segments)).toBe("banana bandana");
      expect(highlightedText(segments).length).toBeGreaterThanOrEqual(5);
    });

    test("supports fuzzy command subsequences and rolls back failed matches", () => {
      const matched = buildCommandPaletteCharacterHighlightSegments(
        "Command palette",
        "cmdpal",
        "fuzzy",
      );
      const failed = buildCommandPaletteCharacterHighlightSegments(
        "Command palette",
        "cmdxyz",
        "fuzzy",
      );

      expect(highlightedText(matched).toLocaleLowerCase()).toBe("cmdpal");
      expect(failed).toEqual([{ text: "Command palette", highlight: false }]);
    });

    test("keeps CJK, emoji, and combining marks in one code-point coordinate system", () => {
      const text = "修复 Cafe\u0301 😀 搜索";
      const cjk = buildCommandPaletteCharacterHighlightSegments(text, "修复");
      const emojiAndMark = buildCommandPaletteTokenHighlightSegments(text, "e\u0301 😀");

      expect(fullText(cjk)).toBe(text);
      expect(highlightedText(cjk)).toBe("修复");
      expect(fullText(emojiAndMark)).toBe(text);
      expect(highlightedText(emojiAndMark)).toBe("e\u0301😀");
    });

    test("preserves text for an empty query", () => {
      expect(buildCommandPaletteCharacterHighlightSegments("😀 Search", "")).toEqual([
        { text: "😀 Search", highlight: false },
      ]);
    });

    test("centers a bounded preview around the first matching query token", () => {
      const preview = buildCommandPaletteQueryHighlightPreview(
        `${"prefix ".repeat(20)}projection window ${"suffix ".repeat(20)}`,
        "projection",
        { maxCharacters: 72, leadingContextCharacters: 18 },
      );

      expect(preview?.excerpt.startsWith("…")).toBe(true);
      expect(preview?.excerpt.endsWith("…")).toBe(true);
      expect(preview?.excerpt.includes("projection window")).toBe(true);
      expect(highlightedText(preview?.segments ?? [])).toBe("projection");
    });

    test("keeps a tail match near the visible leading edge instead of backfilling", () => {
      const preview = buildCommandPaletteQueryHighlightPreview(
        "A deliberately longer preview explains that local commits should update only the affected projection window while preserving causal coverage.",
        "caus",
        { maxCharacters: 88, leadingContextCharacters: 18 },
      );

      expect(preview?.excerpt.startsWith("…")).toBe(true);
      expect(preview?.excerpt.endsWith("causal coverage.")).toBe(true);
      expect(preview?.excerpt.indexOf("caus")).toBeLessThanOrEqual(24);
      expect(highlightedText(preview?.segments ?? [])).toBe("caus");
    });

    test("repositions a short excerpt when CSS would ellipsize before its match", () => {
      const preview = buildCommandPaletteQueryHighlightPreview(
        "Exercise the actual desktop boundary at the canonical viewport.",
        "ca",
        { maxCharacters: 88, leadingContextCharacters: 18 },
      );

      expect(preview?.excerpt.startsWith("…")).toBe(true);
      expect(preview?.excerpt.indexOf("ca")).toBeLessThanOrEqual(24);
      expect(highlightedText(preview?.segments ?? [])).toBe("ca");
    });
  });

  test("reported match ranges become segments, and long text keeps its highlights up to the ellipsis", () => {
    expect(
      buildCommandPaletteRangeHighlightSegments("file-index-module.ts", [
        { start: 0, end: 4 },
        { start: 5, end: 8 },
        { start: 40, end: 41 },
      ]),
    ).toEqual([
      { text: "file", highlight: true },
      { text: "-", highlight: false },
      { text: "ind", highlight: true },
      { text: "ex-module.ts", highlight: false },
    ]);
    expect(
      limitCommandPaletteHighlightSegments(
        [
          { text: "ab", highlight: true },
          { text: "cd  ef", highlight: false },
        ],
        5,
      ),
    ).toEqual([
      { text: "ab", highlight: true },
      { text: "cd", highlight: false },
      { text: "…", highlight: false },
    ]);
  });
});

describe("command palette page results", () => {
  const project = {
    id: "project:one",
    name: "Product",
    appearance: DEFAULT_PROJECT_APPEARANCE,
  } as Project;

  const result = (overrides: Partial<PageSearchResult> = {}): PageSearchResult => ({
    projectId: "project:one",
    pageId: "page:one",
    pageKey: "NDX-42",
    title: "Search authority",
    status: { optionId: "doing", label: "In Progress" },
    priority: "p1-high",
    tags: [
      {
        dataSourceId: "source:one",
        propertyId: "tags",
        optionId: "tag:core",
        label: "Core",
      },
    ],
    assignee: { kind: "member", member_id: "Ada" },
    locationLabel: "Product / In Progress",
    titleParts: [
      { text: "Search", highlighted: true },
      { text: " authority", highlighted: false },
    ],
    excerpt: "Search evidence from Core",
    excerptParts: [
      { text: "Search", highlighted: true },
      { text: " evidence from Core", highlighted: false },
    ],
    matches: [
      {
        source: "title",
        quality: "exact",
        parts: [
          { text: "Search", highlighted: true },
          { text: " authority", highlighted: false },
        ],
      },
    ],
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  });

  describe("Core-authoritative command palette Page results", () => {
    test("requests root suggestions while preserving non-empty query thresholds", () => {
      expect(getCommandPalettePageSearchPlan("root", "  ")).toEqual({ searchLimit: 60 });
      expect(getCommandPalettePageSearchPlan("root", "🦊")).toBeNull();
      expect(getCommandPalettePageSearchPlan("root", "🦊猫")).toEqual({ searchLimit: 60 });
      expect(getCommandPalettePageSearchPlan("pages", "")).toEqual({ searchLimit: 60 });
      expect(getCommandPalettePageSearchPlan("actions", "search")).toBeNull();
    });

    test("preserves Core order and consumes typed highlight evidence", () => {
      const pages = buildCommandPalettePagesFromSearchResults({
        results: [result(), result({ pageId: "page:two", title: "Second", pageKey: null })],
        projects: [project],
      });

      expect(pages.map((page) => page.page.id)).toEqual(["page:one", "page:two"]);
      expect(pages[0]?.searchDecorations?.titleSegments).toEqual([
        { text: "Search", highlight: true },
        { text: " authority", highlight: false },
      ]);
      expect(pages[0]?.reveal).toBeUndefined();
    });

    test("uses the matched Block and its original highlighted text as the navigation target", () => {
      const [page] = buildCommandPalettePagesFromSearchResults({
        results: [
          result({
            matches: [
              {
                source: "property",
                quality: "exact",
                propertyId: "owner",
                propertyName: "Owner",
                parts: [{ text: "Ada", highlighted: true }],
              },
              {
                source: "body",
                quality: "prefix",
                blockId: "block:one",
                blockType: "paragraph",
                parts: [
                  { text: "…", highlighted: false },
                  { text: "迁移", highlighted: true },
                  { text: "方案已准备好", highlighted: false },
                ],
              },
            ],
          }),
        ],
        projects: [project],
      });
      expect(page?.reveal).toEqual({ kind: "page-search", blockId: "block:one", text: "迁移" });
    });

    test("treats an empty-query Core request as pending until its batch arrives", () => {
      expect(
        isCommandPalettePageSearchPending({
          batch: null,
          enabled: true,
          query: "",
          scopeKey: "project:one",
        }),
      ).toBe(true);
    });

    test("shows synchronous metadata rows while complete search is still pending", () => {
      const pages = selectCommandPalettePageResults({
        query: "search",
        projects: [project],
        pageSearchScopeKey: project.id,
        pageSearchBatch: {
          query: "search",
          scopeKey: project.id,
          results: [result()],
          status: "pending",
          error: null,
        },
      });

      expect(pages.map((page) => page.page.title)).toEqual(["Search authority"]);
    });
  });
});

describe("command palette projects", () => {
  const project = (id: string, root: string): Project => ({
    id,
    name: id,
    libraryId: "library:test",
    databaseId: "database:test",
    defaultDatabaseViewId: null,
    lifecycle: "active",
    bindingRevision: 1,
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [{ kind: "directory" as const, path: root, order: 0 }],
    primaryWorkspaceRoot: root,
    pinned: false,
    pinnedOrder: null,
    created: new Date(0),
    updated: new Date(0),
  });
  const window = (items: Project[], nextCursor: string | null = null): ProjectWindow => ({
    items,
    nextCursor,
    hasMore: nextCursor !== null,
    storeEpoch: "epoch:test",
    projectionRevision: 1,
  });
  const ports = () => ({
    chooseFolder: vi.fn<() => Promise<string | null>>(async () => "/work/new-project"),
    readProjects: vi.fn(async () => window([])),
    createProject: vi.fn(async () => project("created", "/work/new-project")),
    startChat: vi.fn(async (_projectId: string) => {}),
  });

  test("opening an existing folder selects its Project even beyond the first catalog window", async () => {
    const api = ports();
    api.readProjects.mockResolvedValueOnce(window([project("other", "/work/other")], "next"));
    api.readProjects.mockResolvedValueOnce(window([project("existing", "/work/new-project/")]));
    await openCommandPaletteProjectFolder(api);
    expect(api.readProjects).toHaveBeenLastCalledWith({ first: 100, after: "next" });
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.startChat).toHaveBeenCalledExactlyOnceWith("existing");
  });

  test("an unregistered folder creates a named Project and opens its chat composer", async () => {
    const api = ports();
    await openCommandPaletteProjectFolder(api);
    expect(api.createProject).toHaveBeenCalledExactlyOnceWith({
      name: "new-project",
      sources: ["/work/new-project"],
    });
    expect(api.startChat).toHaveBeenCalledExactlyOnceWith("created");
  });

  test("opening one folder does not reuse a multi-folder Project with another working directory", async () => {
    const api = ports();
    const multiRoot = project("multi", "/work/primary");
    multiRoot.sources.push({ kind: "directory" as const, path: "/work/new-project", order: 1 });
    api.readProjects.mockResolvedValue(window([multiRoot]));
    await openCommandPaletteProjectFolder(api);
    expect(api.createProject).toHaveBeenCalledExactlyOnceWith({
      name: "new-project",
      sources: ["/work/new-project"],
    });
    expect(api.startChat).toHaveBeenCalledExactlyOnceWith("created");
  });

  test.each([
    { existing: "C:\\Work\\Repo", selected: "c:/work/repo/" },
    { existing: "\\\\Server\\Share\\Repo", selected: "//server/share/repo" },
  ])(
    "opening a Windows folder reuses its Project despite path case or separator differences ($existing)",
    async ({ existing, selected }) => {
      const api = ports();
      api.chooseFolder.mockResolvedValue(selected);
      api.readProjects.mockResolvedValue(window([project("existing", existing)]));
      await openCommandPaletteProjectFolder(api);
      expect(api.createProject).not.toHaveBeenCalled();
      expect(api.startChat).toHaveBeenCalledExactlyOnceWith("existing");
    },
  );

  test("opening a distinct POSIX folder preserves case in the new Project source", async () => {
    const api = ports();
    api.chooseFolder.mockResolvedValue("/work/Repo");
    api.readProjects.mockResolvedValue(window([project("existing", "/work/repo")]));
    await openCommandPaletteProjectFolder(api);
    expect(api.createProject).toHaveBeenCalledExactlyOnceWith({
      name: "Repo",
      sources: ["/work/Repo"],
    });
    expect(api.startChat).toHaveBeenCalledExactlyOnceWith("created");
  });

  test("canceling the folder picker leaves Project and navigation state untouched", async () => {
    const api = ports();
    api.chooseFolder.mockResolvedValue(null);
    await openCommandPaletteProjectFolder(api);
    expect(api.readProjects).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.startChat).not.toHaveBeenCalled();
  });

  test("a failed catalog read or creation never opens a chat or duplicates a Project", async () => {
    const api = ports();
    api.readProjects.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(openCommandPaletteProjectFolder(api)).rejects.toThrow("Unavailable");
    expect(api.createProject).not.toHaveBeenCalled();
    api.createProject.mockRejectedValueOnce(new Error("Cannot create"));
    await expect(openCommandPaletteProjectFolder(api)).rejects.toThrow("Cannot create");
    expect(api.startChat).not.toHaveBeenCalled();
  });
});

describe("command palette", () => {
  function makePage(overrides: Partial<DatabasePageSummary> = {}): DatabasePageSummary {
    const descriptionPreview =
      overrides.descriptionPreview ?? "Add quick page switching and commands.";
    const title = overrides.title ?? "Polish command palette";
    return {
      id: overrides.id ?? "page-1",
      pageKey: overrides.pageKey ?? null,
      title,
      richTitle: overrides.richTitle ?? plainTextToPortableRichText(title),
      descriptionPreview,
      descriptionLength: overrides.descriptionLength ?? descriptionPreview.length,
      hasDescription: overrides.hasDescription ?? descriptionPreview.length > 0,
      status: overrides.status ?? "doing",
      archived: overrides.archived ?? false,
      priority: overrides.priority,
      estimate: overrides.estimate,
      tags: overrides.tags ?? ["search"],
      dueDate: overrides.dueDate,
      scheduledStart: overrides.scheduledStart,
      scheduledEnd: overrides.scheduledEnd,
      isAllDay: overrides.isAllDay ?? false,
      recurrence: overrides.recurrence,
      reminders: overrides.reminders ?? [],
      scheduleTimezone: overrides.scheduleTimezone,
      assignee: overrides.assignee,
      runInTarget: overrides.runInTarget ?? "localProject",
      runInLocalPath: overrides.runInLocalPath,
      runInBaseBranch: overrides.runInBaseBranch,
      runInWorktreePath: overrides.runInWorktreePath,
      runInEnvironmentPath: overrides.runInEnvironmentPath,
      revision: overrides.revision ?? 1,
      created: overrides.created ?? new Date("2026-03-13T00:00:00.000Z"),
      order: overrides.order ?? 0,
    };
  }

  function makeCommand(overrides: Partial<CommandPaletteCommand> = {}): CommandPaletteCommand {
    return {
      kind: "command",
      id: overrides.id ?? "open-settings",
      group: overrides.group ?? "Configure",
      title: overrides.title ?? "Open settings",
      subtitle: overrides.subtitle ?? "App preferences",
      keywords: overrides.keywords ?? ["settings", "preferences"],
      shortcut: overrides.shortcut,
      active: overrides.active ?? false,
      disabled: overrides.disabled ?? false,
      priority: overrides.priority ?? 100,
    };
  }

  function makePalettePage(overrides: Partial<CommandPalettePage> = {}): CommandPalettePage {
    const page = overrides.page ?? makePage();
    return {
      kind: "page",
      id: overrides.id ?? `${overrides.projectId ?? "default"}:${page.id}`,
      projectId: overrides.projectId ?? "default",
      location: overrides.location ?? "Default",
      page,
    };
  }

  function makeChatMatch(sessionId: string, title = `Chat ${sessionId}`): ChatSearchMatch {
    return {
      chat: {
        sessionId,
        threadId: `thread-${sessionId}`,
        title,
        projectId: "default",
        projectName: "Default",
        cwd: null,
        branch: null,
        pullRequests: [],
        pinned: false,
        pinnedOrder: null,
        unread: false,
        activity: "idle",
        createdAt: 1,
        recencyAt: 1,
      },
      titleRanges: [],
      hint: null,
      excerpt: null,
    };
  }

  const NO_CHATS = { findResponse: findFixture("complete") };

  describe("command palette scopes", () => {
    test("keeps workspace discovery available before a folder is selected and cycles both ways", () => {
      const scopes = getCommandPaletteScopes();
      expect(scopes.map((scope) => scope.mode)).toEqual([
        "root",
        "actions",
        "chats",
        "pages",
        "files",
        "text",
      ]);
      let mode: CommandMenuMode = "root";
      const visited: CommandMenuMode[] = [];
      for (let index = 0; index < scopes.length; index += 1) {
        mode = cycleCommandPaletteMode(mode, 1);
        visited.push(mode);
      }
      expect(visited).toEqual(["actions", "chats", "pages", "files", "text", "root"]);
      expect(cycleCommandPaletteMode("root", -1)).toBe("text");
      expect(cycleCommandPaletteMode("text", -1)).toBe("files");
      expect(cycleCommandPaletteMode("files", -1)).toBe("pages");
    });
  });

  describe("command palette discovery sections", () => {
    test("stops offering expansion at sixty even when more candidates exist", () => {
      const matches = Array.from({ length: 65 }, (_, index) => makeChatMatch(`${index}`));
      const sections = (limit: number) =>
        buildCommandPaletteSectionsModel({
          mode: "root",
          query: "chat",
          commands: [],
          pages: [],
          projects: [],
          activeProjectId: null,
          findResponse: findFixture("complete", matches.map(chatFindHit)),
          discoveryLimits: { chats: limit, pages: 5, files: 5, text: 5 },
        });
      const expandable = sections(55).flatItems;
      expect(expandable.filter((item) => item.kind === "chat")).toHaveLength(55);
      expect(expandable.at(-1)).toMatchObject({ kind: "more", scope: "chats" });
      const bounded = sections(60).flatItems;
      expect(bounded.map((item) => item.id)).toEqual(
        matches.slice(0, 60).map((match) => `chat:${match.chat.sessionId}`),
      );
    });

    test("lists catalog chats before chats matched only by messages, once each", () => {
      const model = buildCommandPaletteSectionsModel({
        mode: "chats",
        query: "deploy",
        commands: [],
        pages: [],
        projects: [],
        activeProjectId: "default",
        findResponse: findFixture(
          "complete",
          ["title", "both", "message"].map((id) => chatFindHit(makeChatMatch(id))),
        ),
      });
      expect(model.flatItems.map((item) => item.id)).toEqual([
        "chat:title",
        "chat:both",
        "chat:message",
      ]);
      expect(model.flatItems.every((item) => item.kind === "chat" && item.inActiveProject)).toBe(
        true,
      );
      expect(model.chatStatus).toBeNull();
    });

    test("reveals only canonically addressed history results", () => {
      const runtime = makeChatMatch("runtime");
      const native = makeChatMatch("native");
      const opaque = makeChatMatch("opaque");
      const title = makeChatMatch("title");
      const excerpt = {
        text: "Inspect Marigold before opening.",
        role: "assistant" as const,
        ranges: [{ start: 8, end: 16 }],
      };
      const { flatItems } = buildCommandPaletteSectionsModel({
        mode: "root",
        query: "marigold",
        commands: [],
        pages: [],
        projects: [],
        activeProjectId: null,
        findResponse: findFixture(
          "complete",
          [
            title,
            {
              ...runtime,
              historyMatch: {
                sessionId: runtime.chat.sessionId,
                sourceThreadId: runtime.chat.threadId!,
                itemId: "output-item",
                runId: "run-early",
                matchedText: "Marigold",
              },
            },
            { ...native, excerpt },
            { ...opaque, excerpt: { ...excerpt, ranges: [] } },
          ].map(chatFindHit),
        ),
      });
      const byId = new Map(
        flatItems.filter((item) => item.kind === "chat").map((item) => [item.id, item.reveal]),
      );
      expect(byId.get("chat:title")).toBeUndefined();
      expect(byId.get("chat:native")).toBeUndefined();
      expect(byId.get("chat:opaque")).toBeUndefined();
      expect(byId.get("chat:runtime")).toEqual({
        kind: "chat-search",
        threadId: runtime.chat.threadId,
        text: "Marigold",
        item: { sourceThreadId: runtime.chat.threadId, itemId: "output-item", runId: "run-early" },
      });
    });

    test("reports failed history only where chats are searched", () => {
      const status = (mode: CommandMenuMode) =>
        buildCommandPaletteSectionsModel({
          mode,
          query: "deploy",
          commands: [],
          pages: [],
          projects: [],
          activeProjectId: null,
          findResponse: findFixture("complete", [], {
            coverage: [{ source: "runtime", state: "unavailable" }],
          }),
        }).chatStatus;
      expect(status("root")).toBe("incomplete");
      expect(status("chats")).toBe("incomplete");
      expect(status("pages")).toBeNull();
    });

    test("orders quick actions by task and excludes mock capabilities", () => {
      const model = buildCommandPaletteSectionsModel({
        mode: "root",
        query: "",
        commands: [
          makeCommand({ id: "openFolder", title: "Open folder", priority: 900 }),
          makeCommand({ id: "captureToInbox", title: "Capture to Inbox", priority: 800 }),
          makeCommand({ id: "newThread", title: "New chat", priority: 1 }),
          makeCommand(),
        ],
        pages: [],
        projects: [],
        activeProjectId: null,
        ...NO_CHATS,
      });
      expect(model.flatItems.map((item) => item.id)).toEqual(["newThread", "openFolder"]);
    });
  });

  describe("filterCommandPaletteItems", () => {
    test("keeps Actions confined to ranked commands even when content matches", () => {
      const result = filterCommandPaletteItems({
        query: "settings",
        mode: "actions",
        commands: [makeCommand(), makeCommand({ id: "back", title: "Go back", keywords: [] })],
        pages: [makePalettePage({ page: makePage({ title: "Settings guide" }) })],
      });

      expect(result.mode).toBe("actions");
      expect(result.commands.map((command) => command.id)).toEqual(["open-settings"]);
      expect(result.pages).toEqual([]);
    });

    test("supports command-only root mode without a > prefix", () => {
      const result = filterCommandPaletteItems({
        query: "sett",
        mode: "root",
        commands: [
          makeCommand(),
          makeCommand({
            id: "search",
            title: "Search tasks",
            subtitle: "Current project",
            keywords: ["find"],
          }),
        ],
        pages: [makePalettePage()],
      });

      expect(result.mode).toBe("root");
      expect(result.commands.length).toBe(1);
      expect(result.commands[0]?.id).toBe("open-settings");
      expect(result.pages.length).toBe(0);
    });

    test("matches and decorates a bounded fuzzy command subsequence", () => {
      const result = filterCommandPaletteItems({
        query: "opnset",
        mode: "root",
        commands: [makeCommand()],
        pages: [],
      });

      expect(result.commands).toHaveLength(1);
      expect(
        result.commands[0]?.searchTitleSegments
          ?.filter((segment) => segment.highlight)
          .map((segment) => segment.text)
          .join("")
          .toLocaleLowerCase(),
      ).toBe("opnset");
    });

    test("root mode searches commands directly", () => {
      const result = filterCommandPaletteItems({
        query: "go",
        mode: "root",
        commands: [
          makeCommand({
            id: "navigateBack",
            title: "Back",
            keywords: ["back"],
            disabled: true,
            priority: 500,
          }),
          makeCommand({
            id: "navigateForward",
            title: "Forward",
            keywords: ["forward"],
            disabled: false,
            priority: 490,
          }),
        ],
        pages: [],
      });

      expect(result.mode).toBe("root");
      expect(result.commands.length).toBe(0);
    });

    test("preserves disabled back and forward commands in root mode", () => {
      const result = filterCommandPaletteItems({
        query: "",
        mode: "root",
        commands: [
          makeCommand({
            id: "navigateBack",
            title: "Back",
            keywords: ["back"],
            disabled: true,
            priority: 500,
          }),
          makeCommand({
            id: "navigateForward",
            title: "Forward",
            keywords: ["forward"],
            disabled: false,
            priority: 490,
          }),
        ],
        pages: [],
      });

      expect(result.commands.length).toBe(2);
      expect(result.commands[0]?.id).toBe("navigateBack");
      expect(result.commands[0]?.disabled).toBe(true);
      expect(result.commands[1]?.id).toBe("navigateForward");
    });
  });

  test("Text discovery expands independently to 100 lines without changing backend order", () => {
    const textMatches = Array.from({ length: 100 }, (_, index) => ({
      kind: "text" as const,
      id: `text:${index}`,
      hostId: "local",
      disabled: false,
      match: {
        path: "/work/a.ts",
        root: "/work",
        relativePath: "a.ts",
        line: index + 1,
        column: 1,
        preview: "needle",
        matchRanges: [{ start: 0, end: 6 }],
      },
    }));
    const build = (limit: number) =>
      buildCommandPaletteSectionsModel({
        mode: "root",
        query: "needle",
        commands: [],
        pages: [],
        projects: [],
        activeProjectId: null,
        ...NO_CHATS,
        textMatches,
        discoveryLimits: { chats: 5, pages: 5, files: 5, text: limit },
      }).flatItems;
    expect(build(5).slice(0, 5)).toEqual(textMatches.slice(0, 5));
    expect(build(5).at(-1)).toMatchObject({ kind: "more", scope: "text" });
    expect(build(95).at(-1)).toMatchObject({ kind: "more", scope: "text" });
    expect(build(100)).toEqual(textMatches);
  });
});

describe("fuzzy match segments", () => {
  describe("fuzzy match segments", () => {
    test.each<[text: string, query: string, matchedIndices: number[]]>([
      ["Model", "mo", [0, 1]],
      ["Plan mode", "pm", [0, 5]],
      ["Clear context", "cc", [0, 6]],
      ["Review PR", "rpr", [0, 7, 8]],
      ["GitHub: Fix CI", "fci", [8, 12, 13]],
      ["agent-browser", "ab", [0, 6]],
      ["/Users/a/skills/x/SKILL.md", "skills/x", [9, 10, 11, 12, 13, 14, 15, 16]],
      ["数据库迁移", "迁移", [3, 4]],
      ["🚀 Plan mode", "🚀m", [0, 7]],
      ["🚀Model", "MO", [1, 2]],
      ["🚀 Go", "  ", [0, 1, 2, 3]],
      ["Plan mode", "zzz", []],
      ["Plan mode", "*", []],
      ["Plan mode (PM)", "  pM  ", [11, 12]],
      ["", "mo", []],
    ])("segments %j for query %j at code-point indices %j", (text, query, matchedIndices) => {
      expect(segmentFuzzyMatch(text, query)).toEqual(
        Array.from(text, (text, index) => ({ text, isMatch: matchedIndices.includes(index) })),
      );
    });

    test("requires a contiguous match in substring mode", () => {
      expect(segmentFuzzyMatch("Plan mode", "pm", "substring")).toEqual(
        Array.from("Plan mode", (text) => ({ text, isMatch: false })),
      );
      expect(segmentFuzzyMatch("MO", "mo", "substring")).toEqual([
        { text: "M", isMatch: true },
        { text: "O", isMatch: true },
      ]);
    });
  });

  test("merges adjacent matches and misses without changing the original segments", () => {
    const segments = Object.freeze([
      Object.freeze({ text: "R", isMatch: true }),
      Object.freeze({ text: "P", isMatch: true }),
      Object.freeze({ text: " ", isMatch: false }),
      Object.freeze({ text: "🚀", isMatch: false }),
      Object.freeze({ text: "2", isMatch: true }),
    ]);

    expect(mergeFuzzyMatchSegments(segments)).toEqual([
      { text: "RP", isMatch: true },
      { text: " 🚀", isMatch: false },
      { text: "2", isMatch: true },
    ]);
    expect(mergeFuzzyMatchSegments([])).toEqual([]);
  });
});
