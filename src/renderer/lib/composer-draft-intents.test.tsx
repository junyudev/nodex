import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  composerDraftIntents,
  useComposerDraftIntent,
  type ComposerChatKey,
} from "./composer-draft-intents";

describe("Composer draft intents", () => {
  test("a pending Session intent reaches later subscribers and survives a form remount", async () => {
    const chat = { kind: "session", sessionId: "intent-before-first-turn" } as const;
    const intent = { prompt: "From the Page", attachmentMode: "append", focusNonce: 1 } as const;
    composerDraftIntents.set(chat, intent);
    const first = renderHook(() => useComposerDraftIntent({ ...chat }));
    expect(first.result.current).toBe(intent);
    first.unmount();
    const next = renderHook(() => useComposerDraftIntent({ ...chat }));
    expect(next.result.current).toBe(intent);
    await act(async () => {
      composerDraftIntents.consume(chat, 1);
    });
    expect(next.result.current).toBeNull();
    next.unmount();
  });

  test("Runtime chats notify without a Codex conversation or provider", async () => {
    const chat = { kind: "session", sessionId: "runtime-without-codex" } as const;
    const view = renderHook(() => useComposerDraftIntent(chat));
    const intent = {
      prompt: "Edit the queued message",
      focusNonce: 2,
      queuedFollowUpEdit: { followUpId: "queued", ledgerRevision: 4 },
    };
    await act(async () => {
      composerDraftIntents.set(chat, intent);
    });
    expect(view.result.current).toBe(intent);
    await act(async () => {
      composerDraftIntents.consume(chat, 2);
    });
    expect(view.result.current).toBeNull();
    view.unmount();
  });

  test("a stale acknowledgement cannot consume a newer intent, and consumption notifies once", () => {
    const chat = { kind: "session", sessionId: "consume-fence" } as const;
    const listener = vi.fn();
    const stop = composerDraftIntents.subscribe(chat, listener);
    composerDraftIntents.set(chat, { prompt: "Older", focusNonce: 3 });
    const newer = { prompt: "Newer", focusNonce: 4 };
    composerDraftIntents.set(chat, newer);
    listener.mockClear();
    composerDraftIntents.consume(chat, 3);
    expect(composerDraftIntents.read(chat)).toBe(newer);
    expect(listener).not.toHaveBeenCalled();
    composerDraftIntents.consume(chat, 4);
    expect(composerDraftIntents.read(chat)).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
    composerDraftIntents.consume(chat, 4);
    expect(listener).toHaveBeenCalledOnce();
    stop();
  });

  test("chat keys isolate roots, sibling threads, and remote hosts, and subscriptions release", () => {
    const chats: ComposerChatKey[] = [
      { kind: "session", sessionId: "same-id" },
      { kind: "session-thread", sessionId: "same-id", threadId: "child-a" },
      { kind: "session-thread", sessionId: "same-id", threadId: "child-b" },
      { kind: "session-thread", sessionId: "other-session", threadId: "child-a" },
      { kind: "remote-thread", hostId: "host-a", threadId: "same-id" },
      { kind: "remote-thread", hostId: "host-b", threadId: "same-id" },
    ];
    const listener = vi.fn();
    const stop = composerDraftIntents.subscribe(chats[0]!, listener);
    chats.forEach((chat, index) =>
      composerDraftIntents.set(chat, { prompt: String(index), focusNonce: index }),
    );
    chats.forEach((chat, index) =>
      expect(composerDraftIntents.read(chat)?.prompt).toBe(String(index)),
    );
    expect(listener).toHaveBeenCalledOnce();
    stop();
    chats.forEach((chat, index) => composerDraftIntents.consume(chat, index));
    expect(listener).toHaveBeenCalledOnce();
  });
  test("materializing a Project draft preserves pending intents and captured subscriptions", () => {
    const draft = { kind: "project-draft", projectId: "project", draftId: "draft" } as const;
    const session = { kind: "session", sessionId: "materialized-session" } as const;
    const intent = { prompt: "Before materialization", focusNonce: 10 };
    composerDraftIntents.set(draft, intent);
    const changed = vi.fn();
    const stop = composerDraftIntents.subscribe(draft, changed);
    composerDraftIntents.materializeProjectDraft(draft, session.sessionId);
    expect(composerDraftIntents.read(session)).toBe(intent);
    expect(composerDraftIntents.read(draft)).toBe(intent);
    expect(changed).toHaveBeenCalledOnce();
    const later = { prompt: "Captured handoff", focusNonce: 11 };
    composerDraftIntents.set(draft, later);
    expect(composerDraftIntents.read(session)).toBe(later);
    composerDraftIntents.consume(session, 10);
    expect(composerDraftIntents.read(draft)).toBe(later);
    composerDraftIntents.consume(draft, 11);
    expect(composerDraftIntents.read(session)).toBeNull();
    stop();
  });

  test("materialization keeps the newest handoff and cannot rebind a draft to a different Session", () => {
    const draft = { kind: "project-draft", projectId: "project", draftId: "newest-draft" } as const;
    const session = { kind: "session", sessionId: "newest-session" } as const;
    composerDraftIntents.set(draft, { prompt: "Earlier", focusNonce: 100 });
    const newer = { prompt: "Newer", focusNonce: 50 };
    composerDraftIntents.set(session, newer);
    composerDraftIntents.materializeProjectDraft(draft, session.sessionId);
    composerDraftIntents.materializeProjectDraft(draft, "other-session");
    expect(composerDraftIntents.read(draft)).toBe(newer);
    expect(composerDraftIntents.read({ kind: "session", sessionId: "other-session" })).toBeNull();
    composerDraftIntents.consume(session, 50);
  });
});
