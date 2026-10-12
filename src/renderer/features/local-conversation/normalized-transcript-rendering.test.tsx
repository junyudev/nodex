import { describe, expect, test, vi } from "vite-plus/test";
import { act, waitFor } from "@testing-library/react";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { createCodexCanonicalHydratedConversationState } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { projectCodexTranscript } from "../../../shared/codex-transcript-projection";
import { createCodexConversationHistoryTurnItemsRef } from "../../../shared/codex-conversation-history-page";
import { buildConversationPresentationTurns } from "./use-conversation-body-presentation";
import { CodexTranscriptReadOwner } from "./normalized-transcript-read-owner";
import { CodexTranscriptReadOwnerContext } from "./normalized-transcript-hooks";
import { selectNormalizedConversationTurnEntries } from "./normalized-transcript-selectors";
import { LocalConversationTurnEntry } from "./view/local-conversation-turn-entry";
import { LocalConversationTestQueryProvider } from "./view/local-conversation-test-query.test-fixtures";
import { renderWithMaitai } from "../../test/thread-maitai";
import { NodexTooltipProvider } from "../../components/ui/tooltip";
import { settleAsyncRender } from "../../test/dom";

const key = { hostId: "local", threadId: "thread" };
const agent = (id: string, text: string): Extract<ThreadItem, { type: "agentMessage" }> => ({
  type: "agentMessage",
  id,
  text,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
});
function ownerWithTurns(turnItems: ThreadItem[][]): CodexTranscriptReadOwner {
  const owner = new CodexTranscriptReadOwner(key);
  const state = createCodexCanonicalHydratedConversationState(
    {
      ...buildAgentActivityV2CorpusThread([]),
      id: key.threadId,
      turns: turnItems.map((items, index) => ({
        id: `turn-${index}`,
        items,
        itemsView: "full",
        rootTurnId: null,
        status: "inProgress",
        error: null,
        startedAt: index + 1,
        completedAt: null,
        durationMs: null,
      })),
    },
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
  );
  owner.applyEvent({ type: "reset", value: projectCodexTranscript(state) });
  return owner;
}
function rows(owner: CodexTranscriptReadOwner, rendered: (key: string) => void) {
  const entries = selectNormalizedConversationTurnEntries({
    owner,
    structure: owner.readStructure()!,
    conversation: null,
  });
  return (
    <CodexTranscriptReadOwnerContext.Provider value={owner}>
      <NodexTooltipProvider>
        {entries.map((entry) => (
          <LocalConversationTurnEntry
            key={entry.turnKey}
            conversationId="thread"
            entry={entry}
            cwd="/workspace"
            threadCwd="/workspace"
            canEditTurnUserPrefix={false}
            canForkTurn={false}
            onRendered={rendered}
          />
        ))}
      </NodexTooltipProvider>
    </CodexTranscriptReadOwnerContext.Provider>
  );
}
function render(ui: React.ReactElement) {
  return renderWithMaitai(ui, { wrapper: LocalConversationTestQueryProvider });
}

