import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { useNewChatExecutionDraft } from "./use-new-chat-execution-draft";

type ExecutionScope = Pick<
  Parameters<typeof useNewChatExecutionDraft>[0],
  "sessionId" | "projectId" | "workspaceRoot"
>;

const PROJECT_SCOPE: ExecutionScope = {
  sessionId: "draft-session",
  projectId: "project-a",
  workspaceRoot: "/repo/a",
};
const WORKTREE_DRAFT = {
  runInTarget: "newWorktree",
  worktreeStartingState: {
    type: "branch",
    branchName: "origin/feature",
    remoteRef: "refs/remotes/origin/feature",
  },
} as const;

describe("new-chat execution draft scope", () => {
  test("clears execution choices when selecting another Project, before its projection arrives", async () => {
    const onProjectChange = vi.fn();
    const { result, rerender } = renderHook(
      (scope) => useNewChatExecutionDraft({ ...scope, onProjectChange }),
      { initialProps: PROJECT_SCOPE },
    );
    await act(async () => {
      result.current.changeTarget(WORKTREE_DRAFT);
      await Promise.resolve();
    });

    await act(async () => {
      result.current.changeProject("plain-folder-project");
      await Promise.resolve();
    });
    expect(onProjectChange).toHaveBeenCalledWith("plain-folder-project");
    expect(result.current.target).toEqual({ runInTarget: "localProject" });

    rerender({
      ...PROJECT_SCOPE,
      projectId: "plain-folder-project",
      workspaceRoot: "/plain-folder",
    });
    expect(result.current.target).toEqual({ runInTarget: "localProject" });
    rerender(PROJECT_SCOPE);
    expect(result.current.target).toEqual({ runInTarget: "localProject" });
  });

  test("preserves the chosen starting ref when reselecting the current Project", async () => {
    const onProjectChange = vi.fn();
    const { result } = renderHook(() =>
      useNewChatExecutionDraft({ ...PROJECT_SCOPE, onProjectChange }),
    );
    await act(async () => {
      result.current.changeTarget(WORKTREE_DRAFT);
      await Promise.resolve();
    });
    await act(async () => {
      result.current.changeProject(PROJECT_SCOPE.projectId);
      await Promise.resolve();
    });
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(result.current.target).toEqual(WORKTREE_DRAFT);
  });

  test.each([
    {
      name: "the primary source changes",
      nextScope: { ...PROJECT_SCOPE, workspaceRoot: "/repo/replaced-source" },
    },
    {
      name: "a deleted Project falls back to another Project with the same source",
      nextScope: { ...PROJECT_SCOPE, projectId: "fallback-project" },
    },
    {
      name: "another Session is shown",
      nextScope: { ...PROJECT_SCOPE, sessionId: "another-session" },
    },
    {
      name: "the selected Project is cleared",
      nextScope: { ...PROJECT_SCOPE, projectId: null, workspaceRoot: null },
    },
  ])("never commits the previous worktree choice when $name", async ({ nextScope }) => {
    const committedTargets: string[] = [];
    const { result, rerender } = renderHook(
      (scope: ExecutionScope) => {
        const draft = useNewChatExecutionDraft({ ...scope, onProjectChange: () => {} });
        useLayoutEffect(() => {
          committedTargets.push(draft.target.runInTarget);
        });
        return draft;
      },
      { initialProps: PROJECT_SCOPE },
    );
    await act(async () => {
      result.current.changeTarget(WORKTREE_DRAFT);
      await Promise.resolve();
    });
    committedTargets.length = 0;
    rerender(nextScope);
    expect(committedTargets).toEqual(["localProject"]);
    expect(result.current.target.worktreeStartingState).toBeUndefined();
    rerender(PROJECT_SCOPE);
    expect(result.current.target).toEqual({ runInTarget: "localProject" });
  });
});
