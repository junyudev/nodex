import { findFixture, chatFindHit } from "../test/find-fixture";
import { describe, expect, test } from "vite-plus/test";
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
import type { DatabasePageSummary } from "./types";
import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";

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
