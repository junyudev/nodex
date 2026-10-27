import { QuestionDictationButton } from "../../composer/question-dictation-button";
import { QUESTION_OUTLINE_ACTION_COLORS } from "../../composer/question-action-colors";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import {
  BackIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  EditIcon,
} from "@/components/shared/icons";
import { resolveFormErrorMessage } from "../../../../../lib/forms";
import { cn } from "../../../../../lib/utils";
import type { CodexTranscriptEntry, CodexUserInputRequest } from "../../../../../lib/types";
import { buildCodexCanonicalRequestIdentityKey } from "../../../../../../shared/codex-conversation-state/codex-conversation-state";
import { resolvePromptTextareaSize } from "../prompt-textarea-size";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "../thread-motion";
import { useMeasuredElementHeight } from "../use-measured-element-height";
import { CodexShimmerText } from "../codex-shimmer-text";
import {
  EXPLICIT_REQUEST_FORM_POLICY,
  activateRequestQuestionnaireOther,
  buildRequestQuestionSignature,
  clearCurrentRequestQuestionnaireAnswer,
  isLastRequestQuestion,
  isRequestQuestionnaireSubmittable,
  navigateRequestQuestionnaire,
  reconcileRequestQuestionnaireDraft,
  selectRequestQuestionnaireOption,
  setRequestQuestionnaireFreeform,
  type RequestComposerQuestion,
  type RequestComposerRequest,
  type RequestQuestionnaireDraft,
  type RequestQuestionnairePolicy,
} from "./request-card-questionnaire-state";
import {
  canMoveUserInputFocusToOptionsFromOtherField,
  resolveUserInputQuestionFocusTarget,
  type UserInputFocusTarget,
} from "./request-card-focus";

type CodexUserInputQuestion = CodexUserInputRequest["questions"][number];
const USER_INPUT_TEXTAREA_MAX_HEIGHT_PX = 160;

const USER_INPUT_FOCUS_TARGET_ATTRIBUTE = "data-user-input-focus-target";

export {
  EXPLICIT_REQUEST_FORM_POLICY,
  REQUEST_INPUT_COMPOSER_POLICY,
  SETUP_TASK_FORM_POLICY,
  buildRequestQuestionSignature,
  buildUserInputAnswers,
  createInitialRequestQuestionnaireDraft,
  getRequestQuestionnaireAnswer,
  isRequestQuestionnaireSubmittable,
} from "./request-card-questionnaire-state";
export type {
  RequestComposerQuestion,
  RequestComposerRequest,
  RequestQuestionnaireDraft,
  RequestQuestionnairePolicy,
} from "./request-card-questionnaire-state";

function resolveTranscriptAnswers(question: CodexUserInputQuestion, values: string[]): string[] {
  const normalizedValues = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalizedValues.length === 0) return [];
  if (!question.isSecret) return normalizedValues;
  return ["Hidden response"];
}

type UserInputTranscriptItem = Pick<
  CodexTranscriptEntry,
  "userInputQuestions" | "userInputAnswers"
> & {
  status?: CodexTranscriptEntry["status"];
};

export function UserInputTranscriptView({ item }: { item: UserInputTranscriptItem }) {
  const questions = item.userInputQuestions ?? [];
  const answersByQuestion = item.userInputAnswers ?? {};
  const completed = item.status !== "inProgress";
  const canExpand = completed && questions.length > 0;
  const [expanded, setExpanded] = useState(false);
  const { elementHeightPx, elementRef } = useMeasuredElementHeight();

  if (!completed) {
    return (
      <div className="min-w-0 text-size-chat relative overflow-visible py-0">
        <CodexShimmerText className="text-size-chat select-none truncate text-token-foreground/30">
          Asking {questions.length === 1 ? "1 question" : `${questions.length} questions`}
        </CodexShimmerText>
      </div>
    );
  }

  const summary = (
    <div
      className={cn(
        "group flex min-w-0 items-center gap-1.5 text-left",
        canExpand ? "cursor-interaction" : "cursor-default",
      )}
    >
      <span className="truncate">
        <span className="text-token-description-foreground/90 group-hover:text-token-foreground">
          Asked
        </span>
        <span className="text-token-foreground/40 group-hover:text-token-foreground">
          {" "}
          {questions.length === 1 ? "1 question" : `${questions.length} questions`}
        </span>
      </span>
      {canExpand ? (
        <ChevronRightIcon
          className={cn(
            "text-token-input-placeholder-foreground flex-shrink-0 transition-all duration-300 opacity-0 group-hover:opacity-100",
            expanded && "opacity-100 rotate-90",
          )}
        />
      ) : null}
    </div>
  );

  return (
    <div className="min-w-0 text-size-chat relative overflow-visible py-0">
      <div className="flex flex-col">
        {canExpand ? (
          <button
            type="button"
            className="text-left"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((current) => !current);
            }}
          >
            {summary}
          </button>
        ) : (
          summary
        )}
        <motion.div
          initial={false}
          animate={{
            height: canExpand && expanded ? elementHeightPx : 0,
            opacity: canExpand && expanded ? 1 : 0,
          }}
          transition={CODEX_THREAD_ACCORDION_TRANSITION}
          className={cn(canExpand && expanded ? "overflow-visible" : "overflow-hidden")}
          data-thread-find-skip={canExpand && expanded ? undefined : true}
          style={{
            pointerEvents: canExpand && expanded ? "auto" : "none",
          }}
        >
          <div ref={elementRef} className="flex flex-col gap-3 pt-1 pb-0.5">
            {questions.map((question) => {
              const answers = resolveTranscriptAnswers(
                question,
                answersByQuestion[question.id] ?? [],
              );
              return (
                <div key={question.id} className="flex flex-col gap-1">
                  <span className="text-size-chat text-token-foreground/60">
                    {question.question}
                  </span>
                  <span className="text-size-chat text-token-foreground/30">
                    {answers.length > 0 ? answers.join(", ") : "No answer provided"}
                  </span>
                </div>
              );
            })}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function resolveOtherPromptLabel(question: RequestComposerQuestion): string {
  if (question.otherPlaceholder) return question.otherPlaceholder;
  if (!question.options?.length) {
    return "Type your answer";
  }
  return "Or write your own response";
}

