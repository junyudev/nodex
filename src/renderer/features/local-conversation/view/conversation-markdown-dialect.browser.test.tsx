import { act, fireEvent, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import "streamdown/styles.css";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import { waitForStreamdownCodeHighlight } from "../../../test/dom";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import {
  CodexTranscriptReadOwnerContext,
  CodexTranscriptTurnEntityContext,
} from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import {
  isCodexRealtimeTimelineEntry,
  isCodexTimelineTurnEntry,
} from "../projection/normalized-timeline-entries";
import { buildTurnRenderModel } from "../projection/build-turn-render-model";
import { ThreadBlockRenderer } from "./blocks/local-conversation-block-renderer";
import { LocalConversationTimelinePromotion } from "./local-conversation-timeline-promotion";
import { LocalConversationRealtimeItem } from "./local-conversation-realtime-item";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
} from "./local-conversation-search-source";
import { createLocalConversationSearchHighlightOwner } from "./local-conversation-search-highlight-owner";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";

type Family = "ordinary" | "inlineMarkdown" | "voiceAssistant";
const key = { hostId: "local", threadId: "thread", entityKey: "turn:one" };
const payload = "alpha\n\n\n\nbeta\u2028gamma\u2029delta\u0085epsilon";
const content =
  'before <kbd>needle</kbd> after\n\n::unknown{file="raw &amp; declaration"}' +
  `\n\n\`\`\`text\n${payload}\n\`\`\``;

function nativeFamily(family: Family) {
  const item: Extract<ThreadItem, { type: "agentMessage" }> = {
    type: "agentMessage",
    id: "answer",
    text: family === "inlineMarkdown" ? `::codex-realtime-inline{}\n${content}` : content,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  const native = timelineOwnerFixture(
    {
      data:
        family === "ordinary"
          ? []
          : [
              {
                type: "realtime",
                position: 1,
                item:
                  family === "inlineMarkdown"
                    ? {
                        type: "bemItemPromoted",
                        id: "promotion",
                        realtimeSessionId: "session",
                        turnId: "one",
                        itemId: "answer",
                        presentation: { type: "inlineMarkdown" },
                      }
                    : {
                        type: "transcriptSegment",
                        id: "voice",
                        realtimeSessionId: "session",
                        role: "assistant",
                        text: content,
                      },
              },
            ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    },
    family === "voiceAssistant" ? [] : [item],
  );
  const retain = native.owner.subscribeStructure(() => {});
  const details = native.owner.readTurnDetails(key.entityKey);
  const voice = native.owner.readRealtimeItem("voice");
  const setPhase = (streaming: boolean) => {
    if (voice) {
      native.owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "realtime-item",
            itemId: "voice",
            value: { ...voice, completed: !streaming },
          },
        ],
      });
      return;
    }
    if (!details) throw new Error("Missing native Turn");
    native.owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key,
          details: {
            ...details,
            status: streaming ? "inProgress" : "completed",
            lifecycleStatusByItemId: { answer: streaming ? "inProgress" : "completed" },
          },
          hasSubagentActivity: false,
        },
      ],
    });
  };
  setPhase(true);
  const entry = native
    .project()
    .entries.find((candidate) =>
      family === "inlineMarkdown"
        ? isCodexTimelineTurnEntry(candidate) &&
          candidate.timelinePresentation?.type === "inlineMarkdown"
        : isCodexRealtimeTimelineEntry(candidate),
    );
  const source = createLocalConversationSearchSource({
    routeContextId: "thread",
    getTurns: () => [],
    getProjectedEntries: () => native.project().entries,
    readOwner: () => native.owner,
    scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
  });
  const leaf = (streaming: boolean) => {
    if (family === "ordinary") {
      const turn = native.owner.readTurn(key.entityKey);
      if (!turn) throw new Error("Missing native Turn");
      const model = buildTurnRenderModel({
        turn,
        requests: [],
        isLatestTurn: true,
        isStreamingTurn: streaming,
      });
      const block = model.trailingBlocks.find((candidate) => candidate.type === "assistantMessage");
      if (!block) throw new Error("Missing assistant block");
      return (
        <CodexTranscriptTurnEntityContext.Provider value={key.entityKey}>
          <ThreadBlockRenderer block={block} isLatestTurn isStreamingTurn={streaming} />
        </CodexTranscriptTurnEntityContext.Provider>
      );
    }
    if (entry && isCodexRealtimeTimelineEntry(entry))
      return (
        <LocalConversationRealtimeItem entry={entry} conversationId="thread" cwd="/workspace" />
      );
    if (entry && isCodexTimelineTurnEntry(entry))
      return <LocalConversationTimelinePromotion entry={entry} cwd="/workspace" />;
    throw new Error("Missing native presentation");
  };
  const rows = (streaming: boolean) => (
    <StrictMode>
      <NodexTooltipProvider>
        <CodexTranscriptReadOwnerContext.Provider value={native.owner}>
          <div data-testid="root">
            {leaf(streaming)}
            <button data-content-search-skip>needle control</button>
          </div>
        </CodexTranscriptReadOwnerContext.Provider>
      </NodexTooltipProvider>
    </StrictMode>
  );
  return { ...native, retain, source, rows, setPhase, original: voice?.item ?? item };
}

