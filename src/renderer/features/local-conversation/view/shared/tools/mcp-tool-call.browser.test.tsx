import { act, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, describe } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { renderWithMaitai } from "@/test/thread-maitai";
import { THREAD_TOOL_CALL_FIXTURE_ITEMS } from "@/test/thread-tool-call-fixture";
import type { CodexTranscriptEntry } from "@/lib/types";
import { McpToolCall } from "./mcp-tool-call";
import { DynamicToolCall } from "./dynamic-tool-call";
import { ToolCallInspector } from "./tool-call-inspector";

describe("mcp tool call", () => {
  installRendererThemeFixture();

  const title = "Inspect the page and capture its preview";
  const preview = btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#dfe8ef"/><rect x="20" y="20" width="200" height="16" fill="#43596c"/><rect x="20" y="50" width="140" height="8" fill="#8398aa"/><rect x="20" y="70" width="180" height="8" fill="#8398aa"/></svg>',
  );
  const base = THREAD_TOOL_CALL_FIXTURE_ITEMS.mcp;
  if (!base.mcpToolCall) throw new Error("The MCP fixture must retain its invocation");
  const item: CodexTranscriptEntry = {
    ...base,
    mcpToolCall: {
      ...base.mcpToolCall,
      functionName: "mcp__node_repl__js",
      invocation: {
        server: "node_repl",
        tool: "js",
        arguments: { title, code: 'nodeRepl.write("Preview captured.");' },
      },
      result: {
        type: "success",
        content: [
          { type: "text", text: "Preview captured." },
          { type: "image", mimeType: "image/svg+xml", data: preview },
        ],
        structuredContent: { width: 240, height: 120 },
        raw: {
          content: [
            { type: "text", text: "Preview captured." },
            { type: "image", mimeType: "image/svg+xml", data: preview },
          ],
          structuredContent: { width: 240, height: 120 },
          _meta: null,
        },
      },
    },
  };

  beforeEach(() => {
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel === "codex:mcp-server-statuses:list") return { data: [], nextCursor: null };
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: () => () => {},
    });
  });

  test.each(["light", "dark"] as const)(
    "JavaScript results expand by keyboard and fit a narrow chat in %s mode",
    async (theme) => {
      await page.viewport(420, 620);
      applyRendererThemeForTest(theme);
      document.body.style.background = "var(--background)";
      const view = renderWithMaitai(
        <TestQueryProvider>
          <NodexTooltipProvider>
            <div style={{ width: 360, padding: 16, background: "var(--background)" }}>
              <McpToolCall item={item} />
            </div>
          </NodexTooltipProvider>
        </TestQueryProvider>,
      );
      try {
        const disclosure = await view.findByRole("button", { name: title });
        expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await act(async () => {
          disclosure.focus();
          await userEvent.keyboard("{Enter}");
        });
        await waitFor(() => expect(disclosure).toHaveAttribute("aria-expanded", "true"));
        expect(await view.findByText("Preview captured.")).toBeVisible();
        const image = await waitFor(() => {
          const candidate = view.container.querySelector<HTMLImageElement>("img");
          expect(candidate?.naturalWidth).toBe(240);
          return candidate!;
        });
        expect(image).toBeVisible();
        const surface = view.container.querySelector<HTMLElement>("[style]")!;
        await waitFor(() => expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth));
        const rawButton = view.getByRole("button", { name: "Inspect tool call" });
        await waitFor(() =>
          expect(surface.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
            rawButton.getBoundingClientRect().bottom,
          ),
        );
        await act(async () => {
          disclosure.focus();
          await userEvent.keyboard("{Enter}");
        });
        await waitFor(() => expect(disclosure).toHaveAttribute("aria-expanded", "false"));
        // The result leaves with its closing body, then unmounts.
        await waitFor(() => expect(view.container.querySelector("img")).toBeNull());
      } finally {
        view.unmount();
      }
    },
  );

  test("returned images open full size in one viewer that moves between those that decode", async () => {
    await page.viewport(900, 700);
    const second = btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#2876d8"/></svg>',
    );
    const content = [
      { type: "image" as const, mimeType: "image/svg+xml", data: preview },
      { type: "text" as const, text: "Two previews captured." },
      // Bytes no picture decodes from take no place in the sequence.
      { type: "image" as const, mimeType: "image/png", data: btoa("not a picture") },
      { type: "image" as const, mimeType: "image/svg+xml", data: second },
    ];
    const view = renderWithMaitai(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <McpToolCall
            item={{
              ...item,
              mcpToolCall: {
                ...item.mcpToolCall!,
                result: {
                  type: "success",
                  content,
                  structuredContent: null,
                  raw: { content, structuredContent: null, _meta: null },
                },
              },
            }}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    const shown = (dialog: HTMLElement) =>
      within(dialog).getByRole("img", { name: "Tool output" }).getAttribute("src");
    try {
      const disclosure = await view.findByRole("button", { name: title });
      await act(async () => {
        await userEvent.click(disclosure);
      });
      const [first, last] = await waitFor(() => {
        const images = view.getAllByRole("button", { name: "Tool output" });
        expect(images).toHaveLength(2);
        return images;
      });
      expect(view.getByText("Image unavailable")).toHaveAttribute("role", "status");
      await act(async () => {
        await userEvent.click(first!);
      });
      const dialog = await view.findByRole("dialog", { name: "Image preview" });
      expect(shown(dialog)).toBe(`data:image/svg+xml;base64,${preview}`);
      expect(within(dialog).queryByRole("button", { name: "Previous image" })).toBeNull();

      await act(async () => {
        await userEvent.keyboard("{ArrowRight}");
      });
      await waitFor(() => expect(shown(dialog)).toBe(`data:image/svg+xml;base64,${second}`));
      expect(within(dialog).queryByRole("button", { name: "Next image" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Previous image" })).toBeVisible();

      await act(async () => {
        await userEvent.keyboard("{Escape}");
      });
      await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
      // Closing returns to the image the viewer last showed.
      await waitFor(() => expect(last).toHaveFocus());
    } finally {
      view.unmount();
    }
  });
});

describe("tool call inspection", () => {
  installRendererThemeFixture();

  const workflowCall: CodexTranscriptEntry = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "workflow-1",
    type: "dynamicToolCall",
    kind: "toolCall",
    semanticKind: "dynamicToolCall",
    status: "completed",
    dynamicToolCall: {
      callId: "workflow-1",
      namespace: null,
      tool: "Workflow",
      arguments: { script: "export const meta = {\n  name: 'triage',\n}" },
      status: "completed",
      contentItems: [{ type: "inputText", text: '{"status":"async_launched"}' }],
      success: true,
      durationMs: 49,
      completed: true,
    },
    createdAt: 1,
    updatedAt: 1,
  };

  /** The inspector with `value` as the call's input, already open on that tab. */
  async function renderInspector(value: unknown) {
    installWindowApi({ invoke: async () => null, on: () => () => {} });
    const view = renderWithMaitai(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <div className="group/activity-header">
            <ToolCallInspector
              item={workflowCall}
              outputOmitted={false}
              title="Ran Workflow"
              inspect={() => ({
                toolName: "Workflow",
                status: "completed",
                durationMs: 49,
                input: value,
                output: "done",
                raw: value,
              })}
            />
          </div>
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Inspect tool call" }));
    });
    const inputTab = await view.findByRole("tab", { name: "Input" });
    await act(async () => {
      await userEvent.click(inputTab);
    });
    return view;
  }

  function sourceScroller(dialog: HTMLElement): HTMLElement {
    const scroller = dialog.querySelector<HTMLElement>("[data-source-viewer] > *");
    if (!scroller) throw new Error("The raw source has not rendered");
    return scroller;
  }

  function tokenColor(dialog: HTMLElement, text: string): string {
    const tokens = dialog.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("span");
    const token = [...(tokens ?? [])].findLast((span) => span.textContent?.includes(text));
    if (!token) throw new Error(`The raw source has no token for ${text}`);
    return getComputedStyle(token).color;
  }

  test.each(["light", "dark"] as const)(
    "raw tool calls read in the code-block palette in %s mode",
    async (theme) => {
      await page.viewport(900, 900);
      applyRendererThemeForTest(theme);
      const view = await renderInspector({ callId: "call-1", durationMs: 49, success: true });
      try {
        const dialog = await view.findByRole("dialog");
        // Color probes mutate the DOM; resolve them outside the observer-driven retry.
        const attribute = readRendererThemeColor("--color-codex-syntax-attribute");
        const string = readRendererThemeColor("--color-codex-syntax-string");
        const literal = readRendererThemeColor("--color-codex-syntax-literal");
        await waitFor(() => {
          expect(tokenColor(dialog, "callId")).toBe(attribute);
          expect(tokenColor(dialog, "call-1")).toBe(string);
          expect(tokenColor(dialog, "49")).toBe(literal);
        });
        expect(view.getByRole("button", { name: "Copy" })).toBeVisible();
      } finally {
        view.unmount();
      }
    },
  );

  test("short raw values fit the dialog while long ones scroll inside it", async () => {
    await page.viewport(900, 900);
    const short = await renderInspector({ callId: "call-1" });
    try {
      const dialog = await short.findByRole("dialog");
      await waitFor(() => {
        const scroller = sourceScroller(dialog);
        expect(scroller.clientHeight).toBeGreaterThan(0);
        expect(scroller.scrollHeight).toBe(scroller.clientHeight);
        expect(scroller.clientHeight).toBeLessThan(200);
      });
    } finally {
      short.unmount();
    }

    const long = await renderInspector({ lines: Array.from({ length: 200 }, (_, index) => index) });
    try {
      const dialog = await long.findByRole("dialog");
      await waitFor(() => {
        const scroller = sourceScroller(dialog);
        expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
        expect(scroller.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
      });
    } finally {
      long.unmount();
    }
  });

  test.each([
    ["an MCP result", () => <McpToolCall item={THREAD_TOOL_CALL_FIXTURE_ITEMS.mcp} />],
    ["a fallback tool call", () => <DynamicToolCall item={workflowCall} />],
  ] as const)("%s reveals its inspector at the row's end on hover", async (_, Row) => {
    await page.viewport(900, 900);
    installWindowApi({
      invoke: async (channel: string) =>
        channel === "codex:mcp-server-statuses:list" ? { data: [], nextCursor: null } : null,
      on: () => () => {},
    });
    const view = renderWithMaitai(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <div style={{ width: 640 }}>
            <Row />
            <div data-testid="away-from-row" style={{ height: 200 }} />
          </div>
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    try {
      const inspector = await view.findByRole("button", { name: "Inspect tool call" });
      const opacity = () => getComputedStyle(inspector).opacity;
      // The pointer stays where the previous case left it, which may be over this row.
      await act(async () => {
        await userEvent.hover(view.getByTestId("away-from-row"));
      });
      await waitFor(() => expect(opacity()).toBe("0"));
      const disclosure = view
        .getAllByRole("button")
        .find((candidate) => candidate.getAttribute("aria-expanded") === "false")!;
      await act(async () => {
        await userEvent.hover(disclosure);
      });
      await waitFor(() => expect(opacity()).toBe("1"));
      const row = disclosure.getBoundingClientRect();
      expect(inspector.getBoundingClientRect().right).toBeLessThanOrEqual(row.right + 1);
      await act(async () => {
        await userEvent.click(inspector);
      });
      // Opening the inspector leaves the row's own disclosure alone.
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(await view.findByRole("tab", { name: "Output" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    } finally {
      view.unmount();
    }
  });
});