function resolveUserInputFocusTargetFromElement(
  element: Element | null,
): UserInputFocusTarget | null {
  if (typeof Element === "undefined" || !(element instanceof Element)) return null;

  const target = element
    .closest(`[${USER_INPUT_FOCUS_TARGET_ATTRIBUTE}]`)
    ?.getAttribute(USER_INPUT_FOCUS_TARGET_ATTRIBUTE);
  if (target === "options" || target === "other" || target === "answer") {
    return target;
  }

  return null;
}

function ArrowKeysIndicator({
  visible,
  canGoUp,
  canGoDown,
}: {
  visible: boolean;
  canGoUp: boolean;
  canGoDown: boolean;
}) {
  const arrowPath =
    "M9.33467 16.6663V4.93978L4.6374 9.63704L4.1667 9.16634L3.69599 8.69661L9.52998 2.86263L9.63447 2.77767C9.8925 2.60753 10.2433 2.63564 10.4704 2.86263L16.3034 8.69661L16.3884 8.80111C16.5588 9.05922 16.5306 9.40982 16.3034 9.63704C16.0762 9.86414 15.7255 9.89242 15.4675 9.722L15.363 9.63704L10.6647 4.9388V16.6663C10.6647 17.0336 10.367 17.3314 9.99971 17.3314C9.63259 17.3312 9.33467 17.0335 9.33467 16.6663ZM4.6374 9.63704C4.3777 9.89674 3.95569 9.89674 3.69599 9.63704C3.43657 9.37744 3.43668 8.95628 3.69599 8.69661L4.6374 9.63704Z";
  return (
    <div
      className={cn(
        "ml-auto flex items-center gap-2 text-xs text-(--foreground-tertiary)",
        !visible && "invisible",
      )}
      aria-hidden={!visible}
    >
      <span className="flex items-center gap-0.5">
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={cn(
            "size-3",
            canGoUp ? "text-(--foreground-tertiary)" : "text-(--foreground-tertiary)/20",
          )}
        >
          <path d={arrowPath} fill="currentColor" />
        </svg>
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={cn(
            "size-3 rotate-180",
            canGoDown ? "text-(--foreground-tertiary)" : "text-(--foreground-tertiary)/20",
          )}
        >
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
}: React.ComponentProps<"textarea"> & {
  textareaRef?: (element: HTMLTextAreaElement | null) => void;
}) {
  const innerTextareaRef = useRef<HTMLTextAreaElement>(null);

  const setTextareaRef = (element: HTMLTextAreaElement | null) => {
    innerTextareaRef.current = element;
    textareaRef?.(element);
  };

  const resizeTextarea = useEffectEvent(() => {
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
  });

  useLayoutEffect(() => {
    resizeTextarea();
  }, [value]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      resizeTextarea();
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return <textarea {...props} ref={setTextareaRef} value={value} rows={1} className={className} />;
}

function UserInputQuestionSection({
  question,
  answer,
  busy,
  advancingChoiceId,
  presentation,
  optionsRef,
  otherTextareaRef,
  answerInputRef,
  onOptionSelect,
  onOptionActivate,
  onDraftChange,
  onDictationChange,
  onDictationInteraction,
  onOtherFocus,
  onKeyDown,
  actionButtons,
  showInlineOtherComposer,
}: {
  question: RequestComposerQuestion;
  answer: {
    selectedOptionIds?: string[];
    selectedOptionId: string | null;
    freeformText: string | null;
  };
  busy: boolean;
  advancingChoiceId: string | null;
  presentation: RequestQuestionnairePolicy["presentation"];
  optionsRef: React.RefObject<HTMLDivElement | null>;
  otherTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  answerInputRef: React.RefObject<HTMLInputElement | null>;
  onOptionSelect: (optionLabel: string) => void;
  onOptionActivate: (optionLabel: string) => void;
  onDraftChange: (value: string) => void;
  onDictationChange: (value: string) => void;
  onDictationInteraction?: () => void;
  onOtherFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  actionButtons: React.ReactNode;
  showInlineOtherComposer: boolean;
}) {
  const selectedOption = answer.selectedOptionId;
  const mode = selectedOption === null ? "other" : "option";
  const otherLabel = resolveOtherPromptLabel(question);
  const canMoveIntoOtherAnswer = showInlineOtherComposer;

  const handleOtherTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "ArrowUp" &&
      canMoveUserInputFocusToOptionsFromOtherField(
        event.currentTarget.selectionStart,
        event.currentTarget.selectionEnd,
      ) &&
      question.options?.length
    ) {
      event.preventDefault();
      const nextOptionLabel =
        selectedOption ?? question.options[question.options.length - 1]!.label;
      onOptionSelect(nextOptionLabel);
      const nextOption = optionsRef.current?.querySelector<HTMLButtonElement>(
        `[data-request-option-label="${CSS.escape(nextOptionLabel)}"]`,
      );
      nextOption?.focus({ preventScroll: true });
      return;
    }

    onKeyDown(event);
  };

  return (
    <div className={cn("flex flex-col gap-3", presentation === "composer" ? "pt-1 pb-2" : "py-1")}>
      <div className="flex flex-col gap-1 px-2">
        {question.options?.length ? (
          <>
            <div
              ref={optionsRef}
              className="flex flex-col gap-1 rounded-xl outline-none"
              role={question.multiSelect ? "group" : "radiogroup"}
              aria-label={question.question || question.header}
              data-user-input-focus-target="options"
            >
              {question.options.map((option, index) => {
                const isSelected = question.multiSelect
                  ? answer.selectedOptionIds?.includes(option.label) === true
                  : mode === "option" && selectedOption === option.label;
                const isAdvancing = advancingChoiceId === option.label;
                const recommended = option.label.endsWith(" (Recommended)");
                const descriptionId = option.description
                  ? `request-option-${question.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${index}-description`
                  : undefined;
                return (
                  <button
                    key={option.label}
                    type="button"
                    role={question.multiSelect ? "checkbox" : "radio"}
                    tabIndex={isSelected || (selectedOption === null && index === 0) ? 0 : -1}
                    aria-checked={isSelected}
                    aria-label={option.label}
                    aria-describedby={descriptionId}
                    data-request-option-label={option.label}
                    className={cn(
                      "group flex min-h-8 w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border",

                      isSelected || isAdvancing ? "bg-text/5" : "bg-transparent hover:bg-text/5",
                    )}
                    disabled={busy}
                    onClick={() => {
                      onOptionActivate(option.label);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-5 shrink-0 self-start items-center justify-center rounded-xs border text-xs leading-none font-medium",
                        isAdvancing && presentation === "composer"
                          ? "border-text bg-primary-solid text-primary-solid"
                          : "border-default bg-text/5 text-token-description-foreground",
                      )}
                    >
                      {question.options!.length > 1 ? (
                        index + 1
                      ) : isAdvancing && presentation === "composer" ? (
                        <span className="size-1.5 rounded-full bg-current" aria-hidden />
                      ) : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 @max-5xl/request-card:flex-col @max-5xl/request-card:items-stretch">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 text-sm font-medium wrap-anywhere">
                          {recommended ? option.label.slice(0, -14) : option.label}
                        </span>
                        {recommended ? (
                          <span className="shrink-0 rounded-sm bg-text/5 px-2 py-1 text-xs leading-none text-token-description-foreground">
                            Recommended
                          </span>
                        ) : null}
                      </span>
                      {option.description ? (
                        <span
                          id={descriptionId}
                          className="text-sm text-token-description-foreground"
                        >
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {presentation === "composer" ? (
                      <BackIcon
                        className={cn(
                          "icon-xs ml-auto shrink-0 self-center rotate-180 text-token-description-foreground",
                          isSelected || isAdvancing
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                        aria-hidden
                      />
                    ) : (
                      <ArrowKeysIndicator
                        visible={isSelected}
                        canGoUp={index > 0}
                        canGoDown={
                          index < question.options!.length - 1 ||
                          (canMoveIntoOtherAnswer && index === question.options!.length - 1)
                        }
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div
              className={cn(
                "flex items-center gap-2",
                showInlineOtherComposer ? "justify-between" : "justify-end",
              )}
            >
              {showInlineOtherComposer ? (
                <div className="group flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1 text-sm focus-within:outline-none">
                  <span className="flex size-5 shrink-0 items-center justify-center text-token-description-foreground">
                    <EditIcon className="icon-xs" />
                  </span>
                  <span className="relative min-w-0 flex-1 py-0.5">
                    {!answer.freeformText ? (
                      <span className="pointer-events-none absolute inset-x-0 top-0.5 truncate text-base leading-[1.35] text-token-input-placeholder-foreground opacity-50">
                        {otherLabel}
                      </span>
                    ) : null}
                    <AutoSizingTextarea
                      textareaRef={(element) => {
                        otherTextareaRef.current = element;
                      }}
                      aria-label={question.question || question.header}
                      aria-required={question.required || undefined}
                      value={answer.freeformText ?? ""}
                      disabled={busy}
                      onFocus={onOtherFocus}
                      onChange={(event) => onDraftChange(event.target.value)}
                      onKeyDown={handleOtherTextareaKeyDown}
                      placeholder={otherLabel}
                      data-user-input-focus-target="other"
                      className="request-input-panel__inline-freeform w-full min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-base leading-[1.35] text-token-foreground shadow-none outline-none placeholder:text-transparent"
                    />
                  </span>
                </div>
              ) : null}
              <div
                className={cn(
                  "flex shrink-0 items-center gap-2 place-self-end",
                  presentation === "composer" ? "py-1.5" : "py-1",
                )}
              >
                {question.isOther ? (
                  <QuestionDictationButton
                    id={question.id}
                    value={answer.freeformText ?? ""}
                    onChange={onDictationChange}
                    onInteraction={onDictationInteraction}
                    disabled={busy}
                    isSecret={question.isSecret}
                  />
                ) : null}
                {actionButtons}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              ref={answerInputRef}
              type={question.isSecret ? "password" : "text"}
              aria-label={question.question || question.header}
              aria-required={question.required || undefined}
              value={answer.freeformText ?? ""}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
              placeholder="Type your answer"
              data-user-input-focus-target="answer"
              className="h-10 w-full rounded-xl border border-[color-mix(in_srgb,var(--border)_85%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_2%,transparent)] px-3 text-sm text-(--foreground) transition-colors duration-100 outline-none placeholder:text-(--foreground-tertiary) focus-visible:border-(--ring)"
            />
            <div className="flex items-center justify-end gap-2 py-1">
              <QuestionDictationButton
                id={question.id}
                value={answer.freeformText ?? ""}
                onChange={onDictationChange}
                onInteraction={onDictationInteraction}
                disabled={busy}
                isSecret={question.isSecret}
              />
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
    <ChevronDownIcon
      className={cn("size-4", direction === "prev" ? "rotate-90" : "-rotate-90", className)}
    />
  );
}

interface RequestComposerViewProps {
  className?: string;
  header?: ReactNode;
  headerAccessory?: ReactNode;
  body?: ReactNode;
  showQuestionBodyWhenHeader?: boolean;
  request: RequestComposerRequest;
  policy?: RequestQuestionnairePolicy;
  initialDraft?: RequestQuestionnaireDraft;
  onDraftChange?: (draft: RequestQuestionnaireDraft) => void;
  onUserInteraction?: () => void;
  onSubmit: (request: RequestComposerRequest, state: RequestQuestionnaireDraft) => Promise<void>;
  onSkip?: (request: RequestComposerRequest) => Promise<void>;
  onEscapeDismiss?: (request: RequestComposerRequest) => Promise<void>;
  submitErrorMessage: string;
  skipErrorMessage?: string;
  dismissErrorMessage?: string;
  isPlanMode?: boolean;
}

export function RequestComposerView(props: RequestComposerViewProps) {
  if (props.request.questions.length === 0) return null;

  const requestIdentity = buildCodexCanonicalRequestIdentityKey(props.request.requestId);
  const questionSignature = buildRequestQuestionSignature(props.request);

  return <RequestComposerViewInstance key={`${requestIdentity}:${questionSignature}`} {...props} />;
}

function RequestComposerViewInstance({
  className,
  header,
  headerAccessory,
  body,
  showQuestionBodyWhenHeader = true,
  request,
  policy = EXPLICIT_REQUEST_FORM_POLICY,
  initialDraft,
  onDraftChange,
  onUserInteraction,
  onSubmit,
  onSkip,
  onEscapeDismiss,
  submitErrorMessage,
  skipErrorMessage,
  dismissErrorMessage,
  isPlanMode = false,
}: RequestComposerViewProps) {
  const [busyAction, setBusyAction] = useState<"dismiss" | "skip" | "submit" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [advancingChoiceId, setAdvancingChoiceId] = useState<string | null>(null);
  const [localDraft, setState] = useState<RequestQuestionnaireDraft>(() =>
    reconcileRequestQuestionnaireDraft(request, initialDraft),
  );
  const state = initialDraft ?? localDraft;
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const formRef = useRef<HTMLFormElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const otherTextareaRef = useRef<HTMLTextAreaElement>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const pendingFocusTargetRef = useRef<UserInputFocusTarget | null>(null);
  const advancingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activationLockRef = useRef<symbol | null>(null);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const reducedMotion = useResolvedReducedMotion();

  const isMultiQuestion = request.questions.length > 1;
  const currentIndex = state.questionIndex;
  const question = request.questions[currentIndex]!;
  const answer = state.answers[currentIndex] ?? {
    selectedOptionId: null,
    freeformText: null,
  };
  const hasDismissAction = typeof onEscapeDismiss === "function";
  const hasSkipAction = typeof onSkip === "function";
  const showInlineOtherComposer = question.isOther && Boolean(question.options?.length);
  const isComposerPresentation = policy.presentation === "composer";
  const currentQuestionKey = `${currentIndex}:${question.id}`;
  const currentQuestionRef = useRef(question);
  const currentQuestionKeyRef = useRef(currentQuestionKey);
  currentQuestionRef.current = question;
  currentQuestionKeyRef.current = currentQuestionKey;
  const isCurrentQuestionPanel = () => stateRef.current.questionIndex === currentIndex;

  const commitDraft = (nextDraft: RequestQuestionnaireDraft) => {
    stateRef.current = nextDraft;
    setState(nextDraft);
    onDraftChange?.(nextDraft);
  };

  const clearAdvancing = () => {
    if (advancingTimerRef.current !== null) {
      clearTimeout(advancingTimerRef.current);
      advancingTimerRef.current = null;
    }
    activationLockRef.current = null;
    setAdvancingChoiceId(null);
  };

  const focusPendingTarget = useCallback(() => {
    const pendingFocusTarget = pendingFocusTargetRef.current;
    if (pendingFocusTarget === null) return;

    const nextFocusTarget = resolveUserInputQuestionFocusTarget(
      currentQuestionRef.current,
      pendingFocusTarget,
    );
    if (nextFocusTarget === null) {
      pendingFocusTargetRef.current = null;
      return;
    }

    const nextElement =
      nextFocusTarget === "options"
        ? optionsRef.current?.querySelector<HTMLButtonElement>('[role="radio"][tabindex="0"]')
        : nextFocusTarget === "other"
          ? otherTextareaRef.current
          : answerInputRef.current;
    if (!nextElement) return;

    const focusQuestionKey = nextElement.closest<HTMLElement>("[data-request-question-key]")
      ?.dataset.requestQuestionKey;
    if (focusQuestionKey !== currentQuestionKeyRef.current) return;

    pendingFocusTargetRef.current = null;
    nextElement.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      if (advancingTimerRef.current !== null) {
        clearTimeout(advancingTimerRef.current);
        advancingTimerRef.current = null;
      }
      activationLockRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    formRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    focusPendingTarget();
  }, [currentQuestionKey, focusPendingTarget]);

  const navigateQuestion = (
    nextIndex: number,
    options?: {
      preserveInputFocus?: boolean;
      draft?: RequestQuestionnaireDraft;
      keepAdvancingLock?: boolean;
    },
  ) => {
    const boundedIndex = Math.max(0, Math.min(request.questions.length - 1, nextIndex));
    if (boundedIndex === currentIndex) return;

    if (!options?.keepAdvancingLock) {
      clearAdvancing();
    }
    pendingFocusTargetRef.current = options?.preserveInputFocus
      ? resolveUserInputFocusTargetFromElement(
          typeof document === "undefined" ? null : document.activeElement,
        )
      : "options";
    commitDraft(
      navigateRequestQuestionnaire(request, options?.draft ?? stateRef.current, boundedIndex),
    );
  };

  const updateDraft = (value: string) => {
    clearAdvancing();
    commitDraft(
      setRequestQuestionnaireFreeform(stateRef.current, stateRef.current.questionIndex, value),
    );
  };

  const selectOption = (optionLabel: string) => {
    if (question.multiSelect) return;
    commitDraft(
      selectRequestQuestionnaireOption(
        stateRef.current,
        stateRef.current.questionIndex,
        optionLabel,
      ),
    );
  };

  const activateOther = () => {
    clearAdvancing();
    commitDraft(
      activateRequestQuestionnaireOther(stateRef.current, stateRef.current.questionIndex),
    );
  };

  const canSubmit = isRequestQuestionnaireSubmittable(request, state, policy);
  const isBusy = busyAction !== null || activationLockRef.current !== null;

  const submitDraft = async (nextDraft: RequestQuestionnaireDraft, lockToken?: symbol) => {
    const generation = requestGenerationRef.current;
    if (!isRequestQuestionnaireSubmittable(request, nextDraft, policy)) {
      setErrorMessage("Enter a response before submitting.");
      if (lockToken && activationLockRef.current === lockToken) {
        activationLockRef.current = null;
        setAdvancingChoiceId(null);
      }
      return;
    }

    setBusyAction("submit");
    setErrorMessage(null);
    try {
      await onSubmit(request, nextDraft);
    } catch (error) {
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setErrorMessage(resolveFormErrorMessage(error) ?? submitErrorMessage);
      }
    } finally {
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setBusyAction(null);
        if (!lockToken || activationLockRef.current === lockToken) {
          activationLockRef.current = null;
          setAdvancingChoiceId(null);
        }
      }
    }
  };

  const advanceOrSubmit = (nextDraft: RequestQuestionnaireDraft, lockToken?: symbol) => {
    if (isLastRequestQuestion(request, nextDraft)) {
      void submitDraft(nextDraft, lockToken);
      return;
    }

    navigateQuestion(nextDraft.questionIndex + 1, {
      draft: nextDraft,
      keepAdvancingLock: true,
    });
    if (!lockToken || activationLockRef.current === lockToken) {
      activationLockRef.current = null;
      setAdvancingChoiceId(null);
    }
  };

  const activateOption = (optionLabel: string) => {
    if (busyAction !== null || activationLockRef.current !== null) return;

    const nextDraft = selectRequestQuestionnaireOption(
      stateRef.current,
      stateRef.current.questionIndex,
      optionLabel,
      question.multiSelect,
    );
    commitDraft(nextDraft);
    if (question.multiSelect || policy.choiceBehavior.kind === "selectOnly") return;

    const lockToken = Symbol("request-choice-activation");
    activationLockRef.current = lockToken;
    const acknowledgementMs = policy.choiceBehavior.acknowledgementMs;
    if (acknowledgementMs <= 0) {
      advanceOrSubmit(nextDraft, lockToken);
      return;
    }

    setAdvancingChoiceId(optionLabel);
    const generation = requestGenerationRef.current;
    advancingTimerRef.current = setTimeout(() => {
      advancingTimerRef.current = null;
      if (
        !mountedRef.current ||
        requestGenerationRef.current !== generation ||
        activationLockRef.current !== lockToken
      ) {
        return;
      }
      advanceOrSubmit(nextDraft, lockToken);
    }, acknowledgementMs);
  };

  const handleEscapeDismiss = async () => {
    if (!onEscapeDismiss || busyAction !== null) return;
    clearAdvancing();
    const generation = requestGenerationRef.current;
    setBusyAction("dismiss");
    setErrorMessage(null);
    try {
      await onEscapeDismiss(request);
    } catch (error) {
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setErrorMessage(
          resolveFormErrorMessage(error) ?? dismissErrorMessage ?? "Could not dismiss request",
        );
      }
    } finally {
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setBusyAction(null);
      }
    }
  };

  const handleSkip = async () => {
    if (!onSkip || busyAction !== null || activationLockRef.current !== null) {
      return;
    }
    clearAdvancing();
    const generation = requestGenerationRef.current;
    setBusyAction("skip");
    setErrorMessage(null);
    try {
      await onSkip(request);
    } catch (error) {
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setErrorMessage(
          resolveFormErrorMessage(error) ?? skipErrorMessage ?? "Could not skip request",
        );
      }
    } finally {
      if (mountedRef.current && requestGenerationRef.current === generation) {
        setBusyAction(null);
      }
    }
  };

  const isLastQuestion = isLastRequestQuestion(request, state);

  const handlePrimaryAction = (nextDraft = stateRef.current) => {
    if (busyAction !== null || activationLockRef.current !== null) return;
    if (isLastQuestion) {
      void submitDraft(nextDraft);
      return;
    }

    navigateQuestion(currentIndex + 1, {
      preserveInputFocus: true,
      draft: nextDraft,
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.defaultPrevented) return;
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    handlePrimaryAction();
  };

  const focusOption = (optionLabel: string) => {
    const option = optionsRef.current?.querySelector<HTMLButtonElement>(
      `[data-request-option-label="${CSS.escape(optionLabel)}"]`,
    );
    option?.focus({ preventScroll: true });
  };

  const handleRootKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && hasDismissAction && busyAction === null) {
      event.preventDefault();
      void handleEscapeDismiss();
      return;
    }

    if (busyAction !== null || activationLockRef.current !== null) {
      if (event.key === "Enter" || event.key === " " || /^[1-9]$/.test(event.key)) {
        event.preventDefault();
      }
      return;
    }

    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }

    const targetElement = target instanceof Element ? target : null;
    const targetRadio =
      targetElement?.closest<HTMLButtonElement>("[data-request-option-label]") ?? null;
    const isQuestionnaireShortcutTarget = target === event.currentTarget || targetRadio !== null;
    const options = question.options ?? [];
    if (isQuestionnaireShortcutTarget && /^[1-9]$/.test(event.key)) {
      const optionIndex = Number(event.key) - 1;
      if (optionIndex < options.length) {
        event.preventDefault();
        activateOption(options[optionIndex]!.label);
        return;
      }
      if (optionIndex === options.length && showInlineOtherComposer) {
        event.preventDefault();
        activateOther();
        otherTextareaRef.current?.focus({ preventScroll: true });
      }
      return;
    }

    if (
      isQuestionnaireShortcutTarget &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      if (!isMultiQuestion) return;
      event.preventDefault();
      navigateQuestion(currentIndex + (event.key === "ArrowLeft" ? -1 : 1), {
        preserveInputFocus: true,
      });
      return;
    }

    if (isQuestionnaireShortcutTarget && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      if (options.length === 0) return;
      event.preventDefault();
      const selectedIndex = Math.max(
        0,
        options.findIndex(
          (option) =>
            option.label === (targetRadio?.dataset.requestOptionLabel ?? answer.selectedOptionId),
        ),
      );
      const nextIndex =
        event.key === "ArrowUp"
          ? Math.max(0, selectedIndex - 1)
          : Math.min(options.length - 1, selectedIndex + 1);
      if (
        event.key === "ArrowDown" &&
        selectedIndex === options.length - 1 &&
        showInlineOtherComposer
      ) {
        activateOther();
        otherTextareaRef.current?.focus({ preventScroll: true });
        return;
      }

      const nextOption = options[nextIndex];
      if (!nextOption) return;
      if (!question.multiSelect) selectOption(nextOption.label);
      focusOption(nextOption.label);
      return;
    }

    if (
      (event.key === "Enter" || event.key === " ") &&
      (targetRadio || target === event.currentTarget)
    ) {
      event.preventDefault();
      const optionLabel = targetRadio?.dataset.requestOptionLabel ?? answer.selectedOptionId;
      if (optionLabel) activateOption(optionLabel);
    }
  };

  const handleInlineAction = () => {
    if (busyAction !== null || activationLockRef.current !== null) return;
    const currentAnswer = stateRef.current.answers[stateRef.current.questionIndex];
    if (
      currentAnswer?.freeformText?.trim() ||
      (question.initialAnswer !== undefined && currentAnswer?.freeformText !== null) ||
      (question.multiSelect && currentAnswer?.selectedOptionIds?.length)
    ) {
      advanceOrSubmit(stateRef.current);
      return;
    }

    if (question.required) {
      setErrorMessage("Enter a response before submitting.");
      return;
    }
    const nextDraft = clearCurrentRequestQuestionnaireAnswer(stateRef.current);
    commitDraft(nextDraft);
    advanceOrSubmit(nextDraft);
  };

  const primaryLabel =
    busyAction === "submit" ? "Submitting" : isLastQuestion ? "Submit" : "Continue";

  const formActionButtons = (
    <>
      {hasDismissAction ? (
        <button
          type="button"
          className="group inline-flex shrink-0 items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-sm/4.5 text-token-description-foreground hover:bg-token-list-hover-background focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => void handleEscapeDismiss()}
          disabled={isBusy}
        >
          <span className="text-sm text-token-description-foreground">Dismiss</span>
          <span className="inline-flex items-center rounded-sm bg-token-foreground/10 px-2 py-1 font-sans text-xs leading-none text-token-foreground group-hover:bg-token-foreground/15">
            <span>ESC</span>
          </span>
        </button>
      ) : null}
      {hasSkipAction ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-sm/4.5 text-token-description-foreground hover:bg-token-list-hover-background focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => void handleSkip()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.stopPropagation();
            }
          }}
          disabled={isBusy}
        >
          <span className="text-sm text-token-description-foreground">Skip</span>
        </button>
      ) : null}
      <button
        type={isLastQuestion ? "submit" : "button"}
        className={cn(
          "inline-flex h-token-button-composer shrink-0 items-center gap-1 rounded-full border border-transparent px-2 py-0 text-sm/4.5 text-token-dropdown-background focus:outline-none disabled:cursor-not-allowed disabled:opacity-40",
          isPlanMode
            ? "bg-token-text-link-foreground hover:bg-token-text-link-foreground/90"
            : "bg-token-foreground hover:bg-token-foreground/80",
        )}
        onClick={isLastQuestion ? undefined : () => handlePrimaryAction()}
        disabled={isLastQuestion ? !canSubmit || isBusy : false}
      >
        <span className="text-sm font-medium">{primaryLabel}</span>
        <span className="inline-flex items-center rounded-sm bg-token-dropdown-background/15 px-1.5 py-px text-sm leading-none text-token-dropdown-background">
          <span className="font-mono">⏎</span>
        </span>
      </button>
    </>
  );

  const inlineHasAnswer =
    Boolean(answer.freeformText?.trim()) ||
    question.initialAnswer !== undefined ||
    Boolean(question.multiSelect && answer.selectedOptionIds?.length);
  const inlineActionButtons = (
    <button
      type="button"
      onClick={handleInlineAction}
      disabled={isBusy || Boolean(question.required && !inlineHasAnswer)}
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center rounded-full border px-2 text-sm leading-none font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:opacity-40",
        inlineHasAnswer
          ? "border-transparent bg-token-foreground text-token-dropdown-background hover:bg-token-foreground/80"
          : QUESTION_OUTLINE_ACTION_COLORS,
      )}
    >
      {question.multiSelect
        ? primaryLabel
        : inlineHasAnswer
          ? isLastQuestion
            ? "Send"
            : "Next"
          : "Skip"}
    </button>
  );

  return (
    <form
      ref={formRef}
      className={cn("flex flex-col gap-3", className)}
      tabIndex={0}
      data-user-input-auto-resolution={onUserInteraction ? "" : undefined}
      onPointerDownCapture={() => {
        onUserInteraction?.();
      }}
      onKeyDownCapture={(event) => {
        onUserInteraction?.();
        handleRootKeyDown(event);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        handlePrimaryAction();
      }}
    >
      <div className="@container/request-card border-default bg-surface-elevated-secondary text-token-foreground flex flex-col overflow-hidden rounded-3xl border focus:outline-none">
        {(header || question.header || question.question) && (
          <div className="flex items-center justify-between border-token-border/70 pt-4 pr-3 pb-2 pl-4">
            <div className="text-base leading-5 font-medium text-(--foreground)">
              {header ?? question.question ?? question.header}
            </div>
            <div className="flex shrink-0 items-center gap-1 text-xs text-(--foreground-tertiary)">
              {headerAccessory}
              {isMultiQuestion ? (
                <>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-full text-(--foreground-tertiary) transition-colors duration-100 hover:bg-foreground-5 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={currentIndex === 0}
                    onClick={() => navigateQuestion(currentIndex - 1)}
                    aria-label="Previous question"
                  >
                    <ChevronIcon direction="prev" />
                  </button>
                  <span className="tabular-nums">
                    {currentIndex + 1} of {request.questions.length}
                  </span>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-full text-(--foreground-tertiary) transition-colors duration-100 hover:bg-foreground-5 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={currentIndex === request.questions.length - 1}
                    onClick={() => navigateQuestion(currentIndex + 1)}
                    aria-label="Next question"
                  >
                    <ChevronIcon direction="next" />
                  </button>
                </>
              ) : null}
              {isComposerPresentation && hasDismissAction ? (
                <button
                  type="button"
                  data-request-input-dismiss
                  className="flex size-6.5 items-center justify-center rounded-full text-(--foreground-tertiary) hover:bg-foreground-5 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Dismiss"
                  disabled={isBusy}
                  onClick={() => void handleEscapeDismiss()}
                >
                  <CloseIcon className="icon-xs shrink-0" />
                  <span className="sr-only">Dismiss</span>
                </button>
              ) : null}
            </div>
          </div>
        )}
        {body ? <div className="flex flex-col">{body}</div> : null}
        {header && showQuestionBodyWhenHeader ? (
          <div className="px-4 text-sm font-medium">{question.question}</div>
        ) : null}
        <AnimatePresence initial={false} mode={reducedMotion ? "sync" : "wait"}>
          <motion.div
            key={currentQuestionKey}
            data-request-question-key={currentQuestionKey}
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0, pointerEvents: "none" }}
            transition={
              reducedMotion ? { duration: 0 } : { type: "spring", bounce: 0, duration: 0.3 }
            }
            onAnimationComplete={focusPendingTarget}
          >
            <UserInputQuestionSection
              question={question}
              answer={answer}
              busy={isBusy}
              advancingChoiceId={advancingChoiceId}
              presentation={policy.presentation}
              optionsRef={optionsRef}
              otherTextareaRef={otherTextareaRef}
              answerInputRef={answerInputRef}
              onOptionSelect={(optionLabel) => {
                if (!isCurrentQuestionPanel()) return;
                selectOption(optionLabel);
              }}
              onOptionActivate={(optionLabel) => {
                if (!isCurrentQuestionPanel()) return;
                activateOption(optionLabel);
              }}
              onDraftChange={(value) => {
                if (!isCurrentQuestionPanel()) return;
                updateDraft(value);
              }}
              onDictationInteraction={onUserInteraction}
              onDictationChange={(value) => {
                if (!mountedRef.current) return;
                commitDraft(setRequestQuestionnaireFreeform(stateRef.current, currentIndex, value));
              }}
              onOtherFocus={() => {
                if (!isCurrentQuestionPanel()) return;
                activateOther();
              }}
              onKeyDown={(event) => {
                if (!isCurrentQuestionPanel()) return;
                handleKeyDown(event);
              }}
              actionButtons={isComposerPresentation ? inlineActionButtons : formActionButtons}
              showInlineOtherComposer={showInlineOtherComposer}
            />
          </motion.div>
        </AnimatePresence>

        {errorMessage && (
          <div role="alert" className="px-3 pb-2 text-xs text-(--destructive)">
            {errorMessage}
          </div>
        )}
      </div>
    </form>
  );
}
