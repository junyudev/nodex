import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import "streamdown/styles.css";
import { StrictMode } from "react";
import { MarkdownRenderer } from "./markdown-renderer";
import { CodexTranscriptReadOwnerContext } from "../../../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../../../projection/normalized-timeline.test-fixtures";
import { isCodexRealtimeTimelineEntry } from "../../../projection/normalized-timeline-entries";
import { LocalConversationRealtimeItem } from "../../local-conversation-realtime-item";
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
} from "../../local-conversation-search-source";
import { createLocalConversationSearchHighlightOwner } from "../../local-conversation-search-highlight-owner";
import { projectCodexTranscript } from "../../../../../../shared/codex-transcript-projection";
import type { LocalConversationSearchTarget } from "../../local-conversation-persisted-search";

describe("typed Markdown committed rendering in Chromium", () => {
  test("settles real CSS animation without restarting committed spans and retains a focused closed-code action", async () => {
    const source = "Hello world\n\n```text\nsource\n```";
    const view = render(
      <StrictMode>
        <MarkdownRenderer content={source} parseIncompleteMarkdown animateStreamingText />
      </StrictMode>,
    );
    try {
      const first = view.container.querySelector<HTMLSpanElement>("[data-markdown-segment]")!;
      await waitFor(() =>
        expect(first.getAnimations().every((animation) => animation.playState === "finished")).toBe(
          true,
        ),
      );
      const button = view.container.querySelector<HTMLButtonElement>(
        '[data-streamdown="code-block-copy-button"]',
      )!;
      expect(button.disabled).toBe(false);
      await act(async () => {
        button.focus();
        await Promise.resolve();
      });
      const appended = `${source}\n\nAppended tail`;
      view.rerender(
        <StrictMode>
          <MarkdownRenderer content={appended} parseIncompleteMarkdown animateStreamingText />
        </StrictMode>,
      );
      expect(view.container.querySelector("[data-markdown-segment]")).toBe(first);
      expect(first.hasAttribute("data-sd-animate")).toBe(false);
      expect(view.container.querySelector('[data-streamdown="code-block-copy-button"]')).toBe(
        button,
      );
      expect(document.activeElement).toBe(button);
      view.rerender(
        <StrictMode>
          <MarkdownRenderer content={appended} parseIncompleteMarkdown={false} />
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
  test("resident native Find marks typed text and survives a native leaf remount", async () => {
    const text =
      "first line\nsecond line\n\n" +
      "paragraph\n\n".repeat(20) +
      "a needle phrase in native history";
    const native = timelineOwnerFixture({
      data: [
        {
          type: "realtime",
          position: 1,
          item: {
            type: "transcriptSegment",
            id: "native-voice",
            realtimeSessionId: "session",
            role: "assistant",
            text,
          },
        },
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    const updateNative = (nextText: string, completed: boolean) => {
      const previous = native.state.realtimeItems["native-voice"]!;
      if (previous.item.type !== "transcriptSegment") throw new Error("Missing transcript segment");
      native.owner.applyEvent({
        type: "reset",
        value: projectCodexTranscript({
          ...native.state,
          realtimeItems: {
            "native-voice": { ...previous, item: { ...previous.item, text: nextText }, completed },
          },
        }),
      });
    };
    updateNative(text, false);
    const retain = native.owner.subscribeStructure(() => {});
    const entry = native.project().entries.find(isCodexRealtimeTimelineEntry);
    if (!entry) throw new Error("Missing native entry");
    const source = createLocalConversationSearchSource({
      routeContextId: "thread",
      getTurns: () => [],
      getProjectedEntries: () => native.project().entries,
      readOwner: () => native.owner,
      scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
    });
    const result = projectLocalConversationResidentSearchResult({
      units: source.findMatches("needle phrase"),
      query: "needle phrase",
      contextId: "thread",
      limit: 250,
    });
    const rows = (identity: number) => (
      <CodexTranscriptReadOwnerContext.Provider value={native.owner}>
        <div style={{ height: 180, width: 500, overflow: "auto" }} data-testid="viewport">
          <div data-testid="root">
            <LocalConversationRealtimeItem
              key={identity}
              entry={entry}
              conversationId="thread"
              cwd="/workspace"
            />
            <button data-content-search-skip>needle phrase control</button>
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
    try {
      await act(async () => {
        highlights.publishResult(result, result.matches[0]!.id);
        viewport.scrollTop = viewport.scrollHeight;
        await Promise.resolve();
      });
      expect(root.querySelector("[data-markdown-segment]")).not.toBeNull();
      expect(root.querySelectorAll("br")).toHaveLength(1);
      const before = viewport.scrollTop;
      const mark = highlights.readActiveMatch(result.matches[0]!.id)!;
      expect(mark.textContent).toBe("needle phrase");
      expect(root.querySelectorAll("mark")).toHaveLength(1);
      expect(root.querySelector("button mark")).toBeNull();
      const top = mark.getBoundingClientRect().top;
      view.rerender(rows(1));
      await waitFor(() => {
        const current = highlights.readActiveMatch(result.matches[0]!.id)!;
        expect(current).not.toBe(mark);
        expect(root.querySelectorAll("mark")).toHaveLength(1);
        expect(Math.abs(current.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1);
        expect(Math.abs(viewport.scrollTop - before)).toBeLessThanOrEqual(1);
      });
      await act(async () => {
        updateNative(`${text}\n\ncompleted tail`, true);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(root.querySelector("[data-markdown-segment]")).toBeNull();
        expect(highlights.readActiveMatch(result.matches[0]!.id)?.textContent).toBe(
          "needle phrase",
        );
        expect(view.getByText("completed tail")).toBeDefined();
      });
    } finally {
      highlights.clear();
      view.unmount();
      retain();
    }
  });
});
