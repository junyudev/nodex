import { FormattedMessage, useIntl } from "@/lib/i18n";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ComposerAdaptiveFooter,
  ComposerInput,
} from "@/components/composer/composer-adaptive-footer";
import { ComposerAttachments } from "@/components/composer/composer-attachments";
import {
  COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME,
  COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME,
} from "@/components/composer/composer-footer-controls";
import {
  COMPOSER_DROP_TARGET_CLASS_NAME,
  COMPOSER_PROMPT_SCROLL_CLASS_NAME,
  COMPOSER_PROMPT_TEXT_CLASS_NAME,
  COMPOSER_SURFACE_CLASS_NAME,
} from "@/components/composer/composer-surface";
import {
  MessageImagePicker,
  MessageImageRow,
  useMessageImageInput,
  type MessageDraftImage,
  type MessageImageAccess,
} from "@/components/message/message-images-input";
import { CloseIcon, NodexLogoMarkIcon, UpArrowIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  ComposerBufferedDictationControls,
  ComposerDictateButton,
  ComposerDictationRecovery,
  ComposerDictationSendButton,
} from "@/features/dictation/composer-dictation-controls";
import { useComposerDictationNotifications } from "@/features/dictation/composer-dictation-notifications";
import { useDictationRecordingNavigation } from "@/features/dictation/dictation-recording-navigation";
import {
  createTextareaDictationTarget,
  type DictationTextareaSelection,
} from "@/features/dictation/textarea-dictation-target";
import { useComposerDictationCapabilityState } from "@/features/dictation/use-composer-dictation-capability-state";
import {
  supportsComposerDictation,
  useComposerDictation,
  useComposerDictationHold,
  type ComposerDictationController,
} from "@/features/local-conversation/view/composer/use-composer-dictation";
import { resolveComposerGlobalDictationAdmission } from "@/features/local-conversation/view/composer/composer-global-dictation-admission";
import { resolveCodexRendererCommandPlatform } from "@/lib/codex-window-runtime";
import { useCommandKeymapState } from "@/lib/use-command-keymap-state";
import {
  createCommandKeymapState,
  formatAcceleratorAriaKeyShortcut,
  formatAcceleratorLabel,
  resolveCommandShortcutPresentation,
} from "../../../shared/command-keybindings";
import { cn } from "@/lib/utils";
import { isEmptyInboxDraft, type InboxDraft } from "./inbox-capture-state";
import { MAX_INBOX_TITLE_LENGTH } from "../../../shared/schemas/inbox";

import { useInboxReplyDestination } from "./use-inbox-reply-destination";
import type { InboxReplyDestination } from "../../../shared/inbox";

/** Runs the composer's alternate action, such as starting the work now. */
const ALTERNATE_ACCELERATOR = "CmdOrCtrl+Enter";

const FIELD_CLASS_NAME =
  "block w-full bg-transparent outline-none placeholder:text-token-input-placeholder-foreground placeholder:opacity-50";

/**
 * The capture owner persists drafts and each submission before clearing this input. Images
 * pasted, dropped, or picked are imported as Library Files and attached after the text. A
 * message is named for it unless its sender gives a title, on a line above the text that its
 * host opens; a title already in the draft always shows, so it is never sent unseen.
 *
 * It has a chat composer's rows: the text above, the controls beneath. The text area sizes to
 * what it holds and scrolls by itself once full, so a title stays in view above it.
 *
 * Where its host offers it, `Cmd/Ctrl+Enter` or the Start control sends the message with a
 * request to start its work now; a reply is always just sent.
 */
