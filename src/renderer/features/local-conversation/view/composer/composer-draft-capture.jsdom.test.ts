import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  acquireComposerDraftCapture,
  isComposerDraftCaptureLocked,
  registerComposerDraftCapture,
  subscribeComposerDraftCapture,
  type ComposerDraftCaptureBlocked,
  type ComposerDraftCaptureLease,
  type ComposerDraftCaptureResult,
  type ComposerDraftCaptureTarget,
} from "./composer-draft-capture";
import type { ComposerCompletedDraftSnapshot, ComposerDraftTransfer } from "./composer-draft-state";
import type { PreparedComposerDraftTransfer } from "./composer-draft-transfer-attachments";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const target: ComposerDraftCaptureTarget = {
  threadId: "thread:source",
  composerScopeIdentity: "composer:source",
};

const snapshot = (prompt = "Source draft"): ComposerCompletedDraftSnapshot => ({
  prompt,
  fileAttachments: [],
  addedFiles: [],
  imageAttachments: [],
  appshotContexts: [],
  pastedTextAttachments: [],
  commentAttachments: [],
  goalModeActive: false,
});

function register(
  address: ComposerDraftCaptureTarget = target,
  initial: ComposerDraftCaptureResult = { status: "ready", snapshot: snapshot() },
  persist = vi.fn<(transfer: ComposerDraftTransfer) => Promise<void>>(async () => {}),
  prepare?: (transfer: ComposerDraftTransfer) => Promise<PreparedComposerDraftTransfer>,
) {
  let current = initial;
  const read = vi.fn(() => current);
  const unregister = registerComposerDraftCapture(address, { read, persist, prepare });
  cleanups.push(unregister);
  return {
    read,
    persist,
    unregister,
    update(result: ComposerDraftCaptureResult) {
      current = result;
    },
  };
}

