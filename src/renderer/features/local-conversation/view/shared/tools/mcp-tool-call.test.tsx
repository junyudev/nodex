import { NativeSessionHandoffToolCall } from "./native-session-handoff-tool-call";
import { getToolComponent } from "./get-tool-component";
import { buildThreadHandoffOperation } from "../../../../../test/thread-handoff-fixture";
import {
  createThreadHandoffStore,
  ThreadHandoffStoreProvider,
} from "../../../../../lib/thread-handoff-runtime";
import type { CodexThreadHandoffSnapshot } from "../../../../../../shared/codex-thread-handoff";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { useEffect, useState, type ReactElement } from "react";
import type {
  CodexMcpToolCallView,
  CodexTranscriptEntry,
  ProtocolMcpResourceReadResponse,
} from "../../../../../lib/types";
import { NodexTooltipProvider as TooltipProvider } from "../../../../../components/ui/tooltip";
import { installWindowApi } from "../../../../../test/browser-globals";
import { renderWithMaitai as render } from "../../../../../test/thread-maitai";
import { settleAsyncRender, textContent } from "../../../../../test/dom";
import { createTestQueryClient, TestQueryProvider } from "../../../../../test/query";
import { queryKeys } from "../../../../../lib/query-keys";
import { McpToolCall } from "./mcp-tool-call";
import {
  ConversationRuntimeContext,
  type ConversationRuntime,
} from "../../../conversation-runtime";

function renderMcp(ui: ReactElement, client = createTestQueryClient()) {
  return render(<TestQueryProvider client={client}>{ui}</TestQueryProvider>);
}

function hasExactText(container: HTMLElement, value: string): boolean {
  return Array.from(container.querySelectorAll<HTMLElement>("*")).some(
    (element) => textContent(element) === value,
  );
}

function buildMcpView(overrides?: Partial<CodexMcpToolCallView>): CodexMcpToolCallView {
  return {
    callId: "call_9L9LUlz6nkg1Jp2LA4mrAL8o",
    functionName: "context7__resolve-library-id",
    pluginId: null,
    mcpAppResourceUri: undefined,
    source: null,
    invocation: {
      server: "context7",
      tool: "resolve-library-id",
      arguments: {
        libraryName: "storybook",
        query: "storybook docs",
      },
    },
    durationMs: 2957,
    completed: true,
    result: {
      type: "success",
      content: [
        {
          type: "text",
          text: "Available Libraries:\n\n- Title: Storybook",
        },
      ],
      structuredContent: null,
      raw: {
        content: [
          {
            type: "text",
            text: "Available Libraries:\n\n- Title: Storybook",
          },
        ],
        structuredContent: null,
        _meta: null,
      },
    },
    ...overrides,
    readOnlyHint: overrides?.readOnlyHint ?? null,
  };
}

function buildMcpEntry(overrides?: Partial<CodexTranscriptEntry>): CodexTranscriptEntry {
  const mcpToolCall = buildMcpView(overrides?.mcpToolCall);

  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "tool-1",
    entryId: "tool-1",
    type: "mcp_tool_call",
    kind: "toolCall",
    semanticKind: "mcpToolCall",
    status: mcpToolCall.completed ? "completed" : "inProgress",
    toolCall: {
      subtype: "mcp",
      server: mcpToolCall.invocation.server,
      toolName: mcpToolCall.invocation.tool,
      args: mcpToolCall.invocation.arguments,
      result: mcpToolCall.result,
      error: mcpToolCall.result?.type === "error" ? mcpToolCall.result.error : undefined,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
    mcpToolCall: overrides?.mcpToolCall ?? mcpToolCall,
  };
}

