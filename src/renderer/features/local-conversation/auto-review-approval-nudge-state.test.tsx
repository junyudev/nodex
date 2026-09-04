import { useEffect } from "react";
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import { renderWithMaitai } from "@/test/thread-maitai";
import { settleAsyncRender } from "@/test/dom";
import {
  useAutoReviewApprovalNudgeActions,
  useAutoReviewApprovalNudgeState,
  type AutoReviewApprovalNudgeState,
} from "./auto-review-approval-nudge-state";

interface AutoReviewApprovalNudgeController {
  readonly dismissNudges: () => Promise<void>;
  readonly recordManualApproval: (input: {
    readonly threadId: string;
    readonly eligible: boolean;
    readonly threshold?: number;
  }) => Promise<void>;
  readonly resolveNudge: (threadId: string) => void;
  readonly state: AutoReviewApprovalNudgeState;
}

function AutoReviewApprovalNudgeHarness({
  controllerRef,
}: {
  readonly controllerRef: { current: AutoReviewApprovalNudgeController | null };
}) {
  const state = useAutoReviewApprovalNudgeState();
  const actions = useAutoReviewApprovalNudgeActions();

  useEffect(() => {
    controllerRef.current = { ...actions, state };
  }, [actions, controllerRef, state]);

  return null;
}

describe("auto-review approval nudge state", () => {
  beforeEach(() => {
    clearPersistedAtomStoreForTests();
  });

  test("activates per thread at the manual approval threshold and clears after resolution", async () => {
    const controllerRef: {
      current: AutoReviewApprovalNudgeController | null;
    } = { current: null };
    renderWithMaitai(<AutoReviewApprovalNudgeHarness controllerRef={controllerRef} />);
    await settleAsyncRender();

    await act(async () => {
      await controllerRef.current?.recordManualApproval({
        threadId: "thread_1",
        eligible: true,
      });
      await controllerRef.current?.recordManualApproval({
        threadId: "thread_1",
        eligible: true,
      });
    });
    expect(controllerRef.current?.state.activeThreadIds.thread_1).toBeUndefined();

    await act(async () => {
      await controllerRef.current?.recordManualApproval({
        threadId: "thread_1",
        eligible: true,
      });
    });
    expect(controllerRef.current?.state.activeThreadIds.thread_1).toBe(true);

    await act(async () => {
      controllerRef.current?.resolveNudge("thread_1");
    });
    expect(controllerRef.current?.state.activeThreadIds.thread_1).toBeUndefined();
    expect(controllerRef.current?.state.manualApprovalCountByThreadId.thread_1).toBeUndefined();
  });

  test("permanent dismissal hides every thread and prevents later activation", async () => {
    const controllerRef: {
      current: AutoReviewApprovalNudgeController | null;
    } = { current: null };
    renderWithMaitai(<AutoReviewApprovalNudgeHarness controllerRef={controllerRef} />);
    await settleAsyncRender();

    await act(async () => {
      await controllerRef.current?.recordManualApproval({
        threadId: "thread_1",
        eligible: true,
        threshold: 1,
      });
      await controllerRef.current?.dismissNudges();
      await controllerRef.current?.recordManualApproval({
        threadId: "thread_2",
        eligible: true,
        threshold: 1,
      });
    });

    expect(controllerRef.current?.state.dismissed).toBe(true);
    expect(Object.keys(controllerRef.current?.state.activeThreadIds ?? {})).toHaveLength(0);
    expect(
      Object.keys(controllerRef.current?.state.manualApprovalCountByThreadId ?? {}),
    ).toHaveLength(0);
  });
});
