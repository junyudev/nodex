import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from "react";
import { resolveContextWindowIndicatorState } from "@/lib/codex-context-window";
import type {
  CodexComposerAppshotContext,
  CodexComposerAppshotTarget,
  CodexComposerIntent,
  CodexPermissionState,
  CodexPromptDocumentInput,
  CodexPromptInput,
  CodexReviewDiffCommentAttachment,
  CodexThreadGoalDraftInput,
  CodexThreadGoalMaterializedDraft,
} from "@/lib/types";
import type { ComposerPickedFile } from "../../../../../shared/ipc-api";
import { DEFAULT_CODEX_HOST_ID } from "../../../../../shared/codex-host";
import { dedupeCodexLiveFileAttachments } from "../../../../../shared/codex-live-file-attachments";
import { useCodexServiceTierSettings } from "@/lib/use-codex-service-tier-settings";
import { useCommandKeymapState } from "@/lib/use-command-keymap-state";
import { resolveCommandShortcutPresentation } from "../../../../../shared/command-keybindings";
import { consumeGlobalDictationShortcutNudge, openMicrophoneSettings } from "@/lib/api";
import { dictationErrorMessage } from "@/features/dictation/dictation-errors";
import {
  createPastedTextAttachment,
  readPastedTextAttachment,
  removePastedTextAttachment,
} from "@/lib/api";
import {
  resolveShortcutKeycapTokens,
  resolveThreadComposerAlternateShortcutAccelerator,
  resolveThreadComposerPrimaryShortcutAccelerator,
} from "@/lib/thread-composer-follow-up-mode";
import {
  resolveComposerSubmitIntentFromKeyDown,
  resolveStageThreadsComposerActionState,
  type StageThreadsBusyAction,
  type StageThreadsComposerFollowUpAction,
  type StageThreadsComposerSubmitAction,
} from "../shared/composer-action";
import { cn } from "../../../../lib/utils";
import {
  CloseIcon,
  GoalClearIcon,
  GoalTargetIcon,
  ComposerAddFilesIcon,
  ComposerResumeIcon,
  ComposerPlanModeCloseIcon,
  ComposerPlanModeIcon,
  MicIcon,
  FileIcon,
  ActivitySpinnerIcon,
  StopIcon,
  UpArrowIcon,
} from "@/components/shared/icons";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { toast } from "@/components/ui/toast";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import { ComposerActionTooltipContent } from "./composer-submit-tooltip";
import { QueuedFollowUpSendDialog } from "./queued-follow-up-send-dialog";
import {
  isComposerDictationShortcut,
  isComposerDictationShortcutTargetBlocked,
  useComposerDictation,
} from "./use-composer-dictation";
import { resolveComposerGlobalDictationAdmission } from "./composer-global-dictation-admission";
import {
  ContextWindowIndicator,
  captureComposerAppshot,
  invokeBrowserSidebarCommand,
  NodexTooltip,
  PermissionModeDropdown,
  pickComposerFiles,
  readComposerPermissionState,
} from "./local-conversation-thread-composer-deps";
import {
  shouldShowThreadComposerStatusStrip,
  ThreadComposerStatusStrip,
} from "./local-conversation-thread-composer-status-strip";
import { ComposerContextRailSlot } from "../composer-context-rail";
import {
  COMPOSER_LARGE_PASTE_CHAR_THRESHOLD,
  ComposerPromptEditor,
  parseComposerPromptMentionLink,
  serializeComposerPromptMentionLink,
  type ComposerPromptMentionInput,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorKeyboardEvent,
  type ComposerSuggestionAction,
} from "./composer-prompt-editor";
import {
  inactiveComposerSuggestionState,
  type ComposerSuggestionState,
} from "./composer-suggestion-state";
import {
  ComposerAdaptiveFooter,
  ComposerInput,
  resolveComposerAdaptiveLayout,
} from "./composer-adaptive-footer";
import { useThreadComposerPromptHistoryRecall } from "./thread-composer-prompt-history";
import { InlineSlashCommandMenu } from "./slash-command-menu/inline-slash-command-menu";
import { ExpandedSlashCommandDialog } from "./slash-command-menu/expanded-slash-command-dialog";
import {
  buildComposerSlashCommands,
  canUseComposerGoal,
} from "./slash-command-menu/slash-command-registry";
import { toggleAvatarOverlay } from "@/lib/avatar-overlay-control";
import {
  filterComposerSlashCommands,
  groupComposerSlashCommandMatches,
  resolveComposerSlashHighlight,
  resolveNextSlashHighlight,
} from "./slash-command-menu/slash-command-filter";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandHighlightIntent,
  ComposerSlashTriggerState,
} from "./slash-command-menu/slash-command-types";
import {
  addReviewDiffCommentAttachment,
  clearReviewDiffCommentAttachments,
  removeReviewDiffCommentAttachment,
} from "@/lib/review-diff-comment-attachment-store";
import {
  formatReviewDiffCommentLineLabel,
  getReviewDiffCommentText,
} from "../../../../../shared/review-diff-comments";
import {
  hasPlanMode,
  resolveNextComposerPlanMode,
  shouldShowComposerPlanKeywordSuggestion,
} from "./composer-plan-mode";
import {
  buildComposerThreadGoalDraft,
  type ComposerThreadGoalDraft,
} from "./composer-thread-goal-draft";
import { getThreadGoalMessage } from "../../thread-goal-copy";
import {
  cleanupMaterializedThreadGoalDraft,
  materializeThreadGoalDraft,
} from "../../thread-goal-materialization";
import {
  COMPOSER_FOOTER_LABEL_NARROW_CLASS_NAME,
  COMPOSER_FOOTER_LABEL_WIDE_CLASS_NAME,
  COMPOSER_FOOTER_PLAN_ACCESSORY_BUTTON_CLASS_NAME,
  ComposerFooterAccessoryDivider,
} from "../shared/composer-footer-controls";
import { AgentIntelligenceDropdown } from "@/components/shared/agent-runtime/agent-intelligence-dropdown";
import {
  clearComposerCompletedDraftAtom,
  composerAddedFilesAtom,
  composerAppshotContextsAtom,
  composerConsumedIntentNonceAtom,
  composerDraftInitializedAtom,
  composerDraftTransferFamily,
  composerFileAttachmentsAtom,
  composerGoalModeActiveAtom,
  composerImageAttachmentsAtom,
  composerPastedTextAttachmentsAtom,
  composerResetGenerationAtom,
  composerReviewCommentAttachmentsFamily,
  useComposerPromptDraft,
  type ComposerCompletedDraftSnapshot,
  type ComposerFileAttachment,
  type ComposerPastedTextAttachment,
} from "./composer-draft-state";
import {
  buildComposerImagePromptInputs,
  classifyComposerDataTransfer,
  ComposerImageAttachmentRow,
  createResolvedComposerImageAttachment,
  isSupportedComposerImageMetadata,
  openComposerImageAttachment,
  selectComposerImagePromptSource,
  useComposerImageAttachments,
  type ComposerImageAttachment,
  type ComposerPastedFiles,
  type ResolvedComposerImageInput,
} from "./image-attachments";
import { buildComposerImageEditAttachments } from "./image-attachments/image-edit-intent-attachments";
import { useScopedAtom, useScopedAtomValue, useScopeHandle, useSetScopedAtom } from "@/lib/maitai";
import { ComposerScope, ThreadScope } from "@/lib/workbench-ui-scopes";
import {
  useComposerIntelligenceController,
  type ComposerIntelligenceController,
} from "./use-composer-intelligence-controller";
import {
  isInterruptedTurnResumeEligible,
  createInterruptedTurnResumeGate,
} from "./interrupted-turn-resume-controller";
import {
  ComposerAddContextMenu,
  type ComposerAddContextMenuHandle,
  ComposerAddContextTrigger,
} from "./composer-add-context-menu";
import { useRightPanelComposerPresentation } from "../right-panel-composer-presentation";
import {
  clearBrowserAnnotationAttachments,
  getBrowserAnnotationAttachmentsSnapshot,
  removeBrowserAnnotationAttachment,
  replaceBrowserAnnotationAttachments,
  subscribeBrowserAnnotationAttachments,
  type BrowserAnnotationAttachment,
} from "../../../browser-sidebar/browser-annotation-attachments";
import {
  consumeBrowserImageAttachments,
  getBrowserImageAttachmentsSnapshot,
  subscribeBrowserImageAttachments,
} from "../../../browser-sidebar/browser-image-attachments";
import {
  clearBrowserImageDragState,
  getBrowserImageDragSnapshot,
  subscribeBrowserImageDragState,
} from "../../../browser-sidebar/browser-image-drag-state";
import {
  clearImageEditComposerDraft,
  compileImageEditComposerPrompt,
  getImageEditComposerDraftSnapshot,
  isImageEditComposerAttachmentId,
  registerImageEditComposerChannel,
  removeImageEditComposerAttachment,
  replaceImageEditComposerDraft,
  subscribeImageEditComposerDraft,
  type ImageEditComposerDraftSnapshot,
  type ImageEditComposerSubmitRequest,
  type ImageEditComposerSubmitResult,
} from "@/lib/image-edit-composer-channel";
import {
  beginOptimisticGeneratedImageEdit,
  resolveImageInputSupport,
  trackImageEditSubmit,
  trackImageEditSubmitOutcome,
  type ImageEditSubmissionIntent,
} from "@/features/user-attachment-image-editor";
import { uploadResourceAsset } from "@/lib/assets";
import { resolveImageEditComposerTarget } from "../../image-edit-composer-target";

interface ThreadComposerProps {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  errorMessage: string | null;
  onErrorMessage: (message: string | null) => void;
  contextRailLeadingContent?: ReactNode;
  intelligenceController?: ComposerIntelligenceController;
}

function isElectronLikeComposerEnvironment(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (window.api) {
    return true;
  }

  return document.documentElement.dataset.codexWindowType === "electron";
}

interface ComposerAttachmentState {
  fileAttachments: readonly ComposerFileAttachment[];
  addedFiles: readonly ComposerFileAttachment[];
  imageAttachments: readonly ComposerImageAttachment[];
  appshotContexts: readonly CodexComposerAppshotContext[];
  pastedTextAttachments: readonly ComposerPastedTextAttachment[];
  commentAttachments: readonly CodexReviewDiffCommentAttachment[];
  browserAnnotationAttachments: readonly BrowserAnnotationAttachment[];
}

interface ThreadGoalSubmissionDraft extends ComposerThreadGoalDraft {
  imageAttachments: NonNullable<CodexThreadGoalDraftInput["imageAttachments"]>;
  pastedTextAttachments: NonNullable<CodexThreadGoalDraftInput["pastedTextAttachments"]>;
  hasUnsupportedAttachments: boolean;
}

interface ThreadGoalReplacementConfirmationState {
  draft: ThreadGoalSubmissionDraft;
}

function createComposerAttachmentId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getComposerPickedFileName(file: ComposerPickedFile): string {
  return file.label.trim() || file.path.split(/[\\/]/u).filter(Boolean).at(-1) || "Attachment";
}

function isComposerImageFile(file: ComposerPickedFile): boolean {
  return isSupportedComposerImageMetadata({
    filename: getComposerPickedFileName(file),
    mimeType: file.mimeType,
    size: file.bytes,
  });
}

function hasComposerFileDataTransfer(dataTransfer: DataTransfer): boolean {
  return (
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file") ||
    Array.from(dataTransfer.types ?? []).includes("Files") ||
    (dataTransfer.files?.length ?? 0) > 0
  );
}

function extractComposerPromptMentions(prompt: string): {
  readonly text: string;
  readonly documentItems: readonly CodexPromptDocumentInput[];
  readonly mentions: NonNullable<CodexPromptInput["mentions"]>;
  readonly skills: NonNullable<CodexPromptInput["skills"]>;
} {
  const documentItems: CodexPromptDocumentInput[] = [];
  const mentions: NonNullable<CodexPromptInput["mentions"]> = [];
  const skills: NonNullable<CodexPromptInput["skills"]> = [];
  const textParts: string[] = [];
  const mentionPattern = /\[([^\]\n]+)\]\(([^)\n]+)\)/gu;
  let cursor = 0;

  for (const match of prompt.matchAll(mentionPattern)) {
    const rawLabel = match[1] ?? "";
    const rawPath = match[2] ?? "";
    const mention = parseComposerPromptMentionLink(rawLabel, rawPath);
    if (!mention) continue;

    const precedingText = prompt.slice(cursor, match.index);
    if (precedingText) {
      textParts.push(precedingText);
      documentItems.push({ type: "text", text: precedingText });
    }
    if (mention.kind === "skill") {
      const skill = { name: mention.name, path: mention.path };
      skills.push(skill);
      documentItems.push({ type: "skill", ...skill });
    } else {
      const promptMention = { name: mention.name, path: mention.path };
      mentions.push(promptMention);
      documentItems.push({ type: "mention", ...promptMention });
    }
    cursor = match.index + match[0].length;
  }

  const trailingText = prompt.slice(cursor);
  if (trailingText) {
    textParts.push(trailingText);
    documentItems.push({ type: "text", text: trailingText });
  }

  return {
    text: textParts.join(""),
    documentItems,
    mentions,
    skills,
  };
}

