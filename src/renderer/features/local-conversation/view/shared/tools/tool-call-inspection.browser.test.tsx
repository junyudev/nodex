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
import { ToolCallInspector } from "./tool-call-inspector";

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