describe("McpToolCall", () => {
  beforeEach(() => {
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel === "codex:mcp-server-statuses:list") return { data: [], nextCursor: null };
        if (channel === "codex:mcp-resource:read") {
          return { contents: [], originCallId: null };
        }
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: () => () => {},
    });
  });

  test("scopes MCP app resource reads to the originating tool call", async () => {
    const readCalls: unknown[] = [];
    const resourceResponse: ProtocolMcpResourceReadResponse = {
      contents: [
        {
          uri: "ui://context7/scoped-docs",
          mimeType: "text/html;profile=mcp-app",
          text: "<main>Scoped docs</main>",
        },
      ],
      originCallId: "call_9L9LUlz6nkg1Jp2LA4mrAL8o",
    };
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "codex:mcp-server-statuses:list") {
          return { data: [], nextCursor: null };
        }
        if (channel === "codex:mcp-resource:read") {
          readCalls.push(args[0]);
          return resourceResponse;
        }
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: () => () => {},
    });
    const client = createTestQueryClient();
    client.setQueryData(
      queryKeys.mcp.resource({
        threadId: "thread-1",
        originCallId: "another-call",
        server: "context7",
        uri: "ui://context7/scoped-docs",
      }),
      { ...resourceResponse, originCallId: "another-call" },
    );

    renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              mcpAppResourceUri: "ui://context7/scoped-docs",
            }),
          })}
        />
      </TooltipProvider>,
      client,
    );

    await waitFor(() => {
      expect(readCalls).toEqual([
        {
          threadId: "thread-1",
          originCallId: "call_9L9LUlz6nkg1Jp2LA4mrAL8o",
          server: "context7",
          uri: "ui://context7/scoped-docs",
        },
      ]);
    });
  });

  test("Runtime MCP results stay inspectable without querying another execution owner's resources", async () => {
    const calls: string[] = [];
    installWindowApi({
      invoke: async (channel: string) => {
        calls.push(channel);
        throw new Error(`Unexpected cross-owner query: ${channel}`);
      },
      on: () => () => {},
    });
    const view = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            rawItem: {
              type: "mcpToolCall",
              id: "runtime-call-id",
              nativeCallId: "native-call-id",
            },
            mcpToolCall: buildMcpView({
              callId: "native-call-id",
              mcpAppResourceUri: "ui://context7/scoped-docs",
            }),
          })}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Resolve library ID" }));
      await Promise.resolve();
    });
    expect(view.getByText("Available Libraries: - Title: Storybook")).toBeTruthy();
    expect(calls).toEqual([]);
  });

  test("does not serialize five-megabyte structured content until details expand", async () => {
    let serializationCalls = 0;
    const payload = "x".repeat(5 * 1024 * 1024);
    const structuredContent = {
      payload,
      toJSON() {
        serializationCalls += 1;
        return { payload };
      },
    };
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              result: {
                type: "success",
                content: [],
                structuredContent: structuredContent as never,
                raw: {
                  content: [],
                  structuredContent: structuredContent as never,
                  _meta: null,
                },
              },
            }),
          })}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    expect(serializationCalls).toBe(0);
    expect(container.querySelectorAll("pre")).toHaveLength(0);

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await settleAsyncRender();

    expect(serializationCalls).toBe(1);
    expect(
      Array.from(container.querySelectorAll("pre")).every(
        (element) => (element.textContent?.length ?? 0) <= 32_000,
      ),
    ).toBe(true);
    expect(getByRole("button", { name: "View full json" })).toBeTruthy();
  });

  test("budgets expanded MCP text blocks to 32,000 aggregate characters", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              result: {
                type: "success",
                content: [
                  { type: "text", text: "a".repeat(20_000) },
                  { type: "text", text: "b".repeat(20_000) },
                  { type: "text", text: "c".repeat(20_000) },
                ],
                structuredContent: null,
                raw: {
                  content: [],
                  structuredContent: null,
                  _meta: null,
                },
              },
            }),
          })}
        />
      </TooltipProvider>,
    );

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await settleAsyncRender();

    const mountedPreviewCharacters = Array.from(container.querySelectorAll("pre")).reduce(
      (total, element) => total + (element.textContent?.length ?? 0),
      0,
    );
    expect(mountedPreviewCharacters).toBeLessThanOrEqual(32_000);
    expect(textContent(container).includes("20,000 additional text characters omitted")).toBe(true);
    expect(getByRole("button", { name: "View full plaintext" })).toBeTruthy();
  });

  test("opening withheld MCP output reads only that item and can retry a failed read", async () => {
    const reads: Array<readonly [string | null, string]> = [];
    const runtime = {
      readItemDetail: async (threadId: string | null, itemId: string) => {
        reads.push([threadId, itemId]);
        throw new Error("Read failed");
      },
    } as unknown as ConversationRuntime;
    const view = renderMcp(
      <ConversationRuntimeContext.Provider value={runtime}>
        <McpToolCall
          item={buildMcpEntry({
            rawItemId: "runtime-call-id",
            mcpToolCall: buildMcpView({ outputOmitted: true }),
          })}
        />
      </ConversationRuntimeContext.Provider>,
    );
    expect(reads).toEqual([]);
    const toggle = view.getByRole("button", { name: "Resolve library ID" });
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(reads).toEqual([["thread-1", "runtime-call-id"]]);
    expect((await view.findByRole("alert")).textContent).toBe("Unable to load tool output");
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(reads).toEqual([
      ["thread-1", "runtime-call-id"],
      ["thread-1", "runtime-call-id"],
    ]);
  });

  test("an open MCP activity hydrates its completed result and ignores a superseded read failure", async () => {
    const reads: string[] = [];
    let rejectRead: (reason: Error) => void = () => undefined;
    const pendingRead = new Promise<void>((_resolve, reject) => {
      rejectRead = reject;
    });
    const runtime = {
      readItemDetail: async (_threadId: string | null, itemId: string) => {
        reads.push(itemId);
        return pendingRead;
      },
    } as unknown as ConversationRuntime;
    let updateItem: (payload: CodexMcpToolCallView) => void = () => undefined;
    function Harness() {
      const [payload, setPayload] = useState(buildMcpView({ completed: false }));
      useEffect(() => {
        updateItem = setPayload;
      }, []);
      return (
        <TooltipProvider>
          <ConversationRuntimeContext.Provider value={runtime}>
            <McpToolCall item={buildMcpEntry({ mcpToolCall: payload })} />
          </ConversationRuntimeContext.Provider>
        </TooltipProvider>
      );
    }
    const view = renderMcp(<Harness />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Resolve library ID" }));
      await Promise.resolve();
    });
    expect(reads).toEqual([]);
    await act(async () => {
      updateItem(buildMcpView({ outputOmitted: true }));
      await Promise.resolve();
    });
    expect(reads).toEqual(["tool-1"]);
    expect((await view.findByRole("status")).textContent).toBe("Loading output…");
    await act(async () => {
      updateItem(buildMcpView());
      await Promise.resolve();
    });
    await act(async () => {
      rejectRead(new Error("Stale read"));
      await Promise.resolve();
    });
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByText("Available Libraries: - Title: Storybook")).toBeTruthy();
  });

  test("deduplicates JSON text content against structuredContent when expanded", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              result: {
                type: "success",
                content: [
                  {
                    type: "text",
                    text: '{"snippetCount":3}',
                  },
                ],
                structuredContent: {
                  snippetCount: 3,
                },
                raw: {
                  content: [
                    {
                      type: "text",
                      text: '{"snippetCount":3}',
                    },
                  ],
                  structuredContent: {
                    snippetCount: 3,
                  },
                  _meta: null,
                },
              },
            }),
          })}
        />
      </TooltipProvider>,
    );

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await settleAsyncRender();

    expect(hasExactText(container, "plaintext")).toBe(false);
    expect(Boolean(textContent(container).includes('"snippetCount": 3'))).toBe(true);
  });

  test("renders unknown blocks as JSON fallback instead of dropping them", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              result: {
                type: "success",
                content: [
                  {
                    type: "unknown",
                    raw: {
                      type: "not_real",
                      foo: "bar",
                    },
                  },
                ],
                structuredContent: null,
                raw: {
                  content: [
                    {
                      type: "not_real",
                      foo: "bar",
                    },
                  ],
                  structuredContent: null,
                  _meta: null,
                },
              },
            }),
          })}
        />
      </TooltipProvider>,
    );

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await settleAsyncRender();

    expect(Boolean(textContent(container).includes('"foo": "bar"'))).toBe(true);
    expect(Boolean(textContent(container).includes("Tool returned no content"))).toBe(false);
  });
});

