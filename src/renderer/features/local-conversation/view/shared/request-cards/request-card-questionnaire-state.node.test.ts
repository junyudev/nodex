import { describe, expect, test } from "vite-plus/test";
import {
  EXPLICIT_REQUEST_FORM_POLICY,
  REQUEST_INPUT_COMPOSER_POLICY,
  activateRequestQuestionnaireOther,
  buildUserInputAnswers,
  clearCurrentRequestQuestionnaireAnswer,
  createInitialRequestQuestionnaireDraft,
  isRequestQuestionnaireSubmittable,
  navigateRequestQuestionnaire,
  reconcileRequestQuestionnaireDraft,
  selectRequestQuestionnaireOption,
  setRequestQuestionnaireFreeform,
  type RequestComposerRequest,
} from "./request-card-questionnaire-state";

const request: RequestComposerRequest = {
  requestId: "input_1",
  questions: [
    {
      id: "q_1",
      header: "Need your call",
      question: "What is 1 + 1?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "2 (Recommended)", description: "Matches arithmetic." },
        { label: "3", description: "Marks the previous answer as wrong." },
      ],
    },
    {
      id: "q_2",
      header: "More context",
      question: "Tell Codex what to change next",
      isOther: false,
      isSecret: false,
      options: undefined,
    },
  ],
};

const optionOnlyRequest: RequestComposerRequest = {
  requestId: "input_option_only",
  questions: [
    {
      id: "q_option_only",
      header: "Choose one",
      question: "Which option should Codex use?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "First", description: "Use the first option." },
        { label: "Second", description: "Use the second option." },
      ],
    },
  ],
};