function acquire(address = target): ComposerDraftCaptureLease {
  const result = acquireComposerDraftCapture(address);
  if (result.status !== "ready") throw new Error(result.message);
  cleanups.push(() => result.lease.release());
  return result.lease;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("mounted Composer draft capture", () => {
  test("addresses ownership by both thread and composer scope", async () => {
    const sameThread = { ...target, composerScopeIdentity: "composer:other" };
    const sameScope = { ...target, threadId: "thread:other" };
    const first = register(target, { status: "ready", snapshot: snapshot("First") });
    const second = register(sameThread, { status: "ready", snapshot: snapshot("Second") });
    const third = register(sameScope, { status: "ready", snapshot: snapshot("Third") });
    const selected = acquire({
      threadId: ` ${target.threadId} `,
      composerScopeIdentity: ` ${target.composerScopeIdentity} `,
    });
    const otherThreadComposer = acquire(sameThread);
    const otherScopeThread = acquire(sameScope);
    expect(selected.capture()).toMatchObject({ status: "ready", snapshot: { prompt: "First" } });
    expect(otherThreadComposer.capture()).toMatchObject({
      status: "ready",
      snapshot: { prompt: "Second" },
    });
    expect(otherScopeThread.capture()).toMatchObject({
      status: "ready",
      snapshot: { prompt: "Third" },
    });
    expect(
      acquireComposerDraftCapture({
        threadId: sameScope.threadId,
        composerScopeIdentity: sameThread.composerScopeIdentity,
      }),
    ).toMatchObject({ status: "blocked", reason: "unavailable" });
    await selected.persistTransfer("thread:target");
    expect(first.persist).toHaveBeenCalledTimes(1);
    expect(second.persist).not.toHaveBeenCalled();
    expect(third.persist).not.toHaveBeenCalled();
  });

  test.each(["draft-loading", "draft-error", "pending-attachments", "attachment-error"] as const)(
    "returns %s readiness without taking a lease",
    (reason) => {
      const blocked: ComposerDraftCaptureBlocked = {
        status: "blocked",
        reason,
        message: "Draft is not ready",
      };
      const owner = register(target, blocked);
      expect(acquireComposerDraftCapture(target)).toEqual(blocked);
      expect(isComposerDraftCaptureLocked(target)).toBe(false);
      owner.update({ status: "ready", snapshot: snapshot() });
      expect(acquire(target).capture().status).toBe("ready");
      expect(isComposerDraftCaptureLocked(target)).toBe(true);
    },
  );

  test("keeps one lease busy until release and publishes the lock transition", async () => {
    register();
    const locks: boolean[] = [];
    cleanups.push(
      subscribeComposerDraftCapture(target, () => locks.push(isComposerDraftCaptureLocked(target))),
    );
    const first = acquire();
    expect(acquireComposerDraftCapture(target)).toMatchObject({
      status: "blocked",
      reason: "busy",
    });
    await first.release();
    await first.release();
    expect(isComposerDraftCaptureLocked(target)).toBe(false);
    expect(first.capture()).toMatchObject({ status: "blocked", reason: "unavailable" });
    const next = acquire();
    await first.release();
    expect(isComposerDraftCaptureLocked(target)).toBe(true);
    expect(next.capture().status).toBe("ready");
    expect(locks).toEqual([true, false, true]);
  });

  test("reads the latest complete draft when persistence starts", async () => {
    const owner = register();
    const lease = acquire();
    const latest = {
      ...snapshot("Review docs"),
      promptDocument: {
        text: "Review docs",
        links: [{ from: 7, to: 11, href: "https://example.com/docs" }],
        mentions: [],
      },
    };
    owner.update({ status: "ready", snapshot: latest });
    const transfer = await lease.persistTransfer("thread:target");
    expect(transfer).toEqual({
      ...latest,
      transferId: expect.any(String),
      targetConversationId: "thread:target",
    });
    expect(owner.persist).toHaveBeenCalledExactlyOnceWith(transfer);
    expect(lease.capture()).toEqual({ status: "ready", snapshot: latest });
  });

  test.each([false, true])(
    "release discards only unpublished attachment copies: published %s",
    async (published) => {
      const discard = vi.fn(async () => {});
      register(target, { status: "ready", snapshot: snapshot() }, undefined, async (transfer) => ({
        transfer,
        discard,
      }));
      const lease = acquire();
      const transfer = await lease.persistTransfer("thread:target");
      if (published) lease.commitTransfer(transfer);
      await lease.release();
      await lease.release();
      expect(discard).toHaveBeenCalledTimes(published ? 0 : 1);
      expect(() => lease.commitTransfer(transfer)).toThrow(/no longer available/);
    },
  );

  test("a failed durable write discards its copies and keeps the source draft unchanged", async () => {
    const source = snapshot();
    const discard = vi.fn(async () => {});
    const owner = register(
      target,
      { status: "ready", snapshot: source },
      vi.fn(async () => {
        throw new Error("Write failed");
      }),
      async (transfer) => ({ transfer, discard }),
    );
    const lease = acquire();
    await expect(lease.persistTransfer("thread:target")).rejects.toThrow("Write failed");
    await lease.release();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(owner.read()).toEqual({ status: "ready", snapshot: source });
  });

  test("release during attachment copying cleans the late copies without persisting a stale draft", async () => {
    const copying = gate();
    const discard = vi.fn(async () => {});
    const owner = register(
      target,
      { status: "ready", snapshot: snapshot() },
      undefined,
      async (transfer) => {
        await copying.promise;
        return { transfer, discard };
      },
    );
    const lease = acquire();
    const transfer = lease.persistTransfer("thread:target");
    await lease.release();
    copying.resolve();
    await expect(transfer).rejects.toThrow(/unavailable/);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(owner.persist).not.toHaveBeenCalled();
  });

  test("source changes during persistence discard the unattached copies", async () => {
    const writing = gate();
    const discard = vi.fn(async () => {});
    const owner = register(
      target,
      { status: "ready", snapshot: snapshot() },
      vi.fn(() => writing.promise),
      async (transfer) => ({ transfer, discard }),
    );
    const lease = acquire();
    const transfer = lease.persistTransfer("thread:target");
    await vi.waitFor(() => expect(owner.persist).toHaveBeenCalled());
    owner.update({ status: "ready", snapshot: snapshot("Changed externally") });
    writing.resolve();
    await expect(transfer).rejects.toThrow(/draft changed/);
    await lease.release();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  test("keeps the source intact and allows a fresh lease after persistence fails", async () => {
    const source = snapshot();
    const persist = vi
      .fn<(transfer: ComposerDraftTransfer) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Storage unavailable"))
      .mockResolvedValue(undefined);
    const owner = register(target, { status: "ready", snapshot: source }, persist);
    const failed = acquire();
    await expect(failed.persistTransfer("thread:target")).rejects.toThrow("Storage unavailable");
    expect(failed.capture()).toEqual({ status: "ready", snapshot: source });
    expect(owner.read()).toEqual({ status: "ready", snapshot: source });
    await failed.release();
    const retry = acquire();
    await expect(retry.persistTransfer("thread:target")).resolves.toMatchObject({
      prompt: source.prompt,
    });
    expect(owner.persist).toHaveBeenCalledTimes(2);
    expect(owner.read()).toEqual({ status: "ready", snapshot: source });
  });

  test("fences owner replacement without letting stale cleanup unlock the new owner", async () => {
    const previous = register();
    const stale = acquire();
    const replacement = register(target, {
      status: "ready",
      snapshot: snapshot("Replacement draft"),
    });
    const current = acquire();
    previous.unregister();
    await stale.release();
    expect(stale.capture()).toMatchObject({ status: "blocked", reason: "unavailable" });
    await expect(stale.persistTransfer("thread:target")).rejects.toThrow(/unavailable/);
    expect(isComposerDraftCaptureLocked(target)).toBe(true);
    expect(acquireComposerDraftCapture(target)).toMatchObject({
      status: "blocked",
      reason: "busy",
    });
    await current.persistTransfer("thread:target");
    expect(previous.persist).not.toHaveBeenCalled();
    expect(replacement.persist).toHaveBeenCalledTimes(1);
    await current.release();
    expect(isComposerDraftCaptureLocked(target)).toBe(false);
  });

  test.each(["unmount", "replace"] as const)(
    "rejects an in-flight transfer when its owner is removed: %s",
    async (action) => {
      const saving = gate();
      const owner = register(
        target,
        { status: "ready", snapshot: snapshot() },
        vi.fn(() => saving.promise),
      );
      const lease = acquire();
      const transfer = lease.persistTransfer("thread:target");
      if (action === "unmount") owner.unregister();
      else register(target, { status: "ready", snapshot: snapshot("Replacement") });
      saving.resolve();
      await expect(transfer).rejects.toThrow(/unavailable/);
      expect(lease.capture()).toMatchObject({ status: "blocked", reason: "unavailable" });
    },
  );

  test.each(["during", "after"] as const)(
    "blocks capture and further transfer when external metadata changes %s persistence",
    async (when) => {
      const saving = gate();
      const annotation = {
        schemaVersion: 1 as const,
        id: "annotation",
        browserTabId: "tab",
        createdAt: 1,
        note: "Original",
        pageTitle: "Docs",
        pageUrl: "https://example.com/docs",
        anchors: [],
      };
      const source = { ...snapshot(), browserAnnotationAttachments: [annotation] };
      const owner = register(
        target,
        { status: "ready", snapshot: source },
        vi.fn(() => saving.promise),
      );
      const lease = acquire();
      const transfer = lease.persistTransfer("thread:target");
      if (when === "during") annotation.note = "Changed externally";
      saving.resolve();
      if (when === "during") await expect(transfer).rejects.toThrow(/draft changed/);
      else {
        await transfer;
        annotation.note = "Changed externally";
      }
      expect(lease.capture()).toMatchObject({ status: "blocked", reason: "changed" });
      await expect(lease.persistTransfer("thread:target")).rejects.toThrow(/draft changed/);
      expect(owner.persist).toHaveBeenCalledTimes(1);
      expect(owner.read()).toEqual({ status: "ready", snapshot: source });
      await lease.release();
      expect(acquire().capture()).toEqual({ status: "ready", snapshot: source });
    },
  );
});
