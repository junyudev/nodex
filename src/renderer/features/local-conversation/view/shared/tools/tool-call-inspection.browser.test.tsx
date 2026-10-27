import { act, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { CodexTranscriptEntry } from "@/lib/types";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import { THREAD_TOOL_CALL_FIXTURE_ITEMS } from "@/test/thread-tool-call-fixture";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { renderWithMaitai } from "@/test/thread-maitai";
import { DynamicToolCall } from "./dynamic-tool-call";
import { McpToolCall } from "./mcp-tool-call";
import { ToolCallRawDialog } from "./tool-call-inspection";

installRendererThemeFixture();

function renderRawDialog(value: unknown) {
  return renderWithMaitai(
    <NodexTooltipProvider>
      <ToolCallRawDialog
        open
        onOpenChange={() => undefined}
        title="Raw Workflow tool call"
        triggerLabel="Show raw tool call output"
        getRawValue={() => value}
      />
    </NodexTooltipProvider>,
  );
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
    const view = renderRawDialog({ callId: "call-1", durationMs: 49, success: true });
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
  const short = renderRawDialog({ callId: "call-1" });
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

  const long = renderRawDialog({ lines: Array.from({ length: 200 }, (_, index) => index) });
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

test.each([
  ["an MCP result", () => <McpToolCall item={THREAD_TOOL_CALL_FIXTURE_ITEMS.mcp} />],
  ["a fallback tool call", () => <DynamicToolCall item={workflowCall} />],
] as const)("Raw sits visibly beside Copy in %s instead of on its own row", async (_, Row) => {
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
        </div>
      </NodexTooltipProvider>
    </TestQueryProvider>,
  );
  try {
    const disclosure = await waitFor(() => {
      const button = view
        .getAllByRole("button")
        .find((candidate) => candidate.getAttribute("aria-expanded") === "false");
      if (!button) throw new Error("The row has no closed disclosure");
      return button;
    });
    await act(async () => {
      await userEvent.click(disclosure);
    });
    const raw = await view.findByRole("button", { name: "Show raw tool call output" });
    const copy = view.getAllByRole("button", { name: "Copy" })[0]!;
    expect(raw).toBeVisible();
    await waitFor(() =>
      expect(
        Math.abs(raw.getBoundingClientRect().top - copy.getBoundingClientRect().top),
      ).toBeLessThan(2),
    );
  } finally {
    view.unmount();
  }
});
