import { describe, expect, test } from "vite-plus/test";
import { appToolCatalog } from "../../../../../shared/nodex-app-tools/catalog";
import type { CodexDynamicToolCallView } from "../../../../lib/types";
import {
  NODEX_TOOL_ACTIVITY_TOOLS,
  asFollowingClause,
  joinNodexActivityParts,
  readNodexToolDetail,
  resolveNodexToolActivity,
  splitNodexDocumentBlocks,
  summarizeRepeatedNodexCalls,
} from "./nodex-tool-activity";

const PAGE_ID = "019f0000-0000-7000-8000-000000000001";
const PARENT_ID = "019f0000-0000-7000-8000-000000000002";
const SESSION_ID = "019f0000-0000-7000-8000-000000000003";

function call(
  tool: string,
  argumentsValue: CodexDynamicToolCallView["arguments"] = {},
  output?: unknown,
  overrides: Partial<CodexDynamicToolCallView> = {},
): CodexDynamicToolCallView {
  return {
    callId: `call-${tool}`,
    namespace: "nodex_app",
    tool,
    arguments: argumentsValue,
    status: "completed",
    contentItems:
      output === undefined ? null : [{ type: "inputText", text: JSON.stringify(output) }],
    success: true,
    durationMs: 12,
    completed: true,
    ...overrides,
  };
}

const running = { status: "inProgress", completed: false, success: null } as const;
const failed = { status: "failed", completed: true, success: false } as const;

const label = (value: CodexDynamicToolCallView) => resolveNodexToolActivity(value)?.label;

