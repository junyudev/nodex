import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import type { CodexTranscriptEntry } from "../../../../../lib/types";
import { render, textContent } from "../../../../../test/dom";
import { describeWebSearchAction } from "../../../web-search-display";
import { getWebSearchSummaryDetail, WebSearchToolCall } from "./web-search-tool-call";

function buildWebSearchEntry(overrides?: Partial<CodexTranscriptEntry>): CodexTranscriptEntry {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "tool-1",
    entryId: "tool-1",
    type: "web_search",
    kind: "toolCall",
    semanticKind: "webSearch",
    status: "completed",
    webSearch: {
      query: "storybook react vite args",
      action: {
        type: "search",
        query: "storybook react vite args",
      },
      completed: true,
      sources: [],
    },
    toolCall: {
      subtype: "webSearch",
      toolName: "web_search",
      args: {
        query: "storybook react vite args",
      },
      result: {
        type: "search",
        query: "storybook react vite args",
      },
    },
    rawItem: {
      action: {
        type: "search",
        query: "storybook react vite args",
      },
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("describeWebSearchAction", () => {
  test("uses the first non-empty query and appends an ellipsis for multi-query searches", () => {
    expect(
      describeWebSearchAction(
        {
          type: "search",
          queries: ["storybook args", "storybook decorators"],
        },
        "",
      ),
    ).toBe("storybook args ...");
  });

  test("normalizes site filters in search action detail text", () => {
    expect(
      describeWebSearchAction(
        {
          type: "search",
          query: "site:github.com/openai/codex renderer OR site:www.example.com docs",
        },
        "",
      ),
    ).toBe("renderer docs | github.com \u00b7 example.com");
  });

  test("formats find-in-page actions the same way as Codex Electron", () => {
    expect(
      describeWebSearchAction(
        {
          type: "findInPage",
          pattern: "play function",
          url: "https://storybook.js.org/docs/writing-stories/play-function",
        },
        "",
      ),
    ).toBe("'play function' in https://storybook.js.org/docs/writing-stories/play-function");
  });
});

describe("getWebSearchSummaryDetail", () => {
  test("prefers the raw action payload over generic fallback result data", () => {
    expect(
      getWebSearchSummaryDetail(
        buildWebSearchEntry({
          toolCall: {
            subtype: "webSearch",
            toolName: "web_search",
            args: { query: "ignored fallback query" },
            result: {
              sources: ["storybook"],
            },
          },
          rawItem: {
            action: {
              type: "openPage",
              url: "https://storybook.js.org/docs/writing-stories/args",
            },
          },
        }),
      ),
    ).toBe("https://storybook.js.org/docs/writing-stories/args");
  });
});

describe("WebSearchToolCall", () => {
  test("renders the compact Codex-style summary row", () => {
    const { container } = render(
      <WebSearchToolCall
        item={buildWebSearchEntry({
          rawItem: {
            action: {
              type: "findInPage",
              pattern: "decorators",
              url: "https://storybook.js.org/docs/writing-stories/decorators",
            },
          },
        })}
      />,
    );

    const renderedText = textContent(container);
    expect(Boolean(renderedText.includes("Searched the web"))).toBe(true);
    expect(
      Boolean(
        renderedText.includes(
          "'decorators' in https://storybook.js.org/docs/writing-stories/decorators",
        ),
      ),
    ).toBe(true);
    expect(Boolean(container.querySelector("[data-tool-activity-icon='search']"))).toBe(true);
  });

  test("shimmers the complete Codex summary while the search is running", () => {
    const { container } = render(
      <WebSearchToolCall
        item={buildWebSearchEntry({
          status: "completed",
          webSearch: {
            query: "storybook react vite args",
            action: {
              type: "search",
              query: "storybook react vite args",
            },
            completed: false,
            sources: [],
          },
        })}
      />,
    );

    expect(Boolean(textContent(container).includes("Searching the web"))).toBe(true);
    const shimmer = container.querySelector(".loading-shimmer-pure-text");
    expect(Boolean(shimmer)).toBe(true);
    expect(
      Boolean(textContent(shimmer ?? container).includes("for storybook react vite args")),
    ).toBe(true);
  });

  test("uses the semantic globe summary leaf inside activity groups", () => {
    const { container } = render(
      <WebSearchToolCall
        item={buildWebSearchEntry({
          rawItem: {
            action: {
              type: "search",
              query: "site:github.com/openai/codex renderer",
            },
          },
        })}
      />,
    );

    expect(Boolean(textContent(container).includes("renderer | github.com"))).toBe(true);
    expect(Boolean(container.querySelector("[data-tool-activity-icon='search']"))).toBe(true);
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(false);
  });

  test("keeps the semantic globe when no domain exists", () => {
    const { container } = render(
      <WebSearchToolCall
        item={buildWebSearchEntry({
          toolCall: {
            subtype: "webSearch",
            toolName: "web_search",
            args: {
              query: "no domain here",
            },
            result: {
              type: "search",
              query: "no domain here",
            },
          },
          rawItem: {
            action: {
              type: "search",
              query: "no domain here",
            },
          },
        })}
      />,
    );

    expect(Boolean(textContent(container).includes("no domain here"))).toBe(true);
    expect(Boolean(container.querySelector("[data-tool-activity-icon='search']"))).toBe(true);
  });

  test("renders only the verb when the projected detail is empty", () => {
    const { container } = render(
      <WebSearchToolCall
        item={buildWebSearchEntry({
          toolCall: {
            subtype: "webSearch",
            toolName: "web_search",
            args: {},
            result: {},
          },
          rawItem: { action: { type: "other" }, query: "" },
        })}
      />,
    );

    expect(textContent(container)).toBe("Searched the web");
    expect(Boolean(container.querySelector("[data-tool-activity-icon='search']"))).toBe(true);
  });

  test("opens to the pages the search returned, and stays a plain row without any", () => {
    const sources = [
      {
        url: "https://one.google.com/about/plans",
        title: "Google One plans and pricing",
        label: "one.google.com/about/plans",
      },
      { url: "https://example.com/notes", title: null, label: "example.com/notes" },
    ];
    const { container } = render(
      <WebSearchToolCall
        item={buildWebSearchEntry({
          webSearch: {
            query: "google ai pro price",
            action: { type: "search", query: "google ai pro price" },
            completed: true,
            sources,
          },
        })}
      />,
    );

    const toggle = screen.getByRole("button", { expanded: false });
    expect(container.querySelector("[data-testid='web-search-sources']")).toBeNull();
    fireEvent.click(toggle);

    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
      ["https://one.google.com/about/plans", "Google One plans and pricing"],
      ["https://example.com/notes", "example.com/notes"],
    ]);
    expect(links.every((link) => link.getAttribute("target") === "_blank")).toBe(true);

    const plain = render(<WebSearchToolCall item={buildWebSearchEntry()} />);
    expect(plain.container.querySelector("button[aria-expanded]")).toBeNull();
  });
});
