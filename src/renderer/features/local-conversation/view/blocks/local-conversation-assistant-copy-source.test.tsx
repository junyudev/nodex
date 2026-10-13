import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  CodexTranscriptReadOwnerContext,
  CodexTranscriptTurnEntityContext,
} from "../../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../../projection/normalized-timeline.test-fixtures";
import { buildTurnRenderModel } from "../../projection/build-turn-render-model";
import { ThreadBlockRenderer } from "./local-conversation-block-renderer";
import { LocalConversationTestQueryProvider } from "../local-conversation-test-query.test-fixtures";
import { getMessageCopyHtml } from "../shared/message-clipboard";

const key = { hostId: "local", threadId: "thread", entityKey: "turn:one", itemId: "answer" };
function nativeAssistant(source: string, deferred: boolean) {
  const answer: ThreadItem = {
    type: "agentMessage",
    id: key.itemId,
    text: source,
    phase: deferred ? null : "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  const command: ThreadItem = {
    type: "commandExecution",
    id: "command",
    command: "true",
    cwd: "/workspace",
    status: "completed",
    source: "agent",
    commandActions: [],
    aggregatedOutput: "",
    exitCode: 0,
    durationMs: 1,
    processId: null,
    pluginId: null,
    scriptPath: null,
  };
  const fixture = timelineOwnerFixture(
    { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null },
    deferred ? [answer, command] : [answer],
  );
  const retain = fixture.owner.subscribeStructure(() => {});
  const turn = fixture.owner.readTurn(key.entityKey);
  if (!turn) throw new Error("Missing native assistant Turn");
  const model = buildTurnRenderModel({
    turn,
    requests: [],
    isLatestTurn: true,
    isStreamingTurn: false,
  });
  const block = model.trailingBlocks.find(
    (block) => block.type === (deferred ? "assistantActions" : "assistantMessage"),
  );
  if (!block) throw new Error("Missing native assistant action");
  return { ...fixture, retain, block };
}
function NativeAction({
  fixture,
  owner = fixture.owner,
}: {
  fixture: ReturnType<typeof nativeAssistant>;
  owner?: ReturnType<typeof nativeAssistant>["owner"] | null;
}) {
  return (
    <LocalConversationTestQueryProvider>
      <NodexTooltipProvider>
        <CodexTranscriptReadOwnerContext.Provider value={owner}>
          <CodexTranscriptTurnEntityContext.Provider value={key.entityKey}>
            <section data-content-search-turn-key="one">
              <ThreadBlockRenderer block={fixture.block} isLatestTurn isStreamingTurn={false} />
            </section>
          </CodexTranscriptTurnEntityContext.Provider>
        </CodexTranscriptReadOwnerContext.Provider>
      </NodexTooltipProvider>
    </LocalConversationTestQueryProvider>
  );
}
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

describe("native assistant Copy source", () => {
  test("does not offer Copy when preparation leaves only private-reference whitespace", () => {
    const fixture = nativeAssistant("cite cite", false);
    const mounted = render(<NativeAction fixture={fixture} />);
    try {
      expect(mounted.queryByRole("button", { name: /^Copy$/ })).toBeNull();
    } finally {
      mounted.unmount();
      fixture.retain();
    }
  });
  test("does not treat the last native snapshot as an unbound source after its owner leaves", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fixture = nativeAssistant("Bound native source", true);
    const mounted = render(<NativeAction fixture={fixture} />);
    try {
      const button = await mounted.findByRole("button", { name: /^Copy$/ });
      mounted.rerender(<NativeAction fixture={fixture} owner={null} />);
      expect(mounted.getByRole("button", { name: /^Copy$/ })).toBe(button);
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
      fixture.retain();
    }
  });
  test("copies the projected native source after memory and internal delivery cleanup", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fixture = nativeAssistant(
      "  **Public** <oai-mem-citation>private</oai-mem-citation>\n\n[external_agent_tool_result]\nsecret\n[/external_agent_tool_result]\n\nTail  ",
      false,
    );
    const mounted = render(<NativeAction fixture={fixture} />);
    try {
      const button = await mounted.findByRole("button", { name: /^Copy$/ });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("**Public** \n\nTail"));
    } finally {
      mounted.unmount();
      fixture.retain();
    }
  });
  test.each([false, true])(
    "reads the current item with deferred body=%s, preserving its action and avoiding whole Turn reads",
    async (deferred) => {
      const source = "Original **answer**";
      const suffix = "\n\n**Latest**\n\n\n\n::unknown{value=literal}";
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const fixture = nativeAssistant(source, deferred);
      const mounted = render(<NativeAction fixture={fixture} />);
      try {
        const button = await mounted.findByRole("button", { name: /^Copy$/ });
        const wholeTurn = vi.spyOn(fixture.owner, "readTurn");
        const slice = vi.spyOn(fixture.owner, "readTurnSlice");
        await act(async () => {
          button.focus();
          fixture.owner.applyEvent({
            type: "changes",
            changes: [
              {
                type: "text",
                key,
                target: { field: "text" },
                edits: [{ at: source.length, deleteCount: 0, insert: suffix }],
              },
            ],
          });
          await Promise.resolve();
        });
        expect(mounted.getByRole("button", { name: /^Copy$/ })).toBe(button);
        expect(document.activeElement).toBe(button);
        if (deferred) expect(getMessageCopyHtml(button)).toBeNull();
        await act(async () => {
          fireEvent.click(button);
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(writeText).toHaveBeenCalledExactlyOnceWith((source + suffix).trim()),
        );
        expect(wholeTurn).not.toHaveBeenCalled();
        expect(slice).not.toHaveBeenCalled();
      } finally {
        mounted.unmount();
        fixture.retain();
      }
    },
  );
  test("rejects a retired item while its original Copy button is still connected", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fixture = nativeAssistant("A retired answer", false);
    const mounted = render(<NativeAction fixture={fixture} />);
    try {
      const button = await mounted.findByRole("button", { name: /^Copy$/ });
      await act(async () => {
        fixture.owner.applyEvent({
          type: "changes",
          changes: [{ type: "item", key, value: null }],
        });
        expect(button.isConnected).toBe(true);
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
      fixture.retain();
    }
  });
  test("rejects a disposed owner while the deferred action remains connected", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fixture = nativeAssistant("Retired owner", true);
    const mounted = render(<NativeAction fixture={fixture} />);
    try {
      const button = await mounted.findByRole("button", { name: /^Copy$/ });
      await act(async () => {
        fixture.owner.dispose();
        expect(button.isConnected).toBe(true);
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
      fixture.retain();
    }
  });
});