export function InboxComposer({
  onSend,
  fieldLabel,
  sendLabel,
  alternate,
  leadingAccessory,
  draft,
  onDraftChange,
  images,
  disabled = false,
  readOnly = false,
  focusToken,
  placeholder,
  titleOpen = false,
  onTitleOpenChange,
  visible = true,
  dictateToken,
}: {
  readonly onSend: () => Promise<unknown>;
  /** What the text field is for; an Inbox's composer messages that Inbox. */
  readonly fieldLabel?: string;
  /** What `Enter` does here, as Send names it; an Inbox's composer sends to that Inbox. */
  readonly sendLabel?: string;
  /**
   * The other thing this composer can do with a message, on `Cmd/Ctrl+Enter` and a control beside
   * Send: starting its work from an Inbox, saving it to the Inbox from Mini. A reply is always
   * just sent.
   */
  readonly alternate?: {
    readonly label: string;
    readonly icon: ComponentType<{ readonly className?: string }>;
    readonly run: () => Promise<unknown>;
  };
  /** A control that belongs with the message, beside `Add photos`. */
  readonly leadingAccessory?: ReactNode;
  readonly draft: InboxDraft;
  /** Applied to the draft as it is when written, since an image import finishes later. */
  readonly onDraftChange: (change: (draft: InboxDraft) => InboxDraft) => void;
  /** Null until the Inbox can import images. */
  readonly images: MessageImageAccess | null;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  /** Changing this value focuses the composer, for example after a keyboard shortcut. */
  readonly focusToken?: number;
  readonly placeholder?: string;
  /** Shows the title line even while it is empty; opening it moves the keyboard there. */
  readonly titleOpen?: boolean;
  readonly onTitleOpenChange?: (open: boolean) => void;
  /**
   * False while its host keeps it mounted out of sight; speech being recorded then finishes
   * into the draft, as when a Composer leaves the screen.
   */
  readonly visible?: boolean;
  /** Changing this value starts dictation, for a host's own Dictate control. */
  readonly dictateToken?: number;
}) {
  const intl = useIntl();
  const observedDestination = useInboxReplyDestination(draft.replyTo?.pageId, draft.text);
  const replyDestination =
    draft.replyTo?.turnEpisode && observedDestination?.kind === "nodex"
      ? { ...observedDestination, kind: "unavailable" as const }
      : observedDestination;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const showTitle = titleOpen || draft.title !== "";
  const input = useMessageImageInput({
    access: readOnly ? null : images,
    onImported: (added: readonly MessageDraftImage[]) =>
      onDraftChange((current) => ({ ...current, images: [...current.images, ...added] })),
  });
  // A reply the host says it cannot deliver names where to continue instead of offering Send.
  const canSend =
    !disabled &&
    replyDestination?.kind !== "unavailable" &&
    !input.importing &&
    !isEmptyInboxDraft(draft);
  const alternateOffered = alternate !== undefined && !draft.replyTo;
  const sendDisabled = disabled || readOnly || input.importing;

  const focusedTokenRef = useRef<{ token: number | undefined } | null>(null);
  useLayoutEffect(() => {
    if (!focusToken || focusedTokenRef.current?.token === focusToken) return;
    const input = textareaRef.current;
    input?.focus();
    if (input && input.ownerDocument.activeElement === input) {
      focusedTokenRef.current = { token: focusToken };
    }
  }, [focusToken]);

  // An opened title takes the keyboard as it appears, before another keystroke reaches the text.
  const titleWasOpen = useRef(titleOpen);
  useLayoutEffect(() => {
    if (titleOpen && !titleWasOpen.current) titleRef.current?.focus();
    titleWasOpen.current = titleOpen;
  }, [titleOpen]);

  const sendDraft = async (useAlternate = false) => {
    if (!canSend) return;
    await (useAlternate && alternate ? alternate.run() : onSend());
    onTitleOpenChange?.(false);
    textareaRef.current?.focus();
  };
  // The alternate action asked for while speech is still being transcribed applies once its text
  // is in.
  const alternateAfterTranscript = useRef(false);
  const sendTranscript = () => {
    const useAlternate = alternateAfterTranscript.current;
    alternateAfterTranscript.current = false;
    return sendDraft(useAlternate);
  };

  const {
    dictation,
    supported: dictationSupported,
    microphoneBusy,
    inlineDictation,
    editor,
    prepareDictation,
  } = useInboxComposerDictation({
    textareaRef,
    text: draft.text,
    onDraftChange,
    sendDraft: sendTranscript,
    sendDisabled,
    readOnly,
  });
  const openVoiceSettings = useDictationRecordingNavigation();
  const dictationActive = dictation.isDictating || dictation.isTranscribing;
  const showBufferedDictation = dictationActive && !inlineDictation;
  const preserveEditorFocus = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.button === 0 && editorOwnsFocus(textareaRef.current)) event.preventDefault();
  };

  const submit = async (event?: FormEvent, useAlternate = false) => {
    event?.preventDefault();
    if (dictation.isStarting) return;
    if (dictationActive) {
      if (sendDisabled) return;
      alternateAfterTranscript.current = useAlternate && alternate !== undefined;
      dictation.stopDictation("send");
      return;
    }
    await sendDraft(useAlternate);
  };

  const {
    isDictating,
    isStarting: dictationStarting,
    startDictation,
    stopDictation,
    cancelDictation,
  } = dictation;
  // A host's Dictate control records as this composer's microphone button does, once the
  // composer is on screen to show it.
  const dictatedToken = useRef(dictateToken);
  useEffect(() => {
    if (!visible || !dictateToken || dictatedToken.current === dictateToken) return;
    dictatedToken.current = dictateToken;
    if (!dictationSupported || readOnly || microphoneBusy || dictationActive) return;
    prepareDictation();
    void startDictation();
  }, [
    visible,
    dictateToken,
    dictationSupported,
    readOnly,
    microphoneBusy,
    dictationActive,
    prepareDictation,
    startDictation,
  ]);
  // Each recording starts as a plain send until the alternate is asked for again.
  useEffect(() => {
    if (dictationStarting) alternateAfterTranscript.current = false;
  }, [dictationStarting]);
  useEffect(() => {
    if (visible) return;
    if (isDictating) stopDictation("insert");
    else if (dictationStarting) cancelDictation();
  }, [visible, isDictating, dictationStarting, stopDictation, cancelDictation]);

  const stopReplying = () => onDraftChange((current) => ({ ...current, replyTo: null }));

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Escape" &&
      !event.nativeEvent.isComposing &&
      (dictation.isStarting || dictationActive)
    ) {
      event.preventDefault();
      event.stopPropagation();
      dictation.cancelDictation();
      return;
    }
    // Escape in an empty reply lets go of the post it answers, the way it was taken up.
    if (
      event.key === "Escape" &&
      draft.replyTo &&
      draft.text === "" &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.stopPropagation();
      stopReplying();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit(undefined, alternateOffered && (event.metaKey || event.ctrlKey));
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      textareaRef.current?.focus();
      return;
    }
    // An empty title steps aside the way it came, back to the message.
    if ((event.key === "Backspace" || event.key === "Escape") && draft.title === "") {
      event.preventDefault();
      event.stopPropagation();
      onTitleOpenChange?.(false);
      textareaRef.current?.focus();
    }
  };

  return (
    <form
      data-testid="inbox-composer"
      data-inbox-composer
      onSubmit={(event) => void submit(event)}
      data-file-drop-active={input.dropActive ? "true" : "false"}
      {...input.dropTarget}
      className={cn(
        "relative flex flex-col",
        COMPOSER_SURFACE_CLASS_NAME,
        input.dropActive && COMPOSER_DROP_TARGET_CLASS_NAME,
      )}
    >
      {draft.replyTo ? (
        <div
          data-testid="inbox-composer-reply"
          className="flex min-w-0 items-center gap-1.5 pt-0.5 pr-1 pl-3 text-xs text-token-description-foreground"
        >
          {!draft.replyTo.turnEpisode ? (
            <NodexLogoMarkIcon monochrome className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">
            {intl.formatMessage({
              id: "inbox.inboxComposer.replyingTo",
              defaultMessage: "Replying to",
            })}{" "}
            <span className="text-token-foreground">{draft.replyTo.label}</span>
          </span>
          {replyDestination ? (
            <span
              className="max-w-1/2 min-w-0 shrink-0 truncate"
              aria-label={intl.formatMessage({
                id: "inbox.inboxComposer.replyDestination",
                defaultMessage: "Reply destination",
              })}
            >
              <ReplyDestinationPhrase destination={replyDestination} />
            </span>
          ) : null}
          <NodexTooltip
            tooltipContent={intl.formatMessage({
              id: "inbox.inboxComposer.stopReplying",
              defaultMessage: "Stop replying",
            })}
            side="top"
          >
            <button
              type="button"
              aria-label={intl.formatMessage({
                id: "inbox.inboxComposer.stopReplying",
                defaultMessage: "Stop replying",
              })}
              onClick={stopReplying}
              className="cursor-interaction ml-auto flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-token-foreground/5 hover:text-token-foreground"
            >
              <CloseIcon className="icon-2xs" />
            </button>
          </NodexTooltip>
        </div>
      ) : null}
      <ComposerAttachments>
        <MessageImageRow
          images={draft.images}
          input={input}
          readAuthority={images?.readAuthority ?? null}
          onRemove={(fileId) =>
            onDraftChange((current) => ({
              ...current,
              images: current.images.filter((image) => image.fileId !== fileId),
            }))
          }
        />
      </ComposerAttachments>
      <ComposerDictationRecovery dictation={dictation} onOpenVoiceSettings={openVoiceSettings} />
      <ComposerAdaptiveFooter
        layout="multiline"
        input={
          <ComposerInput layout="multiline">
            {showTitle ? (
              <input
                ref={titleRef}
                aria-label={intl.formatMessage({
                  id: "inbox.inboxComposer.messageTitle",
                  defaultMessage: "Message title",
                })}
                placeholder={intl.formatMessage({
                  id: "inbox.inboxComposer.title",
                  defaultMessage: "Title",
                })}
                readOnly={readOnly}
                value={draft.title}
                maxLength={MAX_INBOX_TITLE_LENGTH}
                onChange={(event) => {
                  const title = event.currentTarget.value;
                  onDraftChange((current) => ({ ...current, title }));
                }}
                onKeyDown={handleTitleKeyDown}
                className={cn(
                  COMPOSER_PROMPT_TEXT_CLASS_NAME,
                  FIELD_CLASS_NAME,
                  "pb-1 font-semibold placeholder:font-normal",
                )}
              />
            ) : null}
            <textarea
              ref={textareaRef}
              aria-label={
                fieldLabel ??
                intl.formatMessage({
                  id: "inbox.inboxComposer.messageYourInbox",
                  defaultMessage: "Message your Inbox",
                })
              }
              rows={1}
              readOnly={readOnly}
              value={draft.text}
              placeholder={
                draft.replyTo?.turnEpisode
                  ? intl.formatMessage({
                      id: "inbox.inboxComposer.replyToChat",
                      defaultMessage: "Reply to chat…",
                    })
                  : draft.replyTo
                    ? intl.formatMessage({
                        id: "inbox.inboxComposer.replyToNodex",
                        defaultMessage: "Reply to Nodex…",
                      })
                    : (placeholder ??
                      intl.formatMessage({
                        id: "inbox.inboxComposer.dropAThoughtTaskOr",
                        defaultMessage: "Drop a thought, task, or question…",
                      }))
              }
              onChange={(event) => {
                const textarea = event.currentTarget;
                const text = textarea.value;
                editor.observe(text, readTextareaSelection(textarea));
                onDraftChange((current) => ({ ...current, text }));
              }}
              onSelect={(event) => {
                const textarea = event.currentTarget;
                if (textarea.value === editor.text)
                  editor.observe(editor.text, readTextareaSelection(textarea));
              }}
              onCompositionStart={editor.beginComposition}
              onCompositionEnd={() => queueMicrotask(editor.finishComposition)}
              onPaste={input.onPaste}
              onKeyDown={handleKeyDown}
              className={cn(
                COMPOSER_PROMPT_TEXT_CLASS_NAME,
                COMPOSER_PROMPT_SCROLL_CLASS_NAME,
                FIELD_CLASS_NAME,
                "resize-none [field-sizing:content]",
                // Opening a title takes the room of the text's second line, not the page's.
                showTitle ? "min-h-5" : "min-h-11",
              )}
            />
          </ComposerInput>
        }
        leadingControls={
          showBufferedDictation ? null : (
            <div className="flex min-w-0 items-center gap-1">
              {images ? (
                <MessageImagePicker
                  onFiles={input.add}
                  choose={images.chooseImages}
                  disabled={readOnly}
                />
              ) : null}
              {leadingAccessory}
            </div>
          )
        }
        trailingControls={
          <div
            className={
              showBufferedDictation
                ? "flex items-center gap-2"
                : "flex items-center justify-end gap-2"
            }
          >
            {dictationSupported ? (
              <InboxDictateButton
                dictation={dictation}
                inlineDictation={inlineDictation}
                show={!showBufferedDictation}
                disabled={readOnly || microphoneBusy}
                textareaRef={textareaRef}
                onStart={prepareDictation}
                preserveEditorFocus={preserveEditorFocus}
              />
            ) : null}
            {showBufferedDictation ? (
              <ComposerBufferedDictationControls
                dictation={dictation}
                preserveEditorFocus={preserveEditorFocus}
                sendDisabled={sendDisabled}
              />
            ) : dictationActive ? (
              <ComposerDictationSendButton
                dictation={dictation}
                label={intl.formatMessage({
                  id: "conversation.localConversationThreadComposer.transcribeAndSend",
                  defaultMessage: "Transcribe and send",
                })}
                preserveEditorFocus={preserveEditorFocus}
                disabled={sendDisabled}
              />
            ) : (
              <>
                {alternate && alternateOffered ? (
                  <ComposerAlternateButton
                    label={alternate.label}
                    icon={alternate.icon}
                    disabled={!canSend}
                    onRun={() => void submit(undefined, true)}
                  />
                ) : null}
                <NodexTooltip
                  tooltipContent={
                    draft.replyTo?.turnEpisode
                      ? intl.formatMessage({
                          id: "inbox.inboxComposer.sendReply",
                          defaultMessage: "Send reply",
                        })
                      : (sendLabel ??
                        intl.formatMessage({
                          id: "inbox.inboxComposer.sendToInbox",
                          defaultMessage: "Send to Inbox",
                        }))
                  }
                  shortcutLabel="↵"
                  side="top"
                >
                  <button
                    type="submit"
                    aria-label={
                      draft.replyTo?.turnEpisode
                        ? intl.formatMessage({
                            id: "inbox.inboxComposer.sendReply",
                            defaultMessage: "Send reply",
                          })
                        : (sendLabel ??
                          intl.formatMessage({
                            id: "inbox.inboxComposer.sendToInbox",
                            defaultMessage: "Send to Inbox",
                          }))
                    }
                    disabled={!canSend}
                    className={cn(
                      COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME,
                      !canSend && "opacity-50",
                    )}
                  >
                    <UpArrowIcon className="icon-sm" />
                  </button>
                </NodexTooltip>
              </>
            )}
          </div>
        }
      />
    </form>
  );
}
/** The composer's alternate action, beside Send; `Cmd/Ctrl+Enter` does the same. */
function ComposerAlternateButton({
  label,
  icon: Icon,
  disabled,
  onRun,
}: {
  readonly label: string;
  readonly icon: ComponentType<{ readonly className?: string }>;
  readonly disabled: boolean;
  readonly onRun: () => void;
}) {
  const platform = resolveCodexRendererCommandPlatform();
  return (
    <NodexTooltip
      tooltipContent={label}
      shortcutLabel={formatAcceleratorLabel(ALTERNATE_ACCELERATOR, platform)}
      side="top"
    >
      <button
        type="button"
        aria-label={label}
        aria-keyshortcuts={
          formatAcceleratorAriaKeyShortcut(ALTERNATE_ACCELERATOR, platform) ?? undefined
        }
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRun}
        className={cn(COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME, disabled && "opacity-50")}
      >
        <Icon className="icon-sm" />
      </button>
    </NodexTooltip>
  );
}

