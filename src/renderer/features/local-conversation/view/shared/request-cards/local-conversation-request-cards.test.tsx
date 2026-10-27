import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { CodexUserInputRequest } from "@/lib/types";
import { render, settleAsyncRender, textContent } from "@/test/dom";
import { installMotionPreferenceForTest } from "@/test/browser-globals";

const optionRequest: CodexUserInputRequest = {
  type: "userInput",
  requestId: "input_1",
  projectId: "project_1",
  threadId: "thread_1",
  turnId: "turn_1",
  itemId: "item_1",
  createdAt: Date.now(),
  isBlocking: true,
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

const multiOptionRequest: CodexUserInputRequest = {
  ...optionRequest,
  requestId: "input_4",
  questions: [
    ...optionRequest.questions,
    {
      id: "q_approval",
      header: "Confirm direction",
      question: "How should Codex proceed?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Approve", description: "Continue with the proposed implementation." },
        { label: "Revise", description: "Return to the plan before implementation." },
      ],
    },
  ],
};

describe("local-conversation request cards", () => {
  test("does not render the final freeform row for option questions when isOther is false", async () => {
    const { REQUEST_INPUT_COMPOSER_POLICY, RequestComposerView } =
      await import("./local-conversation-request-cards");

    const { container } = render(
      <NodexTooltipProvider>
        <RequestComposerView
          request={optionRequestWithoutOtherFlag}
          policy={REQUEST_INPUT_COMPOSER_POLICY}
          onSubmit={async () => {}}
          submitErrorMessage="Could not submit input request"
        />
      </NodexTooltipProvider>,
    );

    expect(textContent(container).includes("Or write your own response")).toBe(false);
  });

  test("allows an immediate freeform question to resolve without an answer", async () => {
    const { REQUEST_INPUT_COMPOSER_POLICY, RequestComposerView } =
      await import("./local-conversation-request-cards");
    let respondCount = 0;
    const onRespond = async () => {
      respondCount += 1;
    };
    const freeformRequest: CodexUserInputRequest = {
      ...optionRequest,
      requestId: "input_blank",
      questions: [
        {
          id: "q_freeform",
          header: "Input required",
          question: "Or write your own response",
          isOther: false,
          isSecret: false,
          options: undefined,
        },
      ],
    };

    const { container } = render(
      <RequestComposerView
        request={freeformRequest}
        policy={REQUEST_INPUT_COMPOSER_POLICY}
        onSubmit={onRespond}
        submitErrorMessage="Could not submit input request"
      />,
    );

    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
      await settleAsyncRender();
    });

    expect(Boolean(textContent(container).includes("Enter a response before submitting."))).toBe(
      false,
    );
    expect(respondCount).toBe(1);
  });

  test("focuses the next question after its reduced-motion panel mounts", async () => {
    const restoreMotionPreference = installMotionPreferenceForTest(true);
    const { REQUEST_INPUT_COMPOSER_POLICY, RequestComposerView } =
      await import("./local-conversation-request-cards");
    try {
      const view = render(
        <NodexTooltipProvider>
          <RequestComposerView
            request={multiQuestionRequest}
            policy={REQUEST_INPUT_COMPOSER_POLICY}
            onSubmit={async () => {}}
            onEscapeDismiss={async () => {}}
            submitErrorMessage="Could not submit input request"
            dismissErrorMessage="Could not dismiss input request"
          />
        </NodexTooltipProvider>,
      );

      await act(async () => {
        fireEvent.click(view.getByRole("radio", { name: "3" }));
        await Promise.resolve();
      });

      await waitFor(
        () => {
          const input = view.getByPlaceholderText("Type your answer");
          expect(document.activeElement).toBe(input);
        },
        { timeout: 2_000 },
      );
    } finally {
      restoreMotionPreference();
    }
  });

  test("focuses the new option panel instead of the outgoing option panel", async () => {
    const { REQUEST_INPUT_COMPOSER_POLICY, RequestComposerView } =
      await import("./local-conversation-request-cards");
    const view = render(
      <NodexTooltipProvider>
        <RequestComposerView
          request={multiOptionRequest}
          policy={REQUEST_INPUT_COMPOSER_POLICY}
          onSubmit={async () => {}}
          onEscapeDismiss={async () => {}}
          submitErrorMessage="Could not submit input request"
          dismissErrorMessage="Could not dismiss input request"
        />
      </NodexTooltipProvider>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Next question" }));
      await Promise.resolve();
    });

    await waitFor(
      () => {
        expect(document.activeElement).toBe(view.getByRole("radio", { name: "Approve" }));
      },
      { timeout: 2_000 },
    );
  });

  test("ignores activation from an outgoing wait-mode question panel", async () => {
    const restoreMatchMedia = installMotionPreferenceForTest(false);
    const { REQUEST_INPUT_COMPOSER_POLICY, RequestComposerView } =
      await import("./local-conversation-request-cards");
    const draftChanges: unknown[] = [];
    const onSubmit = async () => {
      throw new Error("Outgoing question must not submit");
    };
    try {
      const view = render(
        <NodexTooltipProvider>
          <RequestComposerView
            request={multiQuestionRequest}
            policy={REQUEST_INPUT_COMPOSER_POLICY}
            onDraftChange={(draft) => {
              draftChanges.push(draft);
            }}
            onSubmit={onSubmit}
            onEscapeDismiss={async () => {}}
            submitErrorMessage="Could not submit input request"
            dismissErrorMessage="Could not dismiss input request"
          />
        </NodexTooltipProvider>,
      );
      const outgoingOption = view.getByRole("radio", { name: "3" });

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Next question" }));
        await Promise.resolve();
      });
      expect(draftChanges).toHaveLength(1);
      await act(async () => {
        fireEvent.click(outgoingOption);
        await Promise.resolve();
      });
      expect(draftChanges).toHaveLength(1);

      await waitFor(
        () => {
          expect(view.getByPlaceholderText("Type your answer")).not.toBeNull();
        },
        { timeout: 2_000 },
      );
    } finally {
      restoreMatchMedia();
    }
  });

  test("exposes option descriptions inline and keeps recommendation metadata separate", async () => {
    const { REQUEST_INPUT_COMPOSER_POLICY, RequestComposerView } =
      await import("./local-conversation-request-cards");
    const { container, getByRole, getByText } = render(
      <NodexTooltipProvider>
        <RequestComposerView
          request={optionRequest}
          policy={REQUEST_INPUT_COMPOSER_POLICY}
          onSubmit={async () => {}}
          onEscapeDismiss={async () => {}}
          submitErrorMessage="Could not submit input request"
          dismissErrorMessage="Could not dismiss input request"
        />
      </NodexTooltipProvider>,
    );

    expect(getByText("What is 1 + 1?").textContent).toBe("What is 1 + 1?");
    expect(getByText("Recommended").textContent).toBe("Recommended");
    const description = getByText("Matches the obvious arithmetic result.");
    expect(getByRole("radio", { name: "2 (Recommended)" }).getAttribute("aria-describedby")).toBe(
      description.id,
    );
    expect(textContent(container).includes("Or write your own response")).toBe(true);
    expect(container.querySelector('[data-user-input-focus-target="options"]')).not.toBeNull();
    expect(container.querySelector('[data-user-input-focus-target="other"]')).not.toBeNull();
    expect(getByText("Dismiss").textContent).toBe("Dismiss");
    expect(getByText("Skip").textContent).toBe("Skip");
    expect(textContent(container).includes("Submit")).toBe(false);
  });

  test("dismisses user input requests through the dismiss action", async () => {
    const { REQUEST_INPUT_COMPOSER_POLICY, RequestComposerView } =
      await import("./local-conversation-request-cards");
    const responses: string[] = [];
    const { getByText } = render(
      <NodexTooltipProvider>
        <RequestComposerView
          request={optionRequest}
          policy={REQUEST_INPUT_COMPOSER_POLICY}
          onSubmit={async () => {}}
          onEscapeDismiss={async () => {
            responses.push("{}");
          }}
          submitErrorMessage="Could not submit input request"
          dismissErrorMessage="Could not dismiss input request"
        />
      </NodexTooltipProvider>,
    );

    await act(async () => {
      fireEvent.click(getByText("Dismiss"));
      await settleAsyncRender();
    });

    expect(responses[0]).toBe("{}");
  });

  test("does not reinterpret keyboard activation of action buttons as option activation", async () => {
    const { REQUEST_INPUT_COMPOSER_POLICY, RequestComposerView } =
      await import("./local-conversation-request-cards");
    let dismissCount = 0;
    let submitCount = 0;
    const view = render(
      <NodexTooltipProvider>
        <RequestComposerView
          request={optionRequest}
          policy={REQUEST_INPUT_COMPOSER_POLICY}
          onSubmit={async () => {
            submitCount += 1;
          }}
          onEscapeDismiss={async () => {
            dismissCount += 1;
          }}
          submitErrorMessage="Could not submit input request"
          dismissErrorMessage="Could not dismiss input request"
        />
      </NodexTooltipProvider>,
    );
    const dismiss = view.getByRole("button", { name: "Dismiss" });

    expect(fireEvent.keyDown(dismiss, { key: "Enter" })).toBe(true);
    await act(async () => {
      fireEvent.click(dismiss);
      await settleAsyncRender();
    });

    expect(dismissCount).toBe(1);
    expect(submitCount).toBe(0);
  });

  test("renders the completed transcript row with an expandable answer list", async () => {
    const { UserInputTranscriptView } = await import("./local-conversation-request-cards");
    const { container, getByRole } = render(
      <UserInputTranscriptView
        item={{
          userInputQuestions: optionRequest.questions,
          userInputAnswers: {
            q_1: ["2 (Recommended)"],
          },
          status: "completed",
        }}
      />,
    );

    const toggle = getByRole("button", { name: /Asked\s*1 question/i });
    expect(Boolean(textContent(container).includes("Asked 1 question"))).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      fireEvent.click(toggle);
      await settleAsyncRender();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(Boolean(textContent(container).includes("What is 1 + 1?"))).toBe(true);
    expect(Boolean(textContent(container).includes("2 (Recommended)"))).toBe(true);
  });

  test("renders completed Runtime question history through the canonical projection and conceals private answers", async () => {
    const { projectAgentRuntimeItem } =
      await import("../../../agent-runtime-transcript-projection");
    const { projectCodexCanonicalTurnItemViews } =
      await import("../../../../../../shared/codex-canonical-item-projector");
    const { projectCodexItemViewToTranscriptEntry } =
      await import("../../../../../../shared/codex-transcript-entry-projection");
    const { UserInputTranscriptView } = await import("./local-conversation-request-cards");
    const at = "2026-10-27T00:00:00.000Z";
    const item = projectAgentRuntimeItem({
      id: "resolved-question",
      threadId: "thread",
      runId: "run",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "user_input_request",
      requestId: "request",
      questions: [
        { id: "color", header: "Color", question: "Which color?", options: [] },
        { id: "token", header: "Token", question: "Private token?", options: [], isSecret: true },
      ],
      questionAnswer: {
        requestId: "request",
        answers: { color: "Blue", token: "private-token" },
        attachmentsByQuestionId: {},
      },
    })!;
    const [projected] = projectCodexCanonicalTurnItemViews({
      threadId: "thread",
      turnId: "run",
      turnStatus: "completed",
      items: [item],
      observedAtMs: 1,
    });
    const entry = projectCodexItemViewToTranscriptEntry(projected!, "replay", 1);
    const view = render(<UserInputTranscriptView item={entry} />);
    const summary = view.getByRole("button", { name: /Asked\s*2 questions/i });
    await act(async () => {
      fireEvent.click(summary);
      await settleAsyncRender();
    });
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("Blue")).toBeTruthy();
    expect(view.getByText("Hidden response")).toBeTruthy();
    expect(view.queryByText("private-token")).toBeNull();
  });

  test("keeps the completed summary visible even when no answers were recorded", async () => {
    const { UserInputTranscriptView } = await import("./local-conversation-request-cards");
    const { container, getByRole } = render(
      <UserInputTranscriptView
        item={{
          userInputQuestions: optionRequest.questions,
          userInputAnswers: {},
          status: "completed",
        }}
      />,
    );

    const toggle = getByRole("button", { name: /Asked\s*1 question/i });
    expect(Boolean(textContent(container).includes("Asked 1 question"))).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      fireEvent.click(toggle);
      await settleAsyncRender();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(Boolean(textContent(container).includes("No answer provided"))).toBe(true);
  });

  test("renders the in-progress shimmer summary while waiting for answers", async () => {
    const { UserInputTranscriptView } = await import("./local-conversation-request-cards");
    const { container } = render(
      <UserInputTranscriptView
        item={{
          userInputQuestions: optionRequest.questions,
          userInputAnswers: {},
          status: "inProgress",
        }}
      />,
    );

    expect(Boolean(textContent(container).includes("Asking 1 question"))).toBe(true);
    expect(container.querySelector(".loading-shimmer-pure-text")).not.toBeNull();
  });
});