describe("resolveNodexToolActivity", () => {
  test("presents every tool an Agent can call", () => {
    const callable = [
      ...appToolCatalog.map((tool) => tool.name),
      "list_agent_models",
      "delegate_task",
      "task_status",
      "task_wait",
      "task_send",
      "task_question",
      "task_read",
      "task_cancel",
      "stop_workflow",
    ];
    expect(callable.filter((name) => !NODEX_TOOL_ACTIVITY_TOOLS.includes(name))).toEqual([]);
  });

  test("never leaves an identity or a raw tool name in a sentence", () => {
    const identities = [PAGE_ID, PARENT_ID, SESSION_ID];
    const argumentsWithIdentities = {
      id: PAGE_ID,
      pageId: PAGE_ID,
      pageIds: [PAGE_ID, PARENT_ID],
      sessionId: SESSION_ID,
      viewId: PAGE_ID,
      dataSourceId: PAGE_ID,
      tabId: PAGE_ID,
      targets: [{ sessionId: SESSION_ID }],
      destination: { kind: "page", pageId: PARENT_ID },
      target: { kind: "page", pageId: PAGE_ID },
    };
    for (const tool of NODEX_TOOL_ACTIVITY_TOOLS) {
      for (const phase of [{}, running, failed]) {
        const sentence = label(call(tool, argumentsWithIdentities, undefined, phase));
        for (const identity of identities) expect(sentence).not.toContain(identity);
        if (tool.includes("_")) expect(sentence).not.toContain(tool);
      }
    }
  });

  test("presents a Property batch by its distinct target Pages", () => {
    const values = [{ propertyId: "status", value: "done" }];
    const first = { pageIds: [PAGE_ID], values };
    const single = call("set_page_properties", { updates: [first] });
    expect(resolveNodexToolActivity(single)?.parts.at(-1)).toMatchObject({
      kind: "page",
      pageId: PAGE_ID,
    });
    const second = { pageIds: [PAGE_ID, PARENT_ID], values };
    expect(label(call("set_page_properties", { updates: [first, second] }))).toBe(
      "Updated properties on 2 pages",
    );
  });

  test("names a read by its Page and hides the transport format", () => {
    const read = call("fetch", { id: PAGE_ID, format: "markdown" });

    expect(resolveNodexToolActivity(read)).toMatchObject({
      icon: "page",
      parts: [
        { kind: "text", text: "Read" },
        { kind: "page", pageId: PAGE_ID, title: null },
      ],
    });
    expect(label(read)).toBe("Read page");
    expect(label({ ...read, ...running })).toBe("Reading page");
    expect(label({ ...read, ...failed })).toBe("Couldn't read page");
  });

  test("keeps the title a settled read reports, without inline Markdown", () => {
    const read = call(
      "fetch",
      { id: PAGE_ID },
      {
        data: {
          resource: { id: PAGE_ID, type: "page", title: { markdown: "**Launch** plan" } },
        },
      },
    );

    expect(label(read)).toBe("Read “Launch plan”");
  });

  test("reads a non-Page resource as what it is", () => {
    const resource = (value: Record<string, unknown>) =>
      call("fetch", { id: PAGE_ID }, { data: { resource: { id: PAGE_ID, ...value } } });

    const database = resource({ type: "database", title: { markdown: "Tasks" } });
    expect(resolveNodexToolActivity(database)?.icon).toBe("database");
    expect(label(database)).toBe("Read “Tasks”");
    expect(label(resource({ type: "database" }))).toBe("Read database");
    expect(label(resource({ type: "paragraph" }))).toBe("Read block");
  });

  test.each([
    ["the result itself", (data: unknown) => ({ data })],
    ["a provider's text envelope", (data: unknown) => ({ content: JSON.stringify({ data }) })],
    [
      "an MCP content array",
      (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify({ data }) }] }),
    ],
    [
      "structured content",
      (data: unknown) => ({ content: [], structuredContent: { data }, isError: false }),
    ],
  ])("reads a result from %s", (_shape, wrap) => {
    const search = call(
      "search",
      { query: "launch" },
      wrap({ results: [{ kind: "page", id: PAGE_ID }] }),
    );

    expect(label(search)).toBe("Searched pages for “launch” · 1 result");
    expect(readNodexToolDetail(search).pages).toHaveLength(1);
  });

  test("does not mistake a result's own content field for an envelope", () => {
    const read = call(
      "read_session",
      {},
      { sessionId: SESSION_ID, threadId: "thread-1", content: { items: [] } },
    );

    expect(resolveNodexToolActivity(read)?.parts[1]).toMatchObject({
      kind: "chat",
      sessionId: SESSION_ID,
      threadId: "thread-1",
    });
  });

  test("reports a result count from the compact digest and from a complete output", () => {
    const args = { query: "launch" };

    expect(label(call("search", args, { data: { resultCount: 3 } }))).toBe(
      "Searched pages for “launch” · 3 results",
    );
    expect(
      label(call("search", args, { data: { results: [{ kind: "page", id: PAGE_ID }] } })),
    ).toBe("Searched pages for “launch” · 1 result");
    expect(label(call("search", args))).toBe("Searched pages for “launch”");
    expect(label(call("search", args, undefined, running))).toBe("Searching pages for “launch”");
  });

  test("names a query by its View or Data Source", () => {
    expect(
      label(
        call(
          "query_database_view",
          { viewId: "v" },
          { data: { view: { name: "Roadmap" }, resultCount: 2 } },
        ),
      ),
    ).toBe("Queried view “Roadmap” · 2 rows");
    expect(
      label(
        call(
          "query_data_source",
          { dataSourceId: "d" },
          { data: { dataSource: { name: "Tasks" }, rows: [{}] } },
        ),
      ),
    ).toBe("Queried data source “Tasks” · 1 row");
    expect(label(call("query_database_view", { viewId: "v" }))).toBe("Queried view");
  });

  test("links one created Page once its identity exists, and counts several", () => {
    const one = { destination: { kind: "library" }, pages: [{ title: "Launch plan" }] };

    expect(label(call("create_pages", one, undefined, running))).toBe("Creating “Launch plan”");
    expect(
      resolveNodexToolActivity(
        call("create_pages", one, { data: { pages: [{ pageId: PAGE_ID }] } }),
      )?.parts,
    ).toEqual([
      { kind: "text", text: "Created" },
      { kind: "page", pageId: PAGE_ID, title: "Launch plan" },
    ]);

    const several = call(
      "create_pages",
      {
        destination: { kind: "page", pageId: PARENT_ID },
        pages: [{ title: "Alpha" }, { title: "Beta" }],
      },
      { data: { pages: [{ pageId: PAGE_ID, pageKey: "LAB-1" }, { pageId: PARENT_ID }] } },
    );
    expect(label(several)).toBe("Created 2 pages in page");
    expect(readNodexToolDetail(several).pages.map((page) => page.title)).toEqual(["Alpha", "Beta"]);
  });

  test("survives arguments the timeline withheld", () => {
    const withheld = { summary: "Large tool output", truncated: true };

    expect(label(call("create_pages", withheld))).toBe("Created page");
    expect(
      resolveNodexToolActivity(call("update_page", withheld, { data: { pageId: PAGE_ID } }))?.parts,
    ).toEqual([
      { kind: "text", text: "Updated" },
      { kind: "page", pageId: PAGE_ID, title: null },
    ]);
  });

  test("describes an edit by its effect instead of its wire format", () => {
    const update = resolveNodexToolActivity(
      call("update_page", {
        pageId: PAGE_ID,
        body: {
          kind: "patch",
          patches: [
            { oldMarkdown: "Draft", newMarkdown: "Ready\nShipped" },
            { oldMarkdown: "- [ ] Ship", newMarkdown: "- [x] Ship" },
          ],
        },
      }),
    );

    expect(update?.label).toBe("Updated page");
    expect(update?.change).toMatchObject({ label: "2 edits", additions: 3, deletions: 2 });
    expect(update?.change?.lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "removed:Draft",
      "added:Ready",
      "added:Shipped",
      "separator:Edit 2",
      "removed:- [ ] Ship",
      "added:- [x] Ship",
    ]);
  });

  test("bounds a large edit while keeping exact line statistics", () => {
    const oldMarkdown = Array.from({ length: 100 }, (_, index) => `Old ${index + 1}`).join("\n");
    const newMarkdown = Array.from({ length: 100 }, (_, index) => `New ${index + 1}`).join("\n");
    const change = resolveNodexToolActivity(
      call("update_page", {
        pageId: PAGE_ID,
        body: { kind: "patch", patches: [{ oldMarkdown, newMarkdown }] },
      }),
    )?.change;

    expect(change?.lines).toHaveLength(64);
    expect(change?.lines.some((line) => line.text === "Old 1")).toBe(true);
    expect(change?.lines.some((line) => line.text === "New 1")).toBe(true);
    expect(change?.omittedLineCount).toBe(136);
  });

  test("reads a title-only update as a rename", () => {
    expect(
      label(
        call("update_page", { pageId: PAGE_ID, title: { markdown: "New name", ifMatch: "e" } }),
      ),
    ).toBe("Renamed page to “New name”");
  });

  test("names one moved Page and counts several", () => {
    expect(
      resolveNodexToolActivity(
        call("move_pages", {
          pageIds: [PAGE_ID],
          destination: { kind: "page", pageId: PARENT_ID },
        }),
      )?.parts,
    ).toEqual([
      { kind: "text", text: "Moved" },
      { kind: "page", pageId: PAGE_ID, title: null },
      { kind: "text", text: "to" },
      { kind: "page", pageId: PARENT_ID, title: null },
    ]);
    expect(
      label(
        call("move_pages", { pageIds: [PAGE_ID, PARENT_ID], destination: { kind: "library" } }),
      ),
    ).toBe("Moved 2 pages to Library");
  });

  test("links a duplicate to the copy it made once it exists", () => {
    const args = { pageId: PAGE_ID, destination: { kind: "library" } };
    const parts = (value: CodexDynamicToolCallView) => resolveNodexToolActivity(value)?.parts[1];

    expect(parts(call("duplicate_page", args, undefined, running))).toMatchObject({
      pageId: PAGE_ID,
    });
    expect(parts(call("duplicate_page", args, { data: { pageId: PARENT_ID } }))).toMatchObject({
      pageId: PARENT_ID,
    });
  });

  test("addresses a chat by reference and opens the one a result created", () => {
    expect(
      resolveNodexToolActivity(call("read_session", { sessionId: SESSION_ID }))?.parts,
    ).toEqual([
      { kind: "text", text: "Read chat" },
      { kind: "chat", sessionId: SESSION_ID, threadId: null, title: null },
    ]);
    expect(
      resolveNodexToolActivity(
        call(
          "create_session",
          { title: "Plan review", prompt: "Review", target: { type: "projectless" } },
          { sessionId: SESSION_ID, threadId: "thread-1" },
        ),
      )?.parts,
    ).toEqual([
      { kind: "text", text: "Created chat" },
      { kind: "chat", sessionId: SESSION_ID, threadId: "thread-1", title: "Plan review" },
    ]);
    expect(label(call("create_session", { title: "Plan review" }, undefined, running))).toBe(
      "Creating chat “Plan review”",
    );
  });

  test("does not offer a chat a failed call never produced", () => {
    const parts = resolveNodexToolActivity(
      call("fork_session", {}, { sessionId: SESSION_ID, threadId: "thread-1" }, failed),
    )?.parts;

    expect(parts).toEqual([{ kind: "text", text: "Couldn't fork chat" }]);
  });

  test("reads Page work by its key or its Page and the outcome reported", () => {
    expect(label(call("report_work", { pageId: "NODEX-12", outcome: "ready" }))).toBe(
      "Marked NODEX-12 ready for review",
    );
    expect(label(call("report_work", { outcome: "blocked", summary: "Waiting on CI" }))).toBe(
      "Reported work blocked",
    );
    expect(resolveNodexToolActivity(call("start_work", { pageId: PAGE_ID }))?.parts).toEqual([
      { kind: "text", text: "Started work on" },
      { kind: "page", pageId: PAGE_ID, title: null },
    ]);
    expect(
      label(call("follow_thread", { url: "https://github.com/nodex/app/pull/482#discussion" })),
    ).toBe("Followed pull request #482");
    expect(
      label(
        call("inbox_suggest", {
          suggestions: [{ page_ids: [PAGE_ID, PARENT_ID] }, { page_ids: [PAGE_ID] }],
        }),
      ),
    ).toBe("Routed 2 Inbox messages");
  });

  test("names an Automation command by its operation, never by its mode", () => {
    expect(label(call("automations_update", { operation: "list", mode: "run" }))).toBe(
      "Listed automations",
    );
    expect(
      label(call("automations_update", { operation: "suggested_update", name: "Triage" })),
    ).toBe("Proposed automation change “Triage”");
    expect(label({ ...call("automations_update", { operation: "delete" }), ...failed })).toBe(
      "Couldn't delete automation",
    );
  });

  test("states a toggle by the direction it went", () => {
    expect(label(call("set_session_pinned", { pinned: true }))).toBe("Pinned chat");
    expect(label(call("set_session_pinned", { pinned: false }))).toBe("Unpinned chat");
    expect(label(call("set_session_archived", { archived: false }))).toBe("Restored chat");
    expect(label(call("set_session_reminder", { remindAt: null }))).toBe("Cleared chat reminder");
    expect(label(call("set_session_unread", { unread: false }))).toBe("Marked chat read");
  });

  test("names what a tab call opened", () => {
    const open = (target: CodexDynamicToolCallView["arguments"]) =>
      label(call("open_in_nodex", { target }));

    expect(open({ kind: "file", path: "/repo/src/plan.md" })).toBe("Opened plan.md");
    expect(open({ kind: "review" })).toBe("Opened review");
    expect(open({ kind: "terminal" })).toBe("Opened terminal");
    expect(
      resolveNodexToolActivity(call("open_tab", { target: { kind: "page", pageId: PAGE_ID } }))
        ?.parts[1],
    ).toMatchObject({ kind: "page", pageId: PAGE_ID });
  });

  test("leaves tools outside the Nodex namespace to their own presentation", () => {
    expect(
      resolveNodexToolActivity(call("fetch", {}, undefined, { namespace: "other" })),
    ).toBeNull();
    expect(resolveNodexToolActivity(call("unknown_tool"))).toBeNull();
  });
});

