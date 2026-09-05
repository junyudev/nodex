import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import {
  AgentQuestionDismissIcon,
  AgentQuestionIcon,
  ChevronDownIcon,
} from "@/components/shared/icons";
import type { CodexComposerSkill, ProtocolAppInfo } from "@/lib/types";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import type { AsyncQuestionRuntime, AsyncQuestionSnapshot } from "../../async-question-runtime";
import {
  ComposerMentionMenu,
  type ComposerAddContextMenuHandle,
} from "./composer-add-context-menu";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./composer-prompt-editor";
import { inactiveComposerSuggestionState } from "./composer-suggestion-state";
import {
  AsyncQuestionActions,
  AsyncQuestionChoiceMarker,
  AsyncQuestionChoices,
} from "./async-question-controls";

export interface AsyncQuestionMentionContext {
  workspaceRoot: string | null;
  skills: readonly CodexComposerSkill[];
  apps: readonly ProtocolAppInfo[];
}
const EMPTY_MENTION_CONTEXT: AsyncQuestionMentionContext = {
  workspaceRoot: null,
  skills: [],
  apps: [],
};
const QUESTION_FADE: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { type: "spring", duration: 0.3 } },
  exit: { opacity: 0, transition: { type: "spring", duration: 0.3 } },
};
const QUESTION_STAGGER: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.05 } },
  exit: { transition: { staggerChildren: 0.05 } },
};
const QUESTION_EXIT: Variants = { exit: { pointerEvents: "none" } };
const QUESTION_CONTROL =
  "flex shrink-0 items-center justify-center rounded-md border border-transparent p-1 text-token-description-foreground hover:bg-text/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus disabled:cursor-default disabled:opacity-40";