describe("request card questionnaire state", () => {
  test("preserves multiple choices and does not submit a deselected choice", () => {
    const multiple: RequestComposerRequest = {
      ...optionOnlyRequest,
      questions: optionOnlyRequest.questions.map((question) => ({
        ...question,
        multiSelect: true,
      })),
    };
    let draft = createInitialRequestQuestionnaireDraft(multiple);
    expect(buildUserInputAnswers(multiple, draft)).toEqual({});
    draft = selectRequestQuestionnaireOption(draft, 0, "First", true);
    draft = selectRequestQuestionnaireOption(draft, 0, "Second", true);
    expect(buildUserInputAnswers(multiple, draft)).toEqual({ q_option_only: ["First", "Second"] });
    draft = selectRequestQuestionnaireOption(draft, 0, "First", true);
    draft = selectRequestQuestionnaireOption(draft, 0, "Second", true);
    expect(isRequestQuestionnaireSubmittable(multiple, draft, EXPLICIT_REQUEST_FORM_POLICY)).toBe(
      false,
    );
    expect(buildUserInputAnswers(multiple, draft)).toEqual({});
  });
  test("builds a selected option answer and accepts it for explicit forms", () => {
    const draft = {
      answers: [{ selectedOptionId: "First", freeformText: null }],
      questionIndex: 0,
    };

    expect(buildUserInputAnswers(optionOnlyRequest, draft)).toEqual({
      q_option_only: ["First"],
    });
    expect(
      isRequestQuestionnaireSubmittable(optionOnlyRequest, draft, EXPLICIT_REQUEST_FORM_POLICY),
    ).toBe(true);
  });

  test("uses the active freeform answer instead of dormant option text", () => {
    const draft = {
      answers: [
        {
          selectedOptionId: null,
          freeformText: "Try again and use a calculator.",
        },
        {
          selectedOptionId: null,
          freeformText: null,
        },
      ],
      questionIndex: 0,
    };

    expect(buildUserInputAnswers(request, draft)).toEqual({
      q_1: ["Try again and use a calculator."],
    });
  });

  test("does not treat freeform text as an answer for an option-only question", () => {
    expect(
      buildUserInputAnswers(optionOnlyRequest, {
        answers: [
          {
            selectedOptionId: null,
            freeformText: "Choose none of the above.",
          },
        ],
        questionIndex: 0,
      }),
    ).toEqual({});
  });

  test("requires non-empty text for an explicit freeform question", () => {
    const freeformRequest: RequestComposerRequest = {
      ...request,
      questions: [
        {
          id: "q_freeform",
          header: "Input required",
          question: "Tell Nodex what to do differently",
          isOther: false,
          isSecret: false,
          options: undefined,
        },
      ],
    };

    expect(
      isRequestQuestionnaireSubmittable(
        freeformRequest,
        {
          answers: [{ selectedOptionId: null, freeformText: "" }],
          questionIndex: 0,
        },
        EXPLICIT_REQUEST_FORM_POLICY,
      ),
    ).toBe(false);
    expect(
      isRequestQuestionnaireSubmittable(
        freeformRequest,
        {
          answers: [
            {
              selectedOptionId: null,
              freeformText: "Focus on the failing type errors only.",
            },
          ],
          questionIndex: 0,
        },
        EXPLICIT_REQUEST_FORM_POLICY,
      ),
    ).toBe(true);
  });

  test("initializes option and freeform questions coherently", () => {
    expect(createInitialRequestQuestionnaireDraft(request)).toEqual({
      answers: [
        {
          selectedOptionId: "2 (Recommended)",
          freeformText: null,
        },
        {
          selectedOptionId: null,
          freeformText: null,
        },
      ],
      questionIndex: 0,
    });
  });

  test("captures a newly selected choice without losing other answers", () => {
    const initial = createInitialRequestQuestionnaireDraft(request);
    const withFreeform = setRequestQuestionnaireFreeform(initial, 1, "Keep this");
    const selected = selectRequestQuestionnaireOption(withFreeform, 0, "3");

    expect(selected.answers).toEqual([
      {
        selectedOptionId: "3",
        freeformText: null,
      },
      {
        selectedOptionId: null,
        freeformText: "Keep this",
      },
    ]);
  });

  test("omits skipped answers and trims freeform responses", () => {
    const initial = createInitialRequestQuestionnaireDraft(request);
    const skipped = clearCurrentRequestQuestionnaireAnswer(initial);
    const second = navigateRequestQuestionnaire(request, skipped, 1);
    const completed = setRequestQuestionnaireFreeform(
      second,
      1,
      "  Focus on the failing type errors.  ",
    );

    expect(buildUserInputAnswers(request, completed)).toEqual({
      q_2: ["Focus on the failing type errors."],
    });
    expect(
      isRequestQuestionnaireSubmittable(request, completed, REQUEST_INPUT_COMPOSER_POLICY),
    ).toBe(true);
    expect(
      isRequestQuestionnaireSubmittable(request, completed, EXPLICIT_REQUEST_FORM_POLICY),
    ).toBe(false);
  });

  test("prefers an active option over dormant freeform text", () => {
    const initial = createInitialRequestQuestionnaireDraft(request);
    const other = activateRequestQuestionnaireOther(initial, 0);
    const withText = setRequestQuestionnaireFreeform(other, 0, "Try another approach");
    const selected = selectRequestQuestionnaireOption(withText, 0, "2 (Recommended)");

    expect(buildUserInputAnswers(request, selected)).toEqual({
      q_1: ["2 (Recommended)"],
    });
  });

  test("reconciles stale indexes and removed options", () => {
    const restored = reconcileRequestQuestionnaireDraft(request, {
      answers: [
        {
          selectedOptionId: "Removed",
          freeformText: null,
        },
        {
          selectedOptionId: null,
          freeformText: "Keep this",
        },
      ],
      questionIndex: 99,
    });

    expect(restored).toEqual({
      answers: [
        {
          selectedOptionId: "2 (Recommended)",
          freeformText: null,
        },
        {
          selectedOptionId: null,
          freeformText: "Keep this",
        },
      ],
      questionIndex: 1,
    });
  });

  test("preserves an explicitly skipped option across draft reconciliation", () => {
    const initial = createInitialRequestQuestionnaireDraft(request);
    const skipped = clearCurrentRequestQuestionnaireAnswer(initial);
    const restored = reconcileRequestQuestionnaireDraft(request, skipped);

    expect(restored.answers[0]).toEqual({
      selectedOptionId: null,
      freeformText: null,
    });
    expect(buildUserInputAnswers(request, restored)).toEqual({});
  });
});
