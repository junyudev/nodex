import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  __getNodexToastSnapshotForTests,
  __resetNodexToastStoreForTests,
  NodexToastProvider,
} from "@/components/ui/toast";
import { installAsyncRequestAnimationFrame } from "@/test/browser-globals";
import { render, settleAsyncRender } from "@/test/dom";
import { archiveChatWithFeedback, type ArchiveChatFeedbackInput } from "./archive-chat-feedback";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function titles() {
  return __getNodexToastSnapshotForTests().map((record) => record.title);
}

async function startArchive(overrides: Partial<ArchiveChatFeedbackInput> = {}) {
  const view = render(
    <NodexToastProvider>
      <div />
    </NodexToastProvider>,
  );
  const input = {
    chatId: "chat-1",
    archive: vi.fn(async () => true),
    restore: vi.fn(async () => undefined),
    viewArchivedChats: vi.fn(),
    ...overrides,
  };
  let result!: Promise<boolean>;
  await act(async () => {
    result = archiveChatWithFeedback(input);
    await settleAsyncRender();
  });
  return { view, input, result };
}

describe("archiveChatWithFeedback", () => {
  beforeEach(() => {
    installAsyncRequestAnimationFrame();
    __resetNodexToastStoreForTests();
  });

  test("shows the toast with the gesture, before the archive lands", async () => {
    const archive = deferred<boolean>();
    const { view, result } = await startArchive({ archive: () => archive.promise });

    expect(view.getByText("Archived chat")).toBeTruthy();
    expect(view.getByRole("button", { name: "View" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Undo" })).toBeTruthy();

    await act(async () => {
      archive.resolve(true);
      await result;
    });
    await expect(result).resolves.toBe(true);
    expect(titles()).toEqual(["Archived chat"]);
  });

  test("Undo waits for the archive to land, then restores and confirms", async () => {
    const archive = deferred<boolean>();
    const restore = vi.fn(async () => undefined);
    const { view, result } = await startArchive({ archive: () => archive.promise, restore });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Undo" }));
      await settleAsyncRender();
    });
    expect(titles()).toEqual([]);
    expect(restore).not.toHaveBeenCalled();

    await act(async () => {
      archive.resolve(true);
      await result;
      await settleAsyncRender();
    });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(["Chat restored"]);
    expect(__getNodexToastSnapshotForTests()[0]?.level).toBe("success");
  });

  test("reports a failed Undo", async () => {
    const { view } = await startArchive({
      restore: async () => {
        throw new Error("restore failed");
      },
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Undo" }));
      await settleAsyncRender();
    });

    expect(titles()).toEqual(["Failed to unarchive chat"]);
  });

  test.each([
    ["reports failure", () => Promise.resolve(false)],
    ["rejects", () => Promise.reject(new Error("archive failed"))],
  ])("replaces the toast with an error when the archive %s", async (_label, archive) => {
    const restore = vi.fn(async () => undefined);
    const { result } = await startArchive({ archive, restore });

    await expect(result).resolves.toBe(false);
    expect(titles()).toEqual(["Failed to archive chat"]);
    expect(__getNodexToastSnapshotForTests()[0]?.level).toBe("danger");
    expect(restore).not.toHaveBeenCalled();
  });

  test("an Undo pressed before a failed archive restores nothing", async () => {
    const archive = deferred<boolean>();
    const restore = vi.fn(async () => undefined);
    const { view, result } = await startArchive({ archive: () => archive.promise, restore });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Undo" }));
      await settleAsyncRender();
    });
    await act(async () => {
      archive.resolve(false);
      await result;
      await settleAsyncRender();
    });

    expect(restore).not.toHaveBeenCalled();
    expect(titles()).toEqual(["Failed to archive chat"]);
  });

  test("View opens archived chats and dismisses the toast", async () => {
    const viewArchivedChats = vi.fn();
    const { view } = await startArchive({ viewArchivedChats });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "View" }));
      await settleAsyncRender();
    });

    expect(viewArchivedChats).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual([]);
    await waitFor(() => expect(view.queryByText("Archived chat")).toBeNull());
  });
});