describe("joinNodexActivityParts", () => {
  const page = { kind: "page", pageId: PAGE_ID, title: null } as const;

  test("keeps adjacent words one string and spaces them around a reference", () => {
    expect(
      joinNodexActivityParts(
        [
          { kind: "text", text: "Moved" },
          page,
          { kind: "text", text: "to" },
          { kind: "text", text: "Library" },
        ],
        false,
      ),
    ).toEqual(["Moved ", page, " to Library"]);
  });

  test("lowers only the first word of a following clause", () => {
    expect(
      joinNodexActivityParts(
        [
          { kind: "text", text: "Read" },
          { kind: "text", text: "Library" },
        ],
        true,
      ),
    ).toEqual(["read Library"]);
  });
});

describe("what opening a row offers", () => {
  const expandable = (value: CodexDynamicToolCallView) =>
    resolveNodexToolActivity(value)?.expandable;
  const withheld = { outputOmitted: true };

  test("opens only when a person has something to read", () => {
    expect(expandable(call("fetch", { id: PAGE_ID }))).toBe(true);
    expect(expandable(call("fetch", { id: PAGE_ID, format: "blocks" }))).toBe(false);
    expect(expandable(call("fetch", { id: PAGE_ID }, undefined, running))).toBe(false);
    expect(expandable(call("search", { query: "x" }, { data: { resultCount: 2 } }))).toBe(true);
    expect(expandable(call("search", { query: "x" }, { data: { resultCount: 0 } }))).toBe(false);
    expect(
      expandable(call("update_page", { pageId: PAGE_ID, body: { kind: "insert", markdown: "x" } })),
    ).toBe(true);
    expect(expandable(call("send_to_inbox", { body: "Check owners" }))).toBe(true);

    for (const plumbing of ["list_projects", "get_context", "query_content", "read_session"])
      expect(expandable(call(plumbing, {}))).toBe(false);
  });

  test("always opens a failure, which has its reason to give", () => {
    expect(expandable(call("list_projects", {}, undefined, failed))).toBe(true);
  });

  test("reads the Markdown a read returned, through any provider envelope", () => {
    const body = { data: { content: { format: "markdown", markdown: "# Plan" } } };

    expect(readNodexToolDetail(call("fetch", { id: PAGE_ID }, body)).document).toBe("# Plan");
    expect(
      readNodexToolDetail(call("fetch", { id: PAGE_ID }, { content: JSON.stringify(body) }))
        .document,
    ).toBe("# Plan");
  });

  test("does not mistake a settled digest for a result", () => {
    const digest = { data: { resource: { id: PAGE_ID, type: "page" } } };

    expect(readNodexToolDetail(call("fetch", { id: PAGE_ID }, digest, withheld))).toEqual({
      document: null,
      message: null,
      pages: [],
      failure: null,
    });
    expect(
      readNodexToolDetail(
        call("fetch", { id: PAGE_ID }, { isError: true }, { ...failed, ...withheld }),
      ).failure,
    ).toBeNull();
  });

  test("states a failure in the words the tool gave", () => {
    expect(
      readNodexToolDetail(
        call(
          "fetch",
          { id: PAGE_ID },
          { content: JSON.stringify({ message: "Page was not found", code: "not_found" }) },
          failed,
        ),
      ).failure,
    ).toBe("Page was not found");
    expect(
      readNodexToolDetail(
        call("get_usage_limits", {}, { content: "account_unavailable", isError: true }, failed),
      ).failure,
    ).toBe("account_unavailable");
  });

  test("reads the failure Claude reports as labelled text, without its identities", () => {
    const report = JSON.stringify({
      message: `Page or Block ${PAGE_ID} was not found`,
      code: "not_found",
      details: { resourceId: PAGE_ID },
    });
    const detail = (text: string) =>
      readNodexToolDetail({
        ...call("fetch", { id: PAGE_ID }, undefined, failed),
        contentItems: [{ type: "inputText", text }],
      }).failure;

    expect(detail(`Error: ${report}`)).toBe("Page or Block was not found");
    expect(detail(JSON.stringify({ content: `Error: ${report}`, isError: true }))).toBe(
      "Page or Block was not found",
    );
    expect(detail("Error: account_unavailable")).toBe("account_unavailable");
  });

  test("lists the Pages behind a search, using the owning Page for a Block match", () => {
    const search = call(
      "search",
      { query: "launch" },
      {
        data: {
          results: [
            { kind: "page", id: PAGE_ID, title: "Launch plan", pageKey: "LAB-13" },
            { kind: "block", id: "block-1", ownerPageId: PARENT_ID, excerpt: "launch window" },
          ],
        },
      },
    );

    expect(readNodexToolDetail(search).pages).toEqual([
      { pageId: PAGE_ID, title: "Launch plan", pageKey: "LAB-13", excerpt: null },
      { pageId: PARENT_ID, title: null, pageKey: null, excerpt: "launch window" },
    ]);
  });

  test("offers what the Agent wrote to someone verbatim", () => {
    expect(
      readNodexToolDetail(call("send_message_to_session", { sessionId: SESSION_ID, prompt: "Hi" }))
        .message,
    ).toBe("Hi");
    expect(readNodexToolDetail(call("send_to_inbox", { body: "Check owners" })).message).toBe(
      "Check owners",
    );
    expect(
      readNodexToolDetail(call("report_work", { outcome: "ready", summary: "Tests pass" })).message,
    ).toBe("Tests pass");
    expect(readNodexToolDetail(call("start_work", { pageId: PAGE_ID })).message).toBeNull();
  });

  test("lifts child Pages out of a read document and drops identity-only embeds", () => {
    const paragraph = { type: "paragraph", content: "Goals" };

    expect(
      splitNodexDocumentBlocks([
        paragraph,
        { type: "page", id: PAGE_ID },
        { type: "database", id: PARENT_ID },
        { type: "bulletListItem", children: [{ type: "page", id: PARENT_ID }, paragraph] },
      ]),
    ).toEqual({
      blocks: [paragraph, { type: "bulletListItem", children: [paragraph] }],
      childPageIds: [PAGE_ID, PARENT_ID],
    });
  });
});

describe("summarizeRepeatedNodexCalls", () => {
  const read = (callId: string, overrides: Partial<CodexDynamicToolCallView> = {}) =>
    call("fetch", { id: callId }, undefined, { callId, ...overrides });

  test("folds calls of one kind into the first call's clause", () => {
    const clauses = summarizeRepeatedNodexCalls([
      read("a"),
      call("search", { query: "x" }, undefined, { callId: "s" }),
      read("b"),
      read("c"),
    ]);

    expect(clauses.get("a")).toBe("Read 3 pages");
    expect(clauses.get("b")).toBeNull();
    expect(clauses.get("c")).toBeNull();
    expect(clauses.has("s")).toBe(false);
  });

  test("leaves a lone call and a failed call their own sentence", () => {
    const clauses = summarizeRepeatedNodexCalls([read("a"), read("b", failed)]);

    expect(clauses.size).toBe(0);
  });

  test("continues a clause in lowercase", () => {
    expect(asFollowingClause("Read 3 pages")).toBe("read 3 pages");
  });
});
