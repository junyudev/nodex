import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodexPlanImplementationRequest, CodexUserInputRequest } from "../../../lib/types";

mock.module("../../ui/tooltip", () => ({
  Tooltip: ({
    children,
    delayDuration,
    disableAnimation,
  }: {
    children: ReactNode;
    delayDuration?: number;
    disableAnimation?: boolean;
  }) =>
    createElement(
      "span",
      {
        "data-delay-duration": delayDuration,
        "data-disable-animation": disableAnimation ? "true" : undefined,
      },
      children,
    ),
}));

const optionRequest: CodexUserInputRequest = {
  requestId: "input_1",
  projectId: "project_1",
  cardId: "card_1",
  threadId: "thread_1",
  turnId: "turn_1",
  itemId: "item_1",
  createdAt: Date.now(),
  questions: [
    {
      id: "q_1",
      header: "Need your call",
      question: "What is 1 + 1?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "2 (Recommended)", description: "Matches the obvious arithmetic result." },
        { label: "3", description: "Lets Codex know the previous answer was wrong." },
      ],
    },
  ],
};

const optionRequestWithoutOtherFlag: CodexUserInputRequest = {
  ...optionRequest,
  requestId: "input_2",
  questions: optionRequest.questions.map((question) => ({
    ...question,
    isOther: false,
  })),
};

const multiQuestionRequest: CodexUserInputRequest = {
  ...optionRequest,
  requestId: "input_3",
  questions: [
    ...optionRequest.questions,
    {
      id: "q_freeform",
      header: "More context",
      question: "Tell Codex what to change next",
      isOther: false,
      isSecret: false,
      options: undefined,
    },
  ],
};

const planImplementationRequest: CodexPlanImplementationRequest = {
  requestId: "implement-plan:turn_plan",
  projectId: "project_1",
  cardId: "card_1",
  threadId: "thread_1",
  turnId: "turn_plan",
  itemId: "plan_item",
  planContent: "1. Review\n2. Ship",
  createdAt: Date.now(),
};

