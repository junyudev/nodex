import { useRegisterPluginAppFollowUp } from "@/features/local-conversation/view/plugin-app-conversation";
import {
  buildMcpAppFollowUpPrompt,
  type McpAppFollowUpMessage,
} from "@/lib/mcp-app/mcp-app-follow-up";
import { useOpenSkill } from "@/features/skills/open-skill";
import { useComposerExecutionHold } from "./use-composer-execution-hold";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useAgentApprovals } from "../../use-agent-approvals";
import { agentApprovalComposerPlaceholder } from "../../agent-approval";
import { composerDraftIntents } from "@/lib/composer-draft-intents";
import type { PageReference } from "../../../../../shared/page-reference";
import { useComposerPageContext } from "./use-composer-page-context";
import { ComposerPageContextChips } from "./composer-page-context-chips";
import {
  hasThreadTextSelections,
  type ThreadTextSelectionContext,
} from "../../../../../shared/thread-text-selection";
import { useThreadTextSelectionDraft } from "../../thread-text-selection-draft";
import { ThreadTextSelectionAttachments } from "../thread-text-selection-attachments";
import { ApplicationPending } from "@/bootstrap/application-surface";
import { useComposerRealtimeVoice } from "@/features/realtime-voice/realtime-voice-window";
import { RealtimeVoiceControls } from "@/features/realtime-voice/realtime-voice-controls";
import { resolveConversationImageInput } from "../../conversation-image-input";
import { supportsConversationProviderControl } from "../../conversation-provider-controls";
import { useComposerPrediction } from "./use-composer-prediction";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from "react";
import { resolveContextWindowIndicatorState } from "@/lib/context-window";
import type {
  CodexComposerAppshotContext,
  CodexComposerAppshotTarget,
  CodexComposerIntent,
  CodexPromptDocumentInput,
  CodexPromptInput,
  CodexReviewDiffCommentAttachment,
  CodexThreadGoalDraftInput,
  CodexThreadGoalMaterializedDraft,
} from "@/lib/types";
import type { ComposerPickedFile } from "../../../../../shared/ipc-api";
import { DEFAULT_CODEX_HOST_ID } from "../../../../../shared/codex-host";
import { codexImageFileIdFromSource } from "../../../../../shared/codex-image-input";
import { splitCodexPromptAgentConfigLines } from "../../../../../shared/codex-prompt-preparation";
import { dedupeCodexLiveFileAttachments } from "../../../../../shared/codex-live-file-attachments";
import { useCodexServiceTierSettings } from "@/lib/use-codex-service-tier-settings";
import { useCommandKeymapState } from "@/lib/use-command-keymap-state";
import {
  createCommandKeymapState,
  resolveCommandShortcutPresentation,
} from "../../../../../shared/command-keybindings";
import { resolveCodexRendererCommandPlatform } from "@/lib/codex-window-runtime";
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
import { toastFailure } from "@/lib/failure-toast";
import { readableIpcError } from "@/lib/ipc-error-message";
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
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadFooterModel,
  ThreadStageActions,
} from "../../thread-stage-types";
import { ComposerActionTooltipContent } from "./composer-submit-tooltip";
import { QueuedFollowUpSendDialog } from "./queued-follow-up-send-dialog";
import { ComposerNoticeRail } from "./composer-notice-rail";
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
  pickComposerFiles,
} from "./local-conversation-thread-composer-deps";
import {
  shouldShowThreadComposerStatusStrip,
  ThreadComposerStatusStrip,
} from "./local-conversation-thread-composer-status-strip";
import { ComposerContextRailSlot } from "../composer-context-rail";
import {
  COMPOSER_LARGE_PASTE_CHAR_THRESHOLD,
  ComposerPromptEditor,
  appendComposerDictationText,
  buildPromptDoc,
  composerMentionLinkPattern,
  parseComposerPromptMentionLink,
  serializeComposerPromptMentionLink,
  type ComposerPromptMentionInput,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorKeyboardEvent,
  type ComposerSuggestionAction,
} from "./composer-prompt-editor";
import { CLAUDE_PROMPT_KEYWORDS } from "./composer-prompt-keywords";
import { projectMessageText } from "../../../../../shared/message-agent-input";
import { materializeWrittenImages } from "@/lib/prompt-file-images";
import { useLibraryFileReadAuthority } from "@/lib/use-library-navigation";
import {
  inactiveComposerSuggestionState,
  type ComposerSuggestionState,
} from "./composer-suggestion-state";
import {
  ComposerAdaptiveFooter,
  ComposerInput,
  resolveComposerAdaptiveLayout,
} from "@/components/composer/composer-adaptive-footer";
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
  getReviewDiffCommentAttachmentsSnapshot,
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
  COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME,
  ComposerFooterAccessoryDivider,
} from "@/components/composer/composer-footer-controls";
import { ComposerAttachments } from "@/components/composer/composer-attachments";
import {
  COMPOSER_DROP_TARGET_CLASS_NAME,
  COMPOSER_SURFACE_CLASS_NAME,
} from "@/components/composer/composer-surface";
import { useDragDepth } from "@/lib/use-drag-depth";
import { PermissionModeDropdown } from "../shared/permission-mode-dropdown";
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
  composerImageDraftsAtom,
  composerPromptDraftsAtom,
  persistComposerDraftTransfer,
  persistableComposerImages,
  restoreComposerImages,
  useComposerImageDraft,
  composerPastedTextAttachmentsAtom,
  composerResetGenerationAtom,
  composerReviewCommentAttachmentsFamily,
  useComposerPromptDraft,
  type ComposerCompletedDraftSnapshot,
  type ComposerFileAttachment,
  type ComposerPastedTextAttachment,
  type ComposerPromptDocument,
} from "./composer-draft-state";
import {
  isComposerDraftCaptureLocked,
  registerComposerDraftCapture,
  subscribeComposerDraftCapture,
  type ComposerDraftCaptureResult,
} from "./composer-draft-capture";
import { prepareComposerDraftTransferAttachments } from "./composer-draft-transfer-attachments";
import {
  addCopiedLibraryImages,
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
} from "./image-attachments";
import {
  type ResolvedComposerImageInput,
  type ImageEditSubmissionIntent,
  trackImageEditSubmit,
  trackImageEditSubmitOutcome,
} from "@/lib/content-image";
import { buildComposerImageEditAttachments } from "./image-attachments/image-edit-intent-attachments";
import {
  useScopedAtom,
  useScopedAtomValue,
  useScopeHandle,
  useSetScopedAtom,
  useMaitaiStore,
  getConcretePersistedAtom,
  type ScopeHandle,
} from "@/lib/maitai";
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
import { registerComposerImageAttachmentTarget } from "@/lib/composer-image-attachment-channel";
import {
  restoreComposerAppModelContext,
  restoreComposerAppModelContextSnapshot,
  readComposerAppModelContext,
  useComposerAppModelContext,
} from "./composer-app-model-context";
import { ComposerAppModelContextAttachments } from "./composer-app-model-context-attachments";
import { isCodexAppModelContextVisible } from "../../../../../shared/codex-untrusted-app-input";
import { beginOptimisticGeneratedImageEdit } from "@/features/user-attachment-image-editor";

import { uploadResourceAsset } from "@/lib/assets";
import { resolveImageEditComposerTarget } from "../../image-edit-composer-target";

interface ThreadComposerProps {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  contextRailLeadingContent?: ReactNode;
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
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

interface ComposerAttachmentState extends Partial<ThreadTextSelectionContext> {
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
  let cursor = 0;