function editorOwnsFocus(textarea: HTMLTextAreaElement | null): boolean {
  return textarea !== null && textarea.ownerDocument.activeElement === textarea;
}

function readTextareaSelection(textarea: HTMLTextAreaElement): DictationTextareaSelection {
  return {
    from: textarea.selectionStart,
    to: textarea.selectionEnd,
    direction: textarea.selectionDirection,
  };
}

function InboxDictateButton({
  dictation,
  inlineDictation,
  show,
  disabled,
  textareaRef,
  onStart,
  preserveEditorFocus,
}: {
  readonly dictation: ComposerDictationController;
  readonly inlineDictation: boolean;
  readonly show: boolean;
  readonly disabled: boolean;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly onStart: () => void;
  readonly preserveEditorFocus: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const keymap = useCommandKeymapState().data;
  useComposerDictationHold({
    enabled: !disabled,
    keymap,
    canStart: () =>
      !dictation.isStarting &&
      !dictation.isDictating &&
      !dictation.isTranscribing &&
      resolveComposerGlobalDictationAdmission({ visible: true, editor: textareaRef.current }) ===
        null,
    startDictation: dictation.startDictation,
    stopDictation: dictation.stopDictation,
  });
  if (!show) return null;
  const displayKeymap =
    keymap ?? createCommandKeymapState({}, resolveCodexRendererCommandPlatform());
  return (
    <ComposerDictateButton
      dictation={dictation}
      supported
      inlineDictation={inlineDictation}
      disabled={disabled}
      shortcutLabel={
        resolveCommandShortcutPresentation(displayKeymap, "composerDictationHold")?.label
      }
      onStart={onStart}
      onMouseDown={preserveEditorFocus}
    />
  );
}

interface DictationSend {
  readonly text: string;
  readonly signal?: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function useInboxComposerDictation({
  textareaRef,
  text,
  onDraftChange,
  sendDraft,
  sendDisabled,
  readOnly,
}: {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly text: string;
  readonly onDraftChange: (change: (draft: InboxDraft) => InboxDraft) => void;
  readonly sendDraft: () => Promise<void>;
  readonly sendDisabled: boolean;
  readonly readOnly: boolean;
}) {
  const state = useComposerDictationCapabilityState(supportsComposerDictation());
  const supported = state?.isEnabled === true && state.capabilities.composer;
  const microphoneBusy = state?.capabilities.microphoneOwner === "realtime-voice";
  const streaming = state?.capabilities.streaming;
  const [targetId] = useState(() => `inbox-composer:${crypto.randomUUID()}`);
  const notify = useComposerDictationNotifications();
  const attached = useRef(false);
  const pendingSelection = useRef<{ text: string; selection: DictationTextareaSelection } | null>(
    null,
  );
  const pendingSend = useRef<DictationSend | null>(null);
  const [sendRequest, setSendRequest] = useState<DictationSend | null>(null);
  const [editor] = useState(createTextareaDictationTarget);

  useLayoutEffect(() => {
    editor.setWriter((before, text, selection) => {
      pendingSelection.current = { text, selection };
      onDraftChange((current) => (current.text === before ? { ...current, text } : current));
    });
  }, [editor, onDraftChange]);

  useLayoutEffect(() => {
    attached.current = true;
    return () => {
      attached.current = false;
      editor.finishComposition();
      pendingSend.current?.resolve();
      pendingSend.current = null;
    };
  }, [editor]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const pending = pendingSelection.current;
    pendingSelection.current = null;
    if (pending?.text === text) {
      const { from, to, direction } = pending.selection;
      textarea.setSelectionRange(from, to, direction);
    }
    editor.observe(text, editorOwnsFocus(textarea) ? readTextareaSelection(textarea) : undefined);
  }, [editor, text, textareaRef]);

  const performSend = useEffectEvent((request: DictationSend) => {
    if (pendingSend.current !== request) return;
    pendingSend.current = null;
    if (request.signal?.aborted || request.text !== text || sendDisabled) {
      request.resolve();
      return;
    }
    void sendDraft().then(request.resolve, request.reject);
  });
  useEffect(() => {
    if (sendRequest) performSend(sendRequest);
  }, [sendRequest]);

  const syncSelection = () => {
    const textarea = textareaRef.current;
    if (textarea && editorOwnsFocus(textarea) && textarea.value === editor.text)
      editor.observe(editor.text, readTextareaSelection(textarea));
  };
  const finish = async (transcript: string, signal?: AbortSignal) => {
    syncSelection();
    const result = await editor.finish(transcript);
    if (result === "cancelled" || signal?.aborted) return false;
    if (result === "not-active") editor.insert(transcript);
    return true;
  };

  const dictation = useComposerDictation({
    enabled: supported,
    microphoneBusy,
    soundsEnabled: state?.capabilities.sounds,
    streamingAvailability: streaming,
    globalTarget: {
      id: targetId,
      priority: 10,
      admission: () =>
        readOnly
          ? "unavailable"
          : resolveComposerGlobalDictationAdmission({
              visible: true,
              editor: textareaRef.current,
            }),
    },
    transcript: {
      preserve: editor.preserve,
      start: (split) => {
        syncSelection();
        editor.start(split);
      },
      update: (transcript, segment) => {
        syncSelection();
        editor.update(transcript, segment);
      },
      cancel: () => {
        syncSelection();
        editor.cancel();
      },
    },
    onTranscriptInsert: async (transcript, signal) => {
      await finish(transcript, signal);
    },
    onTranscriptSend: async (transcript, signal) => {
      if (!(await finish(transcript, signal)) || !attached.current) return;
      // The host may close over its draft. Submit only after it commits the inserted text.
      await new Promise<void>((resolve, reject) => {
        const request = { text: editor.text, signal, resolve, reject };
        pendingSend.current = request;
        setSendRequest(request);
      });
    },
    onTranscriptAppend: (transcript) => editor.append(transcript),
    ...notify,
  });

  const prepareDictation = () => {
    const textarea = textareaRef.current;
    if (!textarea || editorOwnsFocus(textarea)) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    syncSelection();
  };

  return {
    dictation,
    supported,
    microphoneBusy,
    inlineDictation: streaming === "available",
    editor,
    prepareDictation,
  };
}

/** Where a reply to a Nodex post will go, phrased after the post it replies to. */
function ReplyDestinationPhrase({ destination }: { readonly destination: InboxReplyDestination }) {
  const intl = useIntl();
  const chat = destination.chat ? (
    <span className="text-token-foreground">{destination.chat.title}</span>
  ) : null;
  if (destination.kind === "unavailable" && destination.reason) return <>· {destination.reason}</>;
  if (destination.kind === "unavailable")
    return (
      <>
        <FormattedMessage
          id="inbox.inboxComposer.openChatToContinue"
          defaultMessage="· Open chat to continue"
        />
      </>
    );
  if (destination.kind === "nodex" || !chat)
    return (
      <>
        <FormattedMessage
          id="inbox.inboxComposer.nodexRoutesIt"
          defaultMessage="· Nodex routes it"
        />
      </>
    );
  if (destination.kind === "answer")
    return (
      <>
        {intl.formatMessage(
          { id: "inbox.inboxComposer.answersChat", defaultMessage: "· answers {chat}’s question" },
          { chat },
        )}
      </>
    );
  return (
    <>
      {intl.formatMessage(
        { id: "inbox.inboxComposer.goesToChat", defaultMessage: "· goes to {chat}" },
        { chat },
      )}
    </>
  );
}
