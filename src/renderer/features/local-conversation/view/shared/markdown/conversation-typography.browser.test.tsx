/// <reference types="vite/client" />
import { render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import "@/globals.css";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import {
  applyTypographyPreferences,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
} from "@/lib/typography-preferences";
import { MarkdownRenderer } from "./markdown-renderer";
import { ComposerPromptEditor } from "../../composer/composer-prompt-editor";
import { ThreadLiveActivityFallback } from "../../local-conversation-thread-turn";
import { ThreadActivityHeader } from "../tools/tool-primitives";
import { CodexMcpElicitationRequestCard } from "../../composer/request-cards/codex-mcp-elicitation-request-card";

installRendererThemeFixture();
const codeBodies = import.meta.glob("/node_modules/streamdown/dist/highlighted-body-*.js");
beforeAll(async () => {
  await Promise.all(Object.values(codeBodies).map((load) => load()));
});

const source = [
  "# First heading",
  "## Second heading",
  "### Third heading",
  "Paragraph with **strong text** and `inlineValue`.",
  "- A list item",
  "| Name | Value |\n| --- | --- |\n| Body cell | 42 |",
  "```text\nblockValue\n```",
].join("\n\n");

const applySizes = (uiFontSize: number, codeFontSize: number) => {
  applyTypographyPreferences(
    document.documentElement,
    document.body,
    {
      ...DEFAULT_TYPOGRAPHY_PREFERENCES,
      uiFontSize,
      codeFontSize,
      fonts: {
        ...DEFAULT_TYPOGRAPHY_PREFERENCES.fonts,
        light: { ui: "Arial", content: "Georgia", code: "monospace" },
      },
    },
    "light",
  );
};

const font = (element: Element) => {
  const style = getComputedStyle(element);
  return {
    size: Number.parseFloat(style.fontSize),
    line: Number.parseFloat(style.lineHeight),
    family: style.fontFamily,
    weight: style.fontWeight,
  };
};

function requireElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing rendered element: ${selector}`);
  return element;
}

describe("conversation typography in the renderer build", () => {
  test("derives Markdown hierarchy from prose while preserving independent code size", async () => {
    applySizes(14, 12);
    const view = render(<MarkdownRenderer content={source} dialect="conversation" />);
    await view.findByRole("heading", { name: "First heading" });
    await waitFor(() =>
      expect(
        requireElement(view.container, "[data-readonly-code-block] pre").textContent,
      ).toContain("blockValue"),
    );
    const paragraph = requireElement(view.container, "p");
    const inline = requireElement(view.container, ".inline-markdown");
    const table = requireElement(view.container, "table");
    const code = requireElement(view.container, "[data-readonly-code-block] pre");

    expect(font(paragraph)).toMatchObject({ size: 14, line: 22.75, weight: "430" });
    expect(font(paragraph).family).toContain("Georgia");
    expect(font(view.getByRole("heading", { level: 1 }))).toMatchObject({ size: 21, line: 28 });
    expect(font(view.getByRole("heading", { level: 2 }))).toMatchObject({ size: 17.5, line: 24.5 });
    expect(font(view.getByRole("heading", { level: 3 }))).toMatchObject({
      size: 15.75,
      line: 24.5,
    });
    expect(font(requireElement(view.container, "strong")).weight).toBe("600");
    expect(font(inline).size).toBeCloseTo(12.88, 2);
    expect(font(table)).toMatchObject({ size: 12.25, line: 22.75 });
    expect(font(code)).toMatchObject({ size: 12, line: 20 });
    expect(font(code).family).toContain("monospace");

    applySizes(16, 16);
    expect(font(paragraph)).toMatchObject({ size: 16, line: 26 });
    expect(font(view.getByRole("heading", { level: 1 }))).toMatchObject({ size: 24, line: 32 });
    expect(font(inline).size).toBeCloseTo(14.72, 2);
    expect(font(table)).toMatchObject({ size: 16, line: 26 });
    expect(font(code)).toMatchObject({ size: 16, line: 24 });
    expect(paragraph.isConnected).toBe(true);
  });

  test("keeps composer and activity text in the UI family while their size follows preferences", async () => {
    applySizes(14, 12);
    const view = render(
      <>
        <ComposerPromptEditor
          value="Compose a response"
          placeholder="Prompt"
          disabled={false}
          onChange={() => {}}
          onKeyDown={() => false}
        />
        <ThreadLiveActivityFallback />
        <ThreadActivityHeader>Reading files</ThreadActivityHeader>
      </>,
    );
    const composer = requireElement(view.container, "[data-codex-composer]");
    const thinking = await view.findByText("Thinking", { selector: "[data-codex-shimmer]" });
    const activity = await view.findByText("Reading files");
    expect(font(composer)).toMatchObject({ size: 14, line: 20 });
    expect(font(thinking)).toMatchObject({ size: 14, line: 22 });
    expect(font(activity).size).toBe(14);
    for (const element of [composer, thinking, activity]) {
      expect(font(element).family).toContain("Arial");
      expect(font(element).family).not.toContain("Georgia");
    }
    applySizes(16, 16);
    expect(font(composer)).toMatchObject({ size: 16, line: 20 });
    expect(font(thinking)).toMatchObject({ size: 16, line: 24 });
    expect(font(activity).size).toBe(16);
  });

  test("keeps request field labels and descriptions at their conversation caption size", async () => {
    applySizes(14, 12);
    const view = render(
      <CodexMcpElicitationRequestCard
        request={{
          type: "mcpServerElicitation",
          requestId: "typography-request",
          projectId: "project",
          threadId: "thread",
          turnId: "turn",
          itemId: "item",
          kind: "generic",
          serverName: "Docs",
          mode: "openai/form",
          message: "Choose documentation",
          requestedSchema: {
            type: "object",
            properties: {
              library: {
                type: "string",
                title: "Library",
                description: "Choose a library",
              },
            },
          },
          createdAt: 1,
        }}
        onRespond={async () => {}}
      />,
    );
    const description = await view.findByText("Choose a library");
    const input = await view.findByLabelText("Library");
    const label = input.closest("label")?.querySelector("div");
    if (!label) throw new Error("Missing request field label");
    expect(font(label)).toMatchObject({ size: 13, line: 20, weight: "500" });
    expect(font(description)).toMatchObject({ size: 13, line: 20 });
    applySizes(16, 16);
    expect(font(label)).toMatchObject({ size: 15, line: 20 });
    expect(font(description)).toMatchObject({ size: 15, line: 20 });
  });
});