  for (const match of prompt.matchAll(composerMentionLinkPattern())) {
    const rawLabel = match[1] ?? "";
    const rawPath = match[2] ?? "";
    const mention = parseComposerPromptMentionLink(rawLabel, rawPath);
    if (!mention) continue;

    const precedingText = prompt.slice(cursor, match.index);
    if (precedingText) {
      textParts.push(precedingText);
      documentItems.push({ type: "text", text: precedingText });
    }
    if (mention.kind === "page") {
      textParts.push(match[0]);
      documentItems.push({ type: "text", text: match[0] });
    } else if (mention.kind === "skill") {
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

/**
 * The prompt's Markdown as an Agent receives it, its images counted after the attachment row's.
 * Mentions are Composer atoms rather than Markdown, so they keep their exact source.
 */
function projectComposerPrompt(prompt: string, precedingImageCount: number) {
  const mentions: string[] = [];
  const guarded = prompt.replace(composerMentionLinkPattern(), (link, label, path) =>
    parseComposerPromptMentionLink(label, path) ? `\uE000${mentions.push(link) - 1}\uE001` : link,
  );
  const projected = projectMessageText(guarded, { precedingImageCount });
  return {
    ...projected,
    text: projected.text.replace(/\uE000(\d+)\uE001/gu, (_, index) => mentions[Number(index)]!),
  };
}

function buildComposerPromptInput(input: {
  prompt: string;
  attachments: ComposerAttachmentState;
  executionHostId?: string | null;
  pageReferences?: readonly PageReference[];
}): CodexPromptInput | undefined {
  const executionHostId =
    input.executionHostId === undefined ? DEFAULT_CODEX_HOST_ID : input.executionHostId;
  const attachedImages = buildComposerImagePromptInputs(
    input.attachments.imageAttachments,
    executionHostId,
  );
  const written = projectComposerPrompt(input.prompt, attachedImages.length);
  const parsedPrompt = extractComposerPromptMentions(written.text);
  const text = parsedPrompt.text;
  const images = [...attachedImages, ...(written.images ?? [])];
  const agentConfigs = written.agentConfigs ?? [];
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
  const responseTextAnnotations = [...(input.attachments.responseTextAnnotations ?? [])];
  const selectedTextAttachments = [...(input.attachments.selectedTextAttachments ?? [])];

  if (
    images.length === 0 &&
    appshots.length === 0 &&
    textAttachments.length === 0 &&
    fileAttachments.length === 0 &&
    addedFiles.length === 0 &&
    mentions.length === 0 &&
    skills.length === 0 &&
    commentAttachments.length === 0 &&
    browserAnnotationAttachments.length === 0 &&
    responseTextAnnotations.length === 0 &&
    selectedTextAttachments.length === 0 &&
    agentConfigs.length === 0 &&
    !input.pageReferences?.length
  ) {
    return undefined;
  }

  return {
    text,
    ...(parsedPrompt.documentItems.length > 0
      ? { documentItems: [...parsedPrompt.documentItems] }
      : {}),
    ...(input.pageReferences?.length ? { pageReferences: input.pageReferences } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(appshots.length > 0 ? { appshots } : {}),
    ...(textAttachments.length > 0 ? { textAttachments } : {}),
    ...(fileAttachments.length > 0 ? { fileAttachments } : {}),
    ...(addedFiles.length > 0 ? { addedFiles } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(commentAttachments.length > 0 ? { commentAttachments } : {}),
    ...(browserAnnotationAttachments.length > 0 ? { browserAnnotationAttachments } : {}),
    ...(responseTextAnnotations.length > 0 ? { responseTextAnnotations } : {}),
    ...(selectedTextAttachments.length > 0 ? { selectedTextAttachments } : {}),
    ...(agentConfigs.length > 0 ? { agentConfigs: [...agentConfigs] } : {}),
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
  if (/^\s/u.test(documentPrompt)) return `${prompt}${documentPrompt}`;
  // Multi-line content is a block of its own; inline mentions continue the sentence.
  if (documentPrompt.includes("\n")) return `${prompt.trimEnd()}\n\n${documentPrompt}`;
  return /\s$/u.test(prompt) ? `${prompt}${documentPrompt}` : `${prompt} ${documentPrompt}`;
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
  executionHostId: string | null = DEFAULT_CODEX_HOST_ID,
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
            : codexImageFileIdFromSource(source)
              ? { hostId: executionHostId }
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
    responseTextAnnotations: promptInput?.responseTextAnnotations ?? [],
    selectedTextAttachments: promptInput?.selectedTextAttachments ?? [],
  };
}

function canStartNewThreadTarget(model: ThreadFooterModel): boolean {
  return Boolean(
    model.isNewThreadTab &&
    model.newThreadTarget !== null &&
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
    attachments.browserAnnotationAttachments.length > 0 ||
    hasThreadTextSelections(attachments)
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
    attachments.browserAnnotationAttachments.length > 0 ||
    hasThreadTextSelections(attachments)
  );
}

function withComposerModelContext(
  promptInput: CodexPromptInput | undefined,
  prompt: string,
  attachments: NonNullable<CodexPromptInput["mcpAppModelContextAttachments"]>,
): CodexPromptInput | undefined {
  if (attachments.length === 0) return promptInput;
  return {
    ...promptInput,
    text: promptInput?.text ?? prompt,
    mcpAppModelContextAttachments: [
      ...(promptInput?.mcpAppModelContextAttachments ?? []),
      ...attachments,
    ],
  };
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
      hasThreadTextSelections(attachments) ||
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

/**
 * A message that did not go out. Its draft stays in the composer, so sending again is the retry;
 * each new attempt replaces the previous toast instead of stacking another.
 */
function toastUnsentMessage(reason: unknown): void {
  toastFailure("Message not sent", reason, { id: "composer-message-not-sent" });
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
  const selection = controller.selection;

  return (
    <AgentIntelligenceDropdown
      models={model.availableModels}
      provider={model.provider}
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
  composerHandle: ScopeHandle;
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
  restoreComposerAppModelContextSnapshot(
    input.composerHandle,
    input.snapshot.appModelContextAttachments ?? [],
  );
  replaceReviewCommentAttachments(input.threadId, input.snapshot.commentAttachments);
  if (input.threadId) {
    replaceBrowserAnnotationAttachments(
      input.threadId,
      input.snapshot.browserAnnotationAttachments ?? [],
    );
  }
}

interface HydratedThreadComposerProps extends ThreadComposerProps {
  readonly intentFocusNonce: number | null;
  readonly onIntentFocused: (nonce: number) => void;
  readonly prompt: string;
  readonly readPrompt: () => string;
  readonly readPromptDocument: () => ComposerPromptDocument;
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
  const { model } = props;
  const { intelligenceController } = props;
  const { floating: isFloatingComposer, visible: composerVisible } =
    useRightPanelComposerPresentation();
  const composerThreadId = model.conversation?.threadId ?? model.threadId;
  const browserAnnotationConversationId =
    composerThreadId ?? model.newThreadTarget?.sessionId ?? null;
  const selectionDraft = useThreadTextSelectionDraft(model.hostId, browserAnnotationConversationId);
  // A root Session's prompt is also saved under the Session, so its sidebar row shows the draft.
  const rootSessionId =
    model.composerChatKey?.kind === "session" ? model.composerChatKey.sessionId : null;
  const promptDraft = useComposerPromptDraft(composerThreadId, rootSessionId);
  const imageDraft = useComposerImageDraft(composerThreadId, rootSessionId);
  const [initialized, setInitialized] = useScopedAtom(composerDraftInitializedAtom);
  const [consumedIntentNonce, setConsumedIntentNonce] = useScopedAtom(
    composerConsumedIntentNonceAtom,
  );
  const [, setFileAttachments] = useScopedAtom(composerFileAttachmentsAtom);
  const [, setAddedFiles] = useScopedAtom(composerAddedFilesAtom);
  const [imageAttachments, setImageAttachments] = useScopedAtom(composerImageAttachmentsAtom);
  const [, setAppshotContexts] = useScopedAtom(composerAppshotContextsAtom);
  const [, setPastedTextAttachments] = useScopedAtom(composerPastedTextAttachmentsAtom);
  const [, setGoalModeActive] = useScopedAtom(composerGoalModeActiveAtom);
  const resetGeneration = useScopedAtomValue(composerResetGenerationAtom);
  const clearCompletedDraft = useSetScopedAtom(clearComposerCompletedDraftAtom);
  const submittedDraftCleanupRef = useRef({
    clearCompletedDraft,
    clearPromptDraft: promptDraft.clear,
    composerThreadId,
  });
  const composerHandle = useScopeHandle(ComposerScope);
  const threadScopePath = useScopeHandle(ThreadScope).path;
  const transferDefinition = composerDraftTransferFamily(
    composerThreadId ?? `inactive:${composerHandle.path}`,
  );
  const [transfer, setTransfer] = useScopedAtom(transferDefinition);
  const consumedIntentNonceRef = useRef(consumedIntentNonce);
  const [intentFocusNonce, setIntentFocusNonce] = useState<number | null>(null);
  const [queuedFollowUpEdit, setQueuedFollowUpEdit] = useState<
    CodexComposerIntent["queuedFollowUpEdit"] | null
  >(null);
  const consumedTransferIdRef = useRef<string | null>(null);
  const intent = model.composerIntent;
  const [queuedEditIntentNonce, setQueuedEditIntentNonce] = useState(consumedIntentNonce);
  if (
    promptDraft.loadable.status !== "loading" &&
    imageDraft.loadable.status !== "loading" &&
    intent &&
    intent.focusNonce !== queuedEditIntentNonce
  ) {
    setQueuedEditIntentNonce(intent.focusNonce);
    if (intent.queuedFollowUpEdit) setQueuedFollowUpEdit(intent.queuedFollowUpEdit);
  }

  useLayoutEffect(() => {
    if (promptDraft.loadable.status === "loading" || imageDraft.loadable.status === "loading")
      return;

    // A draft's saved images come back with its text; a transfer or intent below replaces them
    // as it would any draft.
    if (!initialized) {
      const restored = restoreComposerImages(imageDraft.images, 0);
      if (restored.length > 0)
        setImageAttachments((current) => (current.length > 0 ? current : restored));
    }

    if (
      transfer &&
      composerThreadId &&
      transfer.targetConversationId === composerThreadId &&
      consumedTransferIdRef.current !== transfer.transferId
    ) {
      consumedTransferIdRef.current = transfer.transferId;
      selectionDraft.restore({
        responseTextAnnotations: transfer.responseTextAnnotations ?? [],
        selectedTextAttachments: transfer.selectedTextAttachments ?? [],
        activeAnnotationId: transfer.activeAnnotationId ?? null,
        annotationMode: transfer.annotationMode ?? "create",
        annotationDraft: transfer.annotationDraft ?? "",
      });
      applyCompletedDraftSnapshot({
        snapshot: transfer,
        composerHandle,
        setFileAttachments,
        setAddedFiles,
        setImageAttachments,
        setAppshotContexts,
        setPastedTextAttachments,
        setGoalModeActive,
        threadId: composerThreadId,
      });
      if (transfer.imageEditDraft) {
        const target = resolveImageEditComposerTarget({
          composerScopeIdentity: model.composerScopeIdentity,
          chatKey: model.composerChatKey,
          isSideChat: model.conversation?.source?.sideConversation === true,
          threadScopePath,
        });
        replaceImageEditComposerDraft(target.channelId, transfer.imageEditDraft);
      }
      void promptDraft
        .setDocument(
          transfer.promptDocument ?? {
            text: transfer.prompt,
            links: [],
            mentions: [],
          },
        )
        .catch((error: unknown) => {
          toastFailure("Couldn’t restore your draft", error, { id: "composer-draft-restore" });
        });
      setTransfer(null);
    }

    if (intent && consumedIntentNonceRef.current !== intent.focusNonce) {
      consumedIntentNonceRef.current = intent.focusNonce;
      const restored = buildComposerAttachmentStateFromPromptInput(
        intent.promptInput,
        model.hostId,
      );
      const mentionPrompt = buildPersistedMentionPrompt(intent.promptInput);
      const documentPrompt = buildPersistedPromptDocument(intent.promptInput);
      const append = intent.attachmentMode === "append";
      restoreComposerAppModelContext(
        composerHandle,
        intent.promptInput?.mcpAppModelContextAttachments ?? [],
        append,
      );
      selectionDraft.replace(
        {
          responseTextAnnotations: restored.responseTextAnnotations ?? [],
          selectedTextAttachments: restored.selectedTextAttachments ?? [],
        },
        append,
      );
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
          toastFailure("Couldn’t add that to your message", error);
        });
      }
      setConsumedIntentNonce(intent.focusNonce);
      setIntentFocusNonce(intent.focusNonce);
      if (model.composerChatKey)
        composerDraftIntents.consume(model.composerChatKey, intent.focusNonce);
    }

    if (!initialized) setInitialized(true);
  }, [
    browserAnnotationConversationId,
    composerThreadId,
    composerHandle,
    imageDraft.images,
    imageDraft.loadable.status,
    initialized,
    intent,
    model.hostId,
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
    selectionDraft,
    transfer,
    threadScopePath,
    model.composerScopeIdentity,
    model.composerChatKey,
    model.conversation?.source?.sideConversation,
  ]);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      void promptDraft.setPrompt(nextPrompt).catch((error: unknown) => {
        toastFailure("Couldn’t save your draft", error, { id: "composer-draft-save" });
      });
    },
    [promptDraft],
  );
  // Saved images follow the draft once it is restored, so a reload brings them back with its text.
  useEffect(() => {
    if (!initialized || imageDraft.loadable.status !== "ready") return;
    const saved = persistableComposerImages(imageAttachments);
    if (JSON.stringify(saved) === JSON.stringify(imageDraft.images)) return;
    void imageDraft.setImages(saved).catch((error: unknown) => {
      toastFailure("Couldn’t save your draft’s images", error, {
        id: "composer-draft-images-save",
      });
    });
  }, [imageAttachments, imageDraft, initialized]);
  useLayoutEffect(() => {
    submittedDraftCleanupRef.current = {
      clearCompletedDraft,
      clearPromptDraft: promptDraft.clear,
      composerThreadId,
    };
  }, [clearCompletedDraft, composerThreadId, promptDraft.clear]);
  const clearSubmittedDraft = useCallback(() => {
    const cleanup = submittedDraftCleanupRef.current;
    cleanup.clearCompletedDraft();
    clearReviewDiffCommentAttachments(cleanup.composerThreadId);
    void cleanup.clearPromptDraft().catch((error: unknown) => {
      toastFailure("Couldn’t clear your draft", error, { id: "composer-draft-clear" });
    });
  }, []);

  if (promptDraft.loadable.status === "loading" || !initialized) {
    return (
      <ApplicationPending active={composerVisible}>
        <div
          data-composer-draft-hydration="loading"
          className={cn(
            isFloatingComposer
              ? "h-11"
              : "min-h-24 rounded-[20px] border border-token-border bg-token-main-surface-primary",
          )}
        />
      </ApplicationPending>
    );
  }

  return (
    <HydratedThreadComposer
      key={resetGeneration}
      {...props}
      intelligenceController={intelligenceController}
      intentFocusNonce={intentFocusNonce}
      onIntentFocused={(nonce) =>
        setIntentFocusNonce((current) => (current === nonce ? null : current))
      }
      prompt={promptDraft.prompt}
      readPrompt={promptDraft.readPrompt}
      readPromptDocument={promptDraft.readDocument}
      setPrompt={setPrompt}
      clearSubmittedDraft={clearSubmittedDraft}
      queuedFollowUpEdit={queuedFollowUpEdit}
      clearQueuedFollowUpEdit={() => setQueuedFollowUpEdit(null)}
    />
  );
}

async function pickAndAddComposerFiles({
  attachmentGenerationRef,
  imageAttachmentController,
  setFileAttachments,
}: {
  attachmentGenerationRef: { current: number };
  imageAttachmentController: Pick<ReturnType<typeof useComposerImageAttachments>, "addPickedFiles">;
  setFileAttachments: (
    update: (current: readonly ComposerFileAttachment[]) => readonly ComposerFileAttachment[],
  ) => void;
}): Promise<void> {
  attachmentGenerationRef.current += 1;
  const generation = attachmentGenerationRef.current;

  try {
    const pickedFiles = await pickComposerFiles({
      imagesOnly: false,
      title: "Select files",
    });
    if (attachmentGenerationRef.current !== generation || pickedFiles.length === 0) {
      return;
    }

    const nextFileAttachments: ComposerFileAttachment[] = [];
    const nextImageFiles: ComposerPickedFile[] = [];

    for (const pickedFile of pickedFiles) {
      if (!isComposerImageFile(pickedFile)) {
        nextFileAttachments.push({
          uiId: createComposerAttachmentId("file"),
          attachment: {
            label: getComposerPickedFileName(pickedFile),
            path: pickedFile.path,
            fsPath: pickedFile.path,
          },
        });
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
    toastFailure("Couldn’t add files", error);
  }
}

function HydratedThreadComposer({
  model,
  actions,
  contextRailLeadingContent,
  backgroundAgentRows,
  prompt,
  readPrompt,
  readPromptDocument,
  setPrompt,
  clearSubmittedDraft,
  queuedFollowUpEdit,
  clearQueuedFollowUpEdit,
  intelligenceController,
  intentFocusNonce,
  onIntentFocused,
}: HydratedThreadComposerProps) {
  const executionHold = useComposerExecutionHold(
    model.newThreadTarget
      ? { kind: "new_chat", projectId: model.newThreadTarget.projectId }
      : model.composerChatKey?.kind === "session"
        ? { kind: "session", sessionId: model.composerChatKey.sessionId }
        : null,
  );
  // The chat's own condition, such as a cleaned-up worktree, comes before paused work.
  const sendGate = model.sendGate ?? null;
  const sendHeld = sendGate !== null || executionHold.held;
  const { floating: isFloatingComposer, visible: composerVisible } =
    useRightPanelComposerPresentation();
  const composerHandle = useScopeHandle(ComposerScope);
  const composerScopeKey = composerHandle.path;
  const pageContext = useComposerPageContext({
    sessionId: model.newThreadTarget?.sessionId,
    composerScope: composerHandle,
  });
  const maitaiStore = useMaitaiStore();
  const [globalDictationTargetId] = useState(() => `composer:${crypto.randomUUID()}`);
  const threadScopePath = useScopeHandle(ThreadScope).path;
  const canStartNewThread = canStartNewThreadTarget(model);
  const [busyAction, setBusyAction] = useState<StageThreadsBusyAction>(null);

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
  const [previousPlanSuggestionInput, setPreviousPlanSuggestionInput] = useState({
    prompt,
    mode: model.selectedCollaborationMode,
  });
  if (
    previousPlanSuggestionInput.prompt !== prompt ||
    previousPlanSuggestionInput.mode !== model.selectedCollaborationMode
  ) {
    setPreviousPlanSuggestionInput({ prompt, mode: model.selectedCollaborationMode });
    if (prompt.trim().length === 0 || model.selectedCollaborationMode === "plan") {
      setPlanKeywordSuggestionDismissed(false);
    }
  }
  const [goalModeActive, setGoalModeActive] = useScopedAtom(composerGoalModeActiveAtom);
  const [goalReplacementConfirmation, setGoalReplacementConfirmation] =
    useState<ThreadGoalReplacementConfirmationState | null>(null);
  const [pausedQueueSendDialogOpen, setPausedQueueSendDialogOpen] = useState(false);
  const [promptIntrinsicWidthPx, setPromptIntrinsicWidthPx] = useState<number | null>(null);
  const [compactInputWidthPx, setCompactInputWidthPx] = useState<number | null>(null);
  const fileDrag = useDragDepth();
  if (
    pausedQueueSendDialogOpen &&
    model.composerShell.queuedFollowUpStatus === "ready" &&
    model.composerShell.hasInterruptedQueuedFollowUps !== true
  ) {
    setPausedQueueSendDialogOpen(false);
  }
  const approvals = useAgentApprovals();
  const answerableApprovals = approvals.pending.filter(
    (approval) => !approvals.held.has(approval.requestId),
  );
  const approvalPlaceholder = agentApprovalComposerPlaceholder(answerableApprovals);
  const openSkill = useOpenSkill();
  const promptEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const lastFocusedIntentRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (
      intentFocusNonce === null ||
      !composerVisible ||
      lastFocusedIntentRef.current === intentFocusNonce
    )
      return;
    const editor = promptEditorRef.current;
    if (!editor?.getElement()?.isConnected) return;
    editor.focusAtEnd();
    lastFocusedIntentRef.current = intentFocusNonce;
    onIntentFocused(intentFocusNonce);
  }, [intentFocusNonce, composerVisible, onIntentFocused]);
  const dictationEditorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const addContextMenuRef = useRef<ComposerAddContextMenuHandle>(null);
  const appendPromptToHistoryRef = useRef<(text: string) => void>(() => {});
  const resetPromptHistorySelectionRef = useRef<() => void>(() => {});
  const dictationShortcutActiveRef = useRef(false);
  const attachmentGenerationRef = useRef(0);
  const pastedTextSourcesRef = useRef(new Map<string, string>());
  const pastedTextOperationGenerationRef = useRef(new Map<string, number>());
  const pastedTextOperationCounterRef = useRef(0);
  const composerMountedRef = useRef(true);
  const ordinaryFileUploadsRef = useRef({ pending: 0, error: null as string | null });
  const [resumeAttemptGate] = useState(createInterruptedTurnResumeGate);
  const { serviceTierSettings, setServiceTier } = useCodexServiceTierSettings();
  const commandKeymapQuery = useCommandKeymapState();
  const dictationShortcutPresentation = resolveCommandShortcutPresentation(
    commandKeymapQuery.data ?? createCommandKeymapState({}, resolveCodexRendererCommandPlatform()),
    "composerDictationHold",
    "Ctrl+M",
  );
  const composerThreadId = model.conversation?.threadId ?? model.threadId;
  const captureScopeIdentity = model.composerScopeIdentity?.trim() || composerScopeKey;
  const isDraftCaptureLocked = useCallback(
    () =>
      Boolean(
        composerThreadId &&
        isComposerDraftCaptureLocked({
          threadId: composerThreadId,
          composerScopeIdentity: captureScopeIdentity,
        }),
      ),
    [captureScopeIdentity, composerThreadId],
  );
  const subscribeDraftCapture = useCallback(
    (listener: () => void) =>
      composerThreadId
        ? subscribeComposerDraftCapture(
            { threadId: composerThreadId, composerScopeIdentity: captureScopeIdentity },
            listener,
          )
        : () => {},
    [captureScopeIdentity, composerThreadId],
  );
  const draftCaptureLocked = useSyncExternalStore(
    subscribeDraftCapture,
    isDraftCaptureLocked,
    isDraftCaptureLocked,
  );
  const imageEditComposerTarget = resolveImageEditComposerTarget({
    composerScopeIdentity: model.composerScopeIdentity,
    chatKey: model.composerChatKey,
    isSideChat: model.conversation?.source?.sideConversation === true,
    threadScopePath,
  });
  const appModelContext = useComposerAppModelContext({
    hostId: model.hostId,
    threadId: model.conversation?.threadId ?? model.newThreadTarget?.sessionId ?? null,
    enabled:
      model.composerChatKey?.kind === "session" ||
      Boolean(
        model.conversation &&
        (model.provider === null ||
          model.provider === undefined ||
          model.provider.kind === "codex"),
      ),
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
  const selectionDraft = useThreadTextSelectionDraft(model.hostId, browserAnnotationConversationId);
  const selectionFocusNonce = selectionDraft.draft.focusNonce;
  useLayoutEffect(() => {
    if (selectionFocusNonce === 0 || !composerVisible) return;
    promptEditorRef.current?.focusAtEnd();
    selectionDraft.consumeFocus();
  }, [selectionFocusNonce, composerVisible, selectionDraft]);
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
  const queuedImageInput = queuedFollowUpEdit?.modelSelection
    ? model.provider?.imageInputForSelection?.(queuedFollowUpEdit.modelSelection)
    : undefined;
  const imageInputUnavailableReason = queuedImageInput
    ? queuedImageInput.unavailableReason
    : model.provider?.imageInputUnavailableReason;
  const imageInputSupported =
    queuedImageInput?.supported ??
    resolveConversationImageInput({
      provider: model.provider,
      availableModels: model.availableModels,
      selectedModel: model.selectedModel,
    }).supported;
  const handleEditComposerImage = useCallback(
    (attachment: ComposerImageAttachment) => {
      void openComposerImageAttachment({
        attachment,
        attachmentCount: imageAttachments.length,
        composerTarget: imageEditComposerTarget,
        policy: "edit_button",
        projectId: model.projectId,
        threadId: composerThreadId,
      });
    },
    [composerThreadId, imageEditComposerTarget, model.projectId, imageAttachments.length],
  );
  const imageAttachmentController = useComposerImageAttachments({
    attachments: imageAttachments,
    setAttachments: setImageAttachments,
    scopeKey: composerScopeKey,
    enabled: imageInputSupported,
    unavailableReason: imageInputUnavailableReason,
    onError: (message) => toastFailure(message),
    onRemove: (attachmentId) => {
      if (isImageEditComposerAttachmentId(attachmentId)) {
        removeImageEditComposerAttachment(imageEditComposerChannelId, attachmentId);
      }
    },
  });
  useLayoutEffect(
    () =>
      registerComposerImageAttachmentTarget(imageEditComposerTarget, {
        hostId: model.hostId,
        threadId: composerThreadId,
        scopeKey: composerScopeKey,
        append: (images) => {
          if (!imageInputSupported || !composerMountedRef.current || isDraftCaptureLocked())
            return false;
          imageAttachmentController.addResolvedImages(images);
          return true;
        },
      }),
    [
      imageEditComposerTarget,
      model.hostId,
      composerThreadId,
      composerScopeKey,
      imageInputSupported,
      imageAttachmentController,
      isDraftCaptureLocked,
    ],
  );
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
      responseTextAnnotations: selectionDraft.draft.responseTextAnnotations,
      selectedTextAttachments: selectionDraft.draft.selectedTextAttachments,
    }),
    [
      addedFiles,
      appshotContexts,
      browserAnnotationAttachments,
      selectionDraft.draft.responseTextAnnotations,
      selectionDraft.draft.selectedTextAttachments,
      commentAttachments,
      fileAttachments,
      imageAttachments,
      pastedTextAttachments,
    ],
  );
  const hasVisibleAppModelContext = appModelContext.attachments.some(isCodexAppModelContextVisible);
  const hasAppModelContextInput =
    hasVisibleAppModelContext ||
    appModelContext.attachments.some((entry) => entry.kind === "message");
  // Beside Pages are offered context: an included one travels with a message, never makes one.
  const hasAttachments =
    hasComposerAttachmentStateContent(attachmentState) || hasAppModelContextInput;
  const hasVisibleAttachments =
    hasComposerAttachmentStateContent(attachmentState) ||
    hasVisibleAppModelContext ||
    pageContext.offers.length > 0;
  const hasSubmittableAttachments =
    hasSubmittableComposerAttachmentState(attachmentState) || hasAppModelContextInput;
  const hasVisibleNonImageAttachments =
    hasVisibleAppModelContext ||
    pageContext.offers.length > 0 ||
    fileAttachments.length > 0 ||
    addedFiles.length > 0 ||
    appshotContexts.length > 0 ||
    pastedTextAttachments.length > 0 ||
    commentAttachments.length > 0 ||
    browserAnnotationAttachments.length > 0 ||
    hasThreadTextSelections(selectionDraft.draft);
  const hasPendingPastedTextAttachments = pastedTextAttachments.some(
    (attachment) => attachment.status === "pending",
  );
  const latestTurnStatus = model.conversation?.turns.at(-1)?.status ?? null;
  const composerPrediction = useComposerPrediction({
    hostId: model.hostId,
    threadId: composerThreadId,
    latestTurnId: model.body.latestTurnId ?? model.conversation?.turns.at(-1)?.turnId ?? null,
    connected: model.connectionStatus === "connected",
    eligible:
      (model.provider?.kind ?? "codex") === "codex" &&
      model.composerShell.showComposer &&
      model.conversation !== null &&
      model.conversation.source?.sideConversation !== true &&
      model.conversation.ephemeral !== true &&
      !model.conversation.archived &&
      !model.isThreadRunning &&
      latestTurnStatus === "completed" &&
      model.conversation.statusType !== "active" &&
      !model.body.showThreadStartProgressPanel &&
      (model.body.emptyState.type === "none" || model.body.emptyState.type === "emptyThread"),
  });
  const hasResumeInterruptedTurnCapability = Boolean(
    actions.onResumeInterruptedTurn && model.conversation && !hasPendingPastedTextAttachments,
  );
  const pastedTextAttachmentsRef = useRef(pastedTextAttachments);
  useLayoutEffect(() => {
    pastedTextAttachmentsRef.current = pastedTextAttachments;
  }, [pastedTextAttachments]);
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
      const hostId = model.hostId === "durable" ? DEFAULT_CODEX_HOST_ID : model.hostId;
      void createPastedTextAttachment({ text: input.text, hostId })
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
    [model.hostId, setPastedTextAttachments],
  );

