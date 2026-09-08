import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type {
  CodexMcpToolCallView,
  CodexTranscriptEntry,
  ProtocolMcpResourceReadResponse,
} from "../../../../../lib/types";
import { NodexTooltipProvider as TooltipProvider } from "../../../../../components/ui/tooltip";
import { installWindowApi } from "../../../../../test/browser-globals";
import { renderWithMaitai as render } from "../../../../../test/thread-maitai";
import {
  settleAsyncRender,
  textContent,
  textContentIncludingShadowRoots,
} from "../../../../../test/dom";
import { createTestQueryClient, TestQueryProvider } from "../../../../../test/query";
import { queryKeys } from "../../../../../lib/query-keys";
import { CODEX_BROWSER_USE_CHROME_LOGO_DATA_URL } from "../../../../../../shared/codex-mcp-tool-call";
import { McpToolCall } from "./mcp-tool-call";
import { WebMcpToolActivity } from "./webmcp-tool-activity";
import {
  buildMcpAppSidePanelInput,
  resolveMcpWidgetMetadata,
} from "./mcp-tool-call-resource-utils";

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

function buildAutomaticApprovalReviewEntry(
  overrides?: Partial<CodexTranscriptEntry>,
): CodexTranscriptEntry {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "review-1",
    entryId: "review-1",
    type: "automaticApprovalReview",
    kind: "systemEvent",
    semanticKind: "automaticApprovalReview",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    rawItem: {
      targetItemId: "tool-1",
      review: {
        status: "approved",
        riskScore: 0.12,
        riskLevel: "low",
        rationale: "Only documentation lookup is performed.",
      },
      action: {
        type: "mcpToolCall",
        server: "context7",
        toolName: "resolve-library-id",
        connectorId: null,
        connectorName: "Context 7",
        toolTitle: null,
      },
    },
    ...overrides,
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

  test("uses a built-in website identity without requesting a remote favicon", async () => {
    const view = renderMcp(
      <WebMcpToolActivity
        call={{ kind: "invokeTool", name: "search_issues", sourceHostname: "github.com" }}
        fallbackPageUrl="https://example.com/"
      />,
    );
    expect(await view.findByRole("button", { name: "Search issues" })).toBeTruthy();
    expect(view.container.querySelector("img")).toBeNull();
  });

  test("preserves the full producer-bounded website result without a second preview truncation", async () => {
    const output = { description: "product ".repeat(6_000), end: "last product" };
    const view = renderMcp(
      <WebMcpToolActivity
        call={{ kind: "invokeTool", name: "read_catalog", outputJson: JSON.stringify(output) }}
        fallbackPageUrl={null}
      />,
    );
    const disclosure = view.getByRole("button", { name: "Read catalog" });
    await act(async () => {
      fireEvent.click(disclosure);
      await Promise.resolve();
    });
    await waitFor(() => expect(disclosure.getAttribute("aria-expanded")).toBe("true"));
    const result = view.container.querySelectorAll("pre")[1];
    expect(JSON.parse(result?.textContent ?? "")).toEqual(output);
    expect(view.queryByRole("button", { name: /View full/ })).toBeNull();
  });

  test("renders completed website subcalls with independent disclosure and JSON truncation semantics", async () => {
    const payload = buildMcpView({
      source: { kind: "browserUse", backend: "iab" },
      invocation: { server: "node_repl", tool: "js", arguments: { title: "Search website" } },
      result: {
        type: "success",
        content: [],
        structuredContent: null,
        raw: {
          content: [],
          structuredContent: null,
          _meta: {
            "codex/toolSurface": {
              kind: "browserUse",
              backend: "iab",
              screenshot: { pageUrl: "https://fallback.example/page" },
              webMcpCalls: [
                { kind: "listTools", name: "webmcp_list_tools", outputJson: "[]" },
                {
                  kind: "invokeTool",
                  name: "search_API",
                  sourceHostname: "tools.example",
                  inputJson: '{"query":"lamp"}',
                  outputJson: '{"found":3}',
                },
                {
                  kind: "invokeTool",
                  name: "read_reviews",
                  title: "Read reviews",
                  inputJson: '{"ids":[1,…',
                  inputTruncated: true,
                  outputJson: '{"reviews":[…',
                  outputTruncated: true,
                },
              ],
            },
          },
        },
      },
    });
    const view = renderMcp(<McpToolCall item={buildMcpEntry({ mcpToolCall: payload })} />);
    const parent = await view.findByRole("button", { name: "Search website" });
    const listing = view.getByRole("button", { name: "Listed website tools" });
    const search = view.getByRole("button", { name: "Search API" });
    const reviews = view.getByRole("button", { name: "Read reviews" });
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(listing.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(search);
      await Promise.resolve();
    });
    await waitFor(() => expect(search.getAttribute("aria-expanded")).toBe("true"));
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(listing.getAttribute("aria-expanded")).toBe("false");
    const definition = view.getByText(
      (_, element) =>
        element?.tagName === "PRE" &&
        element.textContent ===
          JSON.stringify(
            { name: "search_API", website: "tools.example", input: { query: "lamp" } },
            null,
            2,
          ),
    );
    expect(JSON.parse(definition.textContent ?? "")).toEqual({
      name: "search_API",
      website: "tools.example",
      input: { query: "lamp" },
    });
    await act(async () => {
      fireEvent.click(reviews);
      await Promise.resolve();
    });
    await waitFor(() => expect(reviews.getAttribute("aria-expanded")).toBe("true"));
    expect(view.getByText("Tool (input truncated)")).toBeTruthy();
    expect(view.getByText("Result (truncated)")).toBeTruthy();
    const truncated = view.getByText(
      (_, element) =>
        element?.tagName === "PRE" &&
        element.textContent?.includes('"inputTruncated": true') === true,
    );
    expect(JSON.parse(truncated.textContent ?? "").input).toBe('{"ids":[1,…');
    expect(view.getByText('{"reviews":[…')).toBeTruthy();
    const imageSources = [...view.container.querySelectorAll("img")].map((image) => image.src);
    expect(imageSources).toContain(
      "https://www.google.com/s2/favicons?domain=https%3A%2F%2Ftools.example&sz=32",
    );
    expect(imageSources).toContain(
      "https://www.google.com/s2/favicons?domain=https%3A%2F%2Ffallback.example&sz=32",
    );
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

  test("renders the Codex-style collapsed summary text", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              functionName: "context7__query_docs",
              invocation: {
                server: "context7",
                tool: "query_docs",
                arguments: {
                  libraryId: "/storybookjs/storybook",
                },
              },
              result: {
                type: "success",
                content: [],
                structuredContent: {
                  snippetCount: 3,
                },
                raw: {
                  content: [],
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
    await settleAsyncRender();

    expect(getByRole("button", { name: "Query docs" })).toBeDefined();
    expect(textContent(container).includes("Called")).toBe(false);
    expect(textContent(container).includes("tool from Context 7")).toBe(false);
  });

  test("does not mount completed MCP body content while collapsed", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall item={buildMcpEntry()} />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    expect(textContent(container).includes("Available Libraries:")).toBe(false);

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await settleAsyncRender();

    expect(textContent(container).includes("Available Libraries:")).toBe(true);
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

  test("renders a source icon in the summary row", async () => {
    const { container } = renderMcp(
      <TooltipProvider>
        <McpToolCall item={buildMcpEntry()} />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    expect(Boolean(container.querySelector("[data-tool-activity-icon='connector']"))).toBe(true);
  });

  test("keeps in-progress MCP rows collapsed and non-expandable", async () => {
    const { container, queryByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            status: "inProgress",
            mcpToolCall: buildMcpView({
              completed: false,
              result: null,
            }),
          })}
        />
      </TooltipProvider>,
    );

    await settleAsyncRender();

    expect(Boolean(queryByRole("button", { name: /Resolve library id/i }))).toBe(false);
    expect(textContent(container).includes("Resolve library ID")).toBe(true);
    expect(textContent(container).includes("Calling")).toBe(false);
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(true);
    expect(
      Boolean(container.querySelector(".loading-shimmer-pure-text [data-tool-activity-icon]")),
    ).toBe(false);
  });

  test("allows in-progress MCP rows with a result to expand", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            status: "inProgress",
            mcpToolCall: buildMcpView({
              completed: false,
              result: {
                type: "success",
                content: [
                  {
                    type: "text",
                    text: "Partial tool content",
                  },
                ],
                structuredContent: null,
                raw: {
                  content: [
                    {
                      type: "text",
                      text: "Partial tool content",
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

    const summaryButton = getByRole("button", { name: /Resolve library id/i });
    expect(summaryButton.getAttribute("aria-expanded") ?? "").toBe("false");
    const summary = document.getElementById(summaryButton.getAttribute("aria-labelledby") ?? "");
    expect(Boolean(summary?.querySelector('[data-codex-shimmer="cadenced"]'))).toBe(true);

    await act(async () => {
      fireEvent.click(summaryButton);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(summaryButton.getAttribute("aria-expanded") ?? "").toBe("true");
    });
    expect(textContent(container).includes("Partial tool content")).toBe(true);
  });

  test("uses the node_repl js title as the standalone MCP label", async () => {
    const { getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              functionName: "node_repl__js",
              invocation: {
                server: "node_repl",
                tool: "js",
                arguments: {
                  title: "Inspect package metadata",
                  code: "JSON.stringify({ ok: true })",
                },
              },
            }),
          })}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    expect(getByRole("button", { name: "Inspect package metadata" })).toBeDefined();
  });

  test("preserves MCP acronyms in generic standalone labels", async () => {
    const { getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              functionName: "codex_apps__list_mcp_resources",
              invocation: {
                server: "codex_apps",
                tool: "list_mcp_resources",
                arguments: {},
              },
            }),
          })}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    expect(getByRole("button", { name: "List MCP resources" })).toBeDefined();
  });

  test("uses canonical browser-source labels and icons", async () => {
    const chromeItem = buildMcpEntry({
      mcpToolCall: buildMcpView({
        source: { kind: "browserUse", backend: "chrome" },
        invocation: { server: "node_repl", tool: "browser_action", arguments: {} },
      }),
    });
    const browserItem = buildMcpEntry({
      mcpToolCall: buildMcpView({
        source: { kind: "browserUse", backend: "iab" },
        invocation: { server: "node_repl", tool: "browser_action", arguments: {} },
      }),
    });
    const { container: chromeContainer, getByRole: getChromeRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall item={chromeItem} />
      </TooltipProvider>,
    );
    const { container: browserContainer, getByRole: getBrowserRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall item={browserItem} />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    expect(getChromeRole("button", { name: "Used Chrome" })).toBeDefined();
    expect(getBrowserRole("button", { name: "Used the browser" })).toBeDefined();
    expect(chromeContainer.querySelector("img")?.getAttribute("src")).toBe(
      CODEX_BROWSER_USE_CHROME_LOGO_DATA_URL,
    );
    expect(Boolean(browserContainer.querySelector("[data-tool-activity-icon='browser-use']"))).toBe(
      true,
    );
  });

  test("renders plaintext content and opens the raw output dialog", async () => {
    const { container, getByRole, getByText } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              pluginId: "plugin_1",
              mcpAppResourceUri: "ui://context7/docs",
            }),
          })}
        />
      </TooltipProvider>,
    );

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await waitFor(() => {
      expect(textContent(container).includes("Available Libraries:")).toBe(true);
    });
    expect(Boolean(getByText("plaintext"))).toBe(true);

    fireEvent.click(getByRole("button", { name: "Show raw tool call output" }));
    await waitFor(() => {
      expect(Boolean(getByText("Raw context7.resolve-library-id tool call output"))).toBe(true);
    });
    await waitFor(() => {
      expect(
        textContentIncludingShadowRoots(getByRole("dialog")).includes(
          "call_9L9LUlz6nkg1Jp2LA4mrAL8o",
        ),
      ).toBe(true);
    });
    expect(textContent(container).includes("pluginId")).toBe(false);
    expect(textContent(container).includes("mcpAppResourceUri")).toBe(false);
  });

  test("renders attached automatic approval reviews before MCP body content", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry()}
          automaticApprovalReviews={[buildAutomaticApprovalReviewEntry()]}
        />
      </TooltipProvider>,
    );

    const summaryButton = getByRole("button", { name: /Resolve library id/i });
    expect(summaryButton.getAttribute("aria-expanded") ?? "").toBe("false");

    fireEvent.click(summaryButton);
    await waitFor(() => {
      expect(summaryButton.getAttribute("aria-expanded") ?? "").toBe("true");
    });

    const reviewButton =
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) =>
        textContent(element).includes("Auto-review approved"),
      ) ?? null;
    const plaintextLabel =
      Array.from(container.querySelectorAll<HTMLElement>("div")).find(
        (element) => textContent(element) === "plaintext",
      ) ?? null;

    expect(Boolean(reviewButton)).toBe(true);
    expect(Boolean(plaintextLabel)).toBe(true);
    expect(
      Boolean(
        reviewButton && plaintextLabel
          ? reviewButton.compareDocumentPosition(plaintextLabel) & Node.DOCUMENT_POSITION_FOLLOWING
          : false,
      ),
    ).toBe(true);
  });

  test("renders attached automatic approval reviews as title-only rows in MCP app card mode", async () => {
    const mcpAppResourceResponse: ProtocolMcpResourceReadResponse = {
      originCallId: "call_9L9LUlz6nkg1Jp2LA4mrAL8o",
      contents: [
        {
          uri: "ui://context7/docs",
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><html><body>Docs app</body></html>",
          _meta: {
            "openai/widgetPrefersBorder": true,
          },
        },
      ],
    };
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel === "codex:mcp-server-statuses:list") return { data: [], nextCursor: null };
        if (channel === "codex:mcp-resource:read") return mcpAppResourceResponse;
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: () => () => {},
    });
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.mcp.statuses(), { data: [], nextCursor: null });
    client.setQueryData(
      queryKeys.mcp.resource({
        threadId: "thread-1",
        originCallId: "call_9L9LUlz6nkg1Jp2LA4mrAL8o",
        server: "context7",
        uri: "ui://context7/docs",
      }),
      mcpAppResourceResponse,
    );

    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              mcpAppResourceUri: "ui://context7/docs",
              result: {
                type: "success",
                content: [],
                structuredContent: null,
                raw: {
                  content: [],
                  structuredContent: null,
                  _meta: null,
                },
              },
            }),
          })}
          automaticApprovalReviews={[buildAutomaticApprovalReviewEntry()]}
        />
      </TooltipProvider>,
      client,
    );

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await settleAsyncRender();

    expect(Boolean(container.querySelector("[data-mcp-app-frame-mode='inline']"))).toBe(true);
    expect(textContent(container).includes("Auto-review approved")).toBe(true);
    const reviewElement =
      Array.from(container.querySelectorAll<HTMLElement>("div")).find(
        (element) => textContent(element) === "Auto-review approved",
      ) ?? null;
    const reviewButton = reviewElement?.closest("button") ?? null;
    expect(Boolean(reviewElement)).toBe(true);
    expect(Boolean(reviewButton)).toBe(false);
    expect(
      textContent(reviewElement as HTMLElement).includes("Only documentation lookup is performed."),
    ).toBe(false);
  });

  test("renders structured-only successes without the no-content fallback", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              functionName: "context7__query_docs",
              invocation: {
                server: "context7",
                tool: "query_docs",
                arguments: {
                  libraryId: "/storybookjs/storybook",
                },
              },
              result: {
                type: "success",
                content: [],
                structuredContent: {
                  snippetCount: 3,
                },
                raw: {
                  content: [],
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

    fireEvent.click(getByRole("button", { name: /Query docs/i }));
    await settleAsyncRender();

    expect(Boolean(textContent(container).includes("Tool returned no content"))).toBe(false);
    expect(Boolean(textContent(container).includes('"snippetCount": 3'))).toBe(true);
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

  test("renders MCP app resources as the body branch instead of appending fallback content", async () => {
    const client = createTestQueryClient();
    const resourceResponse: ProtocolMcpResourceReadResponse = {
      originCallId: "call_9L9LUlz6nkg1Jp2LA4mrAL8o",
      contents: [
        {
          uri: "ui://context7/docs-app",
          mimeType: "text/html;profile=mcp-app",
          text: "<main>Docs app</main>",
        },
      ],
    };
    client.setQueryData(
      queryKeys.mcp.resource({
        threadId: "thread-1",
        originCallId: "call_9L9LUlz6nkg1Jp2LA4mrAL8o",
        server: "context7",
        uri: "ui://context7/docs-app",
      }),
      resourceResponse,
    );

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
                    text: "Fallback text should be hidden",
                  },
                ],
                structuredContent: {
                  hidden: true,
                },
                raw: {
                  content: [],
                  structuredContent: {
                    hidden: true,
                  },
                  _meta: { "openai/outputTemplate": "ui://context7/docs-app" },
                },
              },
            }),
          })}
        />
      </TooltipProvider>,
      client,
    );

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await settleAsyncRender();

    expect(container.querySelectorAll("webview")).toHaveLength(1);
    expect(hasExactText(container, "plaintext")).toBe(false);
    expect(Boolean(textContent(container).includes('"hidden": true'))).toBe(false);
  });

  test("renders protocol errors without the no-content fallback", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            status: "failed",
            mcpToolCall: buildMcpView({
              completed: true,
              result: {
                type: "error",
                kind: "protocol",
                error: "Authentication required",
                rawError: {
                  message: "Authentication required",
                },
              },
            }),
          })}
        />
      </TooltipProvider>,
    );

    fireEvent.click(getByRole("button", { name: /Resolve library id/i }));
    await settleAsyncRender();

    expect(Boolean(textContent(container).includes("Authentication required"))).toBe(true);
    expect(Boolean(textContent(container).includes("Tool returned no content"))).toBe(false);
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

  test("renders resource-link content blocks", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              result: {
                type: "success",
                content: [
                  {
                    type: "resource_link",
                    uri: "file:///workspace/docs.md",
                    title: "Docs",
                    annotations: {
                      audience: ["assistant"],
                      priority: 0.75,
                    },
                  },
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

    expect(Boolean(textContent(container).includes("Read Docs"))).toBe(true);
    expect(Boolean(textContent(container).includes("audience=assistant"))).toBe(true);
    expect(Boolean(textContent(container).includes("priority=0.75"))).toBe(true);
  });

  test("renders image and audio content blocks with supported annotations", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              result: {
                type: "success",
                content: [
                  {
                    type: "image",
                    data: "AA==",
                    mimeType: "image/png",
                    annotations: {
                      audience: ["user", "assistant"],
                    },
                  },
                  {
                    type: "audio",
                    data: "AA==",
                    mimeType: "audio/wav",
                    annotations: {
                      lastModified: "2026-07-06T00:00:00Z",
                    },
                  },
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

    expect(container.querySelector("img")?.getAttribute("src") ?? "").toBe(
      "data:image/png;base64,AA==",
    );
    expect(container.querySelector("audio")?.getAttribute("src") ?? "").toBe(
      "data:audio/wav;base64,AA==",
    );
    expect(Boolean(textContent(container).includes("Annotations: audience=user, assistant"))).toBe(
      true,
    );
    expect(
      Boolean(textContent(container).includes("Annotations: lastModified=2026-07-06T00:00:00Z")),
    ).toBe(true);
  });

  test("renders embedded resources with URI, MIME type, annotations, and content", async () => {
    const { container, getByRole } = renderMcp(
      <TooltipProvider>
        <McpToolCall
          item={buildMcpEntry({
            mcpToolCall: buildMcpView({
              result: {
                type: "success",
                content: [
                  {
                    type: "embedded_resource",
                    resource: {
                      uri: "file:///workspace/report.json",
                      mimeType: "application/json",
                      text: '{"ok":true}',
                      annotations: {
                        audience: ["user"],
                        lastModified: "2026-07-06",
                      },
                    },
                  },
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

    expect(hasExactText(container, "URI")).toBe(true);
    expect(hasExactText(container, "MIME type")).toBe(true);
    expect(hasExactText(container, "Annotations")).toBe(true);
    expect(hasExactText(container, "Content")).toBe(true);
    expect(Boolean(textContent(container).includes("file:///workspace/report.json"))).toBe(true);
    expect(Boolean(textContent(container).includes("application/json"))).toBe(true);
    expect(Boolean(textContent(container).includes("audience=user; lastModified=2026-07-06"))).toBe(
      true,
    );
    expect(Boolean(textContent(container).includes('{"ok":true}'))).toBe(true);
  });

  test("builds Codex-style MCP app side-panel ids from renderable resources", () => {
    const sidePanelInput = buildMcpAppSidePanelInput({
      threadId: "thread-1",
      payload: buildMcpView({
        mcpAppResourceUri: "ui://context7/docs",
      }),
      resource: {
        uri: "ui://context7/docs",
        mode: "html",
        html: "<!doctype html><html><body>Docs app</body></html>",
        mimeType: "text/html;profile=mcp-app",
        metadata: {
          ...resolveMcpWidgetMetadata(null),
          heightHint: 420,
        },
      },
    });

    expect(sidePanelInput.mcpAppId).toBe("context7:ui://context7/docs");
    expect(sidePanelInput.capabilityId).toBe(
      "mcp-capability:thread-1:context7:resolve-library-id:call_9L9LUlz6nkg1Jp2LA4mrAL8o:ui%3A%2F%2Fcontext7%2Fdocs",
    );
    expect(sidePanelInput.title).toBe("Resolve Library Id - Context 7");
  });
});
