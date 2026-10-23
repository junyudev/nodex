import { act, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import { applyRendererThemeForTest, installRendererThemeFixture } from "@/test/renderer-theme";
import { renderWithMaitai } from "@/test/thread-maitai";
import { THREAD_TOOL_CALL_FIXTURE_ITEMS } from "@/test/thread-tool-call-fixture";
import type { CodexTranscriptEntry } from "@/lib/types";
import { McpToolCall } from "./mcp-tool-call";

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
      const rawButton = view.getByRole("button", { name: "Show raw tool call output" });
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
      expect(view.container.querySelector("img")).toBeNull();
    } finally {
      view.unmount();
    }
  },
);