  const handleLargeTextPaste = useCallback(
    (text: string): boolean => {
      if (isDraftCaptureLocked()) return true;
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
    [isDraftCaptureLocked, runPastedTextMaterialization, setPastedTextAttachments],
  );

  const addOrdinaryComposerFiles = useCallback(
    async (files: readonly File[], source: "paste" | "drop"): Promise<void> => {
      if (files.length === 0 || isDraftCaptureLocked()) return;

      ordinaryFileUploadsRef.current.pending += 1;
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
      ordinaryFileUploadsRef.current.pending -= 1;
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
      ordinaryFileUploadsRef.current.error = failure
        ? failure.reason instanceof Error
          ? failure.reason.message
          : "Could not add one or more files"
        : null;
      if (failure) toastFailure("Couldn’t add one or more files", failure.reason);
    },
    [isDraftCaptureLocked, setFileAttachments],
  );

  const libraryReadAuthority = useLibraryFileReadAuthority();
  const handlePasteFiles = useCallback(
    (payload: ComposerPastedFiles): boolean => {
      if (isDraftCaptureLocked()) return true;
      if (payload.libraryImages.length > 0) {
        if (!libraryReadAuthority) return false;
        addCopiedLibraryImages(
          imageAttachmentController,
          libraryReadAuthority,
          payload.libraryImages,
        );
        return true;
      }
      if (payload.imageFiles.length > 0) {
        void imageAttachmentController.addFiles(payload.imageFiles, "paste");
      }
      if (payload.otherFiles.length > 0) {
        void addOrdinaryComposerFiles(payload.otherFiles, "paste");
      }
      return payload.imageFiles.length > 0 || payload.otherFiles.length > 0;
    },
    [
      addOrdinaryComposerFiles,
      imageAttachmentController,
      isDraftCaptureLocked,
      libraryReadAuthority,
    ],
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
    selectionDraft.clear();
    clearSubmittedDraft();
  }, [
    browserAnnotationConversationId,
    clearSubmittedDraft,
    imageEditComposerChannelId,
    incrementAttachmentGeneration,
    selectionDraft,
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
      selectionDraft.replace({
        responseTextAnnotations: input.attachments.responseTextAnnotations ?? [],
        selectedTextAttachments: input.attachments.selectedTextAttachments ?? [],
      });
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
      selectionDraft,
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
      if (isDraftCaptureLocked()) return false;
      if (draft.hasUnsupportedAttachments) {
        toast.danger(getThreadGoalMessage("composer.threadGoal.materializeError"), {
          id: "thread-goal-materialize-failed",
        });
        return false;
      }
      const goalHostId = model.hostId;

      if (!model.conversation) {
        const target = model.newThreadTarget;
        const startThreadForSession = actions.onStartThreadForSession;
        if (!target?.sessionId || !startThreadForSession) {
          toastFailure("Couldn’t start a new chat here");
          return false;
        }

        const submittedPresentation = actions.onCaptureSubmissionPresentation?.();
        setBusyAction("send");
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
            materialized = await materializeThreadGoalDraft(goalHostId, threadGoalDraft);
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

        return runWithCleanup(
          async () => {
            const startCompletion = startThreadForSession({
              projectId: target.projectId,
              sessionId: target.sessionId,
              projectDraftId: target.projectDraftId,
              prompt,
              submittedPresentation,
              threadGoalDraft,
              ...(threadGoalMaterializedDraft === undefined ? {} : { threadGoalMaterializedDraft }),
              ...(threadGoalMaterializedDraft === undefined
                ? {}
                : { threadGoalMaterializedHostId: goalHostId }),
              runInTarget: target.runInTarget,
              runInEnvironmentPath: target.runInEnvironmentPath,
              worktreeStartingState: target.worktreeStartingState,
            });
            clearAdmittedSubmission();
            await startCompletion;
            recordSuccessfulPromptSubmit(draft.objective);
            return true;
          },
          {
            cleanup: () => {
              setBusyAction(null);
            },
            onError: async (error) => {
              if (threadGoalMaterializedDraft) {
                await cleanupMaterializedThreadGoalDraft(goalHostId, threadGoalMaterializedDraft);
              }
              restoreAdmittedSubmission({
                prompt: draft.objective,
                attachments: attachmentState,
                imageEditDraft,
                goalModeActive: true,
              });
              toastFailure("Couldn’t start the goal", error, { id: "thread-goal-start-failed" });
              return false;
            },
          },
        );
      }

      const setThreadGoal = actions.onSetThreadGoal;
      if (!setThreadGoal) {
        toastFailure(getThreadGoalMessage("composer.threadGoal.setError"), undefined, {
          id: "thread-goal-set-failed",
        });
        return false;
      }

      setBusyAction("send");
      let materialized: CodexThreadGoalMaterializedDraft | null = null;
      try {
        materialized = await materializeThreadGoalDraft(goalHostId, {
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

      const threadId = model.conversation.threadId;
      const objective = materialized.objective;
      return runWithCleanup(
        async () => {
          await setThreadGoal({
            threadId,
            objective,
            status: "active",
          });
          materialized = null;
          completeSuccessfulSubmission(draft.objective);
          return true;
        },
        {
          cleanup: () => {
            setBusyAction(null);
          },
          onError: async () => {
            await cleanupMaterializedThreadGoalDraft(goalHostId, materialized);
            toast.danger(getThreadGoalMessage("composer.threadGoal.setError"), {
              id: "thread-goal-set-failed",
            });
            return false;
          },
        },
      );
    },
    [
      actions,
      attachmentState,
      clearAdmittedSubmission,
      completeSuccessfulSubmission,
      imageEditDraft,
      isDraftCaptureLocked,
      model.conversation,
      model.hostId,
      model.newThreadTarget,
      recordSuccessfulPromptSubmit,
      restoreAdmittedSubmission,
    ],
  );

  const finalizeEditedQueuedFollowUp = async () => {
    const conversation = model.conversation;
    if (!queuedFollowUpEdit || !conversation) return;
    return runWithCleanup(
      async () => {
        await actions.onRemoveQueuedFollowUp(conversation.threadId, queuedFollowUpEdit.followUpId);
      },
      {
        cleanup: () => {
          clearQueuedFollowUpEdit();
        },
        onError: () => {
          toast.danger("The message was sent, but its original queued copy could not be removed", {
            id: "queued-follow-up-edit-finalize-failed",
          });
        },
      },
    );
  };

  const submitPromptWithPageReferences = async (
    input: {
      prompt: string;
      submitAction: StageThreadsComposerSubmitAction | null;
      imageEditIntent?: ImageEditSubmissionIntent;
      pausedQueueResolution?: "resume" | "clear";
    },
    pageReferences: readonly PageReference[],
  ): Promise<boolean> => {
    if (sendGate) {
      toastUnsentMessage(sendGate.unsentReason);
      return false;
    }
    if (executionHold.held) {
      toastUnsentMessage("Resume work to send");
      return false;
    }
    if (isDraftCaptureLocked()) return false;
    if (hasPendingPastedTextAttachments) return false;
    // Nothing is chosen to send this to yet, so choosing is the next step and the message stays.
    const catalog = model.provider?.modelCatalog;
    if (catalog && !catalog.loading && !catalog.selected.model) {
      intelligenceController.open();
      return false;
    }
    const executionHostId = model.hostId;
    const intentImageAttachments = input.imageEditIntent
      ? buildComposerImageEditAttachments({
          currentAttachments: imageAttachments,
          intent: input.imageEditIntent,
          executionHostId,
          generation: attachmentGenerationRef.current,
        })
      : null;
    if (input.imageEditIntent && !intentImageAttachments) {
      toastUnsentMessage("One or more images couldn’t be read. Add them again and retry.");
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
      toastUnsentMessage(
        "One or more images aren’t available where this chat runs. Remove them or add them again.",
      );
      return false;
    }
    let promptInput: CodexPromptInput | undefined;
    try {
      promptInput = await materializeWrittenImages(
        buildComposerPromptInput({
          prompt: nextPrompt,
          attachments: effectiveAttachmentState,
          pageReferences,
          executionHostId,
        }),
        executionHostId,
      );
    } catch (error) {
      toastUnsentMessage(readableIpcError(error, "An image couldn’t be read."));
      return false;
    }
    const hasAgentConfig =
      (
        promptInput?.agentConfigs ??
        splitCodexPromptAgentConfigLines(promptInput?.text ?? nextPrompt).agentConfigs
      ).length > 0;
    // Document preferences may select a different model. Runtime preparation validates
    // that effective model before submitting or rewinding the conversation.
    if (
      !imageInputSupported &&
      !hasAgentConfig &&
      ((promptInput?.images?.length ?? 0) > 0 || input.imageEditIntent)
    ) {
      toastUnsentMessage(
        imageInputUnavailableReason ?? "Remove images or switch models to send this message.",
      );
      return false;
    }
    const hasPromptAttachments = promptInput !== undefined || hasAppModelContextInput;
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
      const openSideChat = actions.onOpenSideChat;
      if (!model.conversation || !openSideChat) {
        toast.danger("Failed to open side chat", {
          id: "side-chat-open-failed",
        });
        return false;
      }

      setBusyAction("send");
      return runWithCleanup(
        async () => {
          const sideChatPromptInput = await materializeWrittenImages(
            buildComposerPromptInput({
              prompt: sideChatPrompt,
              attachments: effectiveAttachmentState,
              pageReferences,
              executionHostId: model.hostId,
            }),
            model.hostId,
          );
          await appModelContext.submit((mcpAppModelContextAttachments) =>
            openSideChat({
              prompt: sideChatPrompt,
              promptInput: withComposerModelContext(
                sideChatPromptInput,
                sideChatPrompt,
                mcpAppModelContextAttachments,
              ),
            }),
          );
          await finalizeEditedQueuedFollowUp();
          await cleanupSubmittedPastedTextAttachments(submittedPastedTextFiles);
          completeSuccessfulSubmission(sideChatPrompt);
          return true;
        },
        {
          cleanup: () => {
            setBusyAction(null);
          },
          onError: () => {
            toast.danger("Failed to open side chat", {
              id: "side-chat-open-failed",
            });
            return false;
          },
        },
      );
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

    return runWithCleanup(
      async () => {
        if (!model.conversation) {
          if (!target) return false;
          if (target.sessionId) {
            if (!actions.onStartThreadForSession) {
              toastUnsentMessage("This place can’t start a new chat.");
              return false;
            }
            await intelligenceController.flush();
            const startThreadForSession = actions.onStartThreadForSession;
            await appModelContext.submit(async (mcpAppModelContextAttachments) => {
              const startCompletion = startThreadForSession({
                projectId: target.projectId,
                sessionId: target.sessionId,
                projectDraftId: target.projectDraftId,
                prompt: nextPrompt,
                promptInput: withComposerModelContext(
                  promptInput,
                  nextPrompt,
                  mcpAppModelContextAttachments,
                ),
                runInTarget: target.runInTarget,
                runInEnvironmentPath: target.runInEnvironmentPath,
                worktreeStartingState: target.worktreeStartingState,
              });
              clearAdmittedSubmission();
              completedFirstSubmission = true;
              await startCompletion;
            });
            recordSuccessfulPromptSubmit(nextPrompt);
          } else {
            toastUnsentMessage("Choose where the new chat starts, then send again.");
            return false;
          }
        } else if (model.isThreadRunning && approvals.pending.length === 0) {
          const threadId = model.conversation.threadId;
          if (isImageEditFollowUp || input.submitAction === "queue") {
            if (queuedFollowUpEdit && actions.onReplaceQueuedFollowUp) {
              const replaceQueuedFollowUp = actions.onReplaceQueuedFollowUp;
              const edit = queuedFollowUpEdit;
              await appModelContext.submit(async (mcpAppModelContextAttachments) => {
                const replaced = await replaceQueuedFollowUp(
                  threadId,
                  edit.followUpId,
                  edit.ledgerRevision,
                  nextPrompt,
                  {
                    collaborationMode: model.selectedCollaborationMode,
                    promptInput: withComposerModelContext(
                      promptInput,
                      nextPrompt,
                      mcpAppModelContextAttachments,
                    ),
                  },
                );
                if (!replaced)
                  throw new Error("The queued message changed before it could be edited");
              });
              clearQueuedFollowUpEdit();
            } else {
              await appModelContext.submit((mcpAppModelContextAttachments) =>
                actions.onEnqueueQueuedFollowUp(threadId, nextPrompt, {
                  collaborationMode: model.selectedCollaborationMode,
                  promptInput: withComposerModelContext(
                    promptInput,
                    nextPrompt,
                    mcpAppModelContextAttachments,
                  ),
                }),
              );
              await finalizeEditedQueuedFollowUp();
            }
          } else if (input.submitAction === "steer") {
            await appModelContext.submit(async (mcpAppModelContextAttachments) => {
              const effectivePromptInput = withComposerModelContext(
                promptInput,
                nextPrompt,
                mcpAppModelContextAttachments,
              );
              if (effectivePromptInput?.mcpAppModelContextAttachments?.length) {
                await actions.onEnqueueQueuedFollowUp(threadId, nextPrompt, {
                  collaborationMode: model.selectedCollaborationMode,
                  promptInput: effectivePromptInput,
                });
                return;
              }
              const expectedTurnId = model.activeTurn?.turnId;
              if (!expectedTurnId)
                throw new Error(
                  "Nodex is already running. Wait for the active turn to load or queue the follow-up instead.",
                );
              await actions.onSteerPrompt({
                expectedTurnId,
                prompt: nextPrompt,
                promptInput: effectivePromptInput,
                collaborationMode: model.selectedCollaborationMode,
              });
            });
            await finalizeEditedQueuedFollowUp();
          } else {
            toastUnsentMessage(
              "The Agent is still working. Choose Queue or Steer to send a follow-up.",
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
          const submittedPresentation = actions.onCaptureSubmissionPresentation?.();
          await intelligenceController.flush();
          const predictionSubmission = composerPrediction.beforeSubmit();
          await appModelContext.submit((mcpAppModelContextAttachments) =>
            actions.onSendPrompt(nextPrompt, {
              submittedPresentation,
              collaborationMode: model.selectedCollaborationMode,
              promptInput: withComposerModelContext(
                promptInput,
                nextPrompt,
                mcpAppModelContextAttachments,
              ),
              ...intelligenceController.turnOverrides,
            }),
          );
          composerPrediction.recordSubmitted(predictionSubmission, nextPrompt);
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
      },
      {
        cleanup: () => {
          setBusyAction(null);
        },
        onError: (error) => {
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
          toastUnsentMessage(error);
          return false;
        },
      },
    );
  };
  const submitPrompt = (input: Parameters<typeof submitPromptWithPageReferences>[0]) =>
    pageContext.submit((references) => submitPromptWithPageReferences(input, references));
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
  const realtimeVoice = useComposerRealtimeVoice(
    model.conversation &&
      (model.provider === null || model.provider === undefined || model.provider.kind === "codex")
      ? { hostId: model.hostId, threadId: model.conversation.threadId }
      : null,
    appModelContext.recipient,
  );
  const isRealtimeVoiceActive =
    model.dictation.capabilities.microphoneOwner === "realtime-voice" ||
    realtimeVoice.phase !== "inactive";

  const insertDictationTranscript = async (transcript: string): Promise<string | null> => {
    const editor = dictationEditorRef.current ?? promptEditorRef.current;
    const result = await editor?.dictation?.finish(transcript, () => {
      const currentDraft = readPrompt();
      return currentDraft === editor.getPersistedText()
        ? editor.dictation!.document
        : buildPromptDoc(currentDraft);
    });
    if (result === "cancelled") return null;
    if (result === "finished" && editor) {
      const text = editor.getText();
      if (!editor.getElement()?.isConnected) setPrompt(editor.getPersistedText());
      else editor.focus();
      return text;
    }
    if (!transcript.trim()) return editor?.getText() ?? readPrompt();
    if (editor?.getElement()?.isConnected) return editor.insertDictationText(transcript);
    const draft = readPrompt();
    const next = appendComposerDictationText(draft, transcript);
    setPrompt(next);
    return next;
  };

  const handleInsertPromptMention = useCallback((mention: ComposerPromptMentionInput) => {
    promptEditorRef.current?.insertMention(mention);
  }, []);

  const handleToggleDesktopPet = useCallback(() => {
    void toggleAvatarOverlay().catch(() => {
      toast.danger("Could not open the desktop pet");
    });
  }, []);

  const activateGoalMode = () => {
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
  };

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
        const editor = promptEditorRef.current;
        if (editor) editor.focusAtEnd();
      } catch {
        toast.danger(getThreadGoalMessage("composer.threadGoal.clearError"));
      }
    })();
  }, [actions.onClearThreadGoal, model.conversation?.threadGoal, setGoalModeActive]);

  const handlePickComposerFiles = useCallback(
    () =>
      pickAndAddComposerFiles({
        attachmentGenerationRef,
        imageAttachmentController,
        setFileAttachments,
      }),
    [imageAttachmentController, setFileAttachments],
  );

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

  const handleComposerDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!browserImageDrag && !hasComposerFileDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    fileDrag.enter();
  };

