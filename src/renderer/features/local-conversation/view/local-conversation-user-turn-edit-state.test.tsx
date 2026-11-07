import { act } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, test } from "vite-plus/test";
import { appScope, useScopeHandle, type ScopeHandle } from "@/lib/maitai";
import { renderWithAppMaitai } from "@/test/app-maitai";
import {
  removeLocalConversationViewState,
  useLocalConversationEditingTurnIds,
  useLocalConversationUserTurnEditDraft,
  type UserTurnEditDraftUpdate,
} from "./local-conversation-thread-view-state";
import type { UserTurnEditDraft } from "./user-turn-edit-draft";

type DraftState = ReturnType<typeof useLocalConversationUserTurnEditDraft>;

const textDraft = (text: string): UserTurnEditDraft => ({
  text,
  sentImages: [],
  addedImages: [],
});

function mountEditState() {
  const drafts = new Map<string, DraftState>();
  const memberships = new Map<string, Array<readonly string[]>>();
  let appHandle: ScopeHandle | undefined;
  function DraftReader({ conversationId, turnId }: { conversationId: string; turnId: string }) {
    const handle = useScopeHandle(appScope);
    const state = useLocalConversationUserTurnEditDraft(conversationId, turnId);
    useLayoutEffect(() => {
      appHandle = handle;
      drafts.set(`${conversationId}:${turnId}`, state);
    }, [conversationId, handle, state, turnId]);
    return null;
  }
  function MembershipReader({ conversationId }: { conversationId: string }) {
    const ids = useLocalConversationEditingTurnIds(conversationId);
    useLayoutEffect(() => {
      const commits = memberships.get(conversationId) ?? [];
      commits.push(ids);
      memberships.set(conversationId, commits);
    });
    return null;
  }
  const view = renderWithAppMaitai(
    <>
      {["a", "b"].map((conversationId) => (
        <div key={conversationId}>
          <MembershipReader conversationId={conversationId} />
          <DraftReader conversationId={conversationId} turnId="first" />
          <DraftReader conversationId={conversationId} turnId="second" />
        </div>
      ))}
    </>,
  );
  const draft = (conversationId: string, turnId: string) => {
    const state = drafts.get(`${conversationId}:${turnId}`);
    if (!state) throw new Error("Expected a mounted draft reader.");
    return state;
  };
  const commits = (conversationId: string) => memberships.get(conversationId) ?? [];
  return {
    ...view,
    commits,
    draft,
    ids: (conversationId: string) => commits(conversationId).at(-1),
    text: (conversationId: string, turnId: string) => draft(conversationId, turnId)[0]?.text,
    write: (conversationId: string, turnId: string, value: string | null) =>
      act(async () => {
        draft(conversationId, turnId)[1](value === null ? null : textDraft(value));
        await Promise.resolve();
      }),
    update: (conversationId: string, turnId: string, value: UserTurnEditDraftUpdate) =>
      act(async () => {
        draft(conversationId, turnId)[1](value);
        await Promise.resolve();
      }),
    remove: (conversationId: string) =>
      act(async () => {
        if (!appHandle) throw new Error("Expected the application scope.");
        removeLocalConversationViewState(appHandle, conversationId);
        await Promise.resolve();
      }),
  };
}

describe("active message edits", () => {
  test("publishes open and close membership without publishing keystrokes or another conversation's edits", async () => {
    const view = mountEditState();
    expect(view.ids("a")).toEqual([]);
    expect(view.ids("b")).toEqual([]);

    await view.write("a", "first", "Original request");
    expect(view.ids("a")).toEqual(["first"]);
    const initialMembership = view.ids("a");
    const initialCommitCount = view.commits("a").length;
    for (const text of ["Typing", "", "Revised request"]) {
      await view.write("a", "first", text);
      expect(view.text("a", "first")).toBe(text);
      expect(view.ids("a")).toBe(initialMembership);
      expect(view.commits("a")).toHaveLength(initialCommitCount);
    }

    await view.write("b", "first", "Another conversation");
    expect(view.ids("b")).toEqual(["first"]);
    expect(view.commits("a")).toHaveLength(initialCommitCount);

    await view.write("a", "second", "Second editor");
    expect(view.ids("a")).toEqual(["first", "second"]);
    await view.write("a", "first", null);
    expect(view.ids("a")).toEqual(["second"]);
    await view.write("a", "second", null);
    expect(view.ids("a")).toEqual([]);
    expect(view.ids("b")).toEqual(["first"]);
    await view.write("a", "first", "Reopened");
    expect(view.ids("a")).toEqual(["first"]);
  });

  test("an update from the current draft changes its images and cannot reopen a closed edit", async () => {
    const view = mountEditState();
    await view.write("a", "first", "Original request");
    const membership = view.ids("a");
    const commits = view.commits("a").length;
    const lateImage = (current: UserTurnEditDraft | null) =>
      current && { ...current, text: `${current.text} with image` };

    await view.update("a", "first", lateImage);
    expect(view.text("a", "first")).toBe("Original request with image");
    expect(view.ids("a")).toBe(membership);
    expect(view.commits("a")).toHaveLength(commits);

    await view.write("a", "first", null);
    await view.update("a", "first", lateImage);
    expect(view.draft("a", "first")[0]).toBeNull();
    expect(view.ids("a")).toEqual([]);
  });

  test("deletion closes mounted drafts and prevents late setters from reopening the deleted conversation", async () => {
    const view = mountEditState();
    await view.write("a", "first", "Unsaved request");
    await view.write("b", "first", "Keep this draft");
    const lateSetDraft = view.draft("a", "first")[1];
    const otherMembership = view.ids("b");
    const otherCommitCount = view.commits("b").length;

    await view.remove("a");
    expect(view.draft("a", "first")[0]).toBeNull();
    expect(view.ids("a")).toEqual([]);
    expect(view.ids("b")).toBe(otherMembership);
    expect(view.commits("b")).toHaveLength(otherCommitCount);
    expect(view.text("b", "first")).toBe("Keep this draft");

    await act(async () => {
      lateSetDraft(textDraft("A late update"));
      await Promise.resolve();
    });
    expect(view.draft("a", "first")[0]).toBeNull();
    expect(view.ids("a")).toEqual([]);
    await view.write("b", "first", "The other conversation still works");
    expect(view.text("b", "first")).toBe("The other conversation still works");
  });
});
