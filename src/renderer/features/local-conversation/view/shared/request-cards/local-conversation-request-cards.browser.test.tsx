import { render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import "@/globals.css";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { CodexUserInputRequest } from "@/lib/types";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import {
  RequestComposerView,
  REQUEST_INPUT_COMPOSER_POLICY,
  createInitialRequestQuestionnaireDraft,
} from "./local-conversation-request-cards";
import { setRequestQuestionnaireFreeform } from "./request-card-questionnaire-state";

installRendererThemeFixture();

vi.mock("../../composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({ isDictating: false, isStarting: false, isTranscribing: false }),
}));

const request: CodexUserInputRequest = {
  type: "userInput",
  requestId: "request",
  projectId: "project",
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  createdAt: 1,
  isBlocking: true,
  questions: [
    {
      id: "question",
      header: "Next step",
      question: "How should we proceed?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Continue", description: "Follow the plan." }],
    },
  ],
};

const initialDraft = createInitialRequestQuestionnaireDraft(request);
const form = (text: string) => (
  <NodexTooltipProvider>
    <div style={{ width: 640 }}>
      <RequestComposerView
        request={request}
        policy={REQUEST_INPUT_COMPOSER_POLICY}
        initialDraft={setRequestQuestionnaireFreeform(initialDraft, 0, text)}
        onSubmit={async () => {}}
        submitErrorMessage="Could not submit"
      />
    </div>
  </NodexTooltipProvider>
);

test("an Other response grows with its controlled draft, scrolls beyond 160px, and shrinks again", () => {
  const view = render(form(""));
  const textarea = view.getByRole("textbox", {
    name: "How should we proceed?",
  }) as HTMLTextAreaElement;
  const initialHeight = textarea.getBoundingClientRect().height;
  expect(initialHeight).toBeGreaterThan(0);

  view.rerender(form("First line\nSecond line\nThird line\nFourth line"));
  expect(textarea.getBoundingClientRect().height).toBeGreaterThan(initialHeight);
  expect(textarea.scrollHeight).toBe(textarea.clientHeight);

  view.rerender(form(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n")));
  expect(textarea.getBoundingClientRect().height).toBe(160);
  expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
  expect(getComputedStyle(textarea).overflowY).toBe("auto");
  textarea.scrollTop = textarea.scrollHeight;
  expect(textarea.scrollTop).toBeGreaterThan(0);

  view.rerender(form("A short response"));
  expect(textarea.getBoundingClientRect().height).toBe(initialHeight);
  expect(textarea.scrollHeight).toBe(textarea.clientHeight);
});
