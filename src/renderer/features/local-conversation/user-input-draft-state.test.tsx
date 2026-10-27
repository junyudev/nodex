import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test } from "vite-plus/test";
import {
  useCodexUserInputDraft,
  clearCodexUserInputDraft,
  resetCodexUserInputDraftStateForTests,
} from "./user-input-draft-state";
import { questionDraftStore } from "./question-draft-store";
import type { RequestComposerRequest } from "./view/shared/request-cards/request-card-questionnaire-state";

const request: RequestComposerRequest = {
  requestId: "shared-request",
  questions: [{ id: "name", header: "Name", question: "What name?", isOther: true }],
};
beforeEach(() => resetCodexUserInputDraftStateForTests());

test("the same questionnaire on another host cannot inherit or clear authored text", async () => {
  const first = renderHook(() =>
    useCodexUserInputDraft("same-thread", request, {
      hostId: "host-a",
      namespace: "native:host-a",
    }),
  );
  await act(async () => {
    first.result.current.saveDraft({
      questionIndex: 0,
      answers: [{ selectedOptionId: null, freeformText: "Host A text" }],
    });
    await questionDraftStore.flush();
  });
  const second = renderHook(() =>
    useCodexUserInputDraft("same-thread", request, {
      hostId: "host-b",
      namespace: "native:host-b",
    }),
  );
  expect(second.result.current.initialDraft).toBeUndefined();
  await act(async () => {
    clearCodexUserInputDraft("same-thread", "shared-request", "host-b");
    await Promise.resolve();
  });
  expect(first.result.current.initialDraft?.answers[0]?.freeformText).toBe("Host A text");
});
