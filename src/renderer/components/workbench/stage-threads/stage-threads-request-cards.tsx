import {
  useForm,
  useStore,
} from "@tanstack/react-form";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Tooltip } from "../../ui/tooltip";
import { handleFormSubmit, resolveFormErrorMessage } from "../../../lib/forms";
import { cn } from "../../../lib/utils";
import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexItemView,
  CodexPlanImplementationRequest,
  CodexUserInputRequest,
} from "../../../lib/types";
import { resolvePromptTextareaSize } from "./prompt-textarea-size";
import { InlineToolToggle } from "./tools/tool-primitives";

type CodexUserInputQuestion = CodexUserInputRequest["questions"][number];
type RequestComposerQuestion = CodexUserInputQuestion & { otherPlaceholder?: string };
type RequestComposerRequest = {
  requestId: string;
  questions: RequestComposerQuestion[];
};
const USER_INPUT_TEXTAREA_MAX_HEIGHT_PX = 160;
const PLAN_IMPLEMENTATION_QUESTION_ID = "implement-plan";
const PLAN_IMPLEMENTATION_PROMPT = "Implement this plan?";
const PLAN_IMPLEMENTATION_OPTION_LABEL = "Yes, implement this plan";
const PLAN_IMPLEMENTATION_OTHER_PLACEHOLDER = "No, and tell Codex what to do differently";

