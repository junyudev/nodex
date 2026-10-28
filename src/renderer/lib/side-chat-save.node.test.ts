import { describe, expect, test, vi } from "vite-plus/test";
import { createSideChatSaveStore, type SideChatSavePorts } from "./side-chat-save";
import type { ComposerCompletedDraftSnapshot } from "../features/local-conversation/view/composer/composer-draft-state";

const draft: ComposerCompletedDraftSnapshot = {
  prompt: "Keep this unsent thought",
  fileAttachments: [],
  addedFiles: [],
  imageAttachments: [],
  appshotContexts: [],
  pastedTextAttachments: [],
  commentAttachments: [],
  goalModeActive: false,
};
const saved = {
  sessionId: "saved",
  threadId: "saved-thread",
  sourceSessionId: "side",
  projectId: "project",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function fixture() {
  const store = createSideChatSaveStore();
  const lease = {
    capture: vi.fn(() => ({ status: "ready" as const, snapshot: draft })),
    persistTransfer: vi.fn(async (threadId: string) => ({
      ...draft,
      transferId: "transfer",
      targetConversationId: threadId,
    })),
    commitTransfer: vi.fn(),
    release: vi.fn(async () => {}),
  };
  const ports: SideChatSavePorts = {
    sessionId: "side",
    threadId: "side-thread",
    tabId: "side-tab",
    acquireDraft: vi.fn(() => lease),
    readSourceHead: vi.fn(async () => "head"),
    readSavedHead: vi.fn(async () => "saved-head"),
    isSourceCurrent: vi.fn(() => true),
    save: vi.fn(async () => saved),
    refresh: vi.fn(async () => {}),
    publishDraft: vi.fn(),
    open: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
  return { store, ports, lease };
}

describe("saving side chats", () => {
  test("deduplicates save and permits only its exact close after persistence and navigation", async () => {
    const { store, ports, lease } = fixture();
    const persistence = deferred<Awaited<ReturnType<typeof lease.persistTransfer>>>();
    lease.persistTransfer.mockImplementation(() => persistence.promise);
    const opened = deferred<boolean>();
    vi.mocked(ports.open).mockImplementation(() => opened.promise);
    vi.mocked(ports.close).mockImplementation(async () => {
      expect(store.closeDecision("side", "side-tab")).toBe("saved");
      expect(store.closeDecision("side", "other-tab")).toBe("defer");
    });
    const result = store.save(ports);
    expect(store.save(ports)).toBe(result);
    expect(store.pending("side")).toBe(true);
    expect(store.closeDecision("side", "side-tab")).toBe("defer");
    await vi.waitFor(() => expect(lease.persistTransfer).toHaveBeenCalledWith("saved-thread"));
    expect(ports.open).not.toHaveBeenCalled();
    persistence.resolve({ ...draft, targetConversationId: "saved-thread", transferId: "transfer" });
    await vi.waitFor(() => expect(ports.open).toHaveBeenCalled());
    expect(ports.publishDraft).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: draft.prompt }),
    );
    expect(lease.commitTransfer).toHaveBeenCalledWith(
      vi.mocked(ports.publishDraft).mock.calls[0]![0],
    );
    expect(ports.close).not.toHaveBeenCalled();
    opened.resolve(true);
    expect(await result).toEqual(saved);
    expect(ports.save).toHaveBeenCalledTimes(1);
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(store.pending("side")).toBe(false);
    expect(store.closeDecision("side", "side-tab")).toBe("normal");
  });

  test.each(["backend", "draft", "refresh", "navigation"] as const)(
    "retains the side chat on %s failure and retries the same saved identity",
    async (failure) => {
      const { store, ports, lease } = fixture();
      if (failure === "backend") vi.mocked(ports.save).mockRejectedValueOnce(new Error("offline"));
      if (failure === "draft")
        lease.persistTransfer.mockRejectedValueOnce(new Error("draft not persisted"));
      if (failure === "refresh")
        vi.mocked(ports.refresh).mockRejectedValueOnce(new Error("offline"));
      if (failure === "navigation") vi.mocked(ports.open).mockResolvedValueOnce(false);
      await expect(store.save(ports)).rejects.toThrow();
      expect(ports.close).not.toHaveBeenCalled();
      expect(lease.release).toHaveBeenCalledTimes(1);
      expect(store.closeDecision("side", "side-tab")).toBe("normal");
      const identity = vi.mocked(ports.save).mock.calls[0]![0];
      await store.save(ports);
      expect(vi.mocked(ports.save).mock.calls[1]![0]).toEqual(identity);
      expect(ports.close).toHaveBeenCalledTimes(1);
    },
  );

  test("does not navigate after the user leaves the source and retains the saved draft", async () => {
    const { store, ports } = fixture();
    vi.mocked(ports.refresh).mockImplementation(async () => {
      vi.mocked(ports.isSourceCurrent).mockReturnValue(false);
    });
    await expect(store.save(ports)).rejects.toThrow("Return to the side chat");
    expect(ports.open).not.toHaveBeenCalled();
    expect(ports.close).not.toHaveBeenCalled();
    expect(ports.save).toHaveBeenCalledTimes(1);
  });

  test("releases unpublished attachment copies if publication fails before navigation", async () => {
    const { store, ports, lease } = fixture();
    vi.mocked(ports.publishDraft).mockImplementationOnce(() => {
      throw new Error("draft publication failed");
    });
    const released = deferred<void>();
    lease.release.mockImplementationOnce(() => released.promise);
    const result = store.save(ports);
    const rejected = expect(result).rejects.toThrow("draft publication failed");
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalledOnce());
    expect(store.pending("side")).toBe(true);
    expect(lease.commitTransfer).not.toHaveBeenCalled();
    expect(ports.open).not.toHaveBeenCalled();
    expect(ports.close).not.toHaveBeenCalled();
    released.resolve();
    await rejected;
    expect(store.pending("side")).toBe(false);
    await store.save(ports);
    expect(lease.commitTransfer).toHaveBeenCalledOnce();
  });

  test("preserves newer source work and saves its newer head on retry", async () => {
    const { store, ports } = fixture();
    vi.mocked(ports.readSourceHead).mockResolvedValueOnce("first").mockResolvedValue("second");
    await expect(store.save(ports)).rejects.toThrow("newer changes");
    expect(ports.close).not.toHaveBeenCalled();
    const first = vi.mocked(ports.save).mock.calls[0]![0];
    await store.save(ports);
    expect(vi.mocked(ports.save).mock.calls[1]![0].sessionId).not.toBe(first.sessionId);
    expect(ports.close).toHaveBeenCalledTimes(1);
  });

  test("a retry after opening never re-seeds a saved chat whose draft may have advanced", async () => {
    const { store, ports, lease } = fixture();
    vi.mocked(ports.close).mockRejectedValueOnce(new Error("stale panel"));
    await expect(store.save(ports)).rejects.toThrow("stale panel");
    expect(ports.open).toHaveBeenCalledTimes(1);
    const first = vi.mocked(ports.save).mock.calls[0]![0];
    await store.save(ports);
    expect(vi.mocked(ports.save).mock.calls[1]![0]).toEqual(first);
    expect(lease.persistTransfer).toHaveBeenCalledTimes(1);
    expect(ports.publishDraft).toHaveBeenCalledTimes(1);
    expect(ports.close).toHaveBeenCalledTimes(2);
  });

  test("an unfinished transfer never re-seeds a destination that has already continued", async () => {
    const { store, ports, lease } = fixture();
    lease.persistTransfer.mockRejectedValueOnce(new Error("partial storage failure"));
    await expect(store.save(ports)).rejects.toThrow("partial storage failure");
    vi.mocked(ports.readSavedHead).mockResolvedValue("a new Run");
    await expect(store.save(ports)).rejects.toThrow("saved chat has newer work");
    expect(lease.persistTransfer).toHaveBeenCalledTimes(1);
    expect(ports.publishDraft).not.toHaveBeenCalled();
    expect(ports.close).not.toHaveBeenCalled();
  });

  test("edited source drafts get their own saved destination instead of replacing an earlier save", async () => {
    const { store, ports, lease } = fixture();
    vi.mocked(ports.open).mockResolvedValueOnce(false);
    await expect(store.save(ports)).rejects.toThrow();
    const first = vi.mocked(ports.save).mock.calls[0]![0];
    lease.capture.mockReturnValue({
      status: "ready",
      snapshot: { ...draft, prompt: "A new thought" },
    });
    await store.save(ports);
    expect(vi.mocked(ports.save).mock.calls[1]![0].sessionId).not.toBe(first.sessionId);
    expect(lease.persistTransfer).toHaveBeenCalledTimes(2);
  });
});