export function AsyncQuestionPanel({
  threadId,
  runtime,
  state,
  onSend,
  mentionContext = EMPTY_MENTION_CONTEXT,
}: {
  threadId: string;
  runtime: AsyncQuestionRuntime;
  state: AsyncQuestionSnapshot;
  onSend: () => Promise<void>;
  mentionContext?: AsyncQuestionMentionContext;
}) {
  const question = state.selectedId ? state.questions[state.selectedId] : null;
  const panel = useRef<HTMLDivElement>(null);
  const editor = useRef<ComposerPromptEditorHandle>(null);
  const mentionMenu = useRef<ComposerAddContextMenuHandle>(null);
  const [suggestion, setSuggestion] = useState(inactiveComposerSuggestionState);
  const activation = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activating, setActivating] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null | undefined>();
  const reducedMotion = useResolvedReducedMotion();
  const index = state.openIds.indexOf(state.selectedId ?? "");
  const last = index === state.openIds.length - 1;
  const multiple = state.openIds.length > 1;
  const animateQuestions = multiple && !reducedMotion;
  const fade = animateQuestions ? QUESTION_FADE : undefined;
  // Presence transitions keep the outgoing editor mounted until the new question can enter.
  const bindEditor = useCallback(
    (handle: ComposerPromptEditorHandle | null) => {
      editor.current = handle;
      if (!handle || question?.options.length || runtime.read(threadId).selectedId !== question?.id)
        return;
      // The imperative handle is published before the editor creates its ProseMirror view.
      queueMicrotask(() => {
        if (editor.current !== handle || runtime.read(threadId).selectedId !== question?.id) return;
        handle.focus();
      });
    },
    [question?.id, question?.options.length, runtime, threadId],
  );

  useLayoutEffect(() => {
    setActivating(null);
    setHovered(undefined);
    setSuggestion(inactiveComposerSuggestionState());
    if (question?.options.length) panel.current?.focus();
    return () => {
      if (activation.current) clearTimeout(activation.current);
      activation.current = null;
    };
  }, [question?.id, question?.options.length]);
  useEffect(() => {
    if (!question?.deadlineMs) return;
    const deadline = question.deadlineMs;
    const timer = setTimeout(
      () => runtime.expire(threadId, question.id, deadline),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [question?.deadlineMs, question?.id, runtime, threadId]);
  if (!question || question.turnId !== state.activeTurnId) return null;

  const selected = question.draftKind === "option" ? question.options.indexOf(question.draft) : -1;
  const hasOptions = question.options.length > 0;
  const canSend = Boolean(question.draft.trim());
  const clearActivation = () => {
    if (activation.current) clearTimeout(activation.current);
    activation.current = null;
    setActivating(null);
  };
  const navigate = (offset: number) => {
    if (state.submitting || (offset > 0 && !canSend)) return;
    const id = state.openIds[index + offset];
    if (!id) return;
    clearActivation();
    runtime.select(threadId, id);
  };
  const send = async () => {
    try {
      await onSend();
    } catch {
      if (runtime.read(threadId).selectedId !== question.id) return;
      toast.danger("Couldn’t send response");
    }
  };
  const advance = () => {
    if (state.submitting) return;
    if (last) {
      void send();
      return;
    }
    // Choice activation and Skip publish their answer before this render's callback runs.
    const id = state.openIds[index + 1];
    if (id) runtime.select(threadId, id);
  };
  const selectOption = (optionIndex: number) => {
    setHovered(optionIndex);
    runtime.selectOption(threadId, question.id, optionIndex);
  };
  const choose = (optionIndex: number) => {
    if (
      question.options[optionIndex] === undefined ||
      state.submitting ||
      activation.current !== null
    )
      return;
    selectOption(optionIndex);
    setActivating(optionIndex);
    activation.current = setTimeout(() => {
      activation.current = null;
      setActivating(null);
      advance();
    }, 180);
  };
  const skip = () => {
    clearActivation();
    runtime.skip(threadId, question.id);
    advance();
  };
  const close = () => {
    clearActivation();
    runtime.close(threadId);
  };
  const focusFreeform = () => {
    if (!hasOptions || runtime.read(threadId).selectedId !== question.id) return;
    clearActivation();
    setHovered(null);
    runtime.focusFreeform(threadId, question.id);
  };
  const label = last
    ? state.openIds.length === 1 && question.baseline
      ? "Send update"
      : "Send"
    : "Next";
  const replyField = (
    <div
      className={cn(
        "relative min-w-0 flex-1",
        !hasOptions && "rounded-lg border border-border-primary-outline px-3 py-2",
      )}
      onFocus={focusFreeform}
    >
      <ComposerPromptEditor
        ref={bindEditor}
        value={question.freeformDraft}
        placeholder={hasOptions ? "Or write your own response" : "Reply…"}
        disabled={state.submitting}
        compact
        allowSlashCommands={false}
        onSuggestionStateChange={setSuggestion}
        onSuggestionAction={(action) => {
          if (!suggestion.active) return false;
          if (action === "next" || action === "previous")
            return mentionMenu.current?.moveHighlight(action) ?? false;
          if (action !== "complete-query" && action !== "insert-mention") return false;
          if (!mentionMenu.current?.submitHighlighted(action)) editor.current?.closeSuggestions();
          return true;
        }}
        onChange={(value) => runtime.setDraft(threadId, question.id, value)}
        onKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) return false;
          if (event.key === "ArrowUp" && hasOptions) {
            const element =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>('[contenteditable="true"]')
                : null;
            const lineHeight = element ? parseFloat(getComputedStyle(element).lineHeight) : NaN;
            if (element && Number.isFinite(lineHeight) && element.scrollHeight > lineHeight * 1.1)
              return false;
            event.preventDefault();
            event.stopPropagation();
            selectOption(question.options.length - 1);
            panel.current?.focus();
            return true;
          }
          if (event.key !== "Enter" || event.shiftKey) return false;
          event.preventDefault();
          if (runtime.read(threadId).questions[question.id]?.draft.trim() && !state.submitting)
            advance();
          return true;
        }}
      />
    </div>
  );

  return (
    <div
      ref={panel}
      tabIndex={0}
      role="group"
      aria-label="Agent question"
      data-async-question-panel="true"
      className="group-has-[[data-composer-context-suggestions=true]]/async-questions:hidden @container/request-card relative isolate flex flex-col overflow-hidden rounded-3xl border border-default bg-token-bg-fog text-token-foreground outline-none"
      onPointerDownCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-async-question-dismiss]")
        )
          return;
        runtime.touch(threadId, question.id);
      }}
      onKeyDownCapture={(event) => {
        if (
          event.key === "Escape" ||
          (event.target instanceof Element && event.target.closest("[data-async-question-dismiss]"))
        )
          return;
        runtime.touch(threadId, question.id);
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          document.querySelector(
            '[role="dialog"][data-state="open"],[role="menu"][data-state="open"],[role="listbox"][data-state="open"]',
          )
        )
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (state.submitting || activation.current !== null) {
          event.preventDefault();
          return;
        }
        if (
          event.target instanceof Element &&
          event.target.closest(
            '[contenteditable="true"],input,textarea,[data-async-question-dismiss]',
          )
        )
          return;
        const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
        if (digit >= 0 && digit < question.options.length) {
          event.preventDefault();
          choose(digit);
          return;
        }
        if (hasOptions && digit === question.options.length) {
          event.preventDefault();
          editor.current?.focus();
          return;
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          if (multiple) {
            event.preventDefault();
            navigate(event.key === "ArrowRight" ? 1 : -1);
          }
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!hasOptions || (event.key === "ArrowUp" && selected === 0)) return;
          if (
            event.key === "ArrowDown" &&
            (selected === -1 || selected === question.options.length - 1)
          ) {
            editor.current?.focus();
            return;
          }
          selectOption(
            selected === -1
              ? question.options.length - 1
              : selected + (event.key === "ArrowDown" ? 1 : -1),
          );
          return;
        }
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (selected >= 0) choose(selected);
        else if (canSend) advance();
      }}
    >
      <ComposerMentionMenu
        ref={mentionMenu}
        suggestion={suggestion}
        skills={mentionContext.skills}
        apps={mentionContext.apps}
        workspaceRoot={mentionContext.workspaceRoot}
        onDismiss={() => editor.current?.dismissSuggestions()}
        onInsertMention={(mention) => editor.current?.insertMention(mention)}
      />
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={question.id}
          variants={animateQuestions ? QUESTION_EXIT : undefined}
          initial={animateQuestions ? "initial" : false}
          animate={animateQuestions ? "animate" : undefined}
          exit={animateQuestions ? "exit" : undefined}
        >
          <div className="flex items-start justify-between ps-4 pe-3 pt-4 pb-2">
            <motion.div variants={fade} className="flex min-w-0 flex-1 items-start justify-between">
              <span className="flex min-w-0 items-center gap-2 text-size-chat-sm leading-5 font-normal text-token-text-secondary select-none">
                <AgentQuestionIcon />
                Question
              </span>
              <div className="flex shrink-0 items-center gap-1 text-xs text-token-description-foreground">
                {multiple ? (
                  <>
                    <button
                      type="button"
                      aria-label="Previous question"
                      className={QUESTION_CONTROL}
                      disabled={index === 0 || state.submitting}
                      onClick={() => navigate(-1)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.stopPropagation();
                      }}
                    >
                      <ChevronDownIcon className="icon-sm rotate-90" />
                    </button>
                    <span>
                      {index + 1} of {state.openIds.length}
                    </span>
                    <button
                      type="button"
                      aria-label="Next question"
                      className={QUESTION_CONTROL}
                      disabled={last || !canSend || state.submitting}
                      onClick={() => navigate(1)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.stopPropagation();
                      }}
                    >
                      <ChevronDownIcon className="icon-sm -rotate-90" />
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  aria-label="Close question"
                  data-async-question-dismiss="true"
                  className={QUESTION_CONTROL}
                  onClick={close}
                >
                  <AgentQuestionDismissIcon />
                </button>
              </div>
            </motion.div>
          </div>
          <motion.div
            variants={animateQuestions ? QUESTION_STAGGER : undefined}
            className="flex flex-col gap-3 pt-1 pb-2"
          >
            <div className="px-4 text-sm font-medium">
              <span className="block break-words whitespace-pre-wrap select-text">
                {question.title}
              </span>
            </div>
            <div className="flex flex-col gap-1 px-2">
              <AsyncQuestionChoices
                title={question.title}
                options={question.options}
                selected={selected}
                hovered={hovered}
                activating={activating}
                disabled={state.submitting}
                variants={fade}
                onHover={setHovered}
                onChoose={choose}
              />
              {!hasOptions ? (
                <motion.div variants={fade} className="flex w-full items-center px-2 py-1.5">
                  {replyField}
                </motion.div>
              ) : null}
              <motion.div
                variants={fade}
                role="presentation"
                data-async-question-reply-row={hasOptions ? "true" : undefined}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5",
                  hasOptions
                    ? "group min-h-8 w-full cursor-interaction rounded-2xl text-start text-sm transition-colors hover:bg-text/5 ![corner-shape:round]"
                    : "justify-end",
                  hasOptions && activating === null && hovered === null && "bg-text/5",
                )}
                onPointerEnter={hasOptions ? () => setHovered(null) : undefined}
                onMouseDown={
                  hasOptions
                    ? (event) => {
                        if (
                          event.target instanceof Element &&
                          event.target.closest('button,[contenteditable="true"]')
                        )
                          return;
                        event.preventDefault();
                        editor.current?.focus();
                      }
                    : undefined
                }
              >
                {hasOptions ? (
                  <div className="group flex min-w-0 flex-1 cursor-interaction items-center gap-2 text-sm leading-5">
                    <AsyncQuestionChoiceMarker />
                    {replyField}
                  </div>
                ) : null}
                <AsyncQuestionActions
                  deadlineMs={question.deadlineMs}
                  submitting={state.submitting}
                  canSend={canSend && activating === null}
                  label={label}
                  onSkip={skip}
                  onSend={advance}
                />
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
