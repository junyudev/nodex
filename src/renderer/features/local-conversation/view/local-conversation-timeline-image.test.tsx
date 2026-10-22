import { act, fireEvent, waitFor } from "@testing-library/react";
import type { CodexConversationSnapshot } from "@/lib/types";
import { ConversationRuntimeContext, type ConversationRuntime } from "../conversation-runtime";
import { describe, expect, test, vi } from "vite-plus/test";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import { installMotionPreferenceForTest } from "@/test/browser-globals";
import {
  getGeneratedImageLiveCollectionSnapshot,
  registerUserAttachmentImagePreviewOpener,
  type OpenUserAttachmentImagePreviewOptions,
} from "@/features/user-attachment-image-editor";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import { isCodexTimelineTurnEntry } from "../projection/normalized-timeline-entries";
import {
  nativeGeneratedImage,
  nativeImageTimelineFixture,
} from "../projection/normalized-timeline-image.test-fixtures";
import { ConversationImageAssetProvider } from "./conversation-image-asset-context";
import { LocalConversationTurnEntry } from "./local-conversation-turn-entry";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";

const src = "data:image/png;base64,aW1hZ2U=";
const key = { hostId: "local", threadId: "thread", entityKey: "turn:one", itemId: "image" };
const composerTarget = { channelId: "ThreadScope:thread::root", placement: "root" as const };

function renderImageReceipts(
  fixture: ReturnType<typeof nativeImageTimelineFixture>,
  receipts?: readonly string[],
) {
  return (
    <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
      <ConversationImageAssetProvider
        conversationId="thread"
        hostId="local"
        composerTarget={composerTarget}
      >
        {fixture
          .project()
          .entries.filter(isCodexTimelineTurnEntry)
          .filter(
            (entry) => entry.timelineWholeItem && (!receipts || receipts.includes(entry.turnKey)),
          )
          .map((entry) => (
            <LocalConversationTurnEntry
              key={entry.turnKey}
              entry={entry}
              conversationId="thread"
              cwd="/workspace"
              canEditTurnUserPrefix={false}
              canForkTurn={false}
            />
          ))}
      </ConversationImageAssetProvider>
    </CodexTranscriptReadOwnerContext.Provider>
  );
}

function metadataRuntime(state: ReturnType<typeof nativeImageTimelineFixture>["state"]) {
  const turnReads = vi.fn(() => {
    throw new Error("The normalized image surface must not read materialized Turns");
  });
  const snapshot: CodexConversationSnapshot = {
    canonicalState: state,
    threadName: "Image task",
    threadId: state.id,
    projectId: null,
    source: null,
    threadPreview: "",
    cwd: "/workspace",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "",
    resumeState: state.resumeState,
    get turns() {
      return turnReads();
    },
    requests: [],
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditUserTurns: false,
      canForkFromTurn: false,
      canSearch: true,
      canCollapseTurns: false,
    },
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
  };
  const listeners = new Set<() => void>();
  const runtime: ConversationRuntime = {
    kind: "codex",
    hostId: "local",
    read: () => snapshot,
    subscribe: (_id, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attachment: () => ({ status: "attached" }),
    connection: () => ({ status: "connected", retries: 0 }),
    role: () => "owner",
    primaryRequest: () => null,
    children: () => [],
    retain: () => () => {},
    loadHistory: async () => {},
    resume: async () => {},
    markRead: async () => {},
    setPresented: async () => {},
  };
  return { runtime, turnReads, notify: () => listeners.forEach((listener) => listener()) };
}

