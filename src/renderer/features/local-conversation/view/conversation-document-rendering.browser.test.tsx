import {
  act,
  fireEvent,
  waitFor,
  render as renderForLocalConversationSearchHighlights,
  render as renderForRealtimeUserContent,
} from "@testing-library/react";
import { StrictMode, createElement } from "react";
import { describe, expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import "streamdown/styles.css";
import { renderWithMaitai as render, renderWithMaitai } from "../../../test/thread-maitai";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import {
  CodexTranscriptReadOwnerContext,
  CodexTranscriptTurnEntityContext,
} from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import {
  isCodexRealtimeTimelineEntry,
  isCodexTimelineTurnEntry,
  type CodexRealtimeTimelineEntry,
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
import { revealContentSearchUnit } from "../../content-search/content-search-reveal-owner";
import { waitForLocalConversationSearchLayout } from "./local-conversation-search-scroll";
import { applyLocalConversationSearchHighlights } from "./local-conversation-thread-search-dom-marks";
import { TestQueryProvider } from "../../../test/query";
import "../../../globals.css";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { ThreadLiveActivityFallback } from "./local-conversation-thread-turn";
import { LocalConversationTurnEntry } from "./local-conversation-turn-entry";

describe("conversation markdown dialect", () => {
  type Family = "ordinary" | "inlineMarkdown" | "voiceAssistant";
  const key = { hostId: "local", threadId: "thread", entityKey: "turn:one" };
  const payload = "alpha\n\n\n\nbeta\u2028gamma\u2029delta\u0085epsilon";
  const content =
    'before <kbd>needle</kbd> after\n\n::unknown{file="raw &amp; declaration"}' +
    `\n\n\`\`\`text\n${payload}\n\`\`\``;

  function nativeFamily(family: Family) {
    const item: Extract<ThreadItem, { type: "agentMessage" }> = {
      type: "agentMessage",
      moderation: null,
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
        const block = model.trailingBlocks.find(
          (candidate) => candidate.type === "assistantMessage",
        );
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
          await waitFor(() => {
            const code = root.querySelector("[data-readonly-code-block] code");
            expect(code?.textContent).toBe(payload);
            expect(code?.querySelector("span")).toBeNull();
          });
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
          const button = root.querySelector<HTMLButtonElement>('[data-code-block-action="copy"]')!;
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
            expect(root.querySelector('[data-code-block-action="copy"]')).toBe(button),
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
});

describe("local conversation search highlights", () => {
  function fixture(first: string, second: string) {
    const native = timelineOwnerFixture({
      data: [first, second].map((text, index) => ({
        type: "realtime",
        position: index + 1,
        item: {
          type: "transcriptSegment",
          id: `voice-${index}`,
          realtimeSessionId: "session",
          role: "assistant",
          text,
        },
      })),
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    const retain = native.owner.subscribeStructure(() => {});
    const entry = native.project().entries.find(isCodexRealtimeTimelineEntry);
    if (!entry) throw new Error("Missing native voice group");
    const source = createLocalConversationSearchSource({
      routeContextId: "thread",
      getTurns: () => [],
      getProjectedEntries: () => native.project().entries,
      readOwner: () => native.owner,
      scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
    });
    const result = projectLocalConversationResidentSearchResult({
      units: source.findMatches("needle"),
      query: "needle",
      contextId: "thread",
      limit: 250,
    });
    return { ...native, entry, retain, result };
  }
  function NativeRows({
    native,
    entry,
    identity,
  }: {
    native: ReturnType<typeof fixture>;
    entry: CodexRealtimeTimelineEntry;
    identity: number;
  }) {
    return (
      <CodexTranscriptReadOwnerContext.Provider value={native.owner}>
        <div data-testid="viewport" style={{ height: 220, width: 500, overflow: "auto" }}>
          <div data-testid="root">
            <LocalConversationRealtimeItem
              key={identity}
              entry={entry}
              itemId="voice-0"
              conversationId="thread"
              cwd="/workspace"
            />

            <LocalConversationRealtimeItem
              entry={entry}
              itemId="voice-1"
              conversationId="thread"
              cwd="/workspace"
            />

            <button data-content-search-skip>needle tool control</button>
          </div>
        </div>
      </CodexTranscriptReadOwnerContext.Provider>
    );
  }

  describe("native voice Find highlights in Chromium", () => {
    test("updates a highlighted native transcript without duplicated text or replacing its link", async () => {
      const original = "needle [label](https://example.test) and needle";
      const native = fixture(original, "unrelated");
      // A web link reads its site's icon.
      const view = renderForLocalConversationSearchHighlights(
        <NativeRows native={native} entry={native.entry} identity={0} />,
        { wrapper: TestQueryProvider },
      );
      const root = view.getByTestId("root");
      const highlights = createLocalConversationSearchHighlightOwner({
        readRoot: () => root,
        resolveTarget: (match) => match.meta as LocalConversationSearchTarget,
      });
      try {
        const link = await view.findByRole("link", { name: "label" });
        const unit = root.querySelector('[data-native-realtime-item-id="voice-0"]')!;
        await act(async () => {
          highlights.publishResult(native.result, native.result.matches[0]!.id);
          await Promise.resolve();
        });
        await waitFor(() => expect(unit.querySelectorAll("mark")).toHaveLength(2));
        await act(async () => {
          native.owner.applyEvent({
            type: "changes",
            changes: [{ type: "realtime-text", itemId: "voice-0", delta: " new ending" }],
          });
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(unit.textContent).toBe("needle label and needle new ending");
          expect(unit.querySelectorAll("mark")).toHaveLength(2);
          expect(view.getByRole("link", { name: "label" })).toBe(link);
          expect(highlights.readActiveMatch(native.result.matches[0]!.id)?.textContent).toBe(
            "needle",
          );
        });
      } finally {
        highlights.clear();
        view.unmount();
        native.retain();
      }
    });
    test("retains exact marks after a native leaf remount without changing viewport position", async () => {
      const native = fixture("paragraph\n\n".repeat(40) + "needle", "second needle");
      const view = renderForLocalConversationSearchHighlights(
        <NativeRows native={native} entry={native.entry} identity={0} />,
      );
      const root = view.getByTestId("root");
      const viewport = view.getByTestId("viewport");
      const highlights = createLocalConversationSearchHighlightOwner({
        readRoot: () => root,
        resolveTarget: (match) => match.meta as LocalConversationSearchTarget,
      });
      try {
        await waitFor(() =>
          expect(root.querySelectorAll("[data-native-realtime-item-id]")).toHaveLength(2),
        );
        await act(async () => {
          highlights.publishResult(native.result, native.result.matches[0]!.id);
          viewport.scrollTop = viewport.scrollHeight;
          await Promise.resolve();
        });
        const before = viewport.scrollTop;
        const oldMark = highlights.readActiveMatch(native.result.matches[0]!.id)!;
        const beforeTop = oldMark.getBoundingClientRect().top;
        await act(async () => {
          view.rerender(<NativeRows native={native} entry={native.entry} identity={1} />);
          await Promise.resolve();
        });
        await waitFor(() => {
          const mark = highlights.readActiveMatch(native.result.matches[0]!.id);
          expect(mark?.textContent).toBe("needle");
          expect(mark).not.toBe(oldMark);
          expect(Math.abs(mark!.getBoundingClientRect().top - beforeTop)).toBeLessThanOrEqual(1);
          expect(Math.abs(viewport.scrollTop - before)).toBeLessThanOrEqual(1);
        });
        expect(root.querySelector("button mark")).toBeNull();
        expect(native.owner.readStructure()?.turns).toHaveLength(0);
      } finally {
        highlights.clear();
        view.unmount();
        native.retain();
      }
    });

    test("bounds highlights by the native search unit result and keeps retained mark identity", async () => {
      const native = fixture("needle ".repeat(200), "needle ".repeat(200));
      const view = renderForLocalConversationSearchHighlights(
        <NativeRows native={native} entry={native.entry} identity={0} />,
      );
      const root = view.getByTestId("root");
      const activeId = native.result.matches.at(-1)!.id;
      const highlights = createLocalConversationSearchHighlightOwner({
        readRoot: () => root,
        resolveTarget: (match) => match.meta as LocalConversationSearchTarget,
      });
      try {
        await waitFor(() =>
          expect(root.querySelectorAll("[data-native-realtime-item-id]")).toHaveLength(2),
        );
        await act(async () => {
          highlights.publishResult(native.result, activeId);
          await Promise.resolve();
        });
        expect(native.result.totalMatches).toBe(400);
        expect(native.result.matches).toHaveLength(250);
        expect(root.querySelectorAll("mark")).toHaveLength(250);
        expect(root.querySelectorAll('[data-native-realtime-item-id="voice-1"] mark')).toHaveLength(
          50,
        );
        const mark = highlights.readActiveMatch(activeId)!;
        expect(mark.getAttribute("data-content-search-match-id")).toBe(activeId);
        expect(mark.getBoundingClientRect().height).toBeGreaterThan(0);
        expect(root.querySelector("button mark")).toBeNull();
      } finally {
        highlights.clear();
        view.unmount();
        native.retain();
      }
    });
  });
});

describe("native voice user disclosure geometry", () => {
  test("the native user owner reveals a folded Find tail without replacing its Markdown content", async () => {
    const text = "A spoken user line\n".repeat(60) + "\n[Tailneedle](https://example.com/result)";
    const fixture = timelineOwnerFixture({
      data: [
        {
          type: "realtime",
          position: 1,
          item: {
            type: "transcriptSegment",
            id: "user",
            realtimeSessionId: "session",
            role: "user",
            text,
          },
        },
      ],

      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    const retain = fixture.owner.subscribeStructure(() => {});
    const entries = fixture.project().entries;
    const entry = entries.find(isCodexRealtimeTimelineEntry)!;
    const source = createLocalConversationSearchSource({
      routeContextId: "thread",
      getTurns: () => [],
      getProjectedEntries: () => entries,
      readOwner: () => fixture.owner,
      scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
    });
    const view = renderForRealtimeUserContent(
      <div style={{ width: 420 }}>
        <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
          <LocalConversationRealtimeItem entry={entry} conversationId="thread" cwd={null} />
        </CodexTranscriptReadOwnerContext.Provider>
      </div>,
      { wrapper: TestQueryProvider },
    );
    try {
      await view.findByRole("button", { name: "Show more" });
      const tail = (await view.findByText("Tailneedle")).closest("a")!;
      const unit = view.container.querySelector<HTMLElement>("[data-content-search-unit-key]")!;
      await waitFor(() => expect(tail.hasAttribute("inert")).toBe(true));
      expect(tail.getBoundingClientRect().top).toBeGreaterThan(unit.getBoundingClientRect().bottom);
      const targetUnit = source.findMatches("Tailneedle")[0]!;
      await act(async () => {
        expect(revealContentSearchUnit(unit)).toBe(true);
        await waitForLocalConversationSearchLayout();
      });
      await view.findByRole("button", { name: "Show less" });
      expect(view.getByRole("link", { name: "Tailneedle" })).toBe(tail);
      expect(tail.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        unit.getBoundingClientRect().bottom + 1,
      );
      await act(async () => {
        const mark = applyLocalConversationSearchHighlights({
          root: view.container,
          query: "Tailneedle",
          target: { turnKey: targetUnit.turnKey, unitKey: targetUnit.key, occurrenceIndex: 0 },
        });
        expect(mark?.textContent).toBe("Tailneedle");
        expect(mark?.closest("a")).toBe(tail);
        await Promise.resolve();
      });
      expect(fixture.owner.readStructure()?.turns).toHaveLength(0);
    } finally {
      view.unmount();
      retain();
    }
  });
});

describe("thought layout", () => {
  const THREAD_WIDTH = 320;
  const longProse = `I need to check whether the status label stays on one line. ${"The group header renders the summary inside an inline span. ".repeat(80)}`;

  function item(itemId: string, overrides: Partial<CodexConversationItem>): CodexConversationItem {
    return {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId,
      type: "reasoning",
      kind: "reasoning",
      semanticKind: "reasoning",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  function renderStreamingTurn(thought: CodexConversationItem) {
    const turn: CodexConversationTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      status: "inProgress",
      itemIds: ["user", thought.itemId],
      items: [
        item("user", {
          type: "user_message",
          kind: "userMessage",
          semanticKind: "userMessage",
          role: "user",
          markdownText: "Fix the label",
        }),
        thought,
      ],
    };
    return renderWithMaitai(
      createElement(
        "div",
        { style: { width: THREAD_WIDTH } },
        createElement(
          NodexTooltipProvider,
          null,
          createElement(LocalConversationTurnEntry, {
            conversationId: "thread_1",
            entry: {
              turn,
              turnId: turn.turnId,
              turnKey: "turn_1",
              turnSearchKey: "turn_1",
              requests: [],
              isMostRecentTurn: true,
            },
            cwd: "/tmp/project",
            canEditTurnUserPrefix: false,
            canForkTurn: false,
          }),
        ),
      ),
      { wrapper: LocalConversationTestQueryProvider },
    );
  }

  function expectOneLineWithin(element: HTMLElement, frame: HTMLElement) {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    const box = element.getBoundingClientRect();
    expect(box.height).toBeLessThan(lineHeight * 1.5);
    expect(box.right).toBeLessThanOrEqual(frame.getBoundingClientRect().right + 0.5);
  }

  const originalApi = window.api;
  beforeEach(() => {
    window.api = {
      on: () => () => {},
      invoke: async (channel) =>
        channel === "persisted-atom:sync-request" ? { revision: 0, values: {} } : undefined,
    };
  });
  afterEach(() => {
    window.api = originalApi;
  });

  describe("Thought layout", () => {
    test("a long thinking status stays one truncated line inside the Thread", () => {
      const view = renderWithMaitai(
        createElement(
          "div",
          { style: { width: THREAD_WIDTH }, "data-testid": "frame" },
          createElement(ThreadLiveActivityFallback, { message: longProse }),
        ),
      );
      const status = view.container.querySelector<HTMLElement>("[data-codex-shimmer]");
      if (!status) throw new Error("expected the thinking status");
      expectOneLineWithin(status, view.getByTestId("frame"));
      expect(status.scrollWidth).toBeGreaterThan(status.clientWidth);
    });

    test("a long heading stays one line in a thinking group header", async () => {
      const heading = `Checking ${"the reducer and its projections ".repeat(30)}`;
      const view = renderStreamingTurn(
        item("thought", { status: "inProgress", markdownText: `**${heading}**` }),
      );
      const header = await view.findByRole("button", { name: heading.trim() });
      expectOneLineWithin(header, view.container.firstElementChild as HTMLElement);
    });

    test("streaming prose shows five lines under the Thinking status", async () => {
      const view = renderStreamingTurn(
        item("thought", { status: "inProgress", markdownText: longProse }),
      );
      const header = await view.findByRole("button", { name: "Thinking" });
      expectOneLineWithin(header, view.container.firstElementChild as HTMLElement);
      const preview = view.getByTestId("thought-live-preview");
      await waitFor(() => {
        const paragraph = preview.querySelector("p");
        const scroll = preview.querySelector<HTMLElement>(".vertical-scroll-fade-mask");
        if (!paragraph || !scroll) throw new Error("expected streaming Thought prose");
        const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
        expect(scroll.getBoundingClientRect().height).toBeCloseTo(lineHeight * 5, 0);
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
        expect(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight).toBeLessThanOrEqual(1);
      });
    });
  });
});
