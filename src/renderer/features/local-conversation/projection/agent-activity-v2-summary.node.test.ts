import { describe, expect, test } from "vite-plus/test";
import {
  buildThreadAgentActivityDynamicCompletedParts,
  demoteSettledThreadAgentActivitySingleton,
  formatThreadAgentActivityCompletedSummary,
  formatThreadAgentActivityGroupHeader,
  buildThreadAgentActivityMcpSourcesWording,
  buildThreadAgentActivityCompletedSummaryParts,
  collectThreadAgentActivitySummaryFacts,
  orderThreadAgentActivityMcpSources,
  resolveThreadAgentActivityGroupState,
  selectThreadAgentActivityMcpIconItem,
  type ThreadAgentActivitySummaryFact,
} from "./agent-activity-v2-summary";

function paths(...values: string[]): ReadonlySet<string> {
  return new Set(values);
}

describe("v2 activity summary fact accumulator", () => {
  test("dedupes path sets while retaining additive line and command counts", () => {
    const facts = collectThreadAgentActivitySummaryFacts([
      {
        type: "patch",
        createdPaths: paths("a.ts"),
        runningCreatedPaths: paths("a.ts"),
        stoppedCreatedPaths: paths(),
        runningCreatedLineCount: 2,
        changedLineCount: 3,
        editedPaths: paths("b.ts"),
        runningEditedPaths: paths(),
        deletedPaths: paths(),
        runningDeletedPaths: paths(),
      },
      {
        type: "patch",
        createdPaths: paths("a.ts"),
        runningCreatedPaths: paths(),
        stoppedCreatedPaths: paths("a.ts"),
        runningCreatedLineCount: 4,
        changedLineCount: 5,
        editedPaths: paths("b.ts", "c.ts"),
        runningEditedPaths: paths("c.ts"),
        deletedPaths: paths("d.ts"),
        runningDeletedPaths: paths("d.ts"),
      },
      { type: "exec", isInProgress: false },
      { type: "exec", isInProgress: true, createsFolder: true, searchesWeb: true },
    ]);

    expect(facts.createdFileCount).toBe(1);
    expect(facts.runningCreatedFileCount).toBe(1);
    expect(facts.stoppedCreatedFileCount).toBe(1);
    expect(facts.runningCreatedLineCount).toBe(6);
    expect(facts.changedLineCount).toBe(8);
    expect(facts.editedFileCount).toBe(2);
    expect(facts.runningEditedFileCount).toBe(1);
    expect(facts.deletedFileCount).toBe(1);
    expect(facts.runningDeletedFileCount).toBe(1);
    expect(facts.commandCount).toBe(2);
    expect(facts.runningCommandCount).toBe(1);
    expect(facts.runningFolderCreationCommandCount).toBe(1);
    expect(facts.runningWebSearchCommandCount).toBe(1);
  });

  test("dedupes approval failures globally and MCP sources in first-seen order", () => {
    const duplicateFailure = { id: "review_1", status: "denied" as const };
    const source = {
      key: "browser-use",
      name: "Browser",
      logoUrl: null,
      logoUrlDark: null,
      nativeAppReference: null,
    };
    const facts = collectThreadAgentActivitySummaryFacts([
      {
        type: "mcpToolCall",
        isInProgress: true,
        source,
        automaticApprovalReviewFailures: [duplicateFailure],
      },
      { type: "automaticApprovalReview", ...duplicateFailure },
      {
        type: "mcpToolCall",
        isInProgress: false,
        source: { ...source, name: "Browser latest" },
      },
      {
        type: "mcpToolCall",
        isInProgress: false,
        source: { ...source, key: "server:node_repl", name: "Node REPL" },
        automaticApprovalReviewFailures: [{ id: "review_2", status: "timedOut" }],
      },
    ]);

    expect(facts.deniedRequestCount).toBe(1);
    expect(facts.timedOutRequestCount).toBe(1);
    expect(facts.mcpToolCallCount).toBe(3);
    expect(facts.mcpToolCallSources.map((entry) => entry.key).join(",")).toBe(
      "browser-use,server:node_repl",
    );
    expect(facts.mcpToolCallSources[0]?.name).toBe("Browser latest");
    expect(facts.mcpToolCallSources[0]?.count).toBe(2);
    expect(facts.mcpToolCallSources[0]?.runningCount).toBe(1);
  });

  test("merges visualization commands and per-path activities with create precedence", () => {
    const facts: ThreadAgentActivitySummaryFact[] = [
      { type: "exec", isInProgress: false, visualizationActivityKind: "update" },
      { type: "exec", isInProgress: true, visualizationActivityKind: "create" },
      {
        type: "patch",
        createdPaths: paths(),
        runningCreatedPaths: paths(),
        stoppedCreatedPaths: paths(),
        runningCreatedLineCount: 0,
        changedLineCount: 0,
        editedPaths: paths(),
        runningEditedPaths: paths(),
        deletedPaths: paths(),
        runningDeletedPaths: paths(),
        visualizationActivity: {
          activities: [
            { path: "chart.html", kind: "update" },
            { path: "chart.html", kind: "create" },
          ],
          isInProgress: false,
        },
      },
    ];
    const result = collectThreadAgentActivitySummaryFacts(facts);

    expect(result.visualizationActivity?.kind ?? "").toBe("create");
    expect(result.visualizationActivity?.isInProgress ?? false).toBe(true);
    expect(result.completedVisualizationCommandCount).toBe(1);
    expect(result.runningVisualizationCommandCount).toBe(1);
    expect(result.commandCount).toBe(2);
  });

  test("orders completed parts and removes specialized work from generic counts", () => {
    const facts = collectThreadAgentActivitySummaryFacts([
      {
        type: "exploration",
        readPaths: paths("src/app.ts"),
        runningReadPaths: paths(),
        loadedToolPaths: paths("skills/one/SKILL.md"),
        runningLoadedToolPaths: paths(),
        searchCount: 1,
        runningSearchCount: 0,
        listCount: 0,
        runningListCount: 0,
      },
      {
        type: "patch",
        createdPaths: paths("created.ts", "stopped.ts"),
        runningCreatedPaths: paths(),
        stoppedCreatedPaths: paths("stopped.ts"),
        runningCreatedLineCount: 0,
        changedLineCount: 2,
        editedPaths: paths("edited.ts"),
        runningEditedPaths: paths(),
        deletedPaths: paths("deleted.ts"),
        runningDeletedPaths: paths(),
      },
      { type: "exec", isInProgress: false },
      { type: "exec", isInProgress: false, searchesWeb: true },
      { type: "exec", isInProgress: false, visualizationActivityKind: "create" },
      {
        type: "mcpToolCall",
        isInProgress: false,
        source: {
          key: "server:node_repl",
          name: "Node REPL",
          logoUrl: null,
          logoUrlDark: null,
          nativeAppReference: null,
        },
      },
      {
        type: "mcpToolCall",
        isInProgress: false,
        source: {
          key: "calendar",
          name: "Calendar",
          logoUrl: null,
          logoUrlDark: null,
          nativeAppReference: null,
        },
      },
      { type: "mcpToolCall", isInProgress: false, source: null },
      { type: "webSearch", count: 2, runningCount: 0 },
    ]);
    const parts = buildThreadAgentActivityCompletedSummaryParts(facts, {
      orderedMcpSources: facts.mcpToolCallSources.filter((source) => source.key === "calendar"),
      dynamicParts: [{ kind: "dynamicToolCall", item: "handoff", key: "handoff:1" }],
    });

    expect(parts.map((part) => part.kind).join(",")).toBe(
      "mcpSources,loadedTools,unnamedMcpCalls,fileChanges,stoppedFileCreation,exploration,visualization,commands,webSearch,dynamicToolCall",
    );
    expect(parts.find((part) => part.kind === "fileChanges")?.count ?? 0).toBe(3);
    expect(parts.find((part) => part.kind === "unnamedMcpCalls")?.count ?? 0).toBe(1);
    expect(parts.find((part) => part.kind === "commands")?.count ?? 0).toBe(2);
  });

  test("omits zero and negative adjusted completed parts", () => {
    const facts = collectThreadAgentActivitySummaryFacts([
      { type: "exec", isInProgress: false, searchesWeb: true },
      { type: "exec", isInProgress: false, visualizationActivityKind: "update" },
    ]);
    const parts = buildThreadAgentActivityCompletedSummaryParts(facts);

    expect(parts.map((part) => part.kind).join(",")).toBe("visualization,webSearch");
  });

  test("prioritizes visually identified MCP sources while preserving partition order", () => {
    const sources = [
      {
        key: "plain-a",
        name: "Plain A",
        logoUrl: null,
        logoUrlDark: null,
        nativeAppReference: null,
        count: 1,
        runningCount: 0,
      },
      {
        key: "visual-a",
        name: "Visual A",
        logoUrl: "a.png",
        logoUrlDark: null,
        nativeAppReference: null,
        count: 1,
        runningCount: 0,
      },
      {
        key: "server:node_repl",
        name: "Node REPL",
        logoUrl: null,
        logoUrlDark: null,
        nativeAppReference: null,
        count: 1,
        runningCount: 0,
      },
      {
        key: "visual-b",
        name: "Visual B",
        logoUrl: null,
        logoUrlDark: "b.png",
        nativeAppReference: null,
        count: 1,
        runningCount: 0,
      },
      {
        key: "plain-b",
        name: "Plain B",
        logoUrl: null,
        logoUrlDark: null,
        nativeAppReference: null,
        count: 1,
        runningCount: 0,
      },
    ];
    const ordered = orderThreadAgentActivityMcpSources(sources, [
      { item: "visual-b-item", sourceKey: "visual-b", server: "b", visuallyIdentified: true },
      { item: "visual-a-item", sourceKey: "visual-a", server: "a", visuallyIdentified: true },
    ]);

    expect(ordered.map((source) => source.key).join(",")).toBe("visual-a,visual-b,plain-a,plain-b");
  });

  test("builds MCP browser/source wording metadata with unique display names", () => {
    const wording = buildThreadAgentActivityMcpSourcesWording([
      {
        key: "browser-use",
        name: "Chrome",
        logoUrl: null,
        logoUrlDark: null,
        nativeAppReference: null,
        count: 1,
        runningCount: 0,
      },
      {
        key: "browser-use",
        name: "Chrome duplicate",
        logoUrl: null,
        logoUrlDark: null,
        nativeAppReference: null,
        count: 1,
        runningCount: 0,
      },
      {
        key: "navigate_to_codex_page",
        name: "Codex",
        logoUrl: null,
        logoUrlDark: null,
        nativeAppReference: null,
        count: 1,
        runningCount: 0,
      },
    ]);

    expect(wording.names.join(",")).toBe("the browser,Codex");
    expect(wording.sourceCount).toBe(2);
    expect(wording.subject).toBe("sources");
  });

  test("selects the first source icon item with visual identity preference", () => {
    const source = {
      key: "calendar",
      name: "Calendar",
      logoUrl: null,
      logoUrlDark: null,
      nativeAppReference: null,
      count: 2,
      runningCount: 0,
    };
    const namedPart = { kind: "mcpSources" as const, sources: [source] };
    const items = [
      { item: "plain", sourceKey: "calendar", server: "calendar", visuallyIdentified: false },
      { item: "visual", sourceKey: "calendar", server: "calendar", visuallyIdentified: true },
      { item: "unnamed-node", sourceKey: null, server: "node_repl", visuallyIdentified: false },
      { item: "unnamed-other", sourceKey: null, server: "custom", visuallyIdentified: false },
    ];

    expect(selectThreadAgentActivityMcpIconItem(namedPart, items) ?? "").toBe("visual");
    expect(
      selectThreadAgentActivityMcpIconItem({ kind: "unnamedMcpCalls", count: 1 }, items) ?? "",
    ).toBe("unnamed-other");
  });

  test("dedupes dynamic completed parts by exact key in first-seen order", () => {
    const parts = buildThreadAgentActivityDynamicCompletedParts([
      { item: "read-a", key: "codex_app:read_thread:threadsReadCompleted" },
      { item: "read-b", key: "codex_app:read_thread:threadsReadCompleted" },
      { item: "handoff-a", key: 'codex_app:handoff_thread:["thread-a",null]' },
      { item: "handoff-b", key: 'codex_app:handoff_thread:["thread-b",null]' },
      { item: "settings-a", key: "codex_app:read_settings:" },
      { item: "settings-b", key: "codex_app:read_settings:" },
    ]);

    expect(parts.map((part) => part.item).join(",")).toBe("read-a,handoff-a,handoff-b,settings-a");
    expect(parts.map((part) => part.key).join("|")).toBe(
      'codex_app:read_thread:threadsReadCompleted|codex_app:handoff_thread:["thread-a",null]|codex_app:handoff_thread:["thread-b",null]|codex_app:read_settings:',
    );
  });

  test("uses summary outside the latest open activity slice", () => {
    const unit = {
      kind: "group" as const,
      key: "group",
      items: [
        {
          grouping: "groupable" as const,
          item: {
            id: "web",
            turnId: "turn",
            createdAt: 1,
            updatedAt: 1,
            searchableText: "",
            type: "webSearch" as const,
            status: "inProgress" as const,
            entry: {
              threadId: "thread",
              turnId: "turn",
              itemId: "web",
              type: "web_search",
              kind: "toolCall" as const,
              semanticKind: "webSearch" as const,
              createdAt: 1,
              updatedAt: 1,
              webSearch: { query: "parity", action: null, completed: false, sources: [] },
            },
          },
        },
      ] as const,
    };

    expect(
      resolveThreadAgentActivityGroupState({
        unit,
        isLatestVisibleUnit: false,
        isTurnInProgress: true,
        isActivitySliceClosed: false,
        isExploring: false,
      }).kind,
    ).toBe("summary");
    expect(
      resolveThreadAgentActivityGroupState({
        unit,
        isLatestVisibleUnit: true,
        isTurnInProgress: true,
        isActivitySliceClosed: true,
        isExploring: false,
      }).kind,
    ).toBe("summary");
  });

  test("gives the header to the newest running tool, then the latest exploration, then thinking", () => {
    const buildExec = (
      id: string,
      status: "completed" | "inProgress",
      actionType: "read" | "unknown",
    ) => ({
      grouping: "groupable" as const,
      item: {
        id,
        turnId: "turn",
        createdAt: 1,
        updatedAt: 1,
        searchableText: "",
        type: "exec" as const,
        status,
        entry: {
          threadId: "thread",
          turnId: "turn",
          itemId: id,
          type: "command_execution",
          kind: "commandExecution" as const,
          semanticKind: "exec" as const,
          status,
          createdAt: 1,
          updatedAt: 1,
          commandActions:
            actionType === "read"
              ? [{ type: "read" as const, command: "cat file", name: "file", path: "file" }]
              : [{ type: "unknown" as const, command: "echo done" }],
        },
      },
    });
    const unit = {
      kind: "group" as const,
      key: "group",
      items: [
        buildExec("old-running-read", "inProgress", "read"),
        buildExec("barrier-command", "completed", "unknown"),
        buildExec("latest-read", "completed", "read"),
      ] as const,
    };
    const running = resolveThreadAgentActivityGroupState({
      unit,
      isLatestVisibleUnit: true,
      isTurnInProgress: true,
      isActivitySliceClosed: false,
      isExploring: true,
    });
    const exploring = resolveThreadAgentActivityGroupState({
      unit: {
        ...unit,
        items: unit.items.slice(1) as [(typeof unit.items)[1], (typeof unit.items)[2]],
      },
      isLatestVisibleUnit: true,
      isTurnInProgress: true,
      isActivitySliceClosed: false,
      isExploring: true,
    });
    const thinking = resolveThreadAgentActivityGroupState({
      unit: { ...unit, items: [buildExec("done", "completed", "unknown")] as const },
      isLatestVisibleUnit: true,
      isTurnInProgress: true,
      isActivitySliceClosed: false,
      isExploring: false,
    });

    expect(running.kind === "active" ? running.item.item.id : "").toBe("old-running-read");
    expect(exploring.kind === "active" ? exploring.item.item.id : "").toBe("latest-read");
    expect(thinking.kind).toBe("thinking");
  });

  test("demotes only settled ordinary singletons and one-file patches", () => {
    const completedWeb = {
      grouping: "groupable" as const,
      item: {
        id: "web",
        turnId: "turn",
        createdAt: 1,
        updatedAt: 1,
        searchableText: "",
        type: "webSearch" as const,
        status: "completed" as const,
        entry: {
          threadId: "thread",
          turnId: "turn",
          itemId: "web",
          type: "web_search",
          kind: "toolCall" as const,
          semanticKind: "webSearch" as const,
          createdAt: 1,
          updatedAt: 1,
          webSearch: { query: "parity", action: null, completed: true, sources: [] },
        },
      },
    };
    const completedPatch = {
      grouping: "groupable" as const,
      item: {
        ...completedWeb.item,
        id: "patch",
        type: "fileChange" as const,
        entry: {
          ...completedWeb.item.entry,
          itemId: "patch",
          semanticKind: "patch" as const,
          status: "completed" as const,
          fileChange: {
            changes: {
              "src/app.ts": {
                type: "update" as const,
                unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
                movePath: null,
              },
            },
            success: true,
          },
        },
      },
    };
    const webUnit = { kind: "group" as const, key: "web-group", items: [completedWeb] as const };
    const patchUnit = {
      kind: "group" as const,
      key: "patch-group",
      items: [completedPatch] as const,
    };

    expect(demoteSettledThreadAgentActivitySingleton(webUnit, { kind: "summary" }).kind).toBe(
      "standalone",
    );
    expect(demoteSettledThreadAgentActivitySingleton(webUnit, { kind: "thinking" }).kind).toBe(
      "group",
    );
    expect(demoteSettledThreadAgentActivitySingleton(patchUnit, { kind: "summary" }).kind).toBe(
      "standalone",
    );
    expect(
      demoteSettledThreadAgentActivitySingleton(
        {
          ...patchUnit,
          items: [
            completedPatch,
            { ...completedPatch, item: { ...completedPatch.item, id: "patch-2" } },
          ] as const,
        },
        { kind: "summary" },
      ).kind,
    ).toBe("group");
    expect(
      demoteSettledThreadAgentActivitySingleton(
        {
          ...patchUnit,
          items: [
            {
              ...completedPatch,
              item: {
                ...completedPatch.item,
                entry: {
                  ...completedPatch.item.entry,
                  fileChange: {
                    ...completedPatch.item.entry.fileChange,
                    visualizationActivities: [
                      { path: "visualizations/chart.html", kind: "update" as const },
                    ],
                  },
                },
              },
            },
          ] as const,
        },
        { kind: "summary" },
      ).kind,
    ).toBe("group");
  });

  test("formats settled parts in exact leading/following grammar with Worked fallback", () => {
    const summary = formatThreadAgentActivityCompletedSummary(
      [
        {
          kind: "mcpSources",
          sources: [
            {
              key: "browser-use",
              name: "Browser",
              logoUrl: null,
              logoUrlDark: null,
              nativeAppReference: null,
              count: 1,
              runningCount: 0,
            },
          ],
        },
        { kind: "loadedTools", count: 2 },
        { kind: "fileChanges", count: 1 },
        { kind: "exploration" },
        { kind: "commands", count: 2 },
        { kind: "webSearch" },
        { kind: "dynamicToolCall", item: "thread", key: "thread" },
      ],
      { formatDynamicToolCall: () => "Read thread" },
    );

    expect(summary).toBe(
      "Used the browser integration, loaded tools, edited a file, read files, ran commands, searched the web, Read thread",
    );
    expect(formatThreadAgentActivityCompletedSummary([])).toBe("Worked");
  });

  test("formats active command, patch, web, and thinking headers", () => {
    const execItem = {
      grouping: "groupable" as const,
      item: {
        id: "exec",
        turnId: "turn",
        createdAt: 1,
        updatedAt: 1,
        searchableText: "",
        type: "exec" as const,
        status: "inProgress" as const,
        entry: {
          threadId: "thread",
          turnId: "turn",
          itemId: "exec",
          type: "command_execution",
          kind: "commandExecution" as const,
          semanticKind: "exec" as const,
          status: "inProgress" as const,
          createdAt: 1,
          updatedAt: 1,
          command: " bun test ",
        },
      },
    };

    expect(
      formatThreadAgentActivityGroupHeader({
        state: { kind: "active", item: execItem },
        completedParts: [],
      }),
    ).toBe("Running bun test");
    expect(
      formatThreadAgentActivityGroupHeader({
        state: { kind: "active", item: execItem },
        completedParts: [],
        conversationDetailLevel: "STEPS_PROSE",
      }),
    ).toBe("Running command");
    expect(
      formatThreadAgentActivityGroupHeader({
        state: { kind: "thinking" },
        completedParts: [],
      }),
    ).toBe("Thinking");
  });
});
