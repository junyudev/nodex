import { waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { renderWithMaitai } from "@/test/thread-maitai";
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
        triggerKind="toolbar"
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
      await waitFor(() => {
        expect(tokenColor(dialog, "callId")).toBe(
          readRendererThemeColor("--color-codex-syntax-attribute"),
        );
        expect(tokenColor(dialog, "call-1")).toBe(
          readRendererThemeColor("--color-codex-syntax-string"),
        );
        expect(tokenColor(dialog, "49")).toBe(
          readRendererThemeColor("--color-codex-syntax-literal"),
        );
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