test("native handoff keeps observing admitted progress after the MCP call completes", async () => {
  const payload = buildMcpView({
    invocation: {
      server: "nodex_app",
      tool: "handoff_session",
      arguments: { sessionId: "session-1" },
    },
    result: {
      type: "success",
      content: [],
      structuredContent: {
        operationId: "operation-1",
        sessionId: "session-1",
        threadId: "thread-target",
        deliveryState: "started",
      },
      raw: { content: [], structuredContent: null, _meta: null },
    },
  });
  const item = buildMcpEntry({ mcpToolCall: payload });
  expect(getToolComponent(item)).toBe(NativeSessionHandoffToolCall);
  let deliver: (snapshot: CodexThreadHandoffSnapshot) => void = () => undefined;
  const store = createThreadHandoffStore({
    read: async () => ({ revision: 1, operations: [buildThreadHandoffOperation()] }),
    subscribe: (listener) => {
      deliver = listener;
      return () => undefined;
    },
  });
  const view = renderMcp(
    <ThreadHandoffStoreProvider value={store}>
      <NativeSessionHandoffToolCall item={item} />
    </ThreadHandoffStoreProvider>,
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("button", { name: /Handing off Release notes to Local/ })
        .getAttribute("aria-expanded"),
    ).toBe("true"),
  );
  await act(async () => {
    deliver({
      revision: 2,
      operations: [buildThreadHandoffOperation({ revision: 2, status: "success" })],
    });
  });
  await waitFor(() =>
    expect(
      view
        .getByRole("button", { name: "Handed off Release notes to Local" })
        .getAttribute("aria-expanded"),
    ).toBe("false"),
  );
  expect(payload.completed).toBe(true);
  expect(
    getToolComponent(
      buildMcpEntry({
        mcpToolCall: { ...payload, invocation: { ...payload.invocation, server: "other" } },
      }),
    ),
  ).toBe(McpToolCall);
  expect(
    getToolComponent(
      buildMcpEntry({
        mcpToolCall: {
          ...payload,
          invocation: { ...payload.invocation, arguments: { sessionId: "different" } },
        },
      }),
    ),
  ).toBe(McpToolCall);
});
