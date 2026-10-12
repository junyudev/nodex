import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import {
  isCodexRealtimeTimelineEntry,
  type CodexRealtimeTimelineEntry,
} from "../projection/normalized-timeline-entries";
import { LocalConversationRealtimeItem } from "./local-conversation-realtime-item";
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
} from "./local-conversation-search-source";
import { createLocalConversationSearchHighlightOwner } from "./local-conversation-search-highlight-owner";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";

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
  test("retains exact marks after a native leaf remount without changing viewport position", async () => {
    const native = fixture("paragraph\n\n".repeat(40) + "needle", "second needle");
    const view = render(<NativeRows native={native} entry={native.entry} identity={0} />);
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
    const view = render(<NativeRows native={native} entry={native.entry} identity={0} />);
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