export function ApprovalRequestView({
  request,
  onRespond,
}: {
  request: CodexApprovalRequest;
  onRespond: (requestId: string, decision: CodexApprovalDecision) => Promise<void>;
}) {
  return (
    <div className="px-2.5">
      <div className="overflow-hidden rounded-lg border border-(--border) shadow-card-sm">
        <div className="bg-(--background-secondary) px-3 py-2">
          <div className="text-sm font-medium text-(--foreground)">{request.reason || "Approval required"}</div>
          {request.command && (
            <div className="mt-1.5 rounded-3xl border border-(--border) bg-(--background) px-2 py-1.5 font-mono text-xs text-(--foreground-secondary) inset-shadow-field">
              <span className="text-(--foreground-tertiary) select-none">$ </span>
              {request.command}
            </div>
          )}
          {request.cwd && <div className="mt-1 text-xs text-(--foreground-tertiary)">in {request.cwd}</div>}
        </div>
        <div className="flex items-center gap-1.5 border-t border-(--border) px-3 py-2">
          {(
            [
              { decision: "accept", label: "Accept", variant: "green" },
              { decision: "acceptForSession", label: "Accept all", variant: "blue" },
              { decision: "decline", label: "Decline", variant: "red" },
              { decision: "cancel", label: "Cancel", variant: "neutral" },
            ] as const
          ).map(({ decision, label, variant }) => (
            <button
              key={decision}
              type="button"
              className={cn(
                "h-6 rounded-3xl px-2.5 text-xs font-medium hover:opacity-80",
                variant === "green" && "bg-(--green-bg) text-(--green-text) shadow-[0_0_0_1px_var(--green-bg)]",
                variant === "blue" && "bg-(--blue-bg) text-(--blue-text) shadow-[0_0_0_1px_var(--blue-bg)]",
                variant === "red" && "bg-(--red-bg) text-(--red-text) shadow-[0_0_0_1px_var(--red-bg)]",
                variant === "neutral" && "bg-(--background-tertiary) text-(--foreground-secondary) shadow-[0_0_0_1px_var(--border)]",
              )}
              onClick={() => void onRespond(request.requestId, decision)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type UserInputComposerMode = "option" | "other";

interface UserInputComposerState {
  drafts: Record<string, string>;
  modes: Record<string, UserInputComposerMode>;
  selectedOptions: Record<string, string>;
}

type UserInputFocusTarget = "options" | "other" | "answer";

const USER_INPUT_FOCUS_TARGET_ATTRIBUTE = "data-user-input-focus-target";

function createInitialUserInputComposerState(
  request: RequestComposerRequest,
): UserInputComposerState {
  return request.questions.reduce<UserInputComposerState>(
    (acc, question) => {
      const firstOption = question.options?.[0]?.label ?? "";
      acc.drafts[question.id] = "";
      acc.modes[question.id] = question.options?.length ? "option" : "other";
      acc.selectedOptions[question.id] = firstOption;
      return acc;
    },
    {
      drafts: {},
      modes: {},
      selectedOptions: {},
    },
  );
}

function normalizeFreeformAnswer(value: string): string[] {
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function formatAskedQuestionLabel(count: number): string {
  if (count <= 0) return "Asked for input";
  return count === 1 ? "Asked 1 question" : `Asked ${count} questions`;
}

function resolveTranscriptAnswers(question: CodexUserInputQuestion, values: string[]): string[] {
  const normalizedValues = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalizedValues.length === 0) return [];
  if (!question.isSecret) return normalizedValues;
  return ["Hidden response"];
}

export function UserInputTranscriptView({
  item,
}: {
  item: Pick<CodexItemView, "status" | "userInputQuestions" | "userInputAnswers">;
}) {
  const questions = item.userInputQuestions ?? [];
  if (questions.length === 0) return null;

  const answersByQuestion = item.userInputAnswers ?? {};
  const hasAnyAnswer = questions.some((question) => (answersByQuestion[question.id]?.length ?? 0) > 0);
  if (!hasAnyAnswer) return null;

  return (
    <InlineToolToggle
      label={formatAskedQuestionLabel(questions.length)}
      leadingLabel="Asked"
      status={item.status}
    >
      <div className="flex flex-col gap-3 py-0.5">
        {questions.map((question) => {
          const answers = resolveTranscriptAnswers(question, answersByQuestion[question.id] ?? []);
          return (
            <div key={question.id} className="flex flex-col gap-1">
              <span className="text-sm/5 text-(--foreground-secondary)">{question.question}</span>
              <span className="text-sm/5 text-(--foreground-tertiary)">
                {answers.length > 0 ? answers.join(", ") : "No response"}
              </span>
            </div>
          );
        })}
      </div>
    </InlineToolToggle>
  );
}

export function buildUserInputAnswers(
  request: RequestComposerRequest,
  state: UserInputComposerState,
): Record<string, string[]> {
  return request.questions.reduce<Record<string, string[]>>((acc, question) => {
    const draft = state.drafts[question.id] ?? "";
    const selectedOption = state.selectedOptions[question.id] ?? question.options?.[0]?.label ?? "";
    const mode = state.modes[question.id] ?? (question.options?.length ? "option" : "other");

    if (!question.options?.length) {
      acc[question.id] = normalizeFreeformAnswer(draft);
      return acc;
    }

    if (mode === "other") {
      acc[question.id] = normalizeFreeformAnswer(draft);
      return acc;
    }

    acc[question.id] = selectedOption ? [selectedOption] : [];
    return acc;
  }, {});
}

export function isUserInputComposerSubmittable(
  request: RequestComposerRequest,
  state: UserInputComposerState,
): boolean {
  return request.questions.every((question) => {
    const answers = buildUserInputAnswers(
      { ...request, questions: [question] },
      state,
    )[question.id] ?? [];
    return answers.length > 0;
  });
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={cn("icon-2xs", className)} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        d="M10.6 9.70459C11.0142 9.70461 11.35 10.0404 11.35 10.4546V13.7876C11.35 14.2018 11.0142 14.5376 10.6 14.5376C10.1858 14.5376 9.84998 14.2018 9.84998 13.7876V10.4546C9.84998 10.0404 10.1858 9.70459 10.6 9.70459Z"
        fill="currentColor"
      />
      <path
        d="M10.6 6.2876C11.1292 6.28762 11.558 6.71732 11.558 7.24658C11.5578 7.77569 11.1291 8.20457 10.6 8.20459C10.0708 8.20459 9.64215 7.7757 9.64197 7.24658C9.64197 6.71731 10.0707 6.2876 10.6 6.2876Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.6 2.53955C14.9713 2.53955 18.515 6.08326 18.515 10.4546C18.515 14.8259 14.9713 18.3696 10.6 18.3696C6.22864 18.3696 2.68494 14.8259 2.68494 10.4546C2.68494 6.08326 6.22864 2.53955 10.6 2.53955ZM10.6 3.86963C6.96318 3.86963 4.01501 6.81779 4.01501 10.4546C4.01501 14.0914 6.96318 17.0396 10.6 17.0396C14.2368 17.0396 17.1849 14.0914 17.1849 10.4546C17.1849 6.81779 14.2368 3.86963 10.6 3.86963Z"
        fill="currentColor"
      />
    </svg>
  );
}

function resolveOtherPromptLabel(question: RequestComposerQuestion): string {
  if (question.otherPlaceholder) return question.otherPlaceholder;
  if (!question.options?.length) {
    return "Type your answer";
  }
  return "Tell Codex what to do differently";
}

function resolveUserInputFocusTargetFromElement(element: Element | null): UserInputFocusTarget | null {
  if (typeof Element === "undefined" || !(element instanceof Element)) return null;

  const target = element.closest(`[${USER_INPUT_FOCUS_TARGET_ATTRIBUTE}]`)?.getAttribute(USER_INPUT_FOCUS_TARGET_ATTRIBUTE);
  if (target === "options" || target === "other" || target === "answer") {
    return target;
  }

  return null;
}

export function resolveUserInputQuestionFocusTarget(
  question: RequestComposerQuestion,
  target: UserInputFocusTarget | null,
): UserInputFocusTarget | null {
  if (target === null) return null;

  if (!question.options?.length) {
    return "answer";
  }

  if (target === "other" || target === "answer") {
    return "other";
  }

  return "options";
}

export function canMoveUserInputFocusToOptionsFromOtherField(
  selectionStart: number | null,
  selectionEnd: number | null,
): boolean {
  if (selectionStart === null || selectionEnd === null) return false;
  return selectionStart === 0 && selectionEnd === 0;
}

function ArrowKeysIndicator({ visible, canGoUp, canGoDown }: { visible: boolean; canGoUp: boolean; canGoDown: boolean }) {
  const arrowPath = "M9.33467 16.6663V4.93978L4.6374 9.63704L4.1667 9.16634L3.69599 8.69661L9.52998 2.86263L9.63447 2.77767C9.8925 2.60753 10.2433 2.63564 10.4704 2.86263L16.3034 8.69661L16.3884 8.80111C16.5588 9.05922 16.5306 9.40982 16.3034 9.63704C16.0762 9.86414 15.7255 9.89242 15.4675 9.722L15.363 9.63704L10.6647 4.9388V16.6663C10.6647 17.0336 10.367 17.3314 9.99971 17.3314C9.63259 17.3312 9.33467 17.0335 9.33467 16.6663ZM4.6374 9.63704C4.3777 9.89674 3.95569 9.89674 3.69599 9.63704C3.43657 9.37744 3.43668 8.95628 3.69599 8.69661L4.6374 9.63704Z";
  return (
    <div
      className={cn(
        "ml-auto flex items-center gap-2 text-xs text-(--foreground-tertiary)",
        !visible && "invisible",
      )}
      aria-hidden={!visible}
    >
      <span className="flex items-center gap-0.5">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={cn(
          "size-3",
          canGoUp ? "text-(--foreground-tertiary)" : "text-(--foreground-tertiary)/20",
        )}>
          <path d={arrowPath} fill="currentColor" />
        </svg>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className={cn(
          "size-3 rotate-180",
          canGoDown ? "text-(--foreground-tertiary)" : "text-(--foreground-tertiary)/20",
        )}>
          <path d={arrowPath} fill="currentColor" />
        </svg>
      </span>
    </div>
  );
}

function resolveUserInputTextareaMaxHeightPx(): number {
  return USER_INPUT_TEXTAREA_MAX_HEIGHT_PX;
}

function AutoSizingTextarea({
  value,
  className,
  textareaRef,
  ...props
}: React.ComponentProps<"textarea"> & { textareaRef?: (element: HTMLTextAreaElement | null) => void }) {
  const innerTextareaRef = useRef<HTMLTextAreaElement>(null);

  const setTextareaRef = useCallback((element: HTMLTextAreaElement | null) => {
    innerTextareaRef.current = element;
    textareaRef?.(element);
  }, [textareaRef]);

  const resizeTextarea = useCallback(() => {
    const textarea = innerTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";

    const { heightPx, hasOverflow } = resolvePromptTextareaSize({
      scrollHeight: textarea.scrollHeight,
      maxHeightPx: resolveUserInputTextareaMaxHeightPx(),
    });

    if (heightPx <= 0) {
      textarea.style.height = "";
      textarea.style.overflowY = "hidden";
      return;
    }

    textarea.style.height = `${heightPx}px`;
    textarea.style.overflowY = hasOverflow ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, value]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      resizeTextarea();
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [resizeTextarea]);

  return (
    <textarea
      {...props}
      ref={setTextareaRef}
      value={value}
      rows={1}
      className={className}
    />
  );
}

function UserInputQuestionSection({
  question,
  state,
  busy,
  optionsRef,
  otherTextareaRef,
  answerInputRef,
  onOptionSelect,
  onDraftChange,
  onOtherFocus,
  onKeyDown,
  onNavigateQuestion,
  actionButtons,
}: {
  question: RequestComposerQuestion;
  state: UserInputComposerState;
  busy: boolean;
  optionsRef: React.RefObject<HTMLDivElement | null>;
  otherTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  answerInputRef: React.RefObject<HTMLInputElement | null>;
  onOptionSelect: (questionId: string, optionLabel: string) => void;
  onDraftChange: (questionId: string, value: string) => void;
  onOtherFocus: (questionId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onNavigateQuestion?: (direction: "prev" | "next") => void;
  actionButtons: React.ReactNode;
}) {
  const selectedOption = state.selectedOptions[question.id] ?? question.options?.[0]?.label ?? "";
  const mode = state.modes[question.id] ?? (question.options?.length ? "option" : "other");
  const otherLabel = resolveOtherPromptLabel(question);
  const canMoveIntoOtherAnswer = Boolean(question.options?.length);

  const handleRadioGroupKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      onNavigateQuestion?.(event.key === "ArrowLeft" ? "prev" : "next");
      return;
    }

    const options = question.options;
    if (!options?.length || mode !== "option") return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

    event.preventDefault();
    const currentIndex = options.findIndex((o) => o.label === selectedOption);
    if (currentIndex < 0) return;

    const nextIndex = event.key === "ArrowUp"
      ? Math.max(0, currentIndex - 1)
      : Math.min(options.length - 1, currentIndex + 1);
    if (nextIndex !== currentIndex) {
      onOptionSelect(question.id, options[nextIndex]!.label);
      return;
    }

    if (event.key === "ArrowDown") {
      onOtherFocus(question.id);
      otherTextareaRef.current?.focus({ preventScroll: true });
    }
  }, [question.id, question.options, mode, selectedOption, onOptionSelect, onOtherFocus, onNavigateQuestion, otherTextareaRef]);

  const handleOtherTextareaKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "ArrowUp"
      && canMoveUserInputFocusToOptionsFromOtherField(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
      && question.options?.length
    ) {
      event.preventDefault();
      const nextOptionLabel = selectedOption || question.options[question.options.length - 1]!.label;
      onOptionSelect(question.id, nextOptionLabel);
      optionsRef.current?.focus({ preventScroll: true });
      return;
    }

    onKeyDown(event);
  }, [onKeyDown, onOptionSelect, optionsRef, question.id, question.options, selectedOption]);

  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="flex flex-col gap-1 px-2">
        {question.options?.length ? (
          <>
            <div
              ref={optionsRef}
              className="flex flex-col gap-1 rounded-xl outline-none"
              role="radiogroup"
              aria-label={question.question || question.header}
              tabIndex={0}
              data-user-input-focus-target="options"
              onKeyDown={handleRadioGroupKeyDown}
            >
              {question.options.map((option, index) => {
                const isSelected = mode === "option" && selectedOption === option.label;
                return (
                  <button
                    key={option.label}
                    type="button"
                    role="radio"
                    tabIndex={-1}
                    aria-checked={isSelected}
                    aria-label={option.label}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-xl p-2 text-left text-sm transition-colors duration-100 focus:outline-none",
                      isSelected
                        ? "bg-foreground-5"
                        : "bg-transparent hover:bg-foreground-5",
                    )}
                    disabled={busy}
                    onClick={() => {
                      onOptionSelect(question.id, option.label);
                      optionsRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <span className={cn("text-sm", isSelected ? "text-(--foreground-tertiary)" : `text-(--foreground-tertiary)/60`)}>
                      {index + 1}.
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate">{option.label}</span>
                          {option.description && (
                            <Tooltip
                              content={option.description}
                              side="top"
                              delayDuration={0}
                              disableAnimation
                              contentClassName="max-w-64"
                            >
                              <span
                                aria-label={`About ${option.label}`}
                                title={option.description}
                                className="inline-flex shrink-0 items-center text-(--foreground-tertiary) transition-colors duration-100 hover:text-(--foreground-secondary)"
                                onClick={(event) => {
                                  event.stopPropagation();
                                }}
                              >
                                <InfoIcon />
                              </span>
                            </Tooltip>
                          )}
                        </span>
                      </span>
                    </span>
                    <ArrowKeysIndicator
                      visible={isSelected}
                      canGoUp={index > 0}
                      canGoDown={index < question.options!.length - 1 || (canMoveIntoOtherAnswer && index === question.options!.length - 1)}
                    />
                  </button>
                );
              })}
            </div>

            <div className="-mt-1 flex items-end justify-between gap-2">
              <div
                className={cn(
                  "group flex min-w-0 flex-1 items-start gap-2 rounded-xl px-2 py-1 text-sm focus-within:outline-none",
                )}
              >
                <span className="min-w-[1.5ch] pt-0.5 text-left text-(--foreground-tertiary)/60 group-focus-within:text-(--foreground-tertiary)/70">
                  {question.options.length + 1}.
                </span>
                <span className="relative min-w-0 flex-1 py-0.5">
                  {!state.drafts[question.id] && (
                    <span className="pointer-events-none absolute inset-x-0 top-0.5 truncate text-sm/5 text-(--foreground-tertiary)">
                      {otherLabel}
                    </span>
                  )}
                  <AutoSizingTextarea
                    textareaRef={(element) => {
                      otherTextareaRef.current = element;
                    }}
                    value={state.drafts[question.id] ?? ""}
                    disabled={busy}
                    onFocus={() => onOtherFocus(question.id)}
                    onChange={(event) => onDraftChange(question.id, event.target.value)}
                    onKeyDown={handleOtherTextareaKeyDown}
                    placeholder={otherLabel}
                    data-user-input-focus-target="other"
                    className="w-full min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-sm/5 text-(--foreground) shadow-none outline-none placeholder:text-transparent"
                  />
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2 place-self-end py-1">
                {actionButtons}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              ref={answerInputRef}
              type={question.isSecret ? "password" : "text"}
              value={state.drafts[question.id] ?? ""}
              onChange={(event) => onDraftChange(question.id, event.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
              placeholder="Type your answer"
              data-user-input-focus-target="answer"
              className="h-10 w-full rounded-xl border border-[color-mix(in_srgb,var(--border)_85%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_2%,transparent)] px-3 text-sm text-(--foreground) transition-colors duration-100 outline-none placeholder:text-(--foreground-tertiary) focus-visible:border-(--ring)"
            />
            <div className="flex items-center justify-end gap-2 py-1">
              {actionButtons}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronIcon({ direction, className }: { direction: "prev" | "next"; className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(
        "size-4",
        direction === "prev" ? "rotate-90" : "-rotate-90",
        className,
      )}
      aria-hidden
    >
      <path
        d="M15.2793 7.71101C15.539 7.45131 15.961 7.45131 16.2207 7.71101C16.4804 7.97071 16.4804 8.39272 16.2207 8.65242L10.4707 14.4024C10.211 14.6621 9.78902 14.6621 9.52932 14.4024L3.77932 8.65242L3.69436 8.54792C3.52385 8.28979 3.55205 7.93828 3.77932 7.71101C4.00659 7.48374 4.3581 7.45554 4.61623 7.62605L4.72073 7.71101L10 12.9903L15.2793 7.71101Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.6"
      />
    </svg>
  );
}

function RequestComposerView({
  request,
  onSubmit,
  onDismiss,
  submitErrorMessage,
  dismissErrorMessage,
}: {
  request: RequestComposerRequest;
  onSubmit: (request: RequestComposerRequest, state: UserInputComposerState) => Promise<void>;
  onDismiss: (request: RequestComposerRequest) => Promise<void>;
  submitErrorMessage: string;
  dismissErrorMessage: string;
}) {
  const [busyAction, setBusyAction] = useState<"dismiss" | "submit" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const optionsRef = useRef<HTMLDivElement>(null);
  const otherTextareaRef = useRef<HTMLTextAreaElement>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const pendingFocusTargetRef = useRef<UserInputFocusTarget | null>(null);
  const form = useForm({
    defaultValues: createInitialUserInputComposerState(request),
    onSubmit: async ({ value }) => {
      if (!isUserInputComposerSubmittable(request, value)) return;

      setBusyAction("submit");
      setErrorMessage(null);
      try {
        await onSubmit(request, value);
      } catch (error) {
        setErrorMessage(resolveFormErrorMessage(error) ?? submitErrorMessage);
      } finally {
        setBusyAction(null);
      }
    },
  });
  const state = useStore(form.store, (formState) => formState.values);

  const isMultiQuestion = request.questions.length > 1;
  const question = request.questions[currentIndex]!;

  useEffect(() => {
    form.reset(createInitialUserInputComposerState(request));
    setBusyAction(null);
    setErrorMessage(null);
    setCurrentIndex(0);
  }, [form, request]);

  useLayoutEffect(() => {
    const pendingFocusTarget = pendingFocusTargetRef.current;
    if (pendingFocusTarget === null) return;

    pendingFocusTargetRef.current = null;

    const nextFocusTarget = resolveUserInputQuestionFocusTarget(question, pendingFocusTarget);
    if (nextFocusTarget === null) return;

    const nextElement = nextFocusTarget === "options"
      ? optionsRef.current
      : nextFocusTarget === "other"
        ? otherTextareaRef.current
        : answerInputRef.current;
    if (!nextElement) return;

    nextElement.focus({ preventScroll: true });
  }, [currentIndex, question]);

  const navigateQuestion = useCallback((
    nextIndex: number,
    options?: { preserveInputFocus?: boolean },
  ) => {
    const boundedIndex = Math.max(0, Math.min(request.questions.length - 1, nextIndex));
    if (boundedIndex === currentIndex) return;

    pendingFocusTargetRef.current = options?.preserveInputFocus
      ? resolveUserInputFocusTargetFromElement(typeof document === "undefined" ? null : document.activeElement)
      : null;
    setCurrentIndex(boundedIndex);
  }, [currentIndex, request.questions.length]);

  const updateDraft = useCallback((questionId: string, value: string) => {
    form.setFieldValue(`drafts.${questionId}` as never, value as never);
    form.setFieldValue(`modes.${questionId}` as never, "other" as never);
  }, [form]);

  const selectOption = useCallback((questionId: string, optionLabel: string) => {
    form.setFieldValue(`modes.${questionId}` as never, "option" as never);
    form.setFieldValue(`selectedOptions.${questionId}` as never, optionLabel as never);
  }, [form]);

  const activateOther = useCallback((questionId: string) => {
    form.setFieldValue(`modes.${questionId}` as never, "other" as never);
  }, [form]);

  const canSubmit = isUserInputComposerSubmittable(request, state);
  const isBusy = busyAction !== null;

  const handleDismiss = useCallback(async () => {
    setBusyAction("dismiss");
    setErrorMessage(null);
    try {
      await onDismiss(request);
    } catch (error) {
      setErrorMessage(resolveFormErrorMessage(error) ?? dismissErrorMessage);
    } finally {
      setBusyAction(null);
    }
  }, [dismissErrorMessage, onDismiss, request]);

  const isLastQuestion = !isMultiQuestion || currentIndex === request.questions.length - 1;

  const handlePrimaryAction = useCallback(() => {
    if (isLastQuestion) {
      void form.handleSubmit();
      return;
    }

    navigateQuestion(currentIndex + 1, { preserveInputFocus: true });
  }, [currentIndex, form, isLastQuestion, navigateQuestion]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void handleDismiss();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    handlePrimaryAction();
  }, [handleDismiss, handlePrimaryAction]);

  const primaryLabel = busyAction === "submit" ? "Submitting" : isLastQuestion ? "Submit" : "Continue";

  const actionButtons = (
    <>
      <button
        type="button"
        className="group inline-flex shrink-0 items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-sm/4.5 text-token-description-foreground hover:bg-token-foreground/5 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => void handleDismiss()}
        disabled={isBusy}
      >
        <span className="text-sm text-token-description-foreground">Dismiss</span>
        <span className="inline-flex items-center rounded-sm bg-token-foreground/10 px-2 py-1 text-[10px] leading-none text-token-foreground group-hover:bg-token-foreground/15">
          <span className="font-mono">ESC</span>
        </span>
      </button>
      <button
        type={isLastQuestion ? "submit" : "button"}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-transparent bg-token-text-link-foreground px-2 py-0 text-sm/4.5 text-token-dropdown-background hover:bg-token-text-link-foreground/90 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        onClick={isLastQuestion ? undefined : () => void handlePrimaryAction()}
        disabled={isLastQuestion ? (!canSubmit || isBusy) : false}
      >
        <span className="text-sm font-medium">{primaryLabel}</span>
        <span className="inline-flex items-center rounded-sm bg-token-dropdown-background/15 px-1.5 py-px text-sm leading-none text-token-dropdown-background">
          <span className="font-mono">⏎</span>
        </span>
      </button>
    </>
  );

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => handleFormSubmit(event, form.handleSubmit)}
    >
      <div className="flex flex-col overflow-hidden rounded-3xl border border-[color-mix(in_srgb,var(--border)_85%,transparent)] bg-token-input-background shadow-sm">
        {(question.header || question.question) && (
          <div className="flex items-center justify-between pt-4 pr-3 pb-2 pl-4">
            <div className="text-base font-medium text-(--foreground)">
              {question.question || question.header}
            </div>
            {isMultiQuestion && (
              <div className="flex shrink-0 items-center gap-1 text-xs text-(--foreground-tertiary)">
                <button
                  type="button"
                  className="flex size-5 items-center justify-center rounded-full text-(--foreground-tertiary) transition-colors duration-100 hover:bg-foreground-5 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={currentIndex === 0}
                  onClick={() => navigateQuestion(currentIndex - 1)}
                  aria-label="Previous question"
                >
                  <ChevronIcon direction="prev" />
                </button>
                <span className="tabular-nums">{currentIndex + 1} of {request.questions.length}</span>
                <button
                  type="button"
                  className="flex size-5 items-center justify-center rounded-full text-(--foreground-tertiary) transition-colors duration-100 hover:bg-foreground-5 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={currentIndex === request.questions.length - 1}
                  onClick={() => navigateQuestion(currentIndex + 1)}
                  aria-label="Next question"
                >
                  <ChevronIcon direction="next" />
                </button>
              </div>
            )}
          </div>
        )}
        <UserInputQuestionSection
          question={question}
          state={state}
          busy={isBusy}
          optionsRef={optionsRef}
          otherTextareaRef={otherTextareaRef}
          answerInputRef={answerInputRef}
          onOptionSelect={selectOption}
          onDraftChange={updateDraft}
          onOtherFocus={activateOther}
          onKeyDown={handleKeyDown}
          onNavigateQuestion={isMultiQuestion ? (direction) => {
            navigateQuestion(
              direction === "prev" ? currentIndex - 1 : currentIndex + 1,
              { preserveInputFocus: true },
            );
          } : undefined}
          actionButtons={actionButtons}
        />

        {errorMessage && (
          <div className="px-3 pb-2 text-xs text-(--destructive)">{errorMessage}</div>
        )}
      </div>
    </form>
  );
}

export function UserInputComposerView({
  request,
  onRespond,
}: {
  request: CodexUserInputRequest;
  onRespond: (requestId: string, answers: Record<string, string[]>) => Promise<void>;
}) {
  return (
    <RequestComposerView
      request={request}
      onSubmit={async (nextRequest, state) => {
        await onRespond(nextRequest.requestId, buildUserInputAnswers(nextRequest, state));
      }}
      onDismiss={async (nextRequest) => {
        await onRespond(nextRequest.requestId, {});
      }}
      submitErrorMessage="Could not submit input request"
      dismissErrorMessage="Could not dismiss input request"
    />
  );
}

export type PlanImplementationComposerResponse =
  | { type: "dismiss" }
  | { type: "implement" }
  | { type: "followUp"; prompt: string };

function buildPlanImplementationComposerRequest(
  request: CodexPlanImplementationRequest,
): RequestComposerRequest {
  return {
    requestId: request.requestId,
    questions: [
      {
        id: PLAN_IMPLEMENTATION_QUESTION_ID,
        header: PLAN_IMPLEMENTATION_PROMPT,
        question: PLAN_IMPLEMENTATION_PROMPT,
        isOther: true,
        isSecret: false,
        otherPlaceholder: PLAN_IMPLEMENTATION_OTHER_PLACEHOLDER,
        options: [
          {
            label: PLAN_IMPLEMENTATION_OPTION_LABEL,
            description: "",
          },
        ],
      },
    ],
  };
}

export function PlanImplementationComposerView({
  request,
  onRespond,
}: {
  request: CodexPlanImplementationRequest;
  onRespond: (response: PlanImplementationComposerResponse) => Promise<void>;
}) {
  const composerRequest = useMemo(
    () => buildPlanImplementationComposerRequest(request),
    [request.requestId],
  );

  return (
    <RequestComposerView
      request={composerRequest}
      onSubmit={async (nextRequest, state) => {
        const answer = buildUserInputAnswers(nextRequest, state)[PLAN_IMPLEMENTATION_QUESTION_ID]?.[0]?.trim() ?? "";
        if (!answer) return;
        if (answer === PLAN_IMPLEMENTATION_OPTION_LABEL) {
          await onRespond({ type: "implement" });
          return;
        }
        await onRespond({ type: "followUp", prompt: answer });
      }}
      onDismiss={async () => {
        await onRespond({ type: "dismiss" });
      }}
      submitErrorMessage="Could not submit plan implementation request"
      dismissErrorMessage="Could not dismiss plan implementation request"
    />
  );
}