  const handleComposerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!fileDrag.leave()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleComposerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!browserImageDrag && !hasComposerFileDataTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    [browserImageDrag],
  );

  const handleBrowserImageDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!browserImageDrag) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    return runWithCleanup(
      async () => {
        const result = await invokeBrowserSidebarCommand({
          type: "attach-dragged-image",
          browserConversationId: browserImageDrag.browserConversationId,
          browserViewScopeId: browserImageDrag.browserViewScopeId,
          browserTabId: browserImageDrag.browserTabId,
        });
        if (!result.ok) toastFailure("Couldn’t add the Browser image", result.message);
      },
      {
        cleanup: () => {
          clearBrowserImageDragState(browserAnnotationConversationId);
        },
        onError: (error) => {
          toastFailure("Couldn’t add the Browser image", error);
        },
      },
    );
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    fileDrag.end();
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
  };

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
    isStarting,
    canRetryDictation,
    recovery: dictationRecovery,
    dismissRecovery: dismissDictationRecovery,
    appendRecoveredText,
    isTranscribing,
    transcriptionAction,
    waveformCanvasRef,
    startDictation,
    stopDictation,
    retryDictation,
    cancelDictation,
  } = useComposerDictation({
    enabled: isDictationSupported,
    streamingAvailability: model.dictation.capabilities.streaming,
    soundsEnabled: model.dictation.capabilities.sounds,
    globalTarget: {
      id: globalDictationTargetId,
      priority: isFloatingComposer ? 20 : 10,
      admission: () =>
        resolveComposerGlobalDictationAdmission({
          floating: isFloatingComposer,
          visible: composerVisible,
          editor: promptEditorRef.current?.getElement() ?? null,
        }),
    },
    transcript: {
      start: (split) => {
        dictationEditorRef.current = promptEditorRef.current;
        dictationEditorRef.current?.dictation?.start(split);
      },
      update: (text, segment) => dictationEditorRef.current?.dictation?.update(text, segment),
      preserve: () => dictationEditorRef.current?.dictation?.preserve(),
      cancel: () => {
        const editor = dictationEditorRef.current;
        if (!editor) return;
        const previous = editor.getPersistedText();
        editor.dictation?.cancel();
        if (!editor.getElement()?.isConnected && readPrompt() === previous) {
          setPrompt(editor.getPersistedText());
        }
        dictationEditorRef.current = null;
      },
    },
    onTranscriptAppend: async (transcript) => {
      const editor = promptEditorRef.current;
      const current = editor?.getText() ?? readPrompt();
      const text = appendComposerDictationText(current, transcript);
      if (editor?.getElement()?.isConnected) {
        editor.focusAtEnd();
        editor.insertDictationText(transcript);
        return;
      }
      setPrompt(text);
    },
    onTranscriptInsert: async (transcript) => {
      await insertDictationTranscript(transcript);
    },
    onTranscriptSend: async (transcript) => {
      const nextPrompt = await insertDictationTranscript(transcript);
      if (nextPrompt === null) return;
      const actionState = resolveStageThreadsComposerActionState({
        canSendPrompt: !sendHeld && (model.conversation !== null || canStartNewThread),
        isThreadRunning: model.isThreadRunning,
        busyAction,
        hasDraftContent:
          nextPrompt.trim().length > 0 || hasSubmittableAttachments || goalModeActive,
        hasThreadGoal: goalModeActive || Boolean(model.conversation?.threadGoal),
        isQueueingEnabled: model.isQueueingEnabled,
        supportsRunningFollowUps: supportsConversationProviderControl(model.provider, "steer"),
        latestTurnStatus,
        canResumeInterruptedTurn: false,
      });
      await submitPrompt({
        prompt: nextPrompt,
        submitAction: actionState.primarySubmitAction,
      });
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
        retryable: error.retryable,
      });
    },
    onUnsupported: () => {
      toast.danger("Dictation is not available on this device", {
        id: "composer-dictation-unavailable",
      });
    },
  });
  const isComposerDictationActive = isDictating || isTranscribing;
  const inlineDictation = model.dictation.capabilities.streaming === "available";
  const showDictationRow = isComposerDictationActive && !inlineDictation;
  useEffect(() => {
    if (!composerVisible && isDictating) stopDictation("insert");
  }, [composerVisible, isDictating, stopDictation]);
  const canResumeInterruptedTurn =
    hasResumeInterruptedTurnCapability && !isDictating && !isTranscribing;
  const startDictationRef = useRef(startDictation);
  const stopDictationRef = useRef(stopDictation);

  useEffect(() => {
    startDictationRef.current = startDictation;
    stopDictationRef.current = stopDictation;
  }, [startDictation, stopDictation]);

  useEffect(() => {
    if (!isDictationSupported || isRealtimeVoiceActive || !composerVisible) {
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
      void startDictationRef.current("hold");
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
  }, [commandKeymapQuery.data, composerVisible, isDictationSupported, isRealtimeVoiceActive]);

  const handleInterrupt = async () => {
    if (!model.conversation || !model.isThreadRunning) return;
    setBusyAction("interrupt");
    return runWithCleanup(
      async () => {
        await actions.onInterruptTurn(model.activeTurn?.turnId ?? undefined);
      },
      {
        cleanup: () => {
          setBusyAction(null);
        },
        onError: (error) => {
          toastFailure("Couldn’t stop the Agent", error, { id: "composer-interrupt-failed" });
        },
      },
    );
  };

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
    return runWithCleanup(
      async () => {
        await resumeInterruptedTurn();
      },
      {
        cleanup: () => {
          releaseAttempt();
          setBusyAction(null);
        },
        onError: (error) => {
          toastFailure("Couldn’t resume the Agent", error, { id: "composer-resume-failed" });
        },
      },
    );
  }, [actions, model, resumeAttemptGate]);

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
            toastFailure("Couldn’t remove the pasted text", error);
          },
        );
      }
    },
    [incrementAttachmentGeneration, setPastedTextAttachments],
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
          toastFailure("Couldn’t show the pasted text", error);
        });
    },
    [setPastedTextAttachments, setPrompt],
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

  const slashCommands = buildComposerSlashCommands({
    model,
    actions,
    serviceTier: serviceTierSettings.serviceTier,
    setServiceTier,
    openExpandedDialog: () => setSlashDialogOpen(true),
    onPetToggle: handleToggleDesktopPet,
    activateGoalMode,
  });
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
  const slashMatches = filterComposerSlashCommands({
    commands: slashCommands,
    query: slashTrigger.active ? slashTrigger.query : "",
    composerText: prompt,
    trigger: slashTrigger.trigger,
  });
  const slashGroups = groupComposerSlashCommandMatches(slashMatches);
  const slashMenuOpen = slashTrigger.active || nestedSlashCommand !== null;
  const planModeAvailable = hasPlanMode(model.collaborationModes);
  const togglePlanMode = (): boolean => {
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
  };
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
  const selectLatestQueuedFollowUpForArrowUp = (): boolean => {
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
  };
  const { appendPromptToHistory, handlePromptHistoryKeyDown, resetHistorySelection } =
    useThreadComposerPromptHistoryRecall({
      editorRef: promptEditorRef,
      scopeKey: promptHistoryScopeKey,
      composerText: prompt,
      selectLatestQueuedFollowUp: selectLatestQueuedFollowUpForArrowUp,
    });
  useLayoutEffect(() => {
    appendPromptToHistoryRef.current = appendPromptToHistory;
    resetPromptHistorySelectionRef.current = resetHistorySelection;
  }, [appendPromptToHistory, resetHistorySelection]);

  const closeSlashMenu = () => {
    promptEditorRef.current?.closeSuggestions();
    setNestedSlashCommand(null);
    setInlineSlashHighlightIntent({ commandId: null, source: "programmatic" });
  };
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

  const handleSuggestionStateChange = (nextSuggestion: ComposerSuggestionState) => {
    setSuggestionState(nextSuggestion);
    if (nextSuggestion.active) {
      if (nextSuggestion.kind !== "slash-command" || nextSuggestion.source === null) {
        setNestedSlashCommand(null);
      }
      return;
    }
    setNestedSlashCommand(null);
    setInlineSlashHighlightIntent({ commandId: null, source: "programmatic" });
  };

  const clearInlineSlashTrigger = useCallback((trigger: ComposerSlashTriggerState) => {
    promptEditorRef.current?.clearRange({ from: trigger.from, to: trigger.to });
    promptEditorRef.current?.closeSuggestions();
  }, []);

  const selectSlashCommand = (command: ComposerSlashCommand, source: "inline" | "dialog") => {
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
  };

  const backFromNestedSlashMenu = useCallback(() => {
    promptEditorRef.current?.openSlashSubmenu(null);
    setNestedSlashCommand(null);
  }, []);

  const handleSuggestionAction = (action: ComposerSuggestionAction): boolean => {
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
  };

  const handleKeyDown = (event: ComposerPromptEditorKeyboardEvent): boolean => {
    if (isDictating && event.key === "Escape" && !slashMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      cancelDictation();
      return true;
    }
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
    const isComposing = "nativeEvent" in event ? event.nativeEvent.isComposing : event.isComposing;
    const actionState = resolveStageThreadsComposerActionState({
      canSendPrompt: !sendHeld && (model.conversation !== null || canStartNewThread),
      isThreadRunning: model.isThreadRunning,
      busyAction,
      hasDraftContent: prompt.trim().length > 0 || hasAttachments || goalModeActive,
      hasThreadGoal: goalModeActive || Boolean(model.conversation?.threadGoal),
      isQueueingEnabled: model.isQueueingEnabled,
      supportsRunningFollowUps: supportsConversationProviderControl(model.provider, "steer"),
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
    if (isComposerDictationActive) {
      stopDictation("send");
      return true;
    }
    void submitPrompt({
      prompt,
      submitAction: submitIntent.submitAction,
    });
    return true;
  };

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
  const modelCatalog = model.provider?.modelCatalog;
  const currentModelOff = modelCatalog?.currentModelOff;
  const composerNotice =
    sendGate?.notice ??
    executionHold.notice ??
    model.provider?.notice ??
    (currentModelOff
      ? {
          key: "model-off",
          tone: "warning" as const,
          title: currentModelOff.title,
          actions: [
            { label: "Choose model", run: () => intelligenceController.open() },
            currentModelOff.turnOn
              ? { label: "Turn on", pendingLabel: "Turning on…", run: currentModelOff.turnOn }
              : { label: "Manage", run: () => modelCatalog?.manageModels?.() },
          ],
        }
      : null);
  const composerLayout = resolveComposerAdaptiveLayout({
    isFloatingComposer,
    hasAttachments,
    hasExplicitLineBreak: hasMultilinePrompt,
    promptIntrinsicWidthPx,
    compactInputWidthPx,
    hasNotice: composerNotice !== null,
    isDictating: showDictationRow,
  });
  const floatingComposerSingleLine = composerLayout === "single-line";
  const isMacPlatform =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

  const composerActionState = resolveStageThreadsComposerActionState({
    canSendPrompt: !sendHeld && (model.conversation !== null || canStartNewThread),
    isThreadRunning: model.isThreadRunning && approvals.pending.length === 0,
    busyAction,
    hasDraftContent: hasComposerContent,
    hasThreadGoal: goalModeActive || Boolean(model.conversation?.threadGoal),
    isQueueingEnabled: model.isQueueingEnabled,
    supportsRunningFollowUps: supportsConversationProviderControl(model.provider, "steer"),
    latestTurnStatus,
    canResumeInterruptedTurn,
    interruptUnavailableReason: model.provider?.interruptUnavailableReason ?? null,
  });
  // Stop stays in place, unavailable and saying why, for work this reader may not stop.
  const pluginAppSessionId =
    model.composerChatKey?.kind === "session" && composerVisible
      ? model.composerChatKey.sessionId
      : null;
  useRegisterPluginAppFollowUp(
    pluginAppSessionId,
    async (message: McpAppFollowUpMessage, sourceId) => {
      const text = buildMcpAppFollowUpPrompt(message);
      if (message.send === false) {
        setPrompt([readPrompt(), text].filter(Boolean).join("\n\n"));
        return;
      }
      if (sendHeld || busyAction !== null || (!model.conversation && !canStartNewThread))
        throw new Error("This chat is unable to send now.");
      const untrustedAppMessage = { source: "mcp_app", sourceId, text } as const;
      await appModelContext.submit(async (mcpAppModelContextAttachments) => {
        const promptInput = { text, untrustedAppMessage, mcpAppModelContextAttachments };
        if (!model.conversation) {
          const target = model.newThreadTarget;
          if (
            !target?.sessionId ||
            target.sessionId !== pluginAppSessionId ||
            !actions.onStartThreadForSession
          )
            throw new Error("This chat is unavailable.");
          await intelligenceController.flush();
          await actions.onStartThreadForSession({
            projectId: target.projectId,
            sessionId: target.sessionId,
            prompt: text,
            promptInput,
            runInTarget: target.runInTarget,
            runInEnvironmentPath: target.runInEnvironmentPath,
            worktreeStartingState: target.worktreeStartingState,
          });
          return;
        }
        if (model.isThreadRunning) {
          if (!model.isQueueingEnabled) throw new Error("This chat is still working.");
          await actions.onEnqueueQueuedFollowUp(model.conversation.threadId, text, {
            promptInput,
            untrustedAppMessage,
          });
          return;
        }
        await intelligenceController.flush();
        await actions.onSendPrompt(text, {
          promptInput,
          untrustedAppMessage,
          collaborationMode: model.selectedCollaborationMode,
          ...intelligenceController.turnOverrides,
        });
      });
    },
  );
  const stopUnavailableReason = composerActionState.unavailableReason ?? null;
  const submitAnnotation = useEffectEvent(() => {
    selectionDraft.consumeSubmission();
    void submitPrompt({
      prompt: readPrompt(),
      submitAction: composerActionState.primarySubmitAction,
    });
  });
  useEffect(() => {
    if (composerVisible && selectionDraft.draft.submitNonce > 0) submitAnnotation();
  }, [composerVisible, selectionDraft.draft.submitNonce]);

  const submitImageEdit = useEffectEvent(
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
          executionHostId: model.hostId,
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
  useEffect(
    () => registerImageEditComposerChannel(imageEditComposerChannelId, submitImageEdit),
    [imageEditComposerChannelId],
  );

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
  const handleConfirmGoalReplacement = () => {
    const confirmation = goalReplacementConfirmation;
    if (!confirmation || busyAction !== null) return;

    void (async () => {
      const succeeded = await submitThreadGoalDraft(confirmation.draft);
      if (succeeded) {
        await finalizeEditedQueuedFollowUp();
        setGoalReplacementConfirmation(null);
      }
    })();
  };
  const handlePausedQueueSendDecision = (resolution: "resume" | "clear") => {
    if (busyAction !== null) return;
    setPausedQueueSendDialogOpen(false);
    void submitPrompt({
      prompt,
      submitAction: composerActionState.primarySubmitAction,
      pausedQueueResolution: resolution,
    });
  };
  const newThreadPromptPlaceholder = model.newThreadTarget
    ? "Do anything"
    : "Select a card or session before starting a new thread";
  const promptPlaceholder =
    approvalPlaceholder ??
    (model.newThreadStartBlockedReason
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
                : "Select a thread");
  const isPromptEditorDisabled =
    (model.conversation === null && !canStartNewThread) ||
    busyAction !== null ||
    draftCaptureLocked;
  const captureReaderRef = useRef<() => ComposerDraftCaptureResult>(() => ({
    status: "blocked",
    reason: "unavailable",
    message: "This conversation's draft is unavailable.",
  }));
  useLayoutEffect(() => {
    captureReaderRef.current = () => {
      if (
        busyAction !== null ||
        model.isThreadRunning ||
        isStarting ||
        isDictating ||
        isTranscribing ||
        isRealtimeVoiceActive
      ) {
        return {
          status: "blocked",
          reason: "busy",
          message: "Wait for this conversation's current action to finish before saving.",
        };
      }
      const promptState = maitaiStore.jotaiStore.get(
        getConcretePersistedAtom(maitaiStore, composerPromptDraftsAtom),
      );
      const imageState = maitaiStore.jotaiStore.get(
        getConcretePersistedAtom(maitaiStore, composerImageDraftsAtom),
      );
      if (promptState.status === "loading" || imageState.status === "loading") {
        return {
          status: "blocked",
          reason: "draft-loading",
          message: "Wait for the draft to finish loading.",
        };
      }
      if (promptState.status === "error" || imageState.status === "error") {
        return {
          status: "blocked",
          reason: "draft-error",
          message:
            promptState.error?.message ??
            imageState.error?.message ??
            "The draft could not be saved. Try again.",
        };
      }
      const images = composerHandle.get(composerImageAttachmentsAtom);
      const pasted = composerHandle.get(composerPastedTextAttachmentsAtom);
      if (
        images.some(
          (image) => image.materializationStatus === "failed" || image.uploadStatus === "failed",
        ) ||
        pasted.some((attachment) => attachment.status === "failed") ||
        ordinaryFileUploadsRef.current.error
      ) {
        return {
          status: "blocked",
          reason: "attachment-error",
          message: "An attachment could not be added. Retry or remove it before saving.",
        };
      }
      if (
        images.some(
          (image) => image.materializationStatus !== "ready" || image.uploadStatus === "uploading",
        ) ||
        pasted.some((attachment) => attachment.status === "pending") ||
        ordinaryFileUploadsRef.current.pending > 0 ||
        getBrowserImageAttachmentsSnapshot(browserAnnotationConversationId).length > 0
      ) {
        return {
          status: "blocked",
          reason: "pending-attachments",
          message: "Wait for attachments to finish uploading before saving.",
        };
      }
      if (persistableComposerImages(images).length !== images.length) {
        return {
          status: "blocked",
          reason: "attachment-error",
          message: "An image cannot be saved with this draft. Add it again before saving.",
        };
      }
      const storedDocument = readPromptDocument();
      const text = promptEditorRef.current?.getPersistedText() ?? readPrompt();
      const promptDocument =
        storedDocument.text === text ? storedDocument : { text, links: [], mentions: [] };
      return {
        status: "ready",
        snapshot: {
          prompt: text,
          promptDocument,
          fileAttachments: composerHandle.get(composerFileAttachmentsAtom),
          addedFiles: composerHandle.get(composerAddedFilesAtom),
          imageAttachments: images,
          appshotContexts: composerHandle.get(composerAppshotContextsAtom),
          pastedTextAttachments: pasted,
          commentAttachments: getReviewDiffCommentAttachmentsSnapshot(composerThreadId),
          browserAnnotationAttachments: getBrowserAnnotationAttachmentsSnapshot(
            browserAnnotationConversationId,
          ),
          ...selectionDraft.readSnapshot(),
          appModelContextAttachments: readComposerAppModelContext(composerHandle),
          imageEditDraft: getImageEditComposerDraftSnapshot(imageEditComposerChannelId),
          goalModeActive: composerHandle.get(composerGoalModeActiveAtom),
        },
      };
    };
  }, [
    browserAnnotationConversationId,
    busyAction,
    composerHandle,
    composerThreadId,
    imageEditComposerChannelId,
    isDictating,
    isRealtimeVoiceActive,
    isStarting,
    isTranscribing,
    maitaiStore,
    model.isThreadRunning,
    readPrompt,
    readPromptDocument,
    selectionDraft,
  ]);
  useLayoutEffect(() => {
    if (!composerThreadId) return;
    return registerComposerDraftCapture(
      { threadId: composerThreadId, composerScopeIdentity: captureScopeIdentity },
      {
        read: () => captureReaderRef.current(),
        prepare: (transfer) =>
          prepareComposerDraftTransferAttachments(
            transfer,
            {
              read: readPastedTextAttachment,
              create: createPastedTextAttachment,
              remove: removePastedTextAttachment,
            },
            model.hostId,
          ),
        persist: (transfer) => persistComposerDraftTransfer(maitaiStore, transfer),
      },
    );
  }, [captureScopeIdentity, composerThreadId, maitaiStore, model.hostId]);
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
  const composerPluginCwds = model.workspaceSearchContext?.skillRoots ?? [];
  const contextSupported = supportsConversationProviderControl(model.provider, "context");
  const addContextControl = (
    <ComposerAddContextTrigger
      open={contextSuggestionOpen}
      disabled={isPromptEditorDisabled || !contextSupported}
      onToggle={() => {
        promptEditorRef.current?.toggleContextSuggestions();
      }}
    />
  );
  const intelligenceControls = (
    <>
      <ContextWindowIndicator
        state={contextWindowIndicatorState}
        account={!model.provider || model.provider.kind === "codex" ? model.account : null}
        showFallbackLabel={false}
      />
      <ModelSelectorDropdown model={model} controller={intelligenceController} />
    </>
  );
  const dictationControl =
    isDictationSupported && !(inlineDictation && transcriptionAction === "send") ? (
      <NodexTooltip
        tooltipContent={
          isStarting
            ? "Starting dictation…"
            : isDictating
              ? "Stop dictation"
              : isTranscribing
                ? "Finishing dictation"
                : canRetryDictation
                  ? "Retry dictation"
                  : "Dictate"
        }
        shortcutLabel={
          isStarting || isDictating || isTranscribing || canRetryDictation
            ? undefined
            : dictationShortcutPresentation?.label
        }
        side="top"
        sideOffset={4}
      >
        <button
          type="button"
          className={cn(
            "border-token-border no-drag cursor-interaction flex h-token-button-composer aspect-square items-center justify-center gap-1 rounded-full border border-transparent px-0 py-0 text-sm leading-[18px] whitespace-nowrap text-token-text-tertiary select-none transition-colors duration-100 focus:outline-none enabled:hover:bg-token-list-hover-background enabled:hover:text-token-foreground disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:bg-token-list-hover-background",
            inlineDictation && isDictating && "aspect-auto px-2 bg-token-list-hover-background",
          )}
          aria-label={
            isStarting
              ? "Starting dictation; click to cancel"
              : inlineDictation && isDictating
                ? "Stop dictation"
                : isTranscribing
                  ? inlineDictation
                    ? "Finishing dictation"
                    : "Cancel dictation transcription"
                  : canRetryDictation
                    ? "Retry dictation"
                    : "Dictate"
          }
          onClick={() => {
            if (inlineDictation && isDictating) {
              stopDictation("insert");
              return;
            }
            if (isStarting || isTranscribing) {
              cancelDictation();
              return;
            }
            if (canRetryDictation) {
              void retryDictation();
              return;
            }
            promptEditorRef.current?.focusAtEnd();
            void startDictation();
          }}
          disabled={isRealtimeVoiceActive || (inlineDictation && isTranscribing)}
          aria-busy={isStarting || isTranscribing}
        >
          {inlineDictation && isDictating ? (
            <canvas
              ref={waveformCanvasRef}
              className="h-5 w-8 text-token-text-tertiary"
              aria-hidden="true"
            />
          ) : null}
          {isStarting || isTranscribing ? (
            <ActivitySpinnerIcon className="icon-xs" />
          ) : inlineDictation && isDictating ? (
            <StopIcon className="icon-xs" />
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
          COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME,
          (composerActionState.disabled ||
            (composerActionState.action === "send" && !canRunPrimaryAction)) &&
            !isPrimaryActionPending &&
            "opacity-50",
          isPrimaryActionPending && "cursor-wait",
        )}
        onClick={
          stopUnavailableReason !== null
            ? undefined
            : composerActionState.action === "stop"
              ? () => void handleInterrupt()
              : composerActionState.action === "resume"
                ? () => void handleResumeInterruptedTurn()
                : () =>
                    void submitPrompt({
                      prompt,
                      submitAction: composerActionState.primarySubmitAction,
                    })
        }
        // An unavailable Stop stays focusable, so its reason reaches every reader.
        disabled={
          stopUnavailableReason !== null
            ? undefined
            : composerActionState.action === "send"
              ? composerActionState.disabled || !canRunPrimaryAction
              : composerActionState.disabled
        }
        aria-disabled={stopUnavailableReason !== null ? "true" : undefined}
        aria-description={stopUnavailableReason ?? undefined}
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
    inlineDictation && isComposerDictationActive ? (
      <NodexTooltip tooltipContent="Send" side="top">
        <button
          type="button"
          className={cn(COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME, "disabled:opacity-50")}
          aria-label="Send"
          aria-busy={transcriptionAction === "send"}
          disabled={transcriptionAction === "send"}
          onClick={() => stopDictation("send")}
        >
          {transcriptionAction === "send" ? (
            <ActivitySpinnerIcon className="icon-sm" />
          ) : (
            <UpArrowIcon className="icon-sm" />
          )}
        </button>
      </NodexTooltip>
    ) : composerActionState.action === "resume" ? (
      primaryActionButton
    ) : (
      <NodexTooltip
        tooltipContent={stopUnavailableReason ?? composerActionTooltip}
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
    <div
      className="contents"
      onFocusCapture={() => approvals.runtime?.interact({ type: "focus" })}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          approvals.runtime?.interact({ type: "blur" });
      }}
    >
      <ComposerPromptEditor
        onOpenSkill={({ name, path }) => {
          void openSkill({
            hostId: model.hostId === "durable" ? DEFAULT_CODEX_HOST_ID : model.hostId,
            projectId: model.projectId,
            name,
            path,
          }).then((opened) => {
            if (!opened) toast.danger("This skill is no longer here");
          });
        }}
        ref={promptEditorRef}
        data-composer-prompt-frame="true"
        value={prompt}
        placeholder={promptPlaceholder}
        disabled={isPromptEditorDisabled}
        singleLine={singleLine}
        allowMentions={contextSupported}
        {...(model.provider?.kind === "claude" ? { promptKeywords: CLAUDE_PROMPT_KEYWORDS } : {})}
        prediction={
          !isPromptEditorDisabled &&
          model.composerShell.activeRequest === null &&
          !hasAttachments &&
          imageEditDraft.mode === null &&
          !isStarting &&
          !isDictating &&
          !isTranscribing &&
          !isRealtimeVoiceActive
            ? composerPrediction.prediction
            : null
        }
        onPredictionInteraction={composerPrediction.onInteraction}
        onChange={(nextPrompt) => {
          approvals.runtime?.interact({ type: "type", now: Date.now() });
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
    </div>
  );
  const permissionControl =
    model.runtimeMode != null && actions.onRuntimeModeChange ? (
      <PermissionModeDropdown
        triggerStyle="composer"
        mode={model.runtimeMode}
        supportedModes={model.supportedRuntimeModes}
        agentLabel={model.provider?.label}
        emphasized={model.runtimeMode !== model.defaultRuntimeMode}
        appliesNextMessage={composerActionState.action === "stop"}
        onSelect={actions.onRuntimeModeChange}
      />
    ) : null;
  const floatingLeadingControls = (
    <div className="flex min-w-0 items-center gap-[5px]">
      {addContextControl}
      {permissionControl}
    </div>
  );
  const floatingTrailingControls = (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      {model.selectedCollaborationMode === "plan" || goalModeActive ? (
        <ComposerFooterAccessoryDivider />
      ) : null}
      <ActiveComposerModeChip model={model} onToggle={togglePlanMode} />
      <ActiveGoalModeChip active={hasFooterGoalChip} onClear={clearFooterGoal} />
      <div className="flex min-w-0 items-center gap-1">{intelligenceControls}</div>

      {dictationControl}
      {primaryActionControl}
    </div>
  );
  const standardLeadingControls = (
    <div className="flex min-w-0 items-center gap-[5px]">
      {addContextControl}
      {permissionControl}

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
        <RealtimeVoiceControls voice={realtimeVoice} />
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
            "inline-flex size-7 items-center justify-center rounded-full bg-composer-primary p-0.5 text-composer-primary focus-visible:outline-2 focus-visible:outline-background-composer-primary",
            isTranscribing && "opacity-50",
          )}
          aria-label="Transcribe and send"
          onClick={() => stopDictation("send")}
          disabled={transcriptionAction === "send"}
          aria-busy={transcriptionAction === "send"}
        >
          {transcriptionAction === "send" ? (
            <ActivitySpinnerIcon className="size-4" />
          ) : (
            <UpArrowIcon className="size-5" />
          )}
        </button>
      </NodexTooltip>
    </>
  );
  return (
    <>
      {composerNotice && !isFloatingComposer ? (
        <ComposerNoticeRail notice={composerNotice} placement="attached" />
      ) : null}
      <ComposerContextRailSlot visible={showExternalFooter}>
        <ThreadComposerStatusStrip
          model={model}
          actions={actions}
          contextRailLeadingContent={contextRailLeadingContent}
          projectSelectorDisabled={busyAction !== null}
        />
      </ComposerContextRailSlot>
      <div
        inert={draftCaptureLocked}
        className={cn(
          "relative",
          (browserImageDrag || fileDrag.active) && COMPOSER_DROP_TARGET_CLASS_NAME,
        )}
        data-composer-context-suggestions={contextSuggestionOpen ? "true" : undefined}
        data-browser-image-drop-active={browserImageDrag ? "true" : "false"}
        data-file-drop-active={fileDrag.active ? "true" : "false"}
        onDragEnter={handleComposerDragEnter}
        onDragLeave={handleComposerDragLeave}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
      >
        <ComposerAddContextMenu
          ref={addContextMenuRef}
          suggestion={suggestionState}
          activeConversationId={composerThreadId}
          backgroundAgentRows={backgroundAgentRows}
          isHomeMenu={model.isNewThreadTab}
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
          onCompleteQuery={(query) => promptEditorRef.current?.completeSuggestionQuery(query)}
          fileSearchScope={model.workspaceSearchContext}
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
            "relative flex flex-col",
            // A floating composer's frame draws the surface.
            !isFloatingComposer && COMPOSER_SURFACE_CLASS_NAME,
            floatingComposerSingleLine ? "overflow-visible rounded-full" : "overflow-y-auto",
            (showExternalFooter || composerNotice) && "z-10",
          )}
        >
          <div className="relative z-10 flex min-h-0 flex-1 flex-col">
            {composerNotice && isFloatingComposer ? (
              <ComposerNoticeRail notice={composerNotice} placement="inset" />
            ) : null}
            {!floatingComposerSingleLine ? (
              <ComposerAttachments>
                {hasVisibleAttachments ? (
                  <ComposerImageAttachmentRow
                    attachments={imageAttachments}
                    controller={imageAttachmentController}
                    hasVisibleNonImageAttachments={hasVisibleNonImageAttachments}
                    onEdit={handleEditComposerImage}
                  >
                    <ComposerAppModelContextAttachments
                      attachments={appModelContext.attachments}
                      onRemove={appModelContext.remove}
                    />
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
                    <ThreadTextSelectionAttachments
                      context={selectionDraft.draft}
                      onEditAnnotation={selectionDraft.editAnnotation}
                      onRemoveAnnotation={selectionDraft.removeAnnotation}
                      onRemoveSelection={selectionDraft.removeSelection}
                    />
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
                    <ComposerPageContextChips
                      offers={pageContext.offers}
                      onInclude={pageContext.include}
                      onRemove={pageContext.remove}
                    />
                  </ComposerImageAttachmentRow>
                ) : null}
              </ComposerAttachments>
            ) : null}

            {dictationRecovery ? (
              <div
                role="status"
                aria-live="polite"
                className="mx-3 mb-2 flex flex-wrap items-center gap-2 text-xs text-token-text-tertiary"
              >
                {dictationRecovery.phase === "recovering" ? (
                  <ActivitySpinnerIcon className="size-4" />
                ) : null}
                <span className="min-w-0 flex-1">
                  {dictationRecovery.phase === "recovering"
                    ? "Recovering text…"
                    : dictationRecovery.phase === "recovered"
                      ? "Text recovered"
                      : "Dictation stopped"}
                </span>
                {dictationRecovery.phase === "recovered" && dictationRecovery.text ? (
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-token-foreground hover:bg-token-list-hover-background"
                    onClick={() => void appendRecoveredText()}
                  >
                    Add to message
                  </button>
                ) : null}
                {dictationRecovery.phase === "failed" ? (
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-token-foreground hover:bg-token-list-hover-background"
                    onClick={() => void retryDictation()}
                  >
                    Retry
                  </button>
                ) : null}
                {dictationRecovery.saveState === "saved" && actions.onOpenVoiceSettings ? (
                  <button
                    type="button"
                    className="rounded px-2 py-1 hover:bg-token-list-hover-background"
                    onClick={() =>
                      actions.onOpenVoiceSettings?.(dictationRecovery.recordingId ?? undefined)
                    }
                  >
                    View recording
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="Dismiss dictation recovery"
                  className="rounded p-1 hover:bg-token-list-hover-background"
                  onClick={dismissDictationRecovery}
                >
                  <CloseIcon className="size-4" />
                </button>
              </div>
            ) : null}
            <ComposerAdaptiveFooter
              layout={composerLayout}
              input={
                <ComposerInput layout={composerLayout}>
                  {renderPromptEditor(floatingComposerSingleLine)}
                </ComposerInput>
              }
              leadingControls={
                showDictationRow
                  ? null
                  : isFloatingComposer && floatingComposerSingleLine
                    ? floatingLeadingControls
                    : standardLeadingControls
              }
              trailingControls={
                showDictationRow ? (
                  <div className="flex items-center gap-2">{dictationRowContent}</div>
                ) : isFloatingComposer && floatingComposerSingleLine ? (
                  floatingTrailingControls
                ) : (
                  standardTrailingControls
                )
              }
              onCompactInputWidthChange={
                isFloatingComposer ? handleCompactInputWidthChange : undefined
              }
            />
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
