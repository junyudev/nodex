import { act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import type { CodexUserInputRequest } from "@/lib/types";
import { renderWithMaitai } from "@/test/thread-maitai";
import { settleAsyncRender } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import {
  CodexUserInputAutoResolutionCountdown,
  CodexUserInputRequestCard,
} from "./codex-user-input-request-card";
import { resetCodexUserInputDraftStateForTests } from "../../../user-input-draft-state";
import { resetUserInputAutoResolutionStateForTests } from "../../../user-input-auto-resolution-state";

vi.mock("@/lib/use-reduced-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-reduced-motion")>();
  return {
    ...actual,
    useResolvedReducedMotion: () => true,
  };
});

const ordinaryRequest: CodexUserInputRequest = {
  type: "userInput",
  requestId: "ordinary-input",
  projectId: "project-1",
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "ordinary-input-item",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which scope should Codex use?",
      isOther: false,
      options: [
        { label: "Focused", description: "Change only the selected surface." },
        { label: "Broad", description: "Refactor the full request lane." },
      ],
    },
  ],
  isBlocking: true,
  createdAt: 1,
};

const multiQuestionRequest: CodexUserInputRequest = {
  ...ordinaryRequest,
  requestId: "multi-input",
  questions: [
    ordinaryRequest.questions[0]!,
    {
      id: "context",
      header: "Context",
      question: "What else should Codex know?",
      isOther: false,
      options: undefined,
    },
  ],
};

beforeEach(() => {
  resetCodexUserInputDraftStateForTests();
  resetUserInputAutoResolutionStateForTests();
  installWindowApi({
    invoke: async (channel: string) => {
      if (channel === "codex:user-input:auto-resolution:snapshot") return [];
      if (channel === "codex:user-input:auto-resolution:snooze") return false;
      return true;
    },
    on: () => () => {},
  });
});

