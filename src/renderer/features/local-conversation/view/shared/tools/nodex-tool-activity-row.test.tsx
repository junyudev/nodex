import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { PageTargetReadModel } from "../../../../../../shared/page-targets";
import type { CodexDynamicToolCallView, CodexTranscriptEntry } from "../../../../../lib/types";
import { render, textContent } from "../../../../../test/dom";
import { NodexTooltipProvider as TooltipProvider } from "../../../../../components/ui/tooltip";
import { ConversationPageNavigationProvider } from "../../../conversation-page-navigation";
import {
  ConversationRuntimeContext,
  type ConversationRuntime,
} from "../../../conversation-runtime";
import { DynamicToolCall, DynamicToolCallSummary } from "./dynamic-tool-call";
import { presentNodexPageName } from "./nodex-tool-activity-row";

const PAGE_ID = "019f0000-0000-7000-8000-000000000001";
const CHILD_PAGE_ID = "019f0000-0000-7000-8000-000000000002";
const SESSION_ID = "019f0000-0000-7000-8000-000000000003";

const available = (title: string): PageTargetReadModel =>
  ({
    status: "available",
    targetPageId: PAGE_ID,
    libraryId: "library-1",
    storeEpoch: "epoch",
    commitSeq: 1,
    page: { pageId: PAGE_ID, title, lifecycle: "active" },
    document: { readiness: "ready", schemaKey: "page", schemaVersion: 1 },
  }) as unknown as PageTargetReadModel;

const authority = { libraryId: "library-1", storeEpoch: "epoch", commitSeq: 1 };

const targets = vi.hoisted(() => ({ current: null as unknown }));
const sessions = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/block-reference-queries", () => ({
  usePageTargetReadModel: () => ({ data: targets.current, loading: false, error: null }),
}));

vi.mock("@/components/ui/lazy-source-viewer", () => ({
  LazySourceViewer: ({ value }: { readonly value: string }) => <pre>{value}</pre>,
  preloadSourceViewer: () => undefined,
}));

vi.mock("@/lib/use-library-navigation", () => ({
  useLibraryFileReadAuthority: () => null,
  useLibraryMetadata: () => ({ data: null }),
}));

vi.mock("@/lib/query-options", () => ({
  projectSessionDetailQueryOptions: (sessionId: string) => ({
    queryKey: ["session", sessionId],
    queryFn: () => sessions.current,
  }),
}));

vi.mock("../../../../../lib/use-theme", () => ({ useTheme: () => ({ resolved: "dark" }) }));

function buildCall(overrides: Partial<CodexDynamicToolCallView>): CodexDynamicToolCallView {
  return {
    callId: "call-1",
    namespace: "nodex_app",
    tool: "fetch",
    arguments: { id: PAGE_ID },
    status: "completed",
    contentItems: null,
    success: true,
    durationMs: 12,
    completed: true,
    ...overrides,
  };
}

function buildEntry(call: CodexDynamicToolCallView): CodexTranscriptEntry {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    entryId: "entry-1",
    itemId: "item-1",
    createdAt: 1,
    updatedAt: 1,
    dynamicToolCall: call,
  } as unknown as CodexTranscriptEntry;
}