describe("normalized production transcript rendering", () => {
  test("presentation facades read current addressed content and release it with the owner", () => {
    const owner = ownerWithTurns([
      [{ type: "plan", id: "first", text: "Initial" }],
      [{ type: "plan", id: "other", text: "Other" }],
    ]);
    const release = owner.subscribeStructure(() => {});
    const readTurn = vi.spyOn(owner, "readTurn");
    const facades = buildConversationPresentationTurns(owner, owner.readStructure()!);
    expect(readTurn).not.toHaveBeenCalled();
    expect(facades[0]?.status).toBe("inProgress");
    expect(facades[0]?.items[0]?.markdownText).toBe("Initial");
    expect(readTurn).toHaveBeenCalledExactlyOnceWith("turn:turn-0");
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "text",
          key: { ...key, entityKey: "turn:turn-0", itemId: "first" },
          target: { field: "text" },
          edits: [{ at: 7, deleteCount: 0, insert: " next" }],
        },
      ],
    });
    expect(facades[0]?.items[0]?.markdownText).toBe("Initial next");
    expect(readTurn.mock.calls.every(([entity]) => entity === "turn:turn-0")).toBe(true);
    release();
    expect(owner.readStructure()).toBeNull();
    expect(facades[0]?.items).toEqual([]);
    readTurn.mockRestore();
  });

  test("reveals an assistant leaf after a hidden streaming prefix without committing its neighbor", async () => {
    const owner = ownerWithTurns([[agent("answer", "<")], [agent("neighbor", "Neighbor")]]);
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key: { ...key, entityKey: "turn:turn-0" },
          details: {
            ...owner.readTurnDetails("turn:turn-0")!,
            lifecycleStatusByItemId: { answer: "inProgress" },
          },
          hasSubagentActivity: false,
        },
      ],
    });
    const rendered = vi.fn();
    const view = render(rows(owner, rendered));
    await settleAsyncRender();
    const neighborCommits = rendered.mock.calls.filter(([turnKey]) => turnKey === "turn-1").length;
    expect(neighborCommits).toBeGreaterThan(0);
    expect(view.queryByText("Visible answer")).toBeNull();
    await act(async () => {
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "text",
            key: { ...key, entityKey: "turn:turn-0", itemId: "answer" },
            target: { field: "text" },
            edits: [
              {
                at: 1,
                deleteCount: 0,
                insert: "oai-mem-citation>internal</oai-mem-citation>Visible answer",
              },
            ],
          },
        ],
      });
      await Promise.resolve();
    });
    await settleAsyncRender();
    await waitFor(() => {
      const answer = view.container.querySelector(
        `[data-message-copy-root='${JSON.stringify(["thread", "turn-0", "answer"])}'] [data-thread-selected-text-target]`,
      );
      expect(answer?.textContent).toBe("Visible answer");
    });
    expect(rendered.mock.calls.filter(([turnKey]) => turnKey === "turn-1").length).toBe(
      neighborCommits,
    );
    view.unmount();
  });

  test("keeps a fully evicted empty Turn address available until its tail reloads", async () => {
    const owner = ownerWithTurns([[]]);
    const entityKey = "turn:turn-0";
    const select = () =>
      selectNormalizedConversationTurnEntries({
        owner,
        structure: owner.readStructure()!,
        conversation: null,
      });
    expect(select()).toHaveLength(0);
    const details = {
      ...owner.readTurnDetails(entityKey)!,
      status: "completed" as const,
      itemsPagination: {
        itemsView: "full" as const,
        olderCursor: null,
        isLoadingOlder: false,
        hasLoadedOldest: false,
        evicted: true,
      },
    };
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key: { ...key, entityKey },
          details,
          hasSubagentActivity: false,
        },
      ],
    });
    const entries = select();
    expect(entries).toHaveLength(1);
    expect(
      createCodexConversationHistoryTurnItemsRef({
        turnId: entries[0]!.turnId!,
        expectedTopologyGeneration: 0,
        pagination: details.itemsPagination,
      }),
    ).toMatchObject({ turnId: "turn-0", edge: "older" });
    const view = render(rows(owner, vi.fn()));
    await settleAsyncRender();
    const row = view.container.querySelector("[data-content-search-turn-key]");
    expect(row).not.toBeNull();
    await act(async () => {
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "item",
            key: { ...key, entityKey, itemId: "tail" },
            value: agent("tail", "Reloaded tail"),
          },
          {
            type: "item-slots",
            key: { ...key, entityKey },
            slots: { length: 1, entries: [{ index: 0, itemId: "tail" }] },
          },
        ],
      });
      view.rerender(rows(owner, vi.fn()));
      await Promise.resolve();
    });
    expect(view.getByText("Reloaded tail")).toBeDefined();
    expect(view.container.querySelector("[data-content-search-turn-key]")).toBe(row);
  });

  test.each([500, 5000, 10000])(
    "a single item stream in a Turn with %i plan items updates its leaf without rematerializing the row",
    async (itemCount) => {
      const owner = ownerWithTurns([
        [
          ...Array.from({ length: itemCount }, (_, index) => ({
            type: "plan" as const,
            id: `plan-${index}`,
            text: `Plan ${index}`,
          })),
          agent("answer", "Answer"),
        ],
      ]);
      const rendered = vi.fn();
      const readTurn = vi.spyOn(owner, "readTurn");
      const view = render(rows(owner, rendered));
      await settleAsyncRender();
      const initialRowCommits = rendered.mock.calls.length;
      readTurn.mockClear();
      await act(async () => {
        owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "text",
              key: { ...key, entityKey: "turn:turn-0", itemId: "answer" },
              target: { field: "text" },
              edits: [{ at: 6, deleteCount: 0, insert: " updated" }],
            },
          ],
        });
        await Promise.resolve();
      });
      await settleAsyncRender();
      expect(view.getByText("Answer updated")).toBeDefined();
      expect(rendered.mock.calls.length).toBe(initialRowCommits);
      expect(readTurn).not.toHaveBeenCalled();
      const answer = view.getByText("Answer updated");
      const projection = owner.readProjectedItem("turn:turn-0", "answer", "answer");
      let existingLeafCalls = 0;
      const release = owner.subscribeItem("turn:turn-0", "answer", () => existingLeafCalls++);
      await act(async () => {
        owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item-slots-append",
              key: { ...key, entityKey: "turn:turn-0" },
              previousLength: itemCount + 1,
              length: itemCount + 2,
              entries: [{ index: itemCount + 1, itemId: "appended" }],
            },
            {
              type: "item",
              key: { ...key, entityKey: "turn:turn-0", itemId: "appended" },
              value: { type: "plan", id: "appended", text: "Latest plan" },
            },
          ],
        });
        await Promise.resolve();
      });
      await settleAsyncRender();
      expect(view.getByText("Answer updated")).toBe(answer);
      expect(owner.readProjectedItem("turn:turn-0", "answer", "answer")).toBe(projection);
      expect(existingLeafCalls).toBe(0);
      release();
      view.unmount();
      expect(owner.readStructure()).toBeNull();
    },
  );

  test("two rows and repeated item IDs stay isolated during a text update", async () => {
    const owner = ownerWithTurns([[agent("same", "First")], [agent("same", "Other")]]);
    const rendered = vi.fn();
    const view = render(rows(owner, rendered));
    await settleAsyncRender();
    const before = rendered.mock.calls.length;
    await act(async () => {
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "text",
            key: { ...key, entityKey: "turn:turn-0", itemId: "same" },
            target: { field: "text" },
            edits: [{ at: 5, deleteCount: 0, insert: " changed" }],
          },
        ],
      });
      await Promise.resolve();
    });
    expect(view.getByText("First changed")).toBeDefined();
    expect(view.getByText("Other")).toBeDefined();
    expect(rendered.mock.calls.length).toBe(before);
  });

  test("hidden reasoning streams update the compact thinking label independently", async () => {
    const owner = ownerWithTurns([
      [{ type: "reasoning", id: "reason", summary: ["Preparing"], content: [] }],
    ]);
    const rendered = vi.fn();
    const view = render(rows(owner, rendered));
    await settleAsyncRender();
    expect(view.getAllByText("Preparing")[0]).toBeDefined();
    const before = rendered.mock.calls.length;
    await act(async () => {
      owner.applyEvent({
        type: "changes",
        changes: [
          {
            type: "text",
            key: { ...key, entityKey: "turn:turn-0", itemId: "reason" },
            target: { field: "summary", index: 0 },
            edits: [{ at: 9, deleteCount: 0, insert: " the patch" }],
          },
        ],
      });
      await Promise.resolve();
    });
    expect(view.getAllByText("Preparing the patch")[0]).toBeDefined();
    expect(rendered.mock.calls.length).toBe(before);
  });
});
