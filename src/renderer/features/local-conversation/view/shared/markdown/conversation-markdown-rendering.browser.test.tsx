/// <reference types="vite/client" />

import { waitFor, act } from "@testing-library/react";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import { describe, expect, test } from "vite-plus/test";
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
import "streamdown/styles.css";
import { StrictMode } from "react";
import { CodexTranscriptReadOwnerContext } from "../../../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../../../projection/normalized-timeline.test-fixtures";
import {
  isCodexRealtimeTimelineEntry,
  isCodexTimelineTurnEntry,
} from "../../../projection/normalized-timeline-entries";
import { LocalConversationRealtimeItem } from "../../local-conversation-realtime-item";
import { LocalConversationTimelinePromotion } from "../../local-conversation-timeline-promotion";
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
} from "../../local-conversation-search-source";
import { createLocalConversationSearchHighlightOwner } from "../../local-conversation-search-highlight-owner";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { LocalConversationSearchTarget } from "../../local-conversation-persisted-search";

describe("conversation typography", () => {
  installRendererThemeFixture();

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
      expect(font(view.getByRole("heading", { level: 2 }))).toMatchObject({
        size: 17.5,
        line: 24.5,
      });
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
});

describe("typed Markdown committed rendering in Chromium", () => {
  test("settles real CSS animation without restarting committed spans and retains a focused closed-code action", async () => {
    const source = "Hello world\n\n```text\nsource\n```";
    const view = render(
      <StrictMode>
        <MarkdownRenderer
          dialect="conversation"
          content={source}
          parseIncompleteMarkdown
          animateStreamingText
        />
      </StrictMode>,
    );
    try {
      const first = view.container.querySelector<HTMLSpanElement>("[data-markdown-segment]")!;
      expect(first.hasAttribute("data-sd-animate")).toBe(true);
      await waitFor(() => expect(first.hasAttribute("data-sd-animate")).toBe(false));
      const button = view.container.querySelector<HTMLButtonElement>(
        '[data-code-block-action="copy"]',
      )!;
      expect(button.disabled).toBe(false);
      await act(async () => {
        button.focus();
        await Promise.resolve();
      });
      const appended = `${source}\n\nAppended tail`;
      view.rerender(
        <StrictMode>
          <MarkdownRenderer
            dialect="conversation"
            content={appended}
            parseIncompleteMarkdown
            animateStreamingText
          />
        </StrictMode>,
      );
      expect(view.container.querySelector("[data-markdown-segment]")).toBe(first);
      expect(first.hasAttribute("data-sd-animate")).toBe(false);
      expect(view.container.querySelector('[data-code-block-action="copy"]')).toBe(button);
      expect(document.activeElement).toBe(button);
      view.rerender(
        <StrictMode>
          <MarkdownRenderer
            dialect="conversation"
            content={appended}
            parseIncompleteMarkdown={false}
          />
        </StrictMode>,
      );
      expect(view.container.querySelector("[data-markdown-segment]")).toBeNull();
      expect(view.container.querySelectorAll("p")[1]?.textContent).toBe("Appended tail");
      expect(document.activeElement).toBe(button);
      expect(view.container.querySelector("[data-sd-animate]")).toBeNull();
    } finally {
      view.unmount();
    }
  });
  test.each([
    {
      family: "ordinary inline",
      name: "plain",
      content: "a needle phrase in native history",
      fragmentText: "needle phrase",
      breaks: 1,
    },
    {
      family: "ordinary inline",
      name: "formatted",
      content: "a needle **phrase** in native history",
      fragmentText: "needle phrase",
      breaks: 1,
    },
    {
      family: "ordinary inline",
      name: "blockquote paragraphs",
      content: "> a needle\n>\n> **phrase** in native history",
      fragmentText: "needlephrase",
      breaks: 1,
    },
    {
      family: "ordinary inline",
      name: "formatted line break",
      content: "a needle\n**phrase** in native history",
      fragmentText: "needlephrase",
      breaks: 2,
    },
    {
      family: "voice",
      name: "raw source index",
      content: "a needle **phrase** in native history",
      fragmentText: "native history",
      breaks: 1,
    },
  ])(
    "resident $family Find preserves text and marks across remount and completion: $name",
    async ({ family, content, fragmentText, breaks }) => {
      const text = "first line\nsecond line\n\n" + "paragraph\n\n".repeat(20) + content;
      const voice = family === "voice";
      const item: Extract<ThreadItem, { type: "agentMessage" }> = {
        type: "agentMessage",
        moderation: null,
        id: "native-answer",
        text: `::codex-realtime-inline{}\n${text}`,
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      const native = timelineOwnerFixture(
        {
          data: [
            {
              type: "realtime",
              position: 1,
              item: voice
                ? {
                    type: "transcriptSegment",
                    id: "native-voice",
                    realtimeSessionId: "session",
                    role: "assistant",
                    text,
                  }
                : {
                    type: "bemItemPromoted",
                    id: "native-inline-receipt",
                    realtimeSessionId: "session",
                    turnId: "one",
                    itemId: item.id,
                    presentation: { type: "inlineMarkdown" },
                  },
            },
          ],
          nextCursor: null,
          activeRealtimeSessionAtPageStart: "session",
        },
        voice ? [] : [item],
        voice ? undefined : { status: "inProgress", completedAt: null, durationMs: null },
      );
      const updateNative = (nextText: string, completed: boolean) => {
        if (voice) {
          const previous = native.owner.readRealtimeItem("native-voice");
          if (previous?.item.type !== "transcriptSegment")
            throw new Error("Missing transcript segment");
          native.owner.applyEvent({
            type: "changes",
            changes: [
              {
                type: "realtime-item",
                itemId: "native-voice",
                value: { ...previous, item: { ...previous.item, text: nextText }, completed },
              },
            ],
          });
          return;
        }
        const key = { hostId: "local", threadId: "thread", entityKey: "turn:one" };
        const previous = native.owner.readItem(key.entityKey, item.id);
        const details = native.owner.readTurnDetails(key.entityKey);
        if (previous?.type !== "agentMessage" || !details)
          throw new Error("Missing promoted assistant item");
        native.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item",
              key: { ...key, itemId: item.id },
              value: { ...previous, text: `::codex-realtime-inline{}\n${nextText}` },
            },
            {
              type: "turn",
              key,
              details: {
                ...details,
                status: completed ? "completed" : "inProgress",
                lifecycleStatusByItemId: {
                  [item.id]: completed ? "completed" : "inProgress",
                },
              },
              hasSubagentActivity: false,
            },
          ],
        });
      };
      updateNative(text, false);
      const retain = native.owner.subscribeStructure(() => {});
      const entry = native
        .project()
        .entries.find((candidate) =>
          voice
            ? isCodexRealtimeTimelineEntry(candidate)
            : isCodexTimelineTurnEntry(candidate) &&
              candidate.timelinePresentation?.type === "inlineMarkdown",
        );
      if (!entry) throw new Error("Missing native entry");
      const source = createLocalConversationSearchSource({
        routeContextId: "thread",
        getTurns: () => [],
        getProjectedEntries: () => native.project().entries,
        readOwner: () => native.owner,
        scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
      });
      const query = voice ? "native history" : "needle phrase";
      const units = source.findMatches(query);
      expect(units).toHaveLength(1);
      if (voice) {
        expect(units[0]?.text).toBe(text);
        expect(source.findMatches("needle phrase")).toEqual([]);
        expect(source.findMatches("**phrase**")).toHaveLength(1);
      } else {
        expect(units[0]?.itemId).toBe(item.id);
        expect(units[0]?.turnId).toBe("one");
        expect(units[0]?.text).toContain("needle phrase in native history");
        expect(source.findMatches("**phrase**")).toEqual([]);
      }
      const result = projectLocalConversationResidentSearchResult({
        units,
        query,
        contextId: "thread",
        limit: 250,
      });
      expect(result.totalMatches).toBe(1);
      const rows = (identity: number) => (
        <CodexTranscriptReadOwnerContext.Provider value={native.owner}>
          <div style={{ height: 180, width: 500, overflow: "auto" }} data-testid="viewport">
            <div data-testid="root">
              {isCodexRealtimeTimelineEntry(entry) ? (
                <LocalConversationRealtimeItem
                  key={identity}
                  entry={entry}
                  conversationId="thread"
                  cwd="/workspace"
                />
              ) : isCodexTimelineTurnEntry(entry) ? (
                <LocalConversationTimelinePromotion key={identity} entry={entry} cwd="/workspace" />
              ) : null}
              <button data-content-search-skip>{query} control</button>
            </div>
          </div>
        </CodexTranscriptReadOwnerContext.Provider>
      );
      const view = render(rows(0));
      const root = view.getByTestId("root");
      const viewport = view.getByTestId("viewport");
      const highlights = createLocalConversationSearchHighlightOwner({
        readRoot: () => root,
        resolveTarget: (match) => match.meta as LocalConversationSearchTarget,
      });
      const readFragments = () =>
        Array.from(
          root.querySelectorAll<HTMLElement>(
            `[data-content-search-match-id="${CSS.escape(result.matches[0]!.id)}"]`,
          ),
        );
      const readMarkedText = () =>
        readFragments()
          .map((fragment) => fragment.textContent)
          .join("");
      try {
        await act(async () => {
          highlights.publishResult(result, result.matches[0]!.id);
          viewport.scrollTop = viewport.scrollHeight;
          await Promise.resolve();
        });
        expect(root.querySelector("[data-markdown-segment]")).not.toBeNull();
        expect(root.querySelectorAll("br")).toHaveLength(breaks);
        const before = viewport.scrollTop;
        const mark = highlights.readActiveMatch(result.matches[0]!.id)!;
        expect(readMarkedText()).toBe(fragmentText);
        expect(mark).toBe(readFragments()[0]);
        expect(
          new Set(
            Array.from(
              root.querySelectorAll("mark"),
              (element) => element.dataset.contentSearchMatchId,
            ),
          ),
        ).toEqual(new Set([result.matches[0]!.id]));
        expect(root.querySelector("button mark")).toBeNull();
        const top = mark.getBoundingClientRect().top;
        view.rerender(rows(1));
        await waitFor(() => {
          const current = highlights.readActiveMatch(result.matches[0]!.id)!;
          expect(current).not.toBe(mark);
          expect(readMarkedText()).toBe(fragmentText);
          expect(current).toBe(readFragments()[0]);
          expect(Math.abs(current.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1);
          expect(Math.abs(viewport.scrollTop - before)).toBeLessThanOrEqual(1);
        });
        await act(async () => {
          updateNative(`${text}\n\ncompleted tail`, true);
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(root.querySelector("[data-markdown-segment]")).toBeNull();
          expect(readMarkedText()).toBe(fragmentText);
          expect(highlights.readActiveMatch(result.matches[0]!.id)).toBe(readFragments()[0]);
          expect(view.getByText("completed tail")).toBeDefined();
        });
      } finally {
        highlights.clear();
        view.unmount();
        retain();
      }
    },
  );
});