describe("native image receipt surface", () => {
  test("a completed Turn retains item-owned generation and keyed completion without whole-Turn reads", async () => {
    const restoreMotion = installMotionPreferenceForTest(true);
    const fixture = nativeImageTimelineFixture();
    const retain = fixture.owner.subscribeStructure(() => {});
    const metadata = metadataRuntime(fixture.state);
    const surface = (
      <ConversationRuntimeContext.Provider value={metadata.runtime}>
        {renderImageReceipts(fixture)}
      </ConversationRuntimeContext.Provider>
    );
    const wholeReads = [
      vi.spyOn(fixture.owner, "readTurn"),
      vi.spyOn(fixture.owner, "readTurnSlice"),
      vi.spyOn(fixture.owner, "readItemSlots"),
    ];
    const unrelated = vi.fn();
    const releaseUnrelated = fixture.owner.subscribeItem("turn:one", "other", unrelated);
    const view = render(surface, { wrapper: LocalConversationTestQueryProvider });
    try {
      await waitFor(() =>
        expect(view.getAllByRole("status", { name: "Generating image..." })).toHaveLength(2),
      );
      expect(
        getGeneratedImageLiveCollectionSnapshot("thread").images.map((image) => [
          image.id,
          image.status,
        ]),
      ).toEqual([["image", "loading"]]);
      await act(async () =>
        fixture.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item",
              key,
              value: { ...nativeGeneratedImage("image", "completed", src), src },
            },
          ],
        }),
      );
      await waitFor(() =>
        expect(view.getAllByRole("button", { name: "Generated image 1" })).toHaveLength(2),
      );
      expect(view.queryByRole("status", { name: "Generating image..." })).toBeNull();
      expect(
        getGeneratedImageLiveCollectionSnapshot("thread").images.map((image) => [
          image.id,
          image.status,
        ]),
      ).toEqual([["image", "ready"]]);
      await act(async () => {
        metadata.notify();
      });
      expect(metadata.turnReads).not.toHaveBeenCalled();
      expect(unrelated).not.toHaveBeenCalled();
      wholeReads.forEach((read) => expect(read).not.toHaveBeenCalled());
    } finally {
      view.unmount();
      releaseUnrelated();
      retain();
      restoreMotion();
      wholeReads.forEach((read) => read.mockRestore());
    }
    expect(getGeneratedImageLiveCollectionSnapshot("thread").images).toEqual([]);
  });

  test("repeated receipts keep the surviving asset and use the existing preview/edit owner", async () => {
    const fixture = nativeImageTimelineFixture(nativeGeneratedImage("image", "completed", src));
    const retain = fixture.owner.subscribeStructure(() => {});
    const opened = vi.fn(async (_options: OpenUserAttachmentImagePreviewOptions) => true);
    const unregister = registerUserAttachmentImagePreviewOpener(opened);
    const view = render(renderImageReceipts(fixture), {
      wrapper: LocalConversationTestQueryProvider,
    });
    try {
      await waitFor(() =>
        expect(view.getAllByRole("button", { name: "Generated image 1" })).toHaveLength(2),
      );
      expect(getGeneratedImageLiveCollectionSnapshot("thread").groups).toHaveLength(2);
      expect(getGeneratedImageLiveCollectionSnapshot("thread").images).toHaveLength(1);
      view.rerender(renderImageReceipts(fixture, ["timeline:presentation:second"]));
      await waitFor(() =>
        expect(getGeneratedImageLiveCollectionSnapshot("thread").groups).toHaveLength(1),
      );
      expect(
        getGeneratedImageLiveCollectionSnapshot("thread").images.map((image) => image.id),
      ).toEqual(["image"]);
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Generated image 1" }));
      });
      await view.findByRole("dialog", { name: "Image preview" });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit image" }));
      });
      await waitFor(() => expect(opened).toHaveBeenCalledOnce());
      const options = opened.mock.calls[0]?.[0];
      expect(options).toMatchObject({
        composerTarget,
        threadId: "thread",
        initialImageId: "image",
        entrypoint: "lightbox_edit_button",
        openInEditor: true,
      });
      expect(options?.generatedImages?.map((image) => image.id)).toEqual(["image"]);
    } finally {
      view.unmount();
      unregister();
      retain();
    }
    expect(getGeneratedImageLiveCollectionSnapshot("thread").images).toEqual([]);
  });

  test("missing raw history preserves the row and settles when the same native item is restored", async () => {
    const restoreMotion = installMotionPreferenceForTest(true);
    const fixture = nativeImageTimelineFixture(nativeGeneratedImage("image", "completed", src), [
      "first",
    ]);
    const retain = fixture.owner.subscribeStructure(() => {});
    const surface = renderImageReceipts(fixture);
    fixture.owner.applyEvent({ type: "changes", changes: [{ type: "item", key, value: null }] });
    const view = render(surface, {
      wrapper: LocalConversationTestQueryProvider,
    });
    try {
      await waitFor(() =>
        expect(view.container.querySelector("[data-native-image-item-id]")).not.toBeNull(),
      );
      expect(view.queryByRole("status", { name: "Generating image..." })).toBeNull();
      expect(getGeneratedImageLiveCollectionSnapshot("thread").images).toEqual([]);
      const originalRow = view.container.querySelector("[data-native-image-item-id]");
      await act(async () =>
        fixture.owner.applyEvent({
          type: "changes",
          changes: [
            {
              type: "item",
              key,
              value: { ...nativeGeneratedImage("image", "completed", src), src },
            },
          ],
        }),
      );
      await view.findByRole("button", { name: "Generated image 1" });
      expect(view.container.querySelector("[data-native-image-item-id]")).toBe(originalRow);
      expect(getGeneratedImageLiveCollectionSnapshot("thread").images[0]?.id).toBe("image");
    } finally {
      view.unmount();
      retain();
      restoreMotion();
    }
  });
});