describe("compiled assistant display and native Find", () => {
  test.each(["ordinary", "inlineMarkdown", "voiceAssistant"] as const)(
    "preserves %s literal grammar, code Copy and native identity through completion",
    async (family) => {
      const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      const writeText = vi.fn(async (_value: string) => undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const native = nativeFamily(family);
      const view = render(native.rows(true), { wrapper: LocalConversationTestQueryProvider });
      const root = view.getByTestId("root");
      const highlights = createLocalConversationSearchHighlightOwner({
        readRoot: () => root,
        resolveTarget: (match) => match.meta as LocalConversationSearchTarget,
      });
      try {
        await waitFor(() => {
          const paragraphs = root
            .querySelector("[data-content-search-unit-key]")
            ?.querySelectorAll("p");
          expect(paragraphs?.[0]?.textContent).toBe("before <kbd>needle</kbd> after");
          expect(paragraphs?.[1]?.textContent).toBe('::unknown{file="raw &amp; declaration"}');
        });
        expect(root.querySelector("kbd")).toBeNull();
        await waitForStreamdownCodeHighlight(root);
        const units = native.source.findMatches("needle");
        const result = projectLocalConversationResidentSearchResult({
          units,
          query: "needle",
          contextId: "thread",
          limit: 250,
        });
        expect(result.totalMatches).toBe(1);
        await act(async () => {
          highlights.publishResult(result, result.matches[0]!.id);
          await Promise.resolve();
        });
        const mark = highlights.readActiveMatch(result.matches[0]!.id)!;
        expect(mark.textContent).toBe("needle");
        expect(
          mark
            .closest("[data-content-search-unit-key]")
            ?.getAttribute("data-content-search-unit-key"),
        ).toBe(units[0]!.key);
        expect(root.querySelector("button mark")).toBeNull();
        const button = root.querySelector<HTMLButtonElement>(
          '[data-streamdown="code-block-copy-button"]',
        )!;
        await act(async () => {
          button.focus();
          fireEvent.click(button);
          await Promise.resolve();
        });
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(payload));
        await act(async () => {
          native.setPhase(false);
          view.rerender(native.rows(false));
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(root.querySelector('[data-streamdown="code-block-copy-button"]')).toBe(button),
        );
        expect(document.activeElement).toBe(button);
        await waitFor(() =>
          expect(highlights.readActiveMatch(result.matches[0]!.id)?.textContent).toBe("needle"),
        );
        const raw =
          family === "voiceAssistant"
            ? native.owner.readRealtimeItem("voice")?.item
            : native.owner.readItem(key.entityKey, "answer");
        expect(raw).toEqual(native.original);
      } finally {
        highlights.clear();
        view.unmount();
        native.retain();
        if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    },
  );
});