describe("CodexUserInputRequestCard", () => {
  test("responds with the activated choice once after the acknowledgement window", async () => {
    vi.useFakeTimers();
    try {
      const responses: Record<string, string[]>[] = [];
      const view = renderWithMaitai(
        <TooltipProvider>
          <CodexUserInputRequestCard
            conversationId="thread-immediate"
            request={ordinaryRequest}
            onRespond={async (_requestId, answers) => {
              responses.push(answers);
            }}
          />
        </TooltipProvider>,
      );

      await act(async () => {
        fireEvent.click(view.getByRole("radio", { name: "Broad" }));
        fireEvent.click(view.getByRole("radio", { name: "Broad" }));
      });
      expect(responses).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(179);
      });
      expect(responses).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
      });
      expect(responses).toEqual([{ scope: ["Broad"] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("restores the current question and freeform draft after a remount", async () => {
    vi.useFakeTimers();
    try {
      const card = (
        <TooltipProvider>
          <CodexUserInputRequestCard
            conversationId="thread-draft"
            request={multiQuestionRequest}
            onRespond={async () => undefined}
          />
        </TooltipProvider>
      );
      const view = renderWithMaitai(card);

      await act(async () => {
        fireEvent.click(view.getByRole("radio", { name: "Broad" }));
        await vi.advanceTimersByTimeAsync(180);
      });
      const freeform = view.getByPlaceholderText("Type your answer");
      await act(async () => {
        fireEvent.change(freeform, {
          target: { value: "Keep the migration scoped." },
        });
      });

      view.unmount();
      const remounted = renderWithMaitai(card);

      expect((remounted.getByPlaceholderText("Type your answer") as HTMLInputElement).value).toBe(
        "Keep the migration scoped.",
      );
      expect(remounted.getByText("What else should Codex know?")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses one conversation draft slot so replacement input cannot revive", async () => {
    vi.useFakeTimers();
    try {
      const view = renderWithMaitai(
        <TooltipProvider>
          <CodexUserInputRequestCard
            conversationId="thread-draft"
            request={multiQuestionRequest}
            onRespond={async () => undefined}
          />
        </TooltipProvider>,
      );
      await act(async () => {
        fireEvent.click(view.getByRole("radio", { name: "Broad" }));
        await vi.advanceTimersByTimeAsync(180);
      });
      await act(async () => {
        fireEvent.change(view.getByPlaceholderText("Type your answer"), {
          target: { value: "Old request draft." },
        });
      });

      view.rerender(
        <TooltipProvider>
          <CodexUserInputRequestCard
            conversationId="thread-draft"
            request={{
              ...ordinaryRequest,
              requestId: "replacement-request",
              questions: [multiQuestionRequest.questions[1]!],
            }}
            onRespond={async () => undefined}
          />
        </TooltipProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      view.rerender(
        <TooltipProvider>
          <CodexUserInputRequestCard
            conversationId="thread-draft"
            request={multiQuestionRequest}
            onRespond={async () => undefined}
          />
        </TooltipProvider>,
      );

      expect(view.getByText("Which scope should Codex use?")).not.toBeNull();
      expect(view.queryByDisplayValue("Old request draft.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses number keys and freeform Enter through the same advance-and-submit path", async () => {
    vi.useFakeTimers();
    try {
      const responses: Record<string, string[]>[] = [];
      const view = renderWithMaitai(
        <TooltipProvider>
          <CodexUserInputRequestCard
            conversationId="thread-keyboard"
            request={multiQuestionRequest}
            onRespond={async (_requestId, answers) => {
              responses.push(answers);
            }}
          />
        </TooltipProvider>,
      );
      const form = view.container.querySelector("form") as HTMLFormElement;

      expect(document.activeElement).toBe(form);
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "2" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
      });
      const freeform = view.getByPlaceholderText("Type your answer");
      await act(async () => {
        fireEvent.change(freeform, {
          target: { value: "Keep the migration scoped." },
        });
        fireEvent.keyDown(freeform, { key: "Enter" });
        await Promise.resolve();
      });

      expect(responses).toEqual([
        {
          scope: ["Broad"],
          context: ["Keep the migration scoped."],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancels delayed option submission when the card unmounts", async () => {
    vi.useFakeTimers();
    try {
      const onRespond = vi.fn(async () => undefined);
      const view = renderWithMaitai(
        <TooltipProvider>
          <CodexUserInputRequestCard
            conversationId="thread-unmount"
            request={ordinaryRequest}
            onRespond={onRespond}
          />
        </TooltipProvider>,
      );

      fireEvent.click(view.getByRole("radio", { name: "Broad" }));
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
      });

      expect(onRespond).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not dismiss while the final response is still in flight", async () => {
    vi.useFakeTimers();
    try {
      let resolveResponse: () => void = () => undefined;
      const response = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      const onRespond = vi.fn(async () => await response);
      const view = renderWithMaitai(
        <TooltipProvider>
          <CodexUserInputRequestCard
            conversationId="thread-busy"
            request={ordinaryRequest}
            onRespond={onRespond}
          />
        </TooltipProvider>,
      );
      const form = view.container.querySelector("form") as HTMLFormElement;

      await act(async () => {
        fireEvent.click(view.getByRole("radio", { name: "Broad" }));
        await vi.advanceTimersByTimeAsync(180);
      });
      fireEvent.keyDown(form, { key: "Escape" });
      expect(onRespond).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveResponse();
        await Promise.resolve();
      });
      expect(onRespond).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("renders no request surface for an empty questionnaire", () => {
    const view = renderWithMaitai(
      <TooltipProvider>
        <CodexUserInputRequestCard
          conversationId="thread-empty"
          request={{ ...ordinaryRequest, questions: [] }}
          onRespond={async () => undefined}
        />
      </TooltipProvider>,
    );

    expect(view.container.querySelector("form")).toBeNull();
  });

  test("shows only the final minute of the auto-resolution countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const visible = renderWithMaitai(
        <CodexUserInputAutoResolutionCountdown deadlineMs={55_000} />,
      );
      expect(visible.getByLabelText("Auto-resolving in 45 seconds")).not.toBeNull();
      visible.unmount();

      const hidden = renderWithMaitai(
        <CodexUserInputAutoResolutionCountdown deadlineMs={75_000} />,
      );
      expect(hidden.queryByLabelText(/Auto-resolving/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("forces the Other path and empty-response dismiss for onboarding dynamic input", async () => {
    const log: string[] = [];
    const { getByPlaceholderText, getByText } = renderWithMaitai(
      <TooltipProvider>
        <CodexUserInputRequestCard
          conversationId="thread_1"
          request={{
            ...ordinaryRequest,
            requestId: "onboarding-input",
            isOnboardingDynamicInput: true,
          }}
          onRespond={async (requestId, answers) => {
            log.push(`respond:${requestId}:${JSON.stringify(answers)}`);
          }}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    expect((getByPlaceholderText("Something else") as HTMLTextAreaElement).value).toBe("");
    await act(async () => {
      fireEvent.click(getByText("Dismiss"));
      await settleAsyncRender();
    });

    expect(JSON.stringify(log)).toBe(JSON.stringify(["respond:onboarding-input:{}"]));
  });

  test("uses interrupt fallback when no matching auto-resolution entry exists", async () => {
    const log: string[] = [];
    const { getByText, unmount } = renderWithMaitai(
      <TooltipProvider>
        <CodexUserInputRequestCard
          conversationId="thread_1"
          request={ordinaryRequest}
          onRespond={async (_requestId, answers) => {
            log.push(`respond:${JSON.stringify(answers)}`);
          }}
          onInterrupt={async () => {
            log.push("interrupt");
          }}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(getByText("Dismiss"));
      await settleAsyncRender();
    });
    expect(JSON.stringify(log)).toBe(JSON.stringify(["interrupt"]));
    unmount();

    const autoResolved = renderWithMaitai(
      <TooltipProvider>
        <CodexUserInputRequestCard
          conversationId="thread_1"
          request={{ ...ordinaryRequest, autoResolutionMs: 60_000 }}
          onRespond={async (_requestId, answers) => {
            log.push(`auto:${JSON.stringify(answers)}`);
          }}
          onInterrupt={async () => {
            log.push("auto-field-interrupt");
          }}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();
    await act(async () => {
      fireEvent.click(autoResolved.getByText("Dismiss"));
      await settleAsyncRender();
    });

    expect(JSON.stringify(log)).toBe(JSON.stringify(["interrupt", "auto-field-interrupt"]));
  });

  test("claims a main-tracked request before dismissing with an empty response", async () => {
    let snapshotCalls = 0;
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel === "codex:user-input:auto-resolution:snapshot") {
          snapshotCalls += 1;
          if (snapshotCalls === 1) {
            return await new Promise<never>(() => {});
          }
          return [
            {
              conversationId: "thread-tracked",
              requestId: ordinaryRequest.requestId,
              phase: { type: "waitingForInactivity" },
            },
          ];
        }
        return true;
      },
      on: () => () => {},
    });
    const log: string[] = [];
    const view = renderWithMaitai(
      <TooltipProvider>
        <CodexUserInputRequestCard
          conversationId="thread-tracked"
          request={ordinaryRequest}
          onRespond={async (_requestId, answers) => {
            log.push(`respond:${JSON.stringify(answers)}`);
          }}
          onInterrupt={async () => {
            log.push("interrupt");
          }}
        />
      </TooltipProvider>,
    );

    await act(async () => {
      fireEvent.click(view.getByText("Dismiss"));
      await settleAsyncRender();
    });
    expect(log).toEqual(["respond:{}"]);
  });

  test("waits for the atomic snooze claim before choosing the dismiss outcome", async () => {
    let resolveSnooze: ((claimed: boolean) => void) | null = null;
    const snoozeResult = new Promise<boolean>((resolve) => {
      resolveSnooze = resolve;
    });
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel === "codex:user-input:auto-resolution:snooze") {
          return await snoozeResult;
        }
        if (channel === "codex:user-input:auto-resolution:snapshot") {
          return [];
        }
        return true;
      },
      on: () => () => {},
    });
    const onRespond = vi.fn(async () => undefined);
    const onInterrupt = vi.fn(async () => undefined);
    const view = renderWithMaitai(
      <TooltipProvider>
        <CodexUserInputRequestCard
          conversationId="thread-dismiss-race"
          request={ordinaryRequest}
          onRespond={onRespond}
          onInterrupt={onInterrupt}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    fireEvent.click(view.getByText("Dismiss"));
    await Promise.resolve();
    expect(onRespond).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();

    await act(async () => {
      resolveSnooze?.(true);
      await settleAsyncRender();
    });
    expect(onRespond).toHaveBeenCalledWith(ordinaryRequest.requestId, {});
    expect(onInterrupt).not.toHaveBeenCalled();
  });
});