function buildComposerPromptInput(input: {
  prompt: string;
  attachments: ComposerAttachmentState;
  executionHostId?: string | null;
}): CodexPromptInput | undefined {
  const parsedPrompt = extractComposerPromptMentions(input.prompt);
  const text = parsedPrompt.text;
  const executionHostId =
    input.executionHostId === undefined ? DEFAULT_CODEX_HOST_ID : input.executionHostId;
  const images = [
    ...buildComposerImagePromptInputs(input.attachments.imageAttachments, executionHostId),
  ];
  const appshots = input.attachments.appshotContexts.map((context) => ({
    ...context,
  }));
  const textAttachments = input.attachments.pastedTextAttachments.flatMap((attachment) =>
    attachment.status === "ready"
      ? [{ ...attachment.attachment, file: { ...attachment.attachment.file } }]
      : [],
  );
  const fileAttachments = dedupeCodexLiveFileAttachments(
    input.attachments.fileAttachments.map((item) => item.attachment),
  ).map((attachment) => ({ ...attachment }));
  const addedFiles = dedupeCodexLiveFileAttachments(
    input.attachments.addedFiles.map((item) => item.attachment),
  ).map((attachment) => ({ ...attachment }));
  const mentions = parsedPrompt.mentions;
  const skills = parsedPrompt.skills;
  const commentAttachments = [...input.attachments.commentAttachments];
  const browserAnnotationAttachments = [...input.attachments.browserAnnotationAttachments];

  if (
    images.length === 0 &&
    appshots.length === 0 &&
    textAttachments.length === 0 &&
    fileAttachments.length === 0 &&
    addedFiles.length === 0 &&
    mentions.length === 0 &&
    skills.length === 0 &&
    commentAttachments.length === 0 &&
    browserAnnotationAttachments.length === 0
  ) {
    return undefined;
  }

  return {
    text,
    ...(parsedPrompt.documentItems.length > 0
      ? { documentItems: [...parsedPrompt.documentItems] }
      : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(appshots.length > 0 ? { appshots } : {}),
    ...(textAttachments.length > 0 ? { textAttachments } : {}),
    ...(fileAttachments.length > 0 ? { fileAttachments } : {}),
    ...(addedFiles.length > 0 ? { addedFiles } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(commentAttachments.length > 0 ? { commentAttachments } : {}),
    ...(browserAnnotationAttachments.length > 0 ? { browserAnnotationAttachments } : {}),
  };
}

function getComposerAttachmentNameFromPath(path: string, fallback: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? fallback;
}

function serializePersistedPromptMention(mention: {
  readonly name: string;
  readonly path: string;
}): string {
  const parsed = parseComposerPromptMentionLink(`@${mention.name}`, mention.path);
  return serializeComposerPromptMentionLink(
    parsed ?? {
      kind: "file",
      name: mention.name,
      displayName: mention.name,
      path: mention.path,
    },
  );
}

function buildPersistedMentionPrompt(promptInput?: CodexPromptInput): string {
  return [
    ...(promptInput?.mentions ?? []).map(serializePersistedPromptMention),
    ...(promptInput?.skills ?? []).map((skill) =>
      serializeComposerPromptMentionLink({
        kind: "skill",
        name: skill.name,
        displayName: skill.name,
        path: skill.path,
      }),
    ),
  ].join(" ");
}

function buildPersistedPromptDocument(promptInput?: CodexPromptInput): string | null {
  if (!promptInput?.documentItems) return null;
  return promptInput.documentItems
    .map((item) => {
      switch (item.type) {
        case "text":
          return item.text;
        case "mention":
          return serializePersistedPromptMention(item);
        case "skill":
          return serializeComposerPromptMentionLink({
            kind: "skill",
            name: item.name,
            displayName: item.name,
            path: item.path,
          });
      }
    })
    .join("");
}

function mergePersistedMentionPrompt(prompt: string, mentionPrompt: string): string {
  if (!mentionPrompt) return prompt;
  if (!prompt) return `${mentionPrompt} `;
  const separator = /\s$/u.test(prompt) ? "" : " ";
  return `${prompt}${separator}${mentionPrompt} `;
}

function appendPersistedPromptDocument(prompt: string, documentPrompt: string): string {
  if (!documentPrompt) return prompt;
  if (!prompt) return documentPrompt;
  const separator = /\s$/u.test(prompt) || /^\s/u.test(documentPrompt) ? "" : " ";
  return `${prompt}${separator}${documentPrompt}`;
}

function removePersistedMentionPrompt(prompt: string): string {
  return prompt
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/gu, (serialized, rawLabel: string, rawPath: string) => {
      const mention = parseComposerPromptMentionLink(rawLabel, rawPath);
      return mention ? "" : serialized;
    })
    .trimEnd();
}

function buildComposerAttachmentStateFromPromptInput(
  promptInput?: CodexPromptInput,
): ComposerAttachmentState {
  const fileAttachments = dedupeCodexLiveFileAttachments(promptInput?.fileAttachments ?? []).map(
    (attachment) => ({
      uiId: createComposerAttachmentId("file"),
      attachment: { ...attachment },
    }),
  );
  const addedFiles = dedupeCodexLiveFileAttachments(promptInput?.addedFiles ?? []).map(
    (attachment) => ({
      uiId: createComposerAttachmentId("added_file"),
      attachment: { ...attachment },
    }),
  );
  return {
    imageAttachments: (promptInput?.images ?? []).flatMap((image) => {
      const source = image.source.trim();
      const isAbsoluteLocalPath = source.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(source);
      const restored = createResolvedComposerImageAttachment({
        id: createComposerAttachmentId("image"),
        generation: 0,
        value: {
          filename: image.caption?.trim() || getComposerAttachmentNameFromPath(source, "Image"),
          mimeType: source.match(/^data:([^;,]+)/iu)?.[1] ?? "image/png",
          src: source,
          origin: "restored",
          ...(isAbsoluteLocalPath
            ? {
                hostId: DEFAULT_CODEX_HOST_ID,
                localPath: source,
              }
            : {}),
        },
      });
      return restored ? [restored] : [];
    }),
    appshotContexts: (promptInput?.appshots ?? []).map((context) => ({
      ...context,
    })),
    pastedTextAttachments: (promptInput?.textAttachments ?? []).map((attachment) => {
      const id = createComposerAttachmentId("pasted_text");
      if (!("text" in attachment)) {
        const fileBacked = { ...attachment, file: { ...attachment.file } };
        return {
          id,
          status: "ready" as const,
          preview: fileBacked.preview,
          characterCount: fileBacked.characterCount ?? 0,
          attachment: fileBacked,
        };
      }

      if (attachment.file) {
        const fileBacked = {
          file: { ...attachment.file },
          preview: attachment.preview ?? summarizeComposerPastedText(attachment.text),
          ...(attachment.hostId === undefined ? {} : { hostId: attachment.hostId }),
          characterCount: attachment.characterCount ?? attachment.text.length,
        };
        return {
          id,
          status: "ready" as const,
          preview: fileBacked.preview,
          characterCount: fileBacked.characterCount,
          attachment: fileBacked,
        };
      }

      return {
        id,
        status: "failed" as const,
        generation: 0,
        preview: attachment.preview ?? summarizeComposerPastedText(attachment.text),
        characterCount: attachment.characterCount ?? attachment.text.length,
        error: "Paste this text again to attach it.",
      };
    }),
    fileAttachments,
    addedFiles,
    commentAttachments: promptInput?.commentAttachments ?? [],
    browserAnnotationAttachments: promptInput?.browserAnnotationAttachments ?? [],
  };
}

function canStartNewThreadTarget(model: ThreadFooterModel): boolean {
  return Boolean(
    model.isNewThreadTab &&
    model.newThreadTarget !== null &&
    !model.isCloudNewThreadTarget &&
    !model.newThreadStartBlockedReason &&
    Boolean(model.newThreadTarget.sessionId),
  );
}

function hasComposerAttachmentStateContent(attachments: ComposerAttachmentState): boolean {
  return (
    attachments.fileAttachments.length > 0 ||
    attachments.addedFiles.length > 0 ||
    attachments.imageAttachments.length > 0 ||
    attachments.appshotContexts.length > 0 ||
    attachments.pastedTextAttachments.length > 0 ||
    attachments.commentAttachments.length > 0 ||
    attachments.browserAnnotationAttachments.length > 0
  );
}

function hasSubmittableComposerAttachmentState(attachments: ComposerAttachmentState): boolean {
  return (
    attachments.fileAttachments.length > 0 ||
    attachments.addedFiles.length > 0 ||
    attachments.imageAttachments.length > 0 ||
    attachments.appshotContexts.length > 0 ||
    attachments.pastedTextAttachments.some((attachment) => attachment.status === "ready") ||
    attachments.commentAttachments.length > 0 ||
    attachments.browserAnnotationAttachments.length > 0
  );
}

function summarizeComposerPastedText(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) return "Pasted text";
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 79)}…`;
}

function buildThreadGoalSubmissionDraft(
  draft: ComposerThreadGoalDraft,
  attachments: ComposerAttachmentState,
  executionHostId: string,
): ThreadGoalSubmissionDraft {
  const imageAttachments = attachments.imageAttachments.flatMap((attachment) => {
    const src = selectComposerImagePromptSource(attachment, executionHostId);
    if (!src) return [];
    return [
      {
        src,
        localPath:
          attachment.materialization?.hostId === executionHostId
            ? attachment.materialization.localPath
            : null,
        filename: attachment.filename,
      },
    ];
  });
  return {
    ...draft,
    imageAttachments,
    pastedTextAttachments: attachments.pastedTextAttachments.flatMap((attachment) =>
      attachment.status === "ready"
        ? [{ ...attachment.attachment, file: { ...attachment.attachment.file } }]
        : [],
    ),
    hasUnsupportedAttachments:
      attachments.fileAttachments.length > 0 ||
      attachments.addedFiles.length > 0 ||
      attachments.appshotContexts.length > 0 ||
      attachments.commentAttachments.length > 0 ||
      attachments.browserAnnotationAttachments.length > 0 ||
      imageAttachments.length !== attachments.imageAttachments.length,
  };
}

function parseSideChatCommand(prompt: string): string | null {
  const match = prompt.match(/^\/side(?:\s+([\s\S]*))?$/u);
  if (!match) return null;
  return (match[1] ?? "").trim();
}

export const __composerAddContextTestUtils = {
  buildComposerAttachmentStateFromPromptInput,
  buildComposerPromptInput,
  buildPersistedMentionPrompt,
  buildPersistedPromptDocument,
  isComposerImageFile,
  removePersistedMentionPrompt,
};

function ActiveComposerModeChip({
  model,
  onToggle,
}: {
  model: ThreadFooterModel;
  onToggle: () => void;
}) {
  if (model.selectedCollaborationMode !== "plan") {
    return null;
  }

  return (
    <NodexTooltip
      tooltipContent={<PlanModeTooltipContent />}
      side="top"
      align="center"
      sideOffset={4}
      tooltipBodyClassName="text-center"
    >
      <button
        type="button"
        aria-label="Plan"
        className={COMPOSER_FOOTER_PLAN_ACCESSORY_BUTTON_CLASS_NAME}
        onClick={() => {
          onToggle();
        }}
      >
        <ComposerPlanModeIcon className="group-hover:hidden" />
        <ComposerPlanModeCloseIcon className="hidden group-hover:block" />
        <span className={COMPOSER_FOOTER_LABEL_NARROW_CLASS_NAME}>Plan</span>
      </button>
    </NodexTooltip>
  );
}

function ActiveGoalModeChip({ active, onClear }: { active: boolean; onClear: () => void }) {
  if (!active) {
    return null;
  }

  return (
    <NodexTooltip
      tooltipContent={
        <span className="text-token-foreground">
          {getThreadGoalMessage("composer.goalModeIndicator.tooltip")}
        </span>
      }
      side="top"
      align="center"
      sideOffset={4}
    >
      <button
        type="button"
        aria-label={getThreadGoalMessage("composer.goalModeIndicator.clear")}
        className={COMPOSER_FOOTER_PLAN_ACCESSORY_BUTTON_CLASS_NAME}
        onClick={() => {
          onClear();
        }}
      >
        <GoalTargetIcon className="icon-xs shrink-0 group-hover:hidden" />
        <GoalClearIcon className="icon-xs hidden shrink-0 group-hover:block" />
        <span className={COMPOSER_FOOTER_LABEL_WIDE_CLASS_NAME}>
          {getThreadGoalMessage("composer.goalModeIndicator")}
        </span>
      </button>
    </NodexTooltip>
  );
}

function ThreadGoalReplacementConfirmationDialog({
  confirmation,
  pending,
  onCancel,
  onConfirm,
}: {
  confirmation: ThreadGoalReplacementConfirmationState | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!confirmation) {
    return null;
  }

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>
              {getThreadGoalMessage("composer.threadGoal.replaceConfirmation.title")}
            </NodexDialogTitle>
            <NodexDialogDescription>
              {getThreadGoalMessage("composer.threadGoal.replaceConfirmation.subtitle")}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <div className="line-clamp-4 rounded-lg bg-token-bg-secondary px-3 py-2 text-sm text-token-foreground">
              {confirmation.draft.objective}
            </div>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction disabled={pending} onClick={onCancel}>
              {getThreadGoalMessage("composer.threadGoal.replaceConfirmation.cancel")}
            </NodexDialogAction>
            <NodexDialogAction tone="primary" type="submit" disabled={pending}>
              {getThreadGoalMessage("composer.threadGoal.replaceConfirmation.confirm")}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function PlanModeTooltipContent() {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span>Create a plan</span>
      <span className="inline-flex items-center gap-1 text-token-description-foreground">
        <ShortcutKeycaps keys={["Shift + Tab"]} />
        <span>to toggle</span>
      </span>
    </div>
  );
}

function PlanKeywordSuggestion({
  onUsePlanMode,
  onDismiss,
}: {
  onUsePlanMode: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="@container pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 flex justify-center"
      data-plan-keyword-suggestion="true"
    >
      <div className="pointer-events-auto flex w-full max-w-full justify-center">
        <div
          className="relative inline-flex max-w-full min-w-0 items-center justify-between gap-4 overflow-hidden rounded-3xl border border-token-border/80 bg-token-dropdown-background/90 py-1.5 pr-2 pl-3 text-token-foreground shadow-md backdrop-blur-sm"
          data-codex-above-composer-suggestion="keyword-plan-mode"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex items-center justify-center text-token-foreground">
              <ComposerPlanModeIcon className="icon-xs shrink-0" />
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-sm leading-[18px] font-medium text-token-foreground">
                Create a plan
              </span>
              <span className="hidden text-sm leading-none text-token-description-foreground @[500px]:inline">
                <button
                  type="button"
                  className="border-token-border no-drag cursor-interaction pointer-events-none flex !h-auto items-center gap-1 rounded-md border bg-token-bg-fog px-1 py-0.5 text-xs leading-[18px] !leading-none whitespace-nowrap text-token-button-tertiary-foreground select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background"
                  aria-hidden="true"
                  tabIndex={-1}
                >
                  Shift + Tab
                </button>
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="border-token-border no-drag cursor-interaction flex items-center gap-1 rounded-full border border-transparent bg-token-foreground/5 px-2.5 py-0.5 text-sm leading-[18px] whitespace-nowrap text-token-foreground select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:bg-token-foreground/10 data-[state=open]:bg-token-foreground/10"
              data-codex-above-composer-suggestion-action="true"
              onClick={(event) => {
                event.stopPropagation();
                onUsePlanMode();
              }}
            >
              Use plan mode
            </button>
            <button
              type="button"
              aria-label="Dismiss suggestion"
              className="no-drag flex size-[22px] shrink-0 cursor-interaction items-center justify-center rounded-full border border-transparent text-token-description-foreground select-none hover:bg-token-list-hover-background focus:outline-none"
              onClick={(event) => {
                event.stopPropagation();
                onDismiss();
              }}
            >
              <CloseIcon className="icon-xs" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ModelSelectorDropdown({
  model,
  controller,
}: {
  model: ThreadFooterModel;
  controller: ComposerIntelligenceController;
}) {
  const selection = controller.selection as Extract<
    ComposerIntelligenceController["selection"],
    { kind: "codex" }
  >;

  return (
    <AgentIntelligenceDropdown
      models={model.availableModels}
      selection={selection}
      open={controller.isOpen}
      onOpenChange={controller.setOpen}
      onSelectionChange={(nextSelection) => controller.select(nextSelection)}
      triggerRef={controller.triggerRef}
      shortcut={model.modelPickerShortcut}
    />
  );
}

function replaceReviewCommentAttachments(
  threadId: string | null,
  attachments: readonly CodexReviewDiffCommentAttachment[],
): void {
  clearReviewDiffCommentAttachments(threadId);
  for (const attachment of attachments) addReviewDiffCommentAttachment(threadId, attachment);
}

function appendUniqueBy<Value>(
  current: readonly Value[],
  incoming: readonly Value[],
  getKey: (value: Value) => string,
): readonly Value[] {
  const next = new Map(current.map((value) => [getKey(value), value] as const));
  for (const value of incoming) next.set(getKey(value), value);
  return [...next.values()];
}

function applyCompletedDraftSnapshot(input: {
  snapshot: ComposerCompletedDraftSnapshot;
  setFileAttachments: (value: readonly ComposerFileAttachment[]) => void;
  setAddedFiles: (value: readonly ComposerFileAttachment[]) => void;
  setImageAttachments: (value: readonly ComposerImageAttachment[]) => void;
  setAppshotContexts: (value: readonly CodexComposerAppshotContext[]) => void;
  setPastedTextAttachments: (value: readonly ComposerPastedTextAttachment[]) => void;
  setGoalModeActive: (value: boolean) => void;
  threadId: string | null;
}): void {
  input.setFileAttachments(input.snapshot.fileAttachments);
  input.setAddedFiles(input.snapshot.addedFiles);
  input.setImageAttachments(input.snapshot.imageAttachments);
  input.setAppshotContexts(input.snapshot.appshotContexts);
  input.setPastedTextAttachments(input.snapshot.pastedTextAttachments);
  input.setGoalModeActive(input.snapshot.goalModeActive);
  replaceReviewCommentAttachments(input.threadId, input.snapshot.commentAttachments);
}

interface HydratedThreadComposerProps extends ThreadComposerProps {
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  readonly clearSubmittedDraft: () => void;
  readonly intelligenceController: ComposerIntelligenceController;
  readonly queuedFollowUpEdit: CodexComposerIntent["queuedFollowUpEdit"] | null;
  readonly clearQueuedFollowUpEdit: () => void;
}

export function ThreadComposer(props: ThreadComposerProps) {
  if (props.intelligenceController) {
    return (
      <ControlledThreadComposer {...props} intelligenceController={props.intelligenceController} />
    );
  }

  return <ThreadComposerWithOwnedIntelligence {...props} />;
}

function ThreadComposerWithOwnedIntelligence(props: ThreadComposerProps) {
  const intelligenceController = useComposerIntelligenceController(props.model, props.actions);
  return <ControlledThreadComposer {...props} intelligenceController={intelligenceController} />;
}

function ControlledThreadComposer(
  props: ThreadComposerProps & {
    readonly intelligenceController: ComposerIntelligenceController;
  },
) {
  const { model, actions, onErrorMessage } = props;
  const { intelligenceController } = props;
  const { floating: isFloatingComposer } = useRightPanelComposerPresentation();
  const composerThreadId = model.conversation?.threadId ?? model.threadId;
  const browserAnnotationConversationId =
    composerThreadId ?? model.newThreadTarget?.sessionId ?? null;
  const promptDraft = useComposerPromptDraft(composerThreadId);
  const [initialized, setInitialized] = useScopedAtom(composerDraftInitializedAtom);
  const [consumedIntentNonce, setConsumedIntentNonce] = useScopedAtom(
    composerConsumedIntentNonceAtom,
  );
  const [, setFileAttachments] = useScopedAtom(composerFileAttachmentsAtom);
  const [, setAddedFiles] = useScopedAtom(composerAddedFilesAtom);
  const [, setImageAttachments] = useScopedAtom(composerImageAttachmentsAtom);
  const [, setAppshotContexts] = useScopedAtom(composerAppshotContextsAtom);
  const [, setPastedTextAttachments] = useScopedAtom(composerPastedTextAttachmentsAtom);
  const [, setGoalModeActive] = useScopedAtom(composerGoalModeActiveAtom);
  const resetGeneration = useScopedAtomValue(composerResetGenerationAtom);
  const clearCompletedDraft = useSetScopedAtom(clearComposerCompletedDraftAtom);
  const submittedDraftCleanupRef = useRef({
    clearCompletedDraft,
    clearPromptDraft: promptDraft.clear,
    composerThreadId,
    onErrorMessage,
  });
  const composerHandle = useScopeHandle(ComposerScope);
  const transferDefinition = composerDraftTransferFamily(
    composerThreadId ?? `inactive:${composerHandle.path}`,
  );
  const [transfer, setTransfer] = useScopedAtom(transferDefinition);
  const consumedIntentNonceRef = useRef(consumedIntentNonce);
  const [queuedFollowUpEdit, setQueuedFollowUpEdit] = useState<
    CodexComposerIntent["queuedFollowUpEdit"] | null
  >(null);
  const consumedTransferIdRef = useRef<string | null>(null);
  const intent = model.composerIntent ?? model.newThreadComposerIntent ?? null;

  useLayoutEffect(() => {
    if (promptDraft.loadable.status === "loading") return;

    if (
      transfer &&
      composerThreadId &&
      transfer.targetConversationId === composerThreadId &&
      consumedTransferIdRef.current !== transfer.transferId
    ) {
      consumedTransferIdRef.current = transfer.transferId;
      applyCompletedDraftSnapshot({
        snapshot: transfer,
        setFileAttachments,
        setAddedFiles,
        setImageAttachments,
        setAppshotContexts,
        setPastedTextAttachments,
        setGoalModeActive,
        threadId: composerThreadId,
      });
      void promptDraft.setPrompt(transfer.prompt).catch((error: unknown) => {
        onErrorMessage(error instanceof Error ? error.message : "Could not restore composer draft");
      });
      setTransfer(null);
    }

    if (intent && consumedIntentNonceRef.current !== intent.focusNonce) {
      consumedIntentNonceRef.current = intent.focusNonce;
      if (intent.queuedFollowUpEdit) setQueuedFollowUpEdit(intent.queuedFollowUpEdit);
      const restored = buildComposerAttachmentStateFromPromptInput(intent.promptInput);
      const mentionPrompt = buildPersistedMentionPrompt(intent.promptInput);
      const documentPrompt = buildPersistedPromptDocument(intent.promptInput);
      const append = intent.attachmentMode === "append";
      if (append) {
        setFileAttachments((current) =>
          appendUniqueBy(
            current,
            restored.fileAttachments,
            (attachment) =>
              attachment.attachment.fsPath ?? attachment.attachment.path ?? attachment.uiId,
          ),
        );
        setAddedFiles((current) =>
          appendUniqueBy(
            current,
            restored.addedFiles,
            (attachment) =>
              attachment.attachment.fsPath ?? attachment.attachment.path ?? attachment.uiId,
          ),
        );
        setImageAttachments((current) =>
          appendUniqueBy(current, restored.imageAttachments, (attachment) => attachment.id),
        );
        setAppshotContexts((current) =>
          appendUniqueBy(current, restored.appshotContexts, (context) => context.id),
        );
        setPastedTextAttachments((current) =>
          appendUniqueBy(current, restored.pastedTextAttachments, (attachment) => attachment.id),
        );
        for (const attachment of restored.commentAttachments) {
          addReviewDiffCommentAttachment(composerThreadId, attachment);
        }
        if (browserAnnotationConversationId) {
          replaceBrowserAnnotationAttachments(
            browserAnnotationConversationId,
            appendUniqueBy(
              getBrowserAnnotationAttachmentsSnapshot(browserAnnotationConversationId),
              restored.browserAnnotationAttachments,
              (attachment) => attachment.id,
            ),
          );
        }
      } else {
        setFileAttachments(restored.fileAttachments);
        setAddedFiles(restored.addedFiles);
        setImageAttachments(restored.imageAttachments);
        setAppshotContexts(restored.appshotContexts);
        setPastedTextAttachments(restored.pastedTextAttachments);
        replaceReviewCommentAttachments(composerThreadId, restored.commentAttachments);
        if (browserAnnotationConversationId) {
          replaceBrowserAnnotationAttachments(
            browserAnnotationConversationId,
            restored.browserAnnotationAttachments,
          );
        }
      }

      if (
        intent.prompt.length > 0 ||
        intent.clearText === true ||
        mentionPrompt.length > 0 ||
        documentPrompt !== null
      ) {
        const nextPrompt =
          intent.clearText === true
            ? ""
            : documentPrompt !== null
              ? append
                ? appendPersistedPromptDocument(promptDraft.prompt, documentPrompt)
                : documentPrompt
              : mergePersistedMentionPrompt(
                  append
                    ? intent.prompt || promptDraft.prompt
                    : removePersistedMentionPrompt(intent.prompt || promptDraft.prompt),
                  mentionPrompt,
                );
        void promptDraft.setPrompt(nextPrompt).catch((error: unknown) => {
          onErrorMessage(
            error instanceof Error ? error.message : "Could not apply composer intent",
          );
        });
      }
      setConsumedIntentNonce(intent.focusNonce);
      if (composerThreadId) {
        actions.onConsumeComposerIntent(composerThreadId, intent.focusNonce);
      } else if (model.newThreadTarget?.sessionId) {
        actions.onConsumeNewThreadComposerIntent?.(
          model.newThreadTarget.sessionId,
          intent.focusNonce,
        );
      }
    }

    if (!initialized) setInitialized(true);
  }, [
    actions,
    browserAnnotationConversationId,
    composerThreadId,
    initialized,
    intent,
    model.newThreadTarget?.sessionId,
    onErrorMessage,
    promptDraft,
    setAddedFiles,
    setAppshotContexts,
    setConsumedIntentNonce,
    setFileAttachments,
    setGoalModeActive,
    setImageAttachments,
    setInitialized,
    setPastedTextAttachments,
    setTransfer,
    transfer,
  ]);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      void promptDraft.setPrompt(nextPrompt).catch((error: unknown) => {
        onErrorMessage(error instanceof Error ? error.message : "Could not save composer draft");
      });
    },
    [onErrorMessage, promptDraft],
  );
  useLayoutEffect(() => {
    submittedDraftCleanupRef.current = {
      clearCompletedDraft,
      clearPromptDraft: promptDraft.clear,
      composerThreadId,
      onErrorMessage,
    };
  }, [clearCompletedDraft, composerThreadId, onErrorMessage, promptDraft.clear]);
  const clearSubmittedDraft = useCallback(() => {
    const cleanup = submittedDraftCleanupRef.current;
    cleanup.clearCompletedDraft();
    clearReviewDiffCommentAttachments(cleanup.composerThreadId);
    void cleanup.clearPromptDraft().catch((error: unknown) => {
      cleanup.onErrorMessage(
        error instanceof Error ? error.message : "Could not clear composer draft",
      );
    });
  }, []);

  if (promptDraft.loadable.status === "loading" || !initialized) {
    return (
      <div
        data-composer-draft-hydration="loading"
        className={cn(
          "border border-token-border bg-token-main-surface-primary",
          isFloatingComposer ? "h-11 rounded-full" : "min-h-24 rounded-[20px]",
        )}
      />
    );
  }

  return (
    <HydratedThreadComposer
      key={resetGeneration}
      {...props}
      intelligenceController={intelligenceController}
      prompt={promptDraft.prompt}
      setPrompt={setPrompt}
      clearSubmittedDraft={clearSubmittedDraft}
      queuedFollowUpEdit={queuedFollowUpEdit}
      clearQueuedFollowUpEdit={() => setQueuedFollowUpEdit(null)}
    />
  );
}

function HydratedThreadComposer({
  model,
  actions,
  errorMessage,
  onErrorMessage,
  contextRailLeadingContent,
  prompt,
  setPrompt,
  clearSubmittedDraft,
  queuedFollowUpEdit,
  clearQueuedFollowUpEdit,
  intelligenceController,
}: HydratedThreadComposerProps) {
  const {
    floating: isFloatingComposer,
    presentation: composerPresentation,
    visible: composerVisible,
  } = useRightPanelComposerPresentation();
  const composerScopeKey = useScopeHandle(ComposerScope).path;
  const [globalDictationTargetId] = useState(() => `composer:${crypto.randomUUID()}`);
  const threadScopePath = useScopeHandle(ThreadScope).path;
  const canStartNewThread = canStartNewThreadTarget(model);
  const [busyAction, setBusyAction] = useState<StageThreadsBusyAction>(null);
  const [permissionState, setPermissionState] = useState<CodexPermissionState | null>(null);
  const [fileAttachments, setFileAttachments] = useScopedAtom(composerFileAttachmentsAtom);
  const [addedFiles, setAddedFiles] = useScopedAtom(composerAddedFilesAtom);
  const [imageAttachments, setImageAttachments] = useScopedAtom(composerImageAttachmentsAtom);
  const [appshotContexts, setAppshotContexts] = useScopedAtom(composerAppshotContextsAtom);
  const [pastedTextAttachments, setPastedTextAttachments] = useScopedAtom(
    composerPastedTextAttachmentsAtom,
  );
  const [suggestionState, setSuggestionState] = useState<ComposerSuggestionState>(() =>
    inactiveComposerSuggestionState(),
  );
  const [inlineSlashHighlightIntent, setInlineSlashHighlightIntent] =
    useState<ComposerSlashCommandHighlightIntent>({
      commandId: null,
      source: "programmatic",
    });
  const [nestedSlashCommand, setNestedSlashCommand] = useState<ComposerSlashCommand | null>(null);
  const [slashDialogOpen, setSlashDialogOpen] = useState(false);
  const [planKeywordSuggestionDismissed, setPlanKeywordSuggestionDismissed] = useState(false);
  const [goalModeActive, setGoalModeActive] = useScopedAtom(composerGoalModeActiveAtom);
  const [goalReplacementConfirmation, setGoalReplacementConfirmation] =
    useState<ThreadGoalReplacementConfirmationState | null>(null);
  const [pausedQueueSendDialogOpen, setPausedQueueSendDialogOpen] = useState(false);
  const [promptIntrinsicWidthPx, setPromptIntrinsicWidthPx] = useState<number | null>(null);
  const [compactInputWidthPx, setCompactInputWidthPx] = useState<number | null>(null);
  const [isFileDragActive, setFileDragActive] = useState(false);
  useEffect(() => {
    if (
      pausedQueueSendDialogOpen &&
      model.composerShell.queuedFollowUpStatus === "ready" &&
      model.composerShell.hasInterruptedQueuedFollowUps !== true
    ) {
      setPausedQueueSendDialogOpen(false);
    }
  }, [
    model.composerShell.hasInterruptedQueuedFollowUps,
    model.composerShell.queuedFollowUpStatus,
    pausedQueueSendDialogOpen,
  ]);
  const promptEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const addContextMenuRef = useRef<ComposerAddContextMenuHandle>(null);
  const appendPromptToHistoryRef = useRef<(text: string) => void>(() => {});
  const resetPromptHistorySelectionRef = useRef<() => void>(() => {});
  const dictationShortcutActiveRef = useRef(false);
  const fileDragDepthRef = useRef(0);
  const attachmentGenerationRef = useRef(0);
  const pastedTextSourcesRef = useRef(new Map<string, string>());
  const pastedTextOperationGenerationRef = useRef(new Map<string, number>());
  const pastedTextOperationCounterRef = useRef(0);
  const composerMountedRef = useRef(true);
  const [resumeAttemptGate] = useState(createInterruptedTurnResumeGate);
  const { serviceTierSettings, setServiceTier } = useCodexServiceTierSettings();
  const commandKeymapQuery = useCommandKeymapState();
  const dictationShortcutPresentation = resolveCommandShortcutPresentation(
    commandKeymapQuery.data,
    "composerDictationHold",
    "Ctrl+M",
  );
  const composerThreadId = model.conversation?.threadId ?? model.threadId;
  const imageEditComposerTarget = resolveImageEditComposerTarget({
    composerScopeIdentity: model.composerScopeIdentity,
    isSideChat: model.conversation?.source?.sideConversation === true,
    threadScopePath,
  });
  const imageEditComposerChannelId = imageEditComposerTarget.channelId;
  useEffect(() => {
    promptEditorRef.current?.syncMentionMetadata({
      apps: model.composerApps ?? [],
      plugins: model.composerPlugins ?? [],
      skills: model.composerSkills ?? [],
    });
  }, [model.composerApps, model.composerPlugins, model.composerSkills]);
  const browserAnnotationConversationId =
    composerThreadId ?? model.newThreadTarget?.sessionId ?? "";
  const getBrowserAnnotationsSnapshot = useCallback(
    () => getBrowserAnnotationAttachmentsSnapshot(browserAnnotationConversationId),
    [browserAnnotationConversationId],
  );
  const browserAnnotationAttachments = useSyncExternalStore(
    subscribeBrowserAnnotationAttachments,
    getBrowserAnnotationsSnapshot,
    getBrowserAnnotationsSnapshot,
  );
  const getBrowserImagesSnapshot = useCallback(
    () => getBrowserImageAttachmentsSnapshot(browserAnnotationConversationId),
    [browserAnnotationConversationId],
  );
  const browserImageAttachments = useSyncExternalStore(
    subscribeBrowserImageAttachments,
    getBrowserImagesSnapshot,
    getBrowserImagesSnapshot,
  );
  const getBrowserImageDrag = useCallback(
    () => getBrowserImageDragSnapshot(browserAnnotationConversationId),
    [browserAnnotationConversationId],
  );
  const browserImageDrag = useSyncExternalStore(
    subscribeBrowserImageDragState,
    getBrowserImageDrag,
    getBrowserImageDrag,
  );
  const getImageEditDraftSnapshot = useCallback(
    () => getImageEditComposerDraftSnapshot(imageEditComposerChannelId),
    [imageEditComposerChannelId],
  );
  const subscribeImageEditDraft = useCallback(
    (listener: () => void) => subscribeImageEditComposerDraft(imageEditComposerChannelId, listener),
    [imageEditComposerChannelId],
  );
  const imageEditDraft = useSyncExternalStore(
    subscribeImageEditDraft,
    getImageEditDraftSnapshot,
    getImageEditDraftSnapshot,
  );
  const imageInputSupported = resolveImageInputSupport({
    models: model.availableModels,
    selectedModel: model.selectedModel,
  });
  const imageAttachmentsRef = useRef(imageAttachments);
  imageAttachmentsRef.current = imageAttachments;
  const handleOpenComposerImage = useCallback(
    (attachmentId: string) => {
      const attachment = imageAttachmentsRef.current.find(
        (candidate) => candidate.id === attachmentId,
      );
      if (!attachment) return;
      void openComposerImageAttachment({
        attachment,
        attachmentCount: imageAttachmentsRef.current.length,
        composerTarget: imageEditComposerTarget,
        policy: "edit_button",
        projectId: model.projectId,
        threadId: composerThreadId,
      });
    },
    [composerThreadId, imageEditComposerTarget, model.projectId],
  );
  const imageAttachmentController = useComposerImageAttachments({
    attachments: imageAttachments,
    setAttachments: setImageAttachments,
    scopeKey: composerScopeKey,
    enabled: imageInputSupported,
    onError: (message) => onErrorMessage(message),
    onOpen: handleOpenComposerImage,
    onRemove: (attachmentId) => {
      if (isImageEditComposerAttachmentId(attachmentId)) {
        removeImageEditComposerAttachment(imageEditComposerChannelId, attachmentId);
      }
    },
  });
  useEffect(() => {
    if (browserImageAttachments.length === 0) return;
    const attachmentIds = browserImageAttachments.map((attachment) => attachment.id);
    imageAttachmentController.addResolvedImages(
      browserImageAttachments.map((attachment): ResolvedComposerImageInput => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.source.match(/^data:([^;,]+)/iu)?.[1] ?? "image/png",
        src: attachment.source,
        origin: "browser",
        hostId: DEFAULT_CODEX_HOST_ID,
        managedSource: attachment.source,
      })),
    );
    consumeBrowserImageAttachments(browserAnnotationConversationId, attachmentIds);
  }, [browserAnnotationConversationId, browserImageAttachments, imageAttachmentController]);
  useEffect(() => {
    imageAttachmentController.syncResolvedImages(
      "image-editor",
      imageEditDraft.attachments.map((attachment): ResolvedComposerImageInput => {
        const { asset } = attachment;
        return {
          filename: attachment.filename,
          id: attachment.id,
          mimeType: asset.src.match(/^data:([^;,]+)/iu)?.[1] ?? "image/png",
          src: asset.src,
          origin: "image-editor",
          ...(asset.hostId && (asset.localPath || asset.managedSource)
            ? {
                hostId: asset.hostId,
                localPath: asset.localPath,
                managedSource: asset.managedSource,
              }
            : {}),
        };
      }),
    );
  }, [imageAttachmentController, imageEditDraft]);
  const commentAttachments = useScopedAtomValue(
    composerReviewCommentAttachmentsFamily(composerThreadId),
  );
  const attachmentState = useMemo<ComposerAttachmentState>(
    () => ({
      fileAttachments,
      addedFiles,
      imageAttachments,
      appshotContexts,
      pastedTextAttachments,
      commentAttachments,
      browserAnnotationAttachments,
    }),
    [
      addedFiles,
      appshotContexts,
      browserAnnotationAttachments,
      commentAttachments,
      fileAttachments,
      imageAttachments,
      pastedTextAttachments,
    ],
  );
  const hasAttachments = hasComposerAttachmentStateContent(attachmentState);
  const hasSubmittableAttachments = hasSubmittableComposerAttachmentState(attachmentState);
  const hasVisibleNonImageAttachments =
    fileAttachments.length > 0 ||
    addedFiles.length > 0 ||
    appshotContexts.length > 0 ||
    pastedTextAttachments.length > 0 ||
    commentAttachments.length > 0 ||
    browserAnnotationAttachments.length > 0;
  const hasPendingPastedTextAttachments = pastedTextAttachments.some(
    (attachment) => attachment.status === "pending",
  );
  const latestTurnStatus = model.conversation?.turns.at(-1)?.status ?? null;
  const hasResumeInterruptedTurnCapability = Boolean(
    actions.onResumeInterruptedTurn && model.conversation && !hasPendingPastedTextAttachments,
  );
  const pastedTextAttachmentsRef = useRef(pastedTextAttachments);
  pastedTextAttachmentsRef.current = pastedTextAttachments;
  const incrementAttachmentGeneration = useCallback(() => {
    attachmentGenerationRef.current += 1;
  }, []);

  const runPastedTextMaterialization = useCallback(
    (input: {
      readonly id: string;
      readonly text: string;
      readonly preview: string;
      readonly characterCount: number;
      readonly generation: number;
    }) => {
      void createPastedTextAttachment({ text: input.text })
        .then((attachment) => {
          const isCurrent =
            composerMountedRef.current &&
            pastedTextOperationGenerationRef.current.get(input.id) === input.generation;
          if (!isCurrent) {
            return removePastedTextAttachment({ file: attachment.file }).catch(() => undefined);
          }

          pastedTextSourcesRef.current.delete(input.id);
          pastedTextOperationGenerationRef.current.delete(input.id);
          setPastedTextAttachments((current) =>
            current.map((item) =>
              item.id === input.id &&
              item.status === "pending" &&
              item.generation === input.generation
                ? {
                    id: input.id,
                    status: "ready",
                    preview: attachment.preview,
                    characterCount: attachment.characterCount ?? input.characterCount,
                    attachment,
                  }
                : item,
            ),
          );
        })
        .catch((error: unknown) => {
          if (
            !composerMountedRef.current ||
            pastedTextOperationGenerationRef.current.get(input.id) !== input.generation
          ) {
            return;
          }

          setPastedTextAttachments((current) =>
            current.map((item) =>
              item.id === input.id &&
              item.status === "pending" &&
              item.generation === input.generation
                ? {
                    id: input.id,
                    status: "failed",
                    generation: input.generation,
                    preview: input.preview,
                    characterCount: input.characterCount,
                    error: error instanceof Error ? error.message : "Could not add pasted text.",
                  }
                : item,
            ),
          );
        });
    },
    [setPastedTextAttachments],
  );

  const handleLargeTextPaste = useCallback(
    (text: string): boolean => {
      const id = createComposerAttachmentId("pasted_text");
      pastedTextOperationCounterRef.current += 1;
      const generation = pastedTextOperationCounterRef.current;
      const preview = summarizeComposerPastedText(text);
      pastedTextSourcesRef.current.set(id, text);
      pastedTextOperationGenerationRef.current.set(id, generation);
      setPastedTextAttachments((current) => [
        ...current,
        {
          id,
          status: "pending",
          generation,
          preview,
          characterCount: text.length,
        },
      ]);
      runPastedTextMaterialization({
        id,
        text,
        preview,
        characterCount: text.length,
        generation,
      });
      return true;
    },
    [runPastedTextMaterialization, setPastedTextAttachments],
  );

  const addOrdinaryComposerFiles = useCallback(
    async (files: readonly File[], source: "paste" | "drop"): Promise<void> => {
      if (files.length === 0) return;
      if (model.isCloudNewThreadTarget) {
        onErrorMessage("Only images can be added to this composer");
        return;
      }

      const results = await Promise.allSettled(
        files.map(async (file) => {
          let localPath =
            source === "drop" ? (window.api?.getPathForFile?.(file).trim() ?? "") : "";
          if (!localPath) {
            const saved = await uploadResourceAsset(file);
            localPath = window.api?.resolveManagedAssetPath?.(saved.source)?.trim() ?? "";
          }
          if (!localPath) throw new Error(`Could not materialize ${file.name || "file"}`);
          return {
            uiId: createComposerAttachmentId("file"),
            attachment: {
              label: file.name.trim() || getComposerAttachmentNameFromPath(localPath, "Attachment"),
              path: localPath,
              fsPath: localPath,
            },
          } satisfies ComposerFileAttachment;
        }),
      );
      if (!composerMountedRef.current) return;

      const completed = results.flatMap((result): ComposerFileAttachment[] =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (completed.length > 0) {
        setFileAttachments((current) => {
          const combined = [...current, ...completed];
          const retained = new Set(
            dedupeCodexLiveFileAttachments(combined.map((item) => item.attachment)),
          );
          return combined.filter((item) => retained.has(item.attachment));
        });
      }

      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) {
        onErrorMessage(
          failure.reason instanceof Error
            ? failure.reason.message
            : "Could not add one or more files",
        );
      }
    },
    [model.isCloudNewThreadTarget, onErrorMessage, setFileAttachments],
  );

  const handlePasteFiles = useCallback(
    (payload: ComposerPastedFiles): boolean => {
      if (payload.imageFiles.length > 0) {
        void imageAttachmentController.addFiles(payload.imageFiles, "paste");
      }
      if (payload.otherFiles.length > 0) {
        void addOrdinaryComposerFiles(payload.otherFiles, "paste");
      }
      return payload.imageFiles.length > 0 || payload.otherFiles.length > 0;
    },
    [addOrdinaryComposerFiles, imageAttachmentController],
  );

  const handleRetryPastedTextAttachment = useCallback(
    (attachmentId: string) => {
      const text = pastedTextSourcesRef.current.get(attachmentId);
      const attachment = pastedTextAttachmentsRef.current.find((item) => item.id === attachmentId);
      if (!text || !attachment || attachment.status !== "failed") return;

      pastedTextOperationCounterRef.current += 1;
      const generation = pastedTextOperationCounterRef.current;
      pastedTextOperationGenerationRef.current.set(attachmentId, generation);
      setPastedTextAttachments((current) =>
        current.map((item) =>
          item.id === attachmentId
            ? {
                id: item.id,
                status: "pending",
                generation,
                preview: item.preview,
                characterCount: item.characterCount,
              }
            : item,
        ),
      );
      runPastedTextMaterialization({
        id: attachmentId,
        text,
        preview: attachment.preview,
        characterCount: attachment.characterCount,
        generation,
      });
    },
    [runPastedTextMaterialization, setPastedTextAttachments],
  );

  useEffect(() => {
    const pastedTextSources = pastedTextSourcesRef.current;
    const pastedTextOperationGenerations = pastedTextOperationGenerationRef.current;
    composerMountedRef.current = true;
    return () => {
      composerMountedRef.current = false;
      pastedTextSources.clear();
      pastedTextOperationGenerations.clear();
    };
  }, []);
  const recordSuccessfulPromptSubmit = useCallback((text: string) => {
    appendPromptToHistoryRef.current(text);
    resetPromptHistorySelectionRef.current();
  }, []);
  const clearAdmittedSubmission = useCallback(() => {
    incrementAttachmentGeneration();
    clearBrowserAnnotationAttachments(browserAnnotationConversationId);
    clearImageEditComposerDraft(imageEditComposerChannelId);
    clearSubmittedDraft();
  }, [
    browserAnnotationConversationId,
    clearSubmittedDraft,
    imageEditComposerChannelId,
    incrementAttachmentGeneration,
  ]);
  const completeSuccessfulSubmission = useCallback(
    (text: string) => {
      recordSuccessfulPromptSubmit(text);
      clearAdmittedSubmission();
    },
    [clearAdmittedSubmission, recordSuccessfulPromptSubmit],
  );
  const restoreAdmittedSubmission = useCallback(
    (input: {
      readonly prompt: string;
      readonly attachments: ComposerAttachmentState;
      readonly imageEditDraft: ImageEditComposerDraftSnapshot;
      readonly goalModeActive?: boolean;
    }) => {
      setPrompt(input.prompt);
      setFileAttachments(input.attachments.fileAttachments);
      setAddedFiles(input.attachments.addedFiles);
      setImageAttachments(input.attachments.imageAttachments);
      setAppshotContexts(input.attachments.appshotContexts);
      setPastedTextAttachments(input.attachments.pastedTextAttachments);
      replaceReviewCommentAttachments(
        model.conversation?.threadId ?? model.threadId,
        input.attachments.commentAttachments,
      );
      if (browserAnnotationConversationId) {
        replaceBrowserAnnotationAttachments(
          browserAnnotationConversationId,
          input.attachments.browserAnnotationAttachments,
        );
      }
      replaceImageEditComposerDraft(imageEditComposerChannelId, {
        attachments: input.imageEditDraft.attachments,
        mode: input.imageEditDraft.mode,
      });
      if (input.goalModeActive) setGoalModeActive(true);
    },
    [
      browserAnnotationConversationId,
      imageEditComposerChannelId,
      model.conversation?.threadId,
      model.threadId,
      setAddedFiles,
      setAppshotContexts,
      setFileAttachments,
      setGoalModeActive,
      setImageAttachments,
      setPastedTextAttachments,
      setPrompt,
    ],
  );
  const readSubmittedPastedTextFiles = useCallback(
    () =>
      pastedTextAttachmentsRef.current.flatMap((attachment) =>
        attachment.status === "ready" ? [attachment.attachment.file] : [],
      ),
    [],
  );
  const cleanupSubmittedPastedTextAttachments = useCallback(
    async (readyAttachments = readSubmittedPastedTextFiles()) => {
      await Promise.allSettled(
        readyAttachments.map((file) => removePastedTextAttachment({ file })),
      );
    },
    [readSubmittedPastedTextFiles],
  );

  const submitThreadGoalDraft = useCallback(
    async (draft: ThreadGoalSubmissionDraft): Promise<boolean> => {
      if (draft.hasUnsupportedAttachments) {
        toast.danger(getThreadGoalMessage("composer.threadGoal.materializeError"), {
          id: "thread-goal-materialize-failed",
        });
        return false;
      }

      if (!model.conversation) {
        const target = model.newThreadTarget;
        if (!target?.sessionId || !actions.onStartThreadForSession) {
          onErrorMessage("Session thread creation is not available.");
          return false;
        }

        setBusyAction("send");
        onErrorMessage(null);
        let prompt = draft.objective;
        const threadGoalDraft: CodexThreadGoalDraftInput = {
          objective: draft.objective,
          imageAttachments: draft.imageAttachments.map((attachment) => ({ ...attachment })),
          pastedTextAttachments: draft.pastedTextAttachments.map((attachment) => ({
            ...attachment,
          })),
        };
        let threadGoalMaterializedDraft: CodexThreadGoalMaterializedDraft | undefined;
        if (target.runInTarget !== "newWorktree") {
          let materialized: CodexThreadGoalMaterializedDraft;
          try {
            materialized = await materializeThreadGoalDraft(threadGoalDraft);
          } catch {
            toast.danger(getThreadGoalMessage("composer.threadGoal.materializeError"), {
              id: "thread-goal-materialize-failed",
            });
            setBusyAction(null);
            return false;
          }
          prompt = materialized.objective;
          threadGoalMaterializedDraft = materialized;
        }

        try {
          const startCompletion = actions.onStartThreadForSession({
            projectId: target.projectId,
            sessionId: target.sessionId,
            projectDraftId: target.projectDraftId,
            prompt,
            threadGoalDraft,
            ...(threadGoalMaterializedDraft === undefined ? {} : { threadGoalMaterializedDraft }),
            runInTarget: target.runInTarget,
            runInEnvironmentPath: target.runInEnvironmentPath,
            worktreeStartingState: target.worktreeStartingState,
          });
          clearAdmittedSubmission();
          await startCompletion;
          recordSuccessfulPromptSubmit(draft.objective);
          return true;
        } catch (error) {
          if (threadGoalMaterializedDraft) {
            await cleanupMaterializedThreadGoalDraft(threadGoalMaterializedDraft);
          }
          restoreAdmittedSubmission({
            prompt: draft.objective,
            attachments: attachmentState,
            imageEditDraft,
            goalModeActive: true,
          });
          onErrorMessage(error instanceof Error ? error.message : "Could not start thread goal");
          return false;
        } finally {
          setBusyAction(null);
        }
      }

      if (!actions.onSetThreadGoal) {
        onErrorMessage(getThreadGoalMessage("composer.threadGoal.setError"));
        return false;
      }

      setBusyAction("send");
      onErrorMessage(null);
      let materialized: CodexThreadGoalMaterializedDraft | null = null;
      try {
        materialized = await materializeThreadGoalDraft({
          objective: draft.objective,
          imageAttachments: draft.imageAttachments,
          pastedTextAttachments: draft.pastedTextAttachments,
        });
      } catch {
        toast.danger(getThreadGoalMessage("composer.threadGoal.materializeError"), {
          id: "thread-goal-materialize-failed",
        });
        setBusyAction(null);
        return false;
      }

      try {
        await actions.onSetThreadGoal({
          threadId: model.conversation.threadId,
          objective: materialized.objective,
          status: "active",
        });
        materialized = null;
        completeSuccessfulSubmission(draft.objective);
        return true;
      } catch {
        await cleanupMaterializedThreadGoalDraft(materialized);
        toast.danger(getThreadGoalMessage("composer.threadGoal.setError"), {
          id: "thread-goal-set-failed",
        });
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [
      actions,
      attachmentState,
      clearAdmittedSubmission,
      completeSuccessfulSubmission,
      imageEditDraft,
      model.conversation,
      onErrorMessage,
      model.newThreadTarget,
      recordSuccessfulPromptSubmit,
      restoreAdmittedSubmission,
    ],
  );

  const finalizeEditedQueuedFollowUp = useCallback(async () => {
    if (!queuedFollowUpEdit || !model.conversation) return;
    try {
      await actions.onRemoveQueuedFollowUp(
        model.conversation.threadId,
        queuedFollowUpEdit.followUpId,
      );
    } catch {
      toast.danger("The message was sent, but its original queued copy could not be removed", {
        id: "queued-follow-up-edit-finalize-failed",
      });
    } finally {
      clearQueuedFollowUpEdit();
    }
  }, [actions, clearQueuedFollowUpEdit, model.conversation, queuedFollowUpEdit]);

  const submitPrompt = useCallback(
    async (input: {
      prompt: string;
      submitAction: StageThreadsComposerSubmitAction | null;
      imageEditIntent?: ImageEditSubmissionIntent;
      pausedQueueResolution?: "resume" | "clear";
    }): Promise<boolean> => {
      if (hasPendingPastedTextAttachments) return false;
      if (!imageInputSupported && (imageAttachments.length > 0 || input.imageEditIntent)) {
        onErrorMessage("Remove images or switch models to send this message");
        return false;
      }
      const executionHostId = model.isCloudNewThreadTarget ? null : model.hostId;
      const intentImageAttachments = input.imageEditIntent
        ? buildComposerImageEditAttachments({
            currentAttachments: imageAttachments,
            intent: input.imageEditIntent,
            executionHostId,
            generation: attachmentGenerationRef.current,
          })
        : null;
      if (input.imageEditIntent && !intentImageAttachments) {
        onErrorMessage("One or more images could not be read. Add them again and retry.");
        return false;
      }
      const effectiveImageAttachments = intentImageAttachments ?? imageAttachments;
      const effectiveAttachmentState: ComposerAttachmentState = input.imageEditIntent
        ? { ...attachmentState, imageAttachments: effectiveImageAttachments }
        : attachmentState;
      const submittedPastedTextFiles = readSubmittedPastedTextFiles();
      const nextPrompt =
        input.imageEditIntent?.promptRaw ??
        compileImageEditComposerPrompt({
          draft: imageEditDraft,
          generalInstructions: input.prompt,
        });
      const isImageEditFollowUp = Boolean(input.imageEditIntent) || imageEditDraft.mode !== null;
      const trimmedPrompt = nextPrompt.trim();
      if (
        buildComposerImagePromptInputs(effectiveImageAttachments, executionHostId).length !==
        effectiveImageAttachments.length
      ) {
        onErrorMessage(
          "One or more images are unavailable on the selected execution host. Remove them or add them again.",
        );
        return false;
      }
      const promptInput = buildComposerPromptInput({
        prompt: nextPrompt,
        attachments: effectiveAttachmentState,
        executionHostId,
      });
      const hasPromptAttachments = promptInput !== undefined;
      const target = model.newThreadTarget;
      const goalActionAvailable =
        model.conversation !== null
          ? Boolean(actions.onSetThreadGoal)
          : Boolean(actions.onStartThreadForSession) && canStartNewThread;
      const goalDraftResult = buildComposerThreadGoalDraft({
        promptRaw: nextPrompt,
        goalActionAvailable,
        goalModeActive: isImageEditFollowUp ? false : goalModeActive,
        hasAttachments: hasSubmittableComposerAttachmentState(effectiveAttachmentState),
      });

      if (goalDraftResult.status === "empty") {
        setGoalModeActive(false);
        return false;
      }

      if (goalDraftResult.status === "ready") {
        const currentGoal = model.conversation?.threadGoal ?? null;
        const submissionDraft = buildThreadGoalSubmissionDraft(
          goalDraftResult.draft,
          effectiveAttachmentState,
          model.hostId,
        );
        if (
          currentGoal &&
          (currentGoal.objective !== submissionDraft.objective || submissionDraft.hasAttachments)
        ) {
          setGoalReplacementConfirmation({
            draft: submissionDraft,
          });
          return false;
        }

        const submitted = await submitThreadGoalDraft(submissionDraft);
        if (submitted) await finalizeEditedQueuedFollowUp();
        return submitted;
      }

      if (!trimmedPrompt && !hasPromptAttachments) {
        return false;
      }

      const sideChatPrompt = parseSideChatCommand(trimmedPrompt);
      if (sideChatPrompt !== null) {
        if (model.conversation?.source?.sideConversation === true) {
          toast.danger("'/side' is unavailable in side chats. Return to the main thread first", {
            id: "side-chat-unavailable-in-side-chat",
          });
          return false;
        }
        if (!model.conversation || !actions.onOpenSideChat) {
          toast.danger("Failed to open side chat", {
            id: "side-chat-open-failed",
          });
          return false;
        }

        setBusyAction("send");
        onErrorMessage(null);
        try {
          const sideChatPromptInput = buildComposerPromptInput({
            prompt: sideChatPrompt,
            attachments: effectiveAttachmentState,
            executionHostId: model.hostId,
          });
          await actions.onOpenSideChat({
            prompt: sideChatPrompt,
            promptInput: sideChatPromptInput,
          });
          await finalizeEditedQueuedFollowUp();
          await cleanupSubmittedPastedTextAttachments(submittedPastedTextFiles);
          completeSuccessfulSubmission(sideChatPrompt);
          return true;
        } catch {
          toast.danger("Failed to open side chat", {
            id: "side-chat-open-failed",
          });
          return false;
        } finally {
          setBusyAction(null);
        }
      }

      if (
        model.conversation &&
        !model.isThreadRunning &&
        model.composerShell.hasInterruptedQueuedFollowUps === true &&
        actions.onResolveQueuedFollowUpsAfterFreshStart &&
        input.pausedQueueResolution === undefined
      ) {
        setPausedQueueSendDialogOpen(true);
        return false;
      }

      setBusyAction("send");
      onErrorMessage(null);
      const optimisticImageEdit =
        isImageEditFollowUp &&
        model.conversation &&
        (input.imageEditIntent
          ? input.imageEditIntent.attachments.some(
              (attachment) => attachment.image.source === "generated",
            )
          : imageEditDraft.attachments.some((attachment) => attachment.imageSource === "generated"))
          ? beginOptimisticGeneratedImageEdit(model.conversation.threadId)
          : null;
      let completedFirstSubmission = false;

      try {
        if (!model.conversation) {
          if (!target) return false;
          if (target.sessionId) {
            if (!actions.onStartThreadForSession) {
              onErrorMessage("Session thread creation is not available.");
              return false;
            }
            const startCompletion = actions.onStartThreadForSession({
              projectId: target.projectId,
              sessionId: target.sessionId,
              projectDraftId: target.projectDraftId,
              prompt: nextPrompt,
              promptInput,
              runInTarget: target.runInTarget,
              runInEnvironmentPath: target.runInEnvironmentPath,
              worktreeStartingState: target.worktreeStartingState,
            });
            clearAdmittedSubmission();
            completedFirstSubmission = true;
            await startCompletion;
            recordSuccessfulPromptSubmit(nextPrompt);
          } else {
            onErrorMessage("Select a session before starting a new thread.");
            return false;
          }
        } else if (model.isThreadRunning) {
          if (isImageEditFollowUp || input.submitAction === "queue") {
            if (queuedFollowUpEdit && actions.onReplaceQueuedFollowUp) {
              const replaced = await actions.onReplaceQueuedFollowUp(
                model.conversation.threadId,
                queuedFollowUpEdit.followUpId,
                queuedFollowUpEdit.ledgerRevision,
                nextPrompt,
                {
                  collaborationMode: model.selectedCollaborationMode,
                  promptInput,
                },
              );
              if (!replaced)
                throw new Error("The queued message changed before it could be edited");
              clearQueuedFollowUpEdit();
            } else {
              await actions.onEnqueueQueuedFollowUp(model.conversation.threadId, nextPrompt, {
                collaborationMode: model.selectedCollaborationMode,
                promptInput,
              });
              await finalizeEditedQueuedFollowUp();
            }
          } else if (input.submitAction === "steer") {
            if (!model.activeTurn || model.activeTurn.turnId === null) {
              onErrorMessage(
                "Nodex is already running. Wait for the active turn to load or queue the follow-up instead.",
              );
              return false;
            }
            await actions.onSteerPrompt({
              expectedTurnId: model.activeTurn.turnId,
              prompt: nextPrompt,
              promptInput,
              collaborationMode: model.selectedCollaborationMode,
            });
            await finalizeEditedQueuedFollowUp();
          } else {
            onErrorMessage(
              "Nodex is already running. Choose Queue or Steer before submitting a follow-up.",
            );
            return false;
          }
        } else {
          const queuedFollowUpResolution =
            input.pausedQueueResolution &&
            model.composerShell.hasInterruptedQueuedFollowUps === true &&
            actions.onResolveQueuedFollowUpsAfterFreshStart
              ? {
                  resolution: input.pausedQueueResolution,
                  ledgerRevision: model.composerShell.queuedFollowUpLedgerRevision ?? 0,
                  resolve: actions.onResolveQueuedFollowUpsAfterFreshStart,
                }
              : null;
          await intelligenceController.flush();
          await actions.onSendPrompt(nextPrompt, {
            collaborationMode: model.selectedCollaborationMode,
            promptInput,
            ...intelligenceController.turnOverrides,
          });
          if (queuedFollowUpResolution) {
            try {
              await queuedFollowUpResolution.resolve(
                model.conversation.threadId,
                queuedFollowUpResolution.ledgerRevision,
                queuedFollowUpResolution.resolution,
              );
            } catch {
              toast.danger("The message was sent, but the paused queue could not be updated", {
                id: "queued-follow-up-fresh-start-resolution-failed",
              });
            }
          }
          await finalizeEditedQueuedFollowUp();
        }
        if (target?.runInTarget !== "newWorktree") {
          await cleanupSubmittedPastedTextAttachments(submittedPastedTextFiles);
        }
        if (isImageEditFollowUp) {
          if (input.imageEditIntent) {
            trackImageEditSubmit({
              ...input.imageEditIntent.analytics,
              imageSource: input.imageEditIntent.attachments[0]?.image.source ?? "uploaded",
              mode: input.imageEditIntent.mode,
            });
          } else {
            for (const imageSource of ["generated", "uploaded"] as const) {
              const attachments = imageEditDraft.attachments.filter(
                (attachment) => attachment.imageSource === imageSource,
              );
              if (attachments.length === 0) continue;
              const commentCount = attachments.reduce(
                (count, attachment) => count + attachment.comments.length,
                0,
              );
              if (imageSource === "uploaded" && commentCount === 0) continue;
              trackImageEditSubmit({
                commentCount: commentCount > 0 ? commentCount : undefined,
                hasGeneralInstruction: input.prompt.trim().length > 0,
                imageSource,
                mode: commentCount > 0 ? "comment" : "select",
                selectedImageCount: attachments.length,
              });
            }
          }
        }
        if (!completedFirstSubmission) {
          completeSuccessfulSubmission(nextPrompt);
        }
        return true;
      } catch (error) {
        optimisticImageEdit?.rollback();
        if (completedFirstSubmission) {
          // Submission admission clears the draft immediately so its presentation can move to the
          // transcript. A terminal launch failure restores the exact local payload, making the
          // ordinary Send action the explicit retry path (and therefore a new launch identity).
          restoreAdmittedSubmission({
            prompt: input.imageEditIntent ? nextPrompt : input.prompt,
            attachments: effectiveAttachmentState,
            imageEditDraft,
          });
        }
        onErrorMessage(error instanceof Error ? error.message : "Could not send prompt");
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [
      actions,
      attachmentState,
      canStartNewThread,
      clearAdmittedSubmission,
      completeSuccessfulSubmission,
      clearQueuedFollowUpEdit,
      finalizeEditedQueuedFollowUp,
      goalModeActive,
      hasPendingPastedTextAttachments,
      imageAttachments,
      imageEditDraft,
      imageInputSupported,
      intelligenceController,
      model.activeTurn,
      model.composerShell,
      model.conversation,
      model.hostId,
      model.isCloudNewThreadTarget,
      model.isThreadRunning,
      model.newThreadTarget,
      model.selectedCollaborationMode,
      queuedFollowUpEdit,
      recordSuccessfulPromptSubmit,
      readSubmittedPastedTextFiles,
      onErrorMessage,
      cleanupSubmittedPastedTextAttachments,
      restoreAdmittedSubmission,
      setGoalModeActive,
      submitThreadGoalDraft,
    ],
  );
  const isDictationSupported = useMemo(
    () =>
      model.dictation.isEnabled &&
      model.dictation.capabilities.composer &&
      isElectronLikeComposerEnvironment() &&
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined",
    [model.dictation.capabilities.composer, model.dictation.isEnabled],
  );
  const isRealtimeVoiceActive = model.dictation.capabilities.microphoneOwner === "realtime-voice";

  const insertDictationTranscript = useCallback(
    (transcript: string): string => {
      const normalizedTranscript = transcript.trim();
      if (normalizedTranscript.length === 0) {
        return prompt;
      }

      const editor = promptEditorRef.current;
      if (editor) {
        return editor.insertText(normalizedTranscript);
      }

      const nextPrompt = `${prompt}${normalizedTranscript}`;
      setPrompt(nextPrompt);
      return nextPrompt;
    },
    [prompt, setPrompt],
  );

  const handleInsertPromptMention = useCallback((mention: ComposerPromptMentionInput) => {
    promptEditorRef.current?.insertMention(mention);
  }, []);

  const handleToggleDesktopPet = useCallback(() => {
    void toggleAvatarOverlay().catch(() => {
      toast.danger("Could not open the desktop pet");
    });
  }, []);

  const activateGoalMode = useCallback(() => {
    setGoalModeActive(true);
    setPlanKeywordSuggestionDismissed(true);
    if (model.selectedCollaborationMode !== "plan") {
      return;
    }

    const nextMode = resolveNextComposerPlanMode({
      currentMode: model.selectedCollaborationMode,
      modes: model.collaborationModes,
    });
    if (nextMode) {
      void actions.onCollaborationModeChange(nextMode);
    }
  }, [actions, model.collaborationModes, model.selectedCollaborationMode, setGoalModeActive]);

  const clearFooterGoal = useCallback(() => {
    const savedGoal = model.conversation?.threadGoal ?? null;
    const clearThreadGoal = actions.onClearThreadGoal;
    setGoalModeActive(false);

    if (!savedGoal || !clearThreadGoal) {
      return;
    }

    void (async () => {
      try {
        await clearThreadGoal(savedGoal.threadId);
        promptEditorRef.current?.focusAtEnd();
      } catch {
        toast.danger(getThreadGoalMessage("composer.threadGoal.clearError"));
      }
    })();
  }, [actions.onClearThreadGoal, model.conversation?.threadGoal, setGoalModeActive]);

  const handlePickComposerFiles = useCallback(async () => {
    const imagesOnly = model.isCloudNewThreadTarget;
    attachmentGenerationRef.current += 1;
    const generation = attachmentGenerationRef.current;

    try {
      const pickedFiles = await pickComposerFiles({
        imagesOnly,
        title: imagesOnly ? "Select photos" : "Select files",
      });
      if (attachmentGenerationRef.current !== generation || pickedFiles.length === 0) {
        return;
      }

      const nextFileAttachments: ComposerFileAttachment[] = [];
      const nextImageFiles: ComposerPickedFile[] = [];

      for (const pickedFile of pickedFiles) {
        if (!isComposerImageFile(pickedFile)) {
          if (!imagesOnly) {
            nextFileAttachments.push({
              uiId: createComposerAttachmentId("file"),
              attachment: {
                label: getComposerPickedFileName(pickedFile),
                path: pickedFile.path,
                fsPath: pickedFile.path,
              },
            });
          }
          continue;
        }

        if (pickedFile.imageDataUrl) nextImageFiles.push(pickedFile);
      }

      if (attachmentGenerationRef.current !== generation) {
        return;
      }
      if (nextFileAttachments.length > 0) {
        setFileAttachments((current) => {
          const combined = [...current, ...nextFileAttachments];
          const retained = new Set(
            dedupeCodexLiveFileAttachments(combined.map((item) => item.attachment)),
          );
          return combined.filter((item) => retained.has(item.attachment));
        });
      }
      imageAttachmentController.addPickedFiles(nextImageFiles);
    } catch (error) {
      onErrorMessage(error instanceof Error ? error.message : "Could not add files");
    }
  }, [imageAttachmentController, model.isCloudNewThreadTarget, onErrorMessage, setFileAttachments]);

  const handleCaptureAppshot = useCallback(
    async (target: CodexComposerAppshotTarget): Promise<void> => {
      attachmentGenerationRef.current += 1;
      const generation = attachmentGenerationRef.current;
      try {
        const context = await captureComposerAppshot({
          targetId: target.id,
        });
        if (attachmentGenerationRef.current !== generation) return;
        setAppshotContexts((current) => appendUniqueBy(current, [context], (item) => item.id));
      } catch (error) {
        toast.danger("Unable to attach Appshot", {
          description:
            error instanceof Error ? error.message : `Could not capture ${target.appName}`,
        });
      }
    },
    [setAppshotContexts],
  );

  const handleComposerDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!browserImageDrag && !hasComposerFileDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      fileDragDepthRef.current += 1;
      setFileDragActive(true);
    },
    [browserImageDrag],
  );

  const handleComposerDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (fileDragDepthRef.current === 0) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragActive(false);
  }, []);

  const handleComposerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!browserImageDrag && !hasComposerFileDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    [browserImageDrag],
  );

  const handleBrowserImageDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (!browserImageDrag) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      try {
        const result = await invokeBrowserSidebarCommand({
          type: "attach-dragged-image",
          browserConversationId: browserImageDrag.browserConversationId,
          browserViewScopeId: browserImageDrag.browserViewScopeId,
          browserTabId: browserImageDrag.browserTabId,
        });
        if (!result.ok) onErrorMessage(result.message);
      } catch (error) {
        onErrorMessage(error instanceof Error ? error.message : "Could not add Browser image");
      } finally {
        clearBrowserImageDragState(browserAnnotationConversationId);
      }
    },
    [browserAnnotationConversationId, browserImageDrag, onErrorMessage],
  );

  const handleComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      fileDragDepthRef.current = 0;
      setFileDragActive(false);
      if (browserImageDrag) {
        void handleBrowserImageDrop(event);
        return;
      }

      const classification = classifyComposerDataTransfer(event.dataTransfer);
      if (classification.imageFiles.length === 0 && classification.otherFiles.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      if (classification.imageFiles.length > 0) {
        void imageAttachmentController.addFiles(classification.imageFiles, "drop");
      }
      if (classification.otherFiles.length > 0) {
        void addOrdinaryComposerFiles(classification.otherFiles, "drop");
      }
    },
    [addOrdinaryComposerFiles, browserImageDrag, handleBrowserImageDrop, imageAttachmentController],
  );

  useEffect(() => {
    if (!model.dictation.capabilities.global || !commandKeymapQuery.data) return;
    const hasGlobalShortcut = commandKeymapQuery.data.entries.some(
      (entry) =>
        (entry.id === "globalDictationHold" || entry.id === "globalDictationToggle") &&
        entry.keybindings.length > 0,
    );
    if (hasGlobalShortcut) return;

    let disposed = false;
    void consumeGlobalDictationShortcutNudge()
      .then((claimed) => {
        if (!claimed) return;
        if (disposed) return;
        toast.info("Global dictation is ready. Add a hold or toggle shortcut in Voice settings.", {
          id: "global-dictation-shortcut-nudge",
        });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [commandKeymapQuery.data, model.dictation.capabilities.global]);

  const {
    isDictating,
    isTranscribing,
    transcriptionAction,
    waveformCanvasRef,
    startDictation,
    stopDictation,
    retryDictation,
    cancelDictation,
  } = useComposerDictation({
    enabled: isDictationSupported,
    globalTarget: {
      id: globalDictationTargetId,
      priority: isFloatingComposer ? 20 : 10,
      admission: () =>
        resolveComposerGlobalDictationAdmission({
          floating: isFloatingComposer,
          visible: composerVisible,
          expanded: composerPresentation === "expanded",
          editor: promptEditorRef.current?.getElement() ?? null,
        }),
    },
    onTranscriptInsert: (transcript) => {
      insertDictationTranscript(transcript);
    },
    onTranscriptSend: (transcript) => {
      const nextPrompt = insertDictationTranscript(transcript);
      window.setTimeout(() => {
        const actionState = resolveStageThreadsComposerActionState({
          canSendPrompt: model.conversation !== null || canStartNewThread,
          isThreadRunning: model.isThreadRunning,
          busyAction,
          hasDraftContent:
            nextPrompt.trim().length > 0 || hasSubmittableAttachments || goalModeActive,
          hasThreadGoal: goalModeActive || Boolean(model.conversation?.threadGoal),
          isQueueingEnabled: model.isQueueingEnabled,
          latestTurnStatus,
          canResumeInterruptedTurn: false,
        });
        void submitPrompt({
          prompt: nextPrompt,
          submitAction: actionState.primarySubmitAction,
        });
      }, 0);
    },
    onStartError: (error) => {
      console.error("[composer-dictation:start]", {
        kind: error.kind,
        operation: error.operation,
        status: error.status,
        nativeName: error.nativeName,
      });
      toast.danger("Unable to start dictation", {
        id: "composer-dictation-start-error",
        description: dictationErrorMessage(error),
        duration: 0,
        action:
          error.kind === "microphone-permission-denied" || error.kind === "microphone-restricted"
            ? {
                label: "Open microphone settings",
                onClick: () => void openMicrophoneSettings(),
              }
            : undefined,
      });
    },
    onTranscribeError: (error) => {
      console.error("[composer-dictation:transcribe]", {
        kind: error.kind,
        operation: error.operation,
        status: error.status,
        nativeName: error.nativeName,
      });
      toast.danger("Unable to transcribe audio", {
        id: "composer-dictation-transcription-error",
        description: dictationErrorMessage(error),
        duration: 0,
        secondaryAction: actions.onOpenVoiceSettings
          ? {
              label: "View recording",
              onClick: actions.onOpenVoiceSettings,
            }
          : undefined,
        action: {
          label: "Retry",
          variant: "primary",
          onClick: () => void retryDictation(),
        },
      });
    },
    onUnsupported: () => {
      toast.danger("Dictation is not available on this device", {
        id: "composer-dictation-unavailable",
      });
    },
  });
  const isComposerDictationActive = isDictating || isTranscribing;
  const canResumeInterruptedTurn =
    hasResumeInterruptedTurnCapability && !isDictating && !isTranscribing;
  const startDictationRef = useRef(startDictation);
  const stopDictationRef = useRef(stopDictation);

  useEffect(() => {
    startDictationRef.current = startDictation;
    stopDictationRef.current = stopDictation;
  }, [startDictation, stopDictation]);

  useEffect(() => {
    if (!isDictationSupported || isRealtimeVoiceActive) {
      dictationShortcutActiveRef.current = false;
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || !isComposerDictationShortcut(event, commandKeymapQuery.data)) {
        return;
      }
      if (isComposerDictationShortcutTargetBlocked(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (dictationShortcutActiveRef.current) {
        return;
      }

      dictationShortcutActiveRef.current = true;
      void startDictationRef.current();
    };

    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      if (!isComposerDictationShortcut(event, commandKeymapQuery.data)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!dictationShortcutActiveRef.current) {
        return;
      }

      dictationShortcutActiveRef.current = false;
      stopDictationRef.current("insert");
    };

    const releaseActiveShortcut = (): void => {
      if (!dictationShortcutActiveRef.current) return;
      dictationShortcutActiveRef.current = false;
      stopDictationRef.current("insert");
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") releaseActiveShortcut();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", releaseActiveShortcut);
    return () => {
      releaseActiveShortcut();
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", releaseActiveShortcut);
    };
  }, [commandKeymapQuery.data, isDictationSupported, isRealtimeVoiceActive]);

  useEffect(() => {
    let cancelled = false;

    void readComposerPermissionState(model.projectId)
      .then((result) => {
        if (cancelled) return;
        setPermissionState(result);
      })
      .catch(() => {
        if (cancelled) return;
        setPermissionState(null);
      });

    return () => {
      cancelled = true;
    };
  }, [model.permissionMode, model.permissionState, model.projectId]);

  const handleInterrupt = useCallback(async () => {
    if (!model.conversation || !model.isThreadRunning) return;
    setBusyAction("interrupt");
    onErrorMessage(null);
    try {
      await actions.onInterruptTurn(model.activeTurn?.turnId ?? undefined);
    } catch (error) {
      onErrorMessage(error instanceof Error ? error.message : "Could not stop Nodex");
    } finally {
      setBusyAction(null);
    }
  }, [
    actions,
    model.activeTurn?.turnId,
    model.conversation,
    model.isThreadRunning,
    onErrorMessage,
  ]);

  const handleResumeInterruptedTurn = useCallback(async () => {
    const resumeInterruptedTurn = actions.onResumeInterruptedTurn;
    if (!resumeInterruptedTurn) return;
    const releaseAttempt = resumeAttemptGate.tryAcquire(
      isInterruptedTurnResumeEligible({
        model,
        hasResumeAction: true,
      }),
    );
    if (!releaseAttempt) return;
    setBusyAction("resume");
    onErrorMessage(null);
    try {
      await resumeInterruptedTurn();
    } catch (error) {
      onErrorMessage(error instanceof Error ? error.message : "Could not resume Nodex");
    } finally {
      releaseAttempt();
      setBusyAction(null);
    }
  }, [actions, model, onErrorMessage, resumeAttemptGate]);

  const handleRemoveFileAttachment = useCallback(
    (attachmentId: string) => {
      incrementAttachmentGeneration();
      setFileAttachments((current) =>
        current.filter((attachment) => attachment.uiId !== attachmentId),
      );
    },
    [incrementAttachmentGeneration, setFileAttachments],
  );

  const handleRemoveAddedFile = useCallback(
    (attachmentId: string) => {
      incrementAttachmentGeneration();
      setAddedFiles((current) => current.filter((attachment) => attachment.uiId !== attachmentId));
    },
    [incrementAttachmentGeneration, setAddedFiles],
  );

  const handleRemoveAppshotContext = useCallback(
    (contextId: string) => {
      incrementAttachmentGeneration();
      setAppshotContexts((current) => current.filter((context) => context.id !== contextId));
    },
    [incrementAttachmentGeneration, setAppshotContexts],
  );

  const handleRemovePastedTextAttachment = useCallback(
    (attachmentId: string) => {
      const attachment = pastedTextAttachmentsRef.current.find((item) => item.id === attachmentId);
      if (!attachment) return;

      pastedTextOperationGenerationRef.current.delete(attachmentId);
      pastedTextSourcesRef.current.delete(attachmentId);
      incrementAttachmentGeneration();
      setPastedTextAttachments((current) =>
        current.filter((attachment) => attachment.id !== attachmentId),
      );
      if (attachment.status === "ready") {
        void removePastedTextAttachment({ file: attachment.attachment.file }).catch(
          (error: unknown) => {
            onErrorMessage(error instanceof Error ? error.message : "Could not remove pasted text");
          },
        );
      }
    },
    [incrementAttachmentGeneration, onErrorMessage, setPastedTextAttachments],
  );

  const handleShowPastedTextInField = useCallback(
    (attachmentId: string) => {
      const item = pastedTextAttachmentsRef.current.find(
        (attachment) => attachment.id === attachmentId,
      );
      if (!item || item.status !== "ready") return;

      void readPastedTextAttachment({ file: item.attachment.file })
        .then(async (text) => {
          if (
            text.length >= COMPOSER_LARGE_PASTE_CHAR_THRESHOLD &&
            !window.confirm(
              "This pasted text is large and may make the editor slower. Show it anyway?",
            )
          ) {
            return;
          }

          const editor = promptEditorRef.current;
          if (editor) {
            editor.setText(text);
          } else {
            setPrompt(text);
          }
          setPastedTextAttachments((current) =>
            current.filter((attachment) => attachment.id !== attachmentId),
          );
          await removePastedTextAttachment({ file: item.attachment.file });
        })
        .catch((error: unknown) => {
          onErrorMessage(error instanceof Error ? error.message : "Could not restore pasted text");
        });
    },
    [onErrorMessage, setPastedTextAttachments, setPrompt],
  );

  const handleRemoveCommentAttachment = useCallback(
    (attachmentId: string) => {
      removeReviewDiffCommentAttachment(composerThreadId, attachmentId);
    },
    [composerThreadId],
  );

  const handleRemoveBrowserAnnotationAttachment = useCallback(
    (attachmentId: string) => {
      removeBrowserAnnotationAttachment(browserAnnotationConversationId, attachmentId);
    },
    [browserAnnotationConversationId],
  );

  const slashCommands = useMemo(
    () =>
      buildComposerSlashCommands({
        model,
        actions,
        serviceTier: serviceTierSettings.serviceTier,
        setServiceTier,
        openExpandedDialog: () => setSlashDialogOpen(true),
        onPetToggle: handleToggleDesktopPet,
        activateGoalMode,
      }),
    [
      activateGoalMode,
      actions,
      handleToggleDesktopPet,
      model,
      serviceTierSettings.serviceTier,
      setServiceTier,
    ],
  );
  const slashTrigger = useMemo<ComposerSlashTriggerState>(() => {
    if (
      suggestionState.active &&
      suggestionState.kind === "slash-command" &&
      suggestionState.trigger === "/" &&
      suggestionState.range
    ) {
      return {
        active: true,
        trigger: "/",
        query: suggestionState.query,
        from: suggestionState.range.from,
        to: suggestionState.range.to,
      };
    }
    const cursor = suggestionState.anchorPos ?? 0;
    return {
      active: false,
      trigger: "/",
      query: "",
      from: cursor,
      to: cursor,
    };
  }, [suggestionState]);
  const slashMatches = useMemo(
    () =>
      filterComposerSlashCommands({
        commands: slashCommands,
        query: slashTrigger.active ? slashTrigger.query : "",
        composerText: prompt,
        trigger: slashTrigger.trigger,
      }),
    [prompt, slashCommands, slashTrigger.active, slashTrigger.query, slashTrigger.trigger],
  );
  const slashGroups = useMemo(() => groupComposerSlashCommandMatches(slashMatches), [slashMatches]);
  const slashMenuOpen = slashTrigger.active || nestedSlashCommand !== null;
  const planModeAvailable = hasPlanMode(model.collaborationModes);
  const togglePlanMode = useCallback((): boolean => {
    const nextMode = resolveNextComposerPlanMode({
      currentMode: model.selectedCollaborationMode,
      modes: model.collaborationModes,
    });
    if (!nextMode) return false;
    void actions.onCollaborationModeChange(nextMode);
    if (nextMode === "plan") {
      setGoalModeActive(false);
    }
    setPlanKeywordSuggestionDismissed(false);
    return true;
  }, [actions, model.collaborationModes, model.selectedCollaborationMode, setGoalModeActive]);
  const showPlanKeywordSuggestion = shouldShowComposerPlanKeywordSuggestion({
    prompt,
    currentMode: model.selectedCollaborationMode,
    modes: model.collaborationModes,
    dismissed: planKeywordSuggestionDismissed || goalModeActive,
  });
  const resolvedInlineSlashHighlight = resolveComposerSlashHighlight({
    matches: slashMatches,
    intent: inlineSlashHighlightIntent,
  });
  const highlightedInlineSlashCommandId = slashMenuOpen
    ? resolvedInlineSlashHighlight.commandId
    : null;
  const highlightedInlineSlashCommandSource = slashMenuOpen
    ? resolvedInlineSlashHighlight.source
    : "programmatic";
  const promptHistoryScopeKey =
    model.conversation?.threadId ??
    model.threadId ??
    model.newThreadTarget?.sessionId ??
    model.projectId ??
    null;
  const selectLatestQueuedFollowUpForArrowUp = useCallback((): boolean => {
    if (prompt.trim().length !== 0 || hasAttachments || slashMenuOpen || busyAction !== null) {
      return false;
    }

    const threadId = model.conversation?.threadId ?? model.threadId;
    if (!threadId) return false;

    const latestQueuedFollowUp = model.composerShell.queuedFollowUpRows.at(-1);
    if (!latestQueuedFollowUp) return false;

    void actions.onEditQueuedFollowUp({
      threadId,
      followUpId: latestQueuedFollowUp.followUpId,
      prompt: latestQueuedFollowUp.prompt,
      promptInput: latestQueuedFollowUp.promptInput,
    });
    return true;
  }, [
    actions,
    busyAction,
    hasAttachments,
    model.composerShell.queuedFollowUpRows,
    model.conversation?.threadId,
    model.threadId,
    prompt,
    slashMenuOpen,
  ]);
  const { appendPromptToHistory, handlePromptHistoryKeyDown, resetHistorySelection } =
    useThreadComposerPromptHistoryRecall({
      editorRef: promptEditorRef,
      scopeKey: promptHistoryScopeKey,
      composerText: prompt,
      selectLatestQueuedFollowUp: selectLatestQueuedFollowUpForArrowUp,
    });
  appendPromptToHistoryRef.current = appendPromptToHistory;
  resetPromptHistorySelectionRef.current = resetHistorySelection;

  useEffect(() => {
    if (prompt.trim().length > 0 && model.selectedCollaborationMode !== "plan") {
      return;
    }
    setPlanKeywordSuggestionDismissed(false);
  }, [model.selectedCollaborationMode, prompt]);

  const closeSlashMenu = useCallback(() => {
    promptEditorRef.current?.closeSuggestions();
    setNestedSlashCommand(null);
    setInlineSlashHighlightIntent({ commandId: null, source: "programmatic" });
  }, []);
  const closeAddContextMenu = useCallback(() => {
    const editor = promptEditorRef.current;
    if (!editor) return;
    const suggestion = editor.getSuggestionState();
    if (suggestion.active && suggestion.range) {
      editor.clearRange(suggestion.range);
    }
    editor.closeSuggestions();
  }, []);
  const dismissAddContextMenu = useCallback(() => {
    promptEditorRef.current?.dismissSuggestions();
  }, []);

  const handleSuggestionStateChange = useCallback((nextSuggestion: ComposerSuggestionState) => {
    setSuggestionState(nextSuggestion);
    if (nextSuggestion.active) {
      if (nextSuggestion.kind !== "slash-command" || nextSuggestion.source === null) {
        setNestedSlashCommand(null);
      }
      return;
    }
    setNestedSlashCommand(null);
    setInlineSlashHighlightIntent({ commandId: null, source: "programmatic" });
  }, []);

  const clearInlineSlashTrigger = useCallback((trigger: ComposerSlashTriggerState) => {
    promptEditorRef.current?.clearRange({ from: trigger.from, to: trigger.to });
    promptEditorRef.current?.closeSuggestions();
  }, []);

  const selectSlashCommand = useCallback(
    (command: ComposerSlashCommand, source: "inline" | "dialog") => {
      if (command.isEnabled === false) return;

      if (source === "inline") {
        const trigger = slashTrigger;
        if (command.onSelectFromInlineSlash) {
          void command.onSelectFromInlineSlash({
            source: "inline",
            trigger,
            clearTrigger: () => clearInlineSlashTrigger(trigger),
            replaceTrigger: (text) => {
              promptEditorRef.current?.replaceTextRange({
                from: trigger.from,
                to: trigger.to,
                text,
              });
              promptEditorRef.current?.closeSuggestions();
            },
          });
          closeSlashMenu();
          return;
        }

        if (command.Content) {
          promptEditorRef.current?.openSlashSubmenu({
            kind: "slash-command",
            commandId: command.id,
            ...(command.dismissOnInput === true ? { dismissOnInput: true } : {}),
          });
          setNestedSlashCommand(command);
          return;
        }

        clearInlineSlashTrigger(trigger);
        void command.onSelect?.({ source: "inline" });
        closeSlashMenu();
        return;
      }

      if (command.Content) {
        setNestedSlashCommand(command);
        setSlashDialogOpen(false);
        return;
      }
      void command.onSelect?.({ source: "dialog" });
      setSlashDialogOpen(false);
    },
    [clearInlineSlashTrigger, closeSlashMenu, slashTrigger],
  );

  const backFromNestedSlashMenu = useCallback(() => {
    promptEditorRef.current?.openSlashSubmenu(null);
    setNestedSlashCommand(null);
  }, []);

  const handleSuggestionAction = useCallback(
    (action: ComposerSuggestionAction): boolean => {
      if (
        suggestionState.active &&
        (suggestionState.kind === "at-mention" || suggestionState.kind === "skill-mention")
      ) {
        if (action === "next" || action === "previous") {
          return addContextMenuRef.current?.moveHighlight(action) ?? false;
        }
        if (action === "complete-query" || action === "insert-mention") {
          const didSubmit = addContextMenuRef.current?.submitHighlighted(action) ?? false;
          if (!didSubmit && action === "insert-mention") {
            promptEditorRef.current?.closeSuggestions();
          }
          return true;
        }
        return true;
      }

      if (!suggestionState.active || suggestionState.kind !== "slash-command") {
        return false;
      }
      if (nestedSlashCommand) {
        if (action === "insert-mention") {
          closeSlashMenu();
          return true;
        }
        if (action === "complete-query" || action === "next" || action === "previous") {
          return true;
        }
        if (action === "dismiss") {
          setNestedSlashCommand(null);
          return true;
        }
        return action === "backspace";
      }
      if (action === "next" || action === "previous") {
        setInlineSlashHighlightIntent({
          commandId: resolveNextSlashHighlight({
            matches: slashMatches,
            currentCommandId: highlightedInlineSlashCommandId,
            direction: action,
          }),
          source: "keyboard",
        });
        return slashMatches.length > 0;
      }
      if ((action === "complete-query" || action === "insert-mention") && !nestedSlashCommand) {
        const highlighted =
          slashMatches.find((match) => match.command.id === highlightedInlineSlashCommandId)
            ?.command ??
          slashMatches[0]?.command ??
          null;
        if (!highlighted) {
          if (action === "insert-mention") {
            promptEditorRef.current?.closeSuggestions();
          }
          return true;
        }
        selectSlashCommand(highlighted, "inline");
        return true;
      }
      if (action === "dismiss") {
        setNestedSlashCommand(null);
        setInlineSlashHighlightIntent({
          commandId: null,
          source: "programmatic",
        });
        return true;
      }
      return action === "backspace";
    },
    [
      highlightedInlineSlashCommandId,
      closeSlashMenu,
      nestedSlashCommand,
      selectSlashCommand,
      slashMatches,
      suggestionState.active,
      suggestionState.kind,
    ],
  );

  const handleKeyDown = useCallback(
    (event: ComposerPromptEditorKeyboardEvent): boolean => {
      if (nestedSlashCommand && event.key === "Escape") {
        event.preventDefault();
        closeSlashMenu();
        return true;
      }

      if (
        event.key === "Tab" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !slashMenuOpen &&
        planModeAvailable
      ) {
        event.preventDefault();
        event.stopPropagation();
        togglePlanMode();
        return true;
      }

      if (handlePromptHistoryKeyDown(event)) {
        return true;
      }

      const hasMultilinePrompt = prompt.includes("\n");
      const isComposing =
        "nativeEvent" in event ? event.nativeEvent.isComposing : event.isComposing;
      const actionState = resolveStageThreadsComposerActionState({
        canSendPrompt: model.conversation !== null || canStartNewThread,
        isThreadRunning: model.isThreadRunning,
        busyAction,
        hasDraftContent: prompt.trim().length > 0 || hasAttachments || goalModeActive,
        hasThreadGoal: goalModeActive || Boolean(model.conversation?.threadGoal),
        isQueueingEnabled: model.isQueueingEnabled,
        latestTurnStatus,
        canResumeInterruptedTurn,
      });

      const submitIntent = resolveComposerSubmitIntentFromKeyDown({
        enterBehavior: model.composerEnterBehavior,
        hasMultilinePrompt,
        isThreadRunning: model.isThreadRunning,
        primarySubmitAction: actionState.primarySubmitAction,
        alternateSubmitAction: actionState.alternateSubmitAction,
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing,
      });
      if (!submitIntent) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      void submitPrompt({
        prompt,
        submitAction: submitIntent.submitAction,
      });
      return true;
    },
    [
      busyAction,
      canStartNewThread,
      closeSlashMenu,
      goalModeActive,
      hasAttachments,
      model.composerEnterBehavior,
      model.conversation,
      model.isQueueingEnabled,
      model.isThreadRunning,
      latestTurnStatus,
      canResumeInterruptedTurn,
      nestedSlashCommand,
      handlePromptHistoryKeyDown,
      planModeAvailable,
      prompt,
      slashMenuOpen,
      submitPrompt,
      togglePlanMode,
    ],
  );

  const hasDraftContent = prompt.trim().length > 0 || hasSubmittableAttachments || goalModeActive;
  const hasComposerContent = prompt.trim().length > 0 || hasAttachments || goalModeActive;
  const hasFooterGoalChip =
    goalModeActive || Boolean(model.conversation?.threadGoal && actions.onClearThreadGoal);
  const hasMultilinePrompt = prompt.includes("\n");
  const handlePromptIntrinsicWidthChange = useCallback((widthPx: number) => {
    setPromptIntrinsicWidthPx((current) =>
      current !== null && Math.abs(current - widthPx) <= 0.5 ? current : widthPx,
    );
  }, []);
  const handleCompactInputWidthChange = useCallback((widthPx: number | null) => {
    setCompactInputWidthPx((current) =>
      current !== null && widthPx !== null && Math.abs(current - widthPx) <= 0.5
        ? current
        : widthPx,
    );
  }, []);
  const composerLayout = resolveComposerAdaptiveLayout({
    isFloatingComposer,
    hasAttachments,
    hasExplicitLineBreak: hasMultilinePrompt,
    promptIntrinsicWidthPx,
    compactInputWidthPx,
    hasError: Boolean(errorMessage),
    isDictating: isComposerDictationActive,
  });
  const floatingComposerSingleLine = composerLayout === "single-line";
  const isMacPlatform =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

  const composerActionState = resolveStageThreadsComposerActionState({
    canSendPrompt: model.conversation !== null || canStartNewThread,
    isThreadRunning: model.isThreadRunning,
    busyAction,
    hasDraftContent: hasComposerContent,
    hasThreadGoal: goalModeActive || Boolean(model.conversation?.threadGoal),
    isQueueingEnabled: model.isQueueingEnabled,
    latestTurnStatus,
    canResumeInterruptedTurn,
  });
  useEffect(() => {
    return registerImageEditComposerChannel(
      imageEditComposerChannelId,
      async (request: ImageEditComposerSubmitRequest): Promise<ImageEditComposerSubmitResult> => {
        const imageSource =
          request.intent?.attachments[0]?.image.source ??
          imageEditDraft.attachments[0]?.imageSource ??
          "uploaded";
        const mode =
          request.intent?.mode ?? (imageEditDraft.mode === "comment" ? "comment" : "select");
        const route = !model.conversation
          ? "new_thread"
          : model.isThreadRunning
            ? "queued"
            : "existing_thread";
        if (!imageInputSupported) {
          trackImageEditSubmitOutcome({
            failureReason: "image-input-unsupported",
            imageSource,
            mode,
            outcome: "unavailable",
            route,
          });
          return { status: "unavailable", reason: "image-input-unsupported" };
        }
        if (
          request.intent &&
          !buildComposerImageEditAttachments({
            currentAttachments: imageAttachments,
            intent: request.intent,
            executionHostId: model.isCloudNewThreadTarget ? null : model.hostId,
            generation: attachmentGenerationRef.current,
          })
        ) {
          trackImageEditSubmitOutcome({
            failureReason: "asset-unresolvable",
            imageSource,
            mode,
            outcome: "unavailable",
            route,
          });
          return { status: "unavailable", reason: "asset-unresolvable" };
        }

        const queued = model.isThreadRunning;
        const submitted = await submitPrompt({
          prompt,
          submitAction: queued ? "queue" : composerActionState.primarySubmitAction,
          ...(request.intent ? { imageEditIntent: request.intent } : {}),
        });
        trackImageEditSubmitOutcome({
          ...(!submitted ? { failureReason: "transport" as const } : {}),
          imageSource,
          mode,
          outcome: submitted ? (queued ? "queued" : "submitted") : "failed",
          route,
        });
        return submitted
          ? { status: queued ? "queued" : "submitted" }
          : { status: "failed", reason: "transport" };
      },
    );
  }, [
    composerActionState.primarySubmitAction,
    imageEditComposerChannelId,
    imageEditDraft,
    imageAttachments,
    imageInputSupported,
    model.conversation,
    model.hostId,
    model.isCloudNewThreadTarget,
    model.isThreadRunning,
    prompt,
    submitPrompt,
  ]);
  const isSendPending = busyAction === "send" && composerActionState.action === "send";
  const isInterruptPending = busyAction === "interrupt" && composerActionState.action === "stop";
  const isResumePending = busyAction === "resume" && composerActionState.action === "resume";
  const isPrimaryActionPending = isSendPending || isInterruptPending || isResumePending;
  const canRunPrimaryAction = Boolean(
    hasDraftContent &&
    !hasPendingPastedTextAttachments &&
    (model.conversation !== null || canStartNewThread),
  );
  const handleCancelGoalReplacement = useCallback(() => {
    if (busyAction !== null) return;
    setGoalReplacementConfirmation(null);
  }, [busyAction]);
  const handleConfirmGoalReplacement = useCallback(() => {
    const confirmation = goalReplacementConfirmation;
    if (!confirmation || busyAction !== null) return;

    void (async () => {
      const succeeded = await submitThreadGoalDraft(confirmation.draft);
      if (succeeded) {
        await finalizeEditedQueuedFollowUp();
        setGoalReplacementConfirmation(null);
      }
    })();
  }, [
    busyAction,
    finalizeEditedQueuedFollowUp,
    goalReplacementConfirmation,
    submitThreadGoalDraft,
  ]);
  const handlePausedQueueSendDecision = useCallback(
    (resolution: "resume" | "clear") => {
      if (busyAction !== null) return;
      setPausedQueueSendDialogOpen(false);
      void submitPrompt({
        prompt,
        submitAction: composerActionState.primarySubmitAction,
        pausedQueueResolution: resolution,
      });
    },
    [busyAction, composerActionState.primarySubmitAction, prompt, submitPrompt],
  );
  const newThreadPromptPlaceholder = model.newThreadTarget
    ? model.isCloudNewThreadTarget
      ? "Cloud run target is currently mock-only"
      : "Do anything"
    : "Select a card or session before starting a new thread";
  const promptPlaceholder = model.newThreadStartBlockedReason
    ? model.newThreadStartBlockedReason
    : goalModeActive
      ? getThreadGoalMessage("composer.placeholder.goal")
      : isFloatingComposer
        ? "Do anything"
        : model.selectedCollaborationMode === "plan"
          ? "Describe your task to generate a plan..."
          : model.conversation
            ? "Ask for follow-up changes"
            : model.isNewThreadTab
              ? newThreadPromptPlaceholder
              : "Select a thread";
  const isPromptEditorDisabled =
    (model.conversation === null && !canStartNewThread) || busyAction !== null;
  const primaryShortcutKeys = resolveShortcutKeycapTokens({
    accelerator: resolveThreadComposerPrimaryShortcutAccelerator({
      enterBehavior: model.composerEnterBehavior,
      hasMultilinePrompt,
    }),
    isMacPlatform,
  });
  const alternateShortcutKeys = resolveShortcutKeycapTokens({
    accelerator: resolveThreadComposerAlternateShortcutAccelerator(model.composerEnterBehavior),
    isMacPlatform,
  });
  const contextWindowIndicatorState = resolveContextWindowIndicatorState(model.conversation);
  const showExternalFooter = shouldShowThreadComposerStatusStrip(model);
  const composerActionTooltip = renderComposerActionTooltipContent({
    action: composerActionState.action,
    primarySubmitAction: composerActionState.primarySubmitAction,
    alternateSubmitAction: composerActionState.alternateSubmitAction,
    isThreadRunning: model.isThreadRunning,
    primaryShortcutKeys,
    alternateShortcutKeys,
  });
  const contextSuggestionOpen = suggestionState.active && suggestionState.kind === "at-mention";
  const composerPluginCwds = useMemo(
    () =>
      Array.from(
        new Set(
          [model.cwd, model.projectWorkspacePath].flatMap((candidate) =>
            candidate?.trim() ? [candidate.trim()] : [],
          ),
        ),
      ),
    [model.cwd, model.projectWorkspacePath],
  );
  const addContextControl = (
    <ComposerAddContextTrigger
      open={contextSuggestionOpen}
      imagesOnly={model.isCloudNewThreadTarget}
      disabled={isPromptEditorDisabled}
      onToggle={() => {
        promptEditorRef.current?.toggleContextSuggestions();
      }}
    />
  );
  const intelligenceControls = (
    <>
      <ContextWindowIndicator
        state={contextWindowIndicatorState}
        account={model.account}
        showFallbackLabel={false}
      />
      <ModelSelectorDropdown model={model} controller={intelligenceController} />
    </>
  );
  const dictationControl = isDictationSupported ? (
    <NodexTooltip
      tooltipContent={<span className="text-token-foreground">Click to dictate or hold</span>}
      shortcutLabel={dictationShortcutPresentation?.label}
      side="top"
      sideOffset={4}
    >
      <button
        type="button"
        className="border-token-border no-drag cursor-interaction flex h-token-button-composer aspect-square items-center justify-center gap-1 rounded-full border border-transparent px-0 py-0 text-sm leading-[18px] whitespace-nowrap text-token-text-tertiary select-none transition-colors duration-100 focus:outline-none enabled:hover:bg-token-list-hover-background enabled:hover:text-token-foreground disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:bg-token-list-hover-background"
        aria-label={isTranscribing ? "Cancel dictation transcription" : "Dictate"}
        onClick={() => {
          if (isTranscribing) {
            cancelDictation();
            return;
          }
          void startDictation();
        }}
        disabled={isRealtimeVoiceActive}
      >
        {isTranscribing ? (
          <ActivitySpinnerIcon className="icon-xs" />
        ) : (
          <MicIcon className="icon-xs" />
        )}
      </button>
    </NodexTooltip>
  ) : null;
  const primaryActionButton = (
    <span className="inline-flex">
      <button
        type="button"
        className={cn(
          "focus-visible:outline-token-button-background cursor-interaction flex h-token-button-composer aspect-square items-center justify-center rounded-full bg-token-foreground p-0.5 text-token-dropdown-background transition-opacity focus-visible:outline-2",
          (composerActionState.disabled ||
            (composerActionState.action === "send" && !canRunPrimaryAction)) &&
            !isPrimaryActionPending &&
            "opacity-50",
          isPrimaryActionPending && "cursor-wait",
        )}
        onClick={
          composerActionState.action === "stop"
            ? () => void handleInterrupt()
            : composerActionState.action === "resume"
              ? () => void handleResumeInterruptedTurn()
              : () =>
                  void submitPrompt({
                    prompt,
                    submitAction: composerActionState.primarySubmitAction,
                  })
        }
        disabled={
          composerActionState.action === "send"
            ? composerActionState.disabled || !canRunPrimaryAction
            : composerActionState.disabled
        }
        aria-label={composerActionState.label}
      >
        {isPrimaryActionPending ? (
          <ActivitySpinnerIcon className="icon-sm" />
        ) : composerActionState.action === "stop" ? (
          <StopIcon className="icon-xs" />
        ) : composerActionState.action === "resume" ? (
          <ComposerResumeIcon className="icon-xs" />
        ) : (
          <UpArrowIcon className="icon-sm" />
        )}
      </button>
    </span>
  );
  const primaryActionControl =
    composerActionState.action === "resume" ? (
      primaryActionButton
    ) : (
      <NodexTooltip
        tooltipContent={composerActionTooltip}
        side="top"
        tooltipBodyClassName={cn(
          composerActionState.action === "stop" || !model.isThreadRunning
            ? "text-center text-pretty"
            : "max-w-none",
        )}
      >
        {primaryActionButton}
      </NodexTooltip>
    );
  const renderPromptEditor = (singleLine = false) => (
    <ComposerPromptEditor
      ref={promptEditorRef}
      data-composer-prompt-frame="true"
      value={prompt}
      placeholder={promptPlaceholder}
      disabled={isPromptEditorDisabled}
      singleLine={singleLine}
      onChange={(nextPrompt) => {
        setPrompt(nextPrompt);
      }}
      onKeyDown={handleKeyDown}
      onLargeTextPaste={handleLargeTextPaste}
      onPasteFiles={handlePasteFiles}
      onSuggestionStateChange={handleSuggestionStateChange}
      onSuggestionAction={handleSuggestionAction}
      onIntrinsicContentWidthChange={
        isFloatingComposer ? handlePromptIntrinsicWidthChange : undefined
      }
    />
  );
  const floatingLeadingControls = addContextControl;
  const floatingTrailingControls = (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      {model.selectedCollaborationMode === "plan" || goalModeActive ? (
        <ComposerFooterAccessoryDivider />
      ) : null}
      <ActiveComposerModeChip model={model} onToggle={togglePlanMode} />
      <ActiveGoalModeChip active={hasFooterGoalChip} onClear={clearFooterGoal} />
      <div className="flex min-w-0 items-center gap-1">{intelligenceControls}</div>
      <PermissionModeDropdown
        selectedMode={model.permissionMode}
        availableModes={permissionState?.availableModes}
        autoReviewAvailable={permissionState?.autoReviewAvailable ?? false}
        triggerVariant="icon"
        onSelect={actions.onPermissionModeChange}
      />
      {dictationControl}
      {primaryActionControl}
    </div>
  );
  const standardLeadingControls = (
    <div className="flex min-w-0 items-center gap-[5px]">
      {addContextControl}
      <PermissionModeDropdown
        selectedMode={model.permissionMode}
        availableModes={permissionState?.availableModes}
        autoReviewAvailable={permissionState?.autoReviewAvailable ?? false}
        onSelect={actions.onPermissionModeChange}
      />
      {model.selectedCollaborationMode === "plan" || goalModeActive ? (
        <ComposerFooterAccessoryDivider />
      ) : null}
      <ActiveComposerModeChip model={model} onToggle={togglePlanMode} />
      <ActiveGoalModeChip active={hasFooterGoalChip} onClear={clearFooterGoal} />
    </div>
  );
  const standardTrailingControls = (
    <div className="flex min-w-0 items-center justify-end w-full">
      <div className="flex min-w-0 flex-1 justify-end">
        <div className="flex min-w-0 items-center gap-1">{intelligenceControls}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {dictationControl}
        {primaryActionControl}
      </div>
    </div>
  );
  const dictationRowContent = (
    <>
      <NodexTooltip
        tooltipContent={isTranscribing ? "Cancel transcription" : "Cancel dictation"}
        side="top"
        sideOffset={4}
      >
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-full border border-transparent px-0 text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)"
          aria-label={isTranscribing ? "Cancel transcription" : "Cancel dictation"}
          onClick={cancelDictation}
        >
          <CloseIcon className="size-4" />
        </button>
      </NodexTooltip>
      <div
        className="flex h-token-button-composer min-w-0 flex-1 items-center justify-center text-base text-token-text-tertiary select-none"
        role={isTranscribing ? "status" : undefined}
      >
        {isTranscribing ? (
          "Transcribing"
        ) : (
          <canvas
            ref={waveformCanvasRef}
            className="h-token-button-composer w-full text-token-foreground"
            aria-hidden="true"
          />
        )}
      </div>
      <NodexTooltip
        tooltipContent={<span className="text-token-foreground">Stop dictation</span>}
        side="top"
        sideOffset={4}
      >
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-full border border-transparent px-0 text-(--foreground-secondary) transition-colors duration-100 hover:bg-(--background-tertiary) hover:text-(--foreground)"
          aria-label="Stop dictation"
          onClick={() => stopDictation("insert")}
          disabled={isTranscribing}
          aria-busy={transcriptionAction === "insert"}
        >
          {transcriptionAction === "insert" ? (
            <ActivitySpinnerIcon className="size-4" />
          ) : (
            <StopIcon className="size-4" />
          )}
        </button>
      </NodexTooltip>
      <NodexTooltip
        tooltipContent={<span className="text-token-foreground">Transcribe and send</span>}
        side="top"
        sideOffset={4}
      >
        <button
          type="button"
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-full bg-(--foreground) p-0.5 text-(--background) focus-visible:outline-2 focus-visible:outline-(--ring)",
            isTranscribing && "opacity-50",
          )}
          aria-label="Transcribe and send"
          onClick={() => stopDictation("send")}
          disabled={isTranscribing}
          aria-busy={transcriptionAction === "send"}
        >
          {transcriptionAction === "send" ? (
            <ActivitySpinnerIcon className="size-4 text-(--background)" />
          ) : (
            <UpArrowIcon className="size-5" />
          )}
        </button>
      </NodexTooltip>
    </>
  );
  return (
    <>
      <ComposerContextRailSlot visible={showExternalFooter}>
        <ThreadComposerStatusStrip
          model={model}
          actions={actions}
          onErrorMessage={onErrorMessage}
          contextRailLeadingContent={contextRailLeadingContent}
          projectSelectorDisabled={busyAction !== null}
        />
      </ComposerContextRailSlot>
      <div
        className={cn(
          "relative",
          (browserImageDrag || isFileDragActive) &&
            "rounded-[20px] ring-2 ring-token-focus-border ring-offset-2 ring-offset-transparent",
        )}
        data-browser-image-drop-active={browserImageDrag ? "true" : "false"}
        data-file-drop-active={isFileDragActive ? "true" : "false"}
        onDragEnter={handleComposerDragEnter}
        onDragLeave={handleComposerDragLeave}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
      >
        <ComposerAddContextMenu
          ref={addContextMenuRef}
          suggestion={suggestionState}
          isHomeMenu={model.isNewThreadTab}
          imagesOnly={model.isCloudNewThreadTarget}
          plugins={model.composerPlugins ?? []}
          pluginsLoading={model.composerPluginsLoading}
          skills={model.composerSkills ?? []}
          skillsLoading={model.composerSkillsLoading}
          apps={model.composerApps ?? []}
          appsLoading={model.composerAppsLoading}
          sites={model.composerSites ?? []}
          sitesAvailable={model.composerSitesAvailable === true}
          sitesLoading={model.composerSitesLoading}
          chatGptConversations={model.composerChatGptConversations ?? []}
          chatGptConversationsAvailable={model.composerChatGptConversationsAvailable === true}
          chatGptConversationsLoading={model.composerChatGptConversationsLoading}
          workspaceRoot={model.cwd ?? model.projectWorkspacePath ?? null}
          pluginCwds={composerPluginCwds}
          projectId={model.projectId}
          projectSelector={
            model.isNewThreadTab && !model.newThreadProjectSelector?.disabled
              ? (model.newThreadProjectSelector ?? null)
              : null
          }
          goalAvailable={canUseComposerGoal(model, actions)}
          planModeAvailable={planModeAvailable}
          planModeActive={model.selectedCollaborationMode === "plan"}
          onClose={closeAddContextMenu}
          onDismiss={dismissAddContextMenu}
          onPickFiles={handlePickComposerFiles}
          onActivateGoal={activateGoalMode}
          onTogglePlanMode={() => {
            togglePlanMode();
          }}
          onCaptureAppshot={handleCaptureAppshot}
          onProjectChange={(projectId) => {
            actions.onNewThreadProjectChange?.(projectId);
          }}
          onStartNewChatWithPrompt={actions.onStartNewChatWithPrompt}
          onCapabilitiesChanged={actions.onComposerCapabilitiesChanged}
          onPrefillPrompt={(nextPrompt) => {
            setPrompt(nextPrompt);
            window.requestAnimationFrame(() => {
              promptEditorRef.current?.focus();
            });
          }}
          onInsertMention={handleInsertPromptMention}
        />
        <InlineSlashCommandMenu
          open={slashMenuOpen}
          isHomeMenu={model.isNewThreadTab}
          groups={slashGroups}
          matches={slashMatches}
          highlightedCommandId={highlightedInlineSlashCommandId}
          highlightedSource={highlightedInlineSlashCommandSource}
          nestedCommand={nestedSlashCommand}
          onHighlight={(commandId, source) => setInlineSlashHighlightIntent({ commandId, source })}
          onSelect={(command) => selectSlashCommand(command, "inline")}
          onClose={closeSlashMenu}
          onBack={backFromNestedSlashMenu}
        />
        {showPlanKeywordSuggestion ? (
          <PlanKeywordSuggestion
            onUsePlanMode={() => {
              togglePlanMode();
            }}
            onDismiss={() => {
              setPlanKeywordSuggestionDismissed(true);
            }}
          />
        ) : null}
        <div
          className={cn(
            "composer-surface-chrome relative flex flex-col bg-token-input-background/90 backdrop-blur-lg electron:dark:bg-token-dropdown-background",
            floatingComposerSingleLine
              ? "overflow-visible rounded-full"
              : "overflow-y-auto _multilineSurface_1u8sk_2",
            showExternalFooter && "z-10",
          )}
        >
          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            {!floatingComposerSingleLine ? (
              <div
                className="_attachmentsDefault_1u8sk_2"
                data-composer-attachments="true"
                data-composer-spacing="default"
                data-visible-attachments={hasAttachments ? "true" : undefined}
              >
                {hasAttachments ? (
                  <ComposerImageAttachmentRow
                    attachments={imageAttachments}
                    controller={imageAttachmentController}
                    hasVisibleNonImageAttachments={hasVisibleNonImageAttachments}
                  >
                    {appshotContexts.map((context) => (
                      <NodexTooltip
                        key={context.id}
                        tooltipContent={
                          context.windowTitle
                            ? `${context.appName} — ${context.windowTitle}`
                            : context.appName
                        }
                      >
                        <div
                          className="group relative h-24 w-36 shrink-0 overflow-hidden rounded-xl border border-token-border bg-token-main-surface-secondary"
                          data-composer-appshot="true"
                        >
                          <img
                            src={context.imageDataUrl}
                            alt={`${context.appName} Appshot`}
                            draggable={false}
                            className="size-full object-cover"
                          />
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-linear-to-t from-black/75 to-transparent px-2 pt-5 pb-1.5 text-[11px] text-white">
                            {context.appIconDataUrl ? (
                              <img
                                src={context.appIconDataUrl}
                                alt=""
                                aria-hidden="true"
                                draggable={false}
                                className="size-3.5 shrink-0 object-contain"
                              />
                            ) : null}
                            <span className="min-w-0 truncate">{context.appName}</span>
                          </div>
                          <button
                            type="button"
                            className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-80 backdrop-blur-sm transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-token-focus-border"
                            onClick={() => handleRemoveAppshotContext(context.id)}
                            aria-label={`Remove ${context.appName} Appshot`}
                          >
                            <CloseIcon className="size-3" />
                          </button>
                        </div>
                      </NodexTooltip>
                    ))}
                    {pastedTextAttachments.map((attachment, index) => (
                      <NodexTooltip
                        key={attachment.id}
                        tooltipContent={
                          attachment.status === "failed" ? attachment.error : attachment.preview
                        }
                      >
                        <div className="inline-flex max-w-72 items-center gap-1 rounded-full bg-token-foreground/5 py-1 pr-1 pl-2 text-xs text-token-foreground">
                          {attachment.status === "pending" ? (
                            <ActivitySpinnerIcon className="size-3 text-token-description-foreground" />
                          ) : (
                            <ComposerAddFilesIcon className="size-3 text-token-description-foreground" />
                          )}
                          <span className="min-w-0 truncate">
                            {attachment.status === "pending"
                              ? "Adding pasted text…"
                              : attachment.status === "failed"
                                ? "Pasted text failed"
                                : "Pasted text.txt"}
                          </span>
                          <span className="shrink-0 text-token-description-foreground">
                            {attachment.characterCount.toLocaleString()} chars
                          </span>
                          {attachment.status === "failed" ? (
                            <button
                              type="button"
                              className="rounded px-1 hover:bg-token-foreground/10"
                              onClick={() => handleRetryPastedTextAttachment(attachment.id)}
                            >
                              Retry
                            </button>
                          ) : null}
                          {attachment.status === "ready" ? (
                            <button
                              type="button"
                              className="rounded px-1 hover:bg-token-foreground/10"
                              onClick={() => handleShowPastedTextInField(attachment.id)}
                            >
                              Show in text field
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="rounded px-1 text-token-description-foreground hover:bg-token-foreground/10"
                            onClick={() => handleRemovePastedTextAttachment(attachment.id)}
                            aria-label={`Remove pasted text ${index + 1}`}
                          >
                            x
                          </button>
                        </div>
                      </NodexTooltip>
                    ))}
                    {fileAttachments.map((attachment) => (
                      <NodexTooltip
                        key={attachment.uiId}
                        tooltipContent={`Remove ${attachment.attachment.label}`}
                      >
                        <button
                          type="button"
                          className="inline-flex max-w-48 items-center gap-1 rounded-full bg-token-foreground/5 px-2 py-1 text-xs text-token-foreground hover:bg-token-foreground/10"
                          onClick={() => handleRemoveFileAttachment(attachment.uiId)}
                        >
                          <ComposerAddFilesIcon className="size-3 text-token-description-foreground" />
                          <span className="min-w-0 truncate">{attachment.attachment.label}</span>
                          <span className="text-token-description-foreground">x</span>
                        </button>
                      </NodexTooltip>
                    ))}
                    {addedFiles.map((attachment) => (
                      <NodexTooltip
                        key={attachment.uiId}
                        tooltipContent={`Remove ${attachment.attachment.label}`}
                      >
                        <button
                          type="button"
                          className="inline-flex max-w-48 items-center gap-1 rounded-full bg-token-foreground/5 px-2 py-1 text-xs text-token-foreground hover:bg-token-foreground/10"
                          onClick={() => handleRemoveAddedFile(attachment.uiId)}
                        >
                          <ComposerAddFilesIcon className="size-3 text-token-description-foreground" />
                          <span className="min-w-0 truncate">{attachment.attachment.label}</span>
                          <span className="text-token-description-foreground">x</span>
                        </button>
                      </NodexTooltip>
                    ))}
                    {browserAnnotationAttachments.map((attachment) => (
                      <NodexTooltip
                        key={attachment.id}
                        tooltipContent={`Remove browser annotation on ${attachment.pageTitle || attachment.pageUrl}`}
                      >
                        <button
                          type="button"
                          className="inline-flex max-w-72 items-center gap-1 rounded-full bg-token-foreground/5 px-2 py-1 text-xs text-token-foreground hover:bg-token-foreground/10"
                          onClick={() => handleRemoveBrowserAnnotationAttachment(attachment.id)}
                        >
                          <FileIcon className="size-3 text-token-description-foreground" />
                          <span className="min-w-0 truncate">
                            {attachment.pageTitle || "Browser annotation"}
                          </span>
                          <span className="shrink-0 text-token-description-foreground">
                            {attachment.anchors.length}{" "}
                            {attachment.anchors.length === 1 ? "anchor" : "anchors"}
                          </span>
                          <span className="text-token-description-foreground">x</span>
                        </button>
                      </NodexTooltip>
                    ))}
                    {commentAttachments.map((attachment) => {
                      const lineLabel = formatReviewDiffCommentLineLabel({
                        side: attachment.position.side,
                        line: attachment.position.line,
                        ...(attachment.position.start_line
                          ? { startLine: attachment.position.start_line }
                          : {}),
                        ...(attachment.position.start_side
                          ? { startSide: attachment.position.start_side }
                          : {}),
                      });
                      const fileLabel = getComposerAttachmentNameFromPath(
                        attachment.position.path,
                        attachment.position.path,
                      );
                      const commentText = getReviewDiffCommentText(attachment);
                      return (
                        <NodexTooltip
                          key={attachment.id}
                          tooltipContent={`Remove ${lineLabel}: ${commentText}`}
                        >
                          <button
                            type="button"
                            className="inline-flex max-w-64 items-center gap-1 rounded-full bg-token-foreground/5 px-2 py-1 text-xs text-token-foreground hover:bg-token-foreground/10"
                            onClick={() => handleRemoveCommentAttachment(attachment.id)}
                          >
                            <FileIcon className="size-3 text-token-description-foreground" />
                            <span className="min-w-0 truncate">{fileLabel}</span>
                            <span className="shrink-0 text-token-description-foreground">
                              {lineLabel.replace("Comment on ", "")}
                            </span>
                            <span className="text-token-description-foreground">x</span>
                          </button>
                        </NodexTooltip>
                      );
                    })}
                  </ComposerImageAttachmentRow>
                ) : null}
              </div>
            ) : null}

            {isComposerDictationActive ? (
              isFloatingComposer ? (
                <div className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 px-2 py-1">
                  {dictationRowContent}
                </div>
              ) : (
                <>
                  <ComposerInput layout="multiline">{renderPromptEditor()}</ComposerInput>
                  {errorMessage ? (
                    <div className="px-3 pb-2 text-xs text-(--destructive)">{errorMessage}</div>
                  ) : null}
                  <div className="mb-2 flex items-center gap-2 px-2">{dictationRowContent}</div>
                </>
              )
            ) : (
              <>
                {errorMessage && isFloatingComposer ? (
                  <div className="px-3 pt-2 text-xs text-(--destructive)">{errorMessage}</div>
                ) : null}
                <ComposerAdaptiveFooter
                  layout={composerLayout}
                  input={
                    <>
                      <ComposerInput layout={composerLayout}>
                        {renderPromptEditor(floatingComposerSingleLine)}
                      </ComposerInput>
                      {errorMessage && !isFloatingComposer ? (
                        <div className="px-3 pb-2 text-xs text-(--destructive)">{errorMessage}</div>
                      ) : null}
                    </>
                  }
                  leadingControls={
                    isFloatingComposer && floatingComposerSingleLine
                      ? floatingLeadingControls
                      : standardLeadingControls
                  }
                  trailingControls={
                    isFloatingComposer && floatingComposerSingleLine
                      ? floatingTrailingControls
                      : standardTrailingControls
                  }
                  onCompactInputWidthChange={
                    isFloatingComposer ? handleCompactInputWidthChange : undefined
                  }
                />
              </>
            )}
          </div>
        </div>
      </div>

      {slashDialogOpen ? (
        <ExpandedSlashCommandDialog
          commands={slashCommands}
          composerText={prompt}
          onSelect={(command) => selectSlashCommand(command, "dialog")}
          onClose={() => setSlashDialogOpen(false)}
        />
      ) : null}
      <ThreadGoalReplacementConfirmationDialog
        confirmation={goalReplacementConfirmation}
        pending={busyAction !== null}
        onCancel={handleCancelGoalReplacement}
        onConfirm={handleConfirmGoalReplacement}
      />
      <QueuedFollowUpSendDialog
        open={pausedQueueSendDialogOpen}
        queuedMessageCount={model.composerShell.queuedFollowUpRows.length}
        pending={busyAction !== null}
        onOpenChange={(open) => {
          if (!open && busyAction === null) setPausedQueueSendDialogOpen(false);
        }}
        onClearQueue={() => handlePausedQueueSendDecision("clear")}
        onSendMessage={() => handlePausedQueueSendDecision("resume")}
      />
    </>
  );
}

function renderComposerActionTooltipContent(input: {
  action: "send" | "stop" | "resume";
  primarySubmitAction: StageThreadsComposerSubmitAction | null;
  alternateSubmitAction: StageThreadsComposerFollowUpAction | null;
  isThreadRunning: boolean;
  primaryShortcutKeys: readonly string[];
  alternateShortcutKeys: readonly string[];
}) {
  return (
    <ComposerActionTooltipContent
      action={input.action}
      primarySubmitAction={input.primarySubmitAction}
      alternateSubmitAction={input.alternateSubmitAction}
      isThreadRunning={input.isThreadRunning}
      primaryShortcutKeys={input.primaryShortcutKeys}
      alternateShortcutKeys={input.alternateShortcutKeys}
    />
  );
}