function renderRow(ui: ReactElement, onOpenPage: ((id: string) => void) | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ConversationPageNavigationProvider value={onOpenPage}>
          {ui}
        </ConversationPageNavigationProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("presentNodexPageName", () => {
  test("shows the Page's current title over the one the call recorded", () => {
    expect(presentNodexPageName({ title: "Old", target: available("New") })).toEqual({
      text: "New",
      named: true,
      openable: true,
    });
    expect(presentNodexPageName({ title: null, target: available("  ") }).text).toBe("Untitled");
  });

  test("never falls back to an identity", () => {
    const pending = presentNodexPageName({ title: null, target: null });
    const gone = presentNodexPageName({
      title: null,
      target: { ...authority, status: "deleted", targetPageId: PAGE_ID },
    });
    const unknown = presentNodexPageName({
      title: null,
      target: { ...authority, status: "missing", targetPageId: PAGE_ID },
    });
    const other = presentNodexPageName({
      title: null,
      target: {
        ...authority,
        status: "invalid_target",
        targetPageId: PAGE_ID,
        actualBlockType: "database",
      },
    });

    expect(pending).toEqual({ text: "page", named: false, openable: false });
    expect(gone).toEqual({ text: "deleted page", named: false, openable: false });
    expect(unknown).toEqual({ text: "page", named: false, openable: false });
    expect(other).toEqual({ text: "database", named: false, openable: false });
  });

  test("keeps the recorded title of a Page that is gone, without offering to open it", () => {
    expect(
      presentNodexPageName({
        title: "Launch plan",
        target: { ...authority, status: "deleted", targetPageId: PAGE_ID },
      }),
    ).toEqual({ text: "Launch plan", named: true, openable: false });
  });
});

describe("NodexToolActivityRow", () => {
  test("names a read Page and opens it beside the chat", async () => {
    targets.current = available("Launch plan");
    const opened: string[] = [];
    const view = renderRow(<DynamicToolCall item={buildEntry(buildCall({}))} />, (pageId) => {
      opened.push(pageId);
    });

    const link = await view.findByRole("link", { name: "Launch plan" });
    expect(textContent(view.container)).toBe("Read Launch plan");

    await act(async () => {
      fireEvent.click(link);
      await Promise.resolve();
    });

    expect(opened).toEqual([PAGE_ID]);
    expect(
      view.getByRole("button", { name: "Read Launch plan" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("says what it can when a Page is unavailable and offers nothing to open", () => {
    targets.current = { ...authority, status: "missing", targetPageId: PAGE_ID };
    const view = renderRow(
      <DynamicToolCall item={buildEntry(buildCall({ status: "failed", success: false }))} />,
      () => undefined,
    );

    expect(textContent(view.container)).toBe("Couldn't read page");
    expect(view.queryByRole("link")).toBeNull();
  });

  test("names a Page in quotes inside a group summary, which cannot nest a link", () => {
    targets.current = available("Launch plan");
    const view = renderRow(
      <DynamicToolCallSummary
        call={buildCall({})}
        isLeadingSummaryPart={false}
        variant="summary-text"
      />,
      () => undefined,
    );

    expect(textContent(view.container)).toBe("read “Launch plan”");
    expect(view.queryByRole("link")).toBeNull();
  });

  test("loads a withheld result only when opened", async () => {
    targets.current = available("Launch plan");
    const readItemDetail = vi.fn(async () => undefined);
    const runtime = { readItemDetail } as unknown as ConversationRuntime;
    const view = renderRow(
      <ConversationRuntimeContext.Provider value={runtime}>
        <DynamicToolCall item={buildEntry(buildCall({ outputOmitted: true }))} />
      </ConversationRuntimeContext.Provider>,
    );

    expect(readItemDetail).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Read Launch plan" }));
      await Promise.resolve();
    });

    expect(readItemDetail).toHaveBeenCalledWith("thread-1", "item-1");
    expect(await view.findByText("Loading…")).toBeTruthy();
  });

  test("shows a read Page as a document with its child Pages under their names", async () => {
    targets.current = available("Launch plan");
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  content: JSON.stringify({
                    data: {
                      resource: { id: PAGE_ID, type: "page", title: { markdown: "Launch plan" } },
                      content: {
                        format: "markdown",
                        markdown: `## Goals\n\nShip the beta\n\n::page{id="${CHILD_PAGE_ID}"}`,
                      },
                    },
                  }),
                }),
              },
            ],
          }),
        )}
      />,
      () => undefined,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Read Launch plan" }));
      await Promise.resolve();
    });

    expect(await view.findByRole("heading", { name: "Goals" })).toBeTruthy();
    expect(textContent(view.container)).toContain("Ship the beta");
    // The exact call is the inspector's: no JSON, no identities, no tool name.
    expect(textContent(view.container)).not.toContain('"format"');
    expect(textContent(view.container)).not.toContain(CHILD_PAGE_ID);
    expect(textContent(view.container)).not.toContain("nodex_app");
    expect(view.queryByText("Arguments")).toBeNull();
    expect(view.queryByText("Output")).toBeNull();
    expect(view.getAllByRole("link", { name: "Launch plan" })).toHaveLength(2);
  });

  test("states a failure's message when opened", async () => {
    targets.current = null;
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            status: "failed",
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  content: JSON.stringify({ message: "Page was not found", code: "not_found" }),
                }),
              },
            ],
          }),
        )}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Couldn't read page" }));
      await Promise.resolve();
    });

    expect(textContent(view.container)).toContain("Page was not found");
    expect(textContent(view.container)).not.toContain("not_found");
  });

  test("shows an edit's size on the row and only its diff when opened", async () => {
    targets.current = available("Launch plan");
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            tool: "update_page",
            arguments: {
              pageId: PAGE_ID,
              body: {
                kind: "patch",
                patches: [
                  { oldMarkdown: "Owner: TBD", newMarkdown: "Owner: Ada\nReviewer: Grace" },
                ],
              },
            },
            contentItems: [
              { type: "inputText", text: JSON.stringify({ data: { pageId: PAGE_ID } }) },
            ],
          }),
        )}
      />,
    );

    expect(textContent(view.container)).toContain("+2");
    expect(textContent(view.container)).not.toContain("Owner: TBD");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Updated Launch plan" }));
      await Promise.resolve();
    });

    expect(textContent(view.container)).toContain("Owner: TBD");
    expect(textContent(view.container)).toContain("Reviewer: Grace");
    expect(view.queryByText("Arguments")).toBeNull();
    expect(view.queryByText("Output")).toBeNull();
  });

  test("lists the Pages a call found once it is opened", async () => {
    targets.current = available("Launch plan");
    const opened: string[] = [];
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            tool: "search",
            arguments: { query: "launch" },
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  data: {
                    results: [
                      { kind: "page", id: "page-2", title: "Launch FAQ", pageKey: "LAB-2" },
                    ],
                  },
                }),
              },
            ],
          }),
        )}
      />,
      (pageId) => opened.push(pageId),
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Searched pages for “launch” · 1 result" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await view.findByRole("link", { name: "Launch FAQ" }));
      await Promise.resolve();
    });

    expect(opened).toEqual(["page-2"]);
    expect(textContent(view.container)).toContain("LAB-2");
  });

  test("a call with nothing to read does not open, and is still inspectable", async () => {
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            tool: "list_projects",
            arguments: {},
            contentItems: [{ type: "inputText", text: JSON.stringify({ projects: [] }) }],
          }),
        )}
      />,
    );

    expect(textContent(view.container)).toBe("Listed projects");
    expect(view.container.querySelector("[aria-expanded='false']:not([data-state])")).toBeNull();
    expect(view.getByRole("button", { name: "Inspect tool call" })).toBeTruthy();
  });

  test("the inspector opens on the output, with the input and record a tab away", async () => {
    targets.current = available("Launch plan");
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            durationMs: 1_500,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({ content: JSON.stringify({ data: { ok: "yes" } }) }),
              },
            ],
          }),
        )}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Inspect tool call" }));
      await Promise.resolve();
    });

    const dialog = await view.findByRole("dialog");
    expect(textContent(dialog)).toContain("nodex_app.fetch");
    expect(textContent(dialog)).toContain("Completed");
    expect(textContent(dialog)).toContain("1.5 s");
    expect(view.getByRole("tab", { name: "Output" }).getAttribute("aria-selected")).toBe("true");
    expect(textContent(dialog)).toContain('"ok": "yes"');
    expect(textContent(dialog)).not.toContain("content");
    await act(async () => {
      fireEvent.click(view.getByRole("tab", { name: "Input" }));
      await Promise.resolve();
    });
    expect(view.getByRole("tab", { name: "Input" }).getAttribute("aria-selected")).toBe("true");
    expect(textContent(dialog)).toContain(PAGE_ID);
  });

  test("the inspector reads a withheld output when it opens", async () => {
    targets.current = available("Launch plan");
    const readItemDetail = vi.fn(async () => undefined);
    const runtime = { readItemDetail } as unknown as ConversationRuntime;
    const view = renderRow(
      <ConversationRuntimeContext.Provider value={runtime}>
        <DynamicToolCall item={buildEntry(buildCall({ outputOmitted: true }))} />
      </ConversationRuntimeContext.Provider>,
    );

    expect(readItemDetail).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Inspect tool call" }));
      await Promise.resolve();
    });

    expect(readItemDetail).toHaveBeenCalledWith("thread-1", "item-1");
    expect(await view.findByText("Loading output…")).toBeTruthy();
  });

  test("shows what the Agent wrote to another chat", async () => {
    sessions.current = { displayTitle: "Plan review", thread: null };
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            tool: "send_message_to_session",
            arguments: { sessionId: SESSION_ID, prompt: "Please review the plan" },
          }),
        )}
      />,
    );

    await act(async () => {
      fireEvent.click(await view.findByRole("button", { name: /^Messaged chat/ }));
      await Promise.resolve();
    });

    expect(await view.findByText("Please review the plan")).toBeTruthy();
  });

  test("opens the chat an Agent created from its name", async () => {
    sessions.current = { displayTitle: "Plan review", thread: null };
    const opened: Array<{ id: string; context: unknown }> = [];
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            tool: "create_session",
            arguments: { prompt: "Review", title: "Plan review", target: { type: "projectless" } },
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({ sessionId: SESSION_ID, threadId: "thread-created" }),
              },
            ],
          }),
        )}
        onOpenThread={(threadId, context) => {
          opened.push({ id: threadId, context });
        }}
      />,
    );

    await act(async () => {
      fireEvent.click(await view.findByRole("link", { name: "Plan review" }));
      await Promise.resolve();
    });

    expect(opened).toEqual([{ id: "thread-created", context: { runtimeSessionId: SESSION_ID } }]);
  });

  test("offers no chat a failed call never made", () => {
    const view = renderRow(
      <DynamicToolCall
        item={buildEntry(
          buildCall({
            tool: "fork_session",
            arguments: {},
            status: "failed",
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({ sessionId: SESSION_ID, threadId: "thread-created" }),
              },
            ],
          }),
        )}
        onOpenThread={() => {
          throw new Error("A failed fork has no chat to open");
        }}
      />,
    );

    expect(textContent(view.container)).toBe("Couldn't fork chat");
    expect(view.queryByRole("link")).toBeNull();
  });
});