describe("stage-threads request cards", () => {
  test("defaults option questions to the first choice and treats them as submittable", async () => {
    const { buildUserInputAnswers, isUserInputComposerSubmittable } = await import("./stage-threads-request-cards");
    const state = {
      drafts: { q_1: "" },
      modes: { q_1: "option" as const },
      selectedOptions: { q_1: "2 (Recommended)" },
    };

    expect(JSON.stringify(buildUserInputAnswers(optionRequest, state))).toBe(JSON.stringify({ q_1: ["2 (Recommended)"] }));
    expect(isUserInputComposerSubmittable(optionRequest, state)).toBeTrue();
  });

  test("prefers the freeform answer when the other path is active", async () => {
    const { buildUserInputAnswers } = await import("./stage-threads-request-cards");
    const state = {
      drafts: { q_1: "Try again and use a calculator." },
      modes: { q_1: "other" as const },
      selectedOptions: { q_1: "2 (Recommended)" },
    };

    expect(JSON.stringify(buildUserInputAnswers(optionRequest, state))).toBe(
      JSON.stringify({ q_1: ["Try again and use a calculator."] }),
    );
  });

  test("keeps the final freeform row for option questions even when isOther is false", async () => {
    const { buildUserInputAnswers, UserInputComposerView } = await import("./stage-threads-request-cards");
    const state = {
      drafts: { q_1: "Choose none of the above and revise the plan." },
      modes: { q_1: "other" as const },
      selectedOptions: { q_1: "2 (Recommended)" },
    };

    expect(JSON.stringify(buildUserInputAnswers(optionRequestWithoutOtherFlag, state))).toBe(
      JSON.stringify({ q_1: ["Choose none of the above and revise the plan."] }),
    );

    const markup = renderToStaticMarkup(
      createElement(UserInputComposerView, {
        request: optionRequestWithoutOtherFlag,
        onRespond: async () => {},
      }),
    );

    expect(markup.includes("Tell Codex what to do differently")).toBeTrue();
  });

  test("requires text for freeform-only questions before submit is enabled", async () => {
    const { isUserInputComposerSubmittable } = await import("./stage-threads-request-cards");
    const request: CodexUserInputRequest = {
      ...optionRequest,
      questions: [
        {
          id: "q_freeform",
          header: "Input required",
          question: "Tell Codex what to do differently",
          isOther: false,
          isSecret: false,
          options: undefined,
        },
      ],
    };

    expect(
      isUserInputComposerSubmittable(request, {
        drafts: { q_freeform: "" },
        modes: { q_freeform: "other" },
        selectedOptions: { q_freeform: "" },
      }),
    ).toBeFalse();
    expect(
      isUserInputComposerSubmittable(request, {
        drafts: { q_freeform: "Focus on the failing type errors only." },
        modes: { q_freeform: "other" },
        selectedOptions: { q_freeform: "" },
      }),
    ).toBeTrue();
  });

  test("maps preserved focus targets onto the next question shape", async () => {
    const { resolveUserInputQuestionFocusTarget } = await import("./stage-threads-request-cards");

    expect(resolveUserInputQuestionFocusTarget(multiQuestionRequest.questions[0]!, "options")).toBe("options");
    expect(resolveUserInputQuestionFocusTarget(multiQuestionRequest.questions[0]!, "answer")).toBe("other");
    expect(resolveUserInputQuestionFocusTarget(multiQuestionRequest.questions[1]!, "options")).toBe("answer");
    expect(resolveUserInputQuestionFocusTarget(multiQuestionRequest.questions[1]!, null)).toBe(null);
  });

  test("only allows arrow-up escape from the freeform row when the caret is at the start", async () => {
    const { canMoveUserInputFocusToOptionsFromOtherField } = await import("./stage-threads-request-cards");

    expect(canMoveUserInputFocusToOptionsFromOtherField(0, 0)).toBeTrue();
    expect(canMoveUserInputFocusToOptionsFromOtherField(1, 1)).toBeFalse();
    expect(canMoveUserInputFocusToOptionsFromOtherField(0, 2)).toBeFalse();
    expect(canMoveUserInputFocusToOptionsFromOtherField(null, null)).toBeFalse();
  });

  test("renders the composer-style request surface with hover metadata affordance", async () => {
    const { UserInputComposerView } = await import("./stage-threads-request-cards");
    const markup = renderToStaticMarkup(
      createElement(UserInputComposerView, {
        request: optionRequest,
        onRespond: async () => {},
      }),
    );

    expect(markup.includes("What is 1 + 1?")).toBeTrue();
    expect(markup.includes("2 (Recommended)")).toBeTrue();
    expect(markup.includes("About 2 (Recommended)")).toBeTrue();
    expect(markup.includes('data-delay-duration="0"')).toBeTrue();
    expect(markup.includes('data-disable-animation="true"')).toBeTrue();
    expect(markup.includes("Tell Codex what to do differently")).toBeTrue();
    expect(markup.includes('data-user-input-focus-target="options"')).toBeTrue();
    expect(markup.includes('data-user-input-focus-target="other"')).toBeTrue();
    expect(markup.includes("focus-visible:ring-1")).toBeFalse();
    expect(markup.includes("Dismiss")).toBeTrue();
    expect(markup.includes("Submit")).toBeTrue();
  });

  test("renders the official plan implementation composer copy", async () => {
    const { PlanImplementationComposerView } = await import("./stage-threads-request-cards");
    const markup = renderToStaticMarkup(
      createElement(PlanImplementationComposerView, {
        request: planImplementationRequest,
        onRespond: async () => {},
      }),
    );

    expect(markup.includes("Implement this plan?")).toBeTrue();
    expect(markup.includes("Yes, implement this plan")).toBeTrue();
    expect(markup.includes("No, and tell Codex what to do differently")).toBeTrue();
    expect(markup.includes('data-user-input-focus-target="options"')).toBeTrue();
    expect(markup.includes('data-user-input-focus-target="other"')).toBeTrue();
  });
});
