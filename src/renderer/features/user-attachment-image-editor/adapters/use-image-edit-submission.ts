import { useState } from "react";
import { toast } from "@/components/ui/toast";
import {
  useCodexAppServerControl,
  useCodexConversationValue,
} from "@/features/local-conversation/local-conversation-store";
import type { CodexPromptInput } from "@/lib/types";
import { parseAbsoluteImagePath } from "@/lib/codex-conversation-image-assets";
import { parseAssetSource } from "../../../../shared/assets";
import { DEFAULT_CODEX_HOST_ID } from "../../../../shared/codex-host";
import type {
  EditableImageDescriptor,
  ImageEditComposerTarget,
  ImageEditSubmissionIntent,
} from "../model/types";
import { requestImageEditComposerSubmit } from "@/lib/image-edit-composer-channel";
import {
  trackImageEditSubmit,
  trackImageEditSubmitOutcome,
} from "../analytics/image-editor-analytics";
import { beginOptimisticGeneratedImageEdit } from "./generated-image-collection-store";
import { resolveImageInputSupport } from "../model/feature-policy";

function resolveSubmissionSource(image: EditableImageDescriptor): string | null {
  const candidates = [image.dataUrl, image.downloadSrc, image.attachmentSrc, image.src];
  for (const candidate of candidates) {
    const source = candidate?.trim() ?? "";
    if (
      source.startsWith("data:image/") ||
      source.startsWith("http://") ||
      source.startsWith("https://")
    ) {
      return source;
    }
  }

  const managedCandidates = [
    image.managedSource,
    image.localPath,
    image.attachmentSrc,
    image.downloadSrc,
    image.src,
    image.dataUrl,
  ];
  for (const candidate of managedCandidates) {
    const managedSource = candidate?.trim() ?? "";
    if (!parseAssetSource(managedSource)) continue;
    if (image.hostId && image.hostId !== DEFAULT_CODEX_HOST_ID) return null;
    return managedSource;
  }
  const localPath = parseAbsoluteImagePath(image.localPath ?? "");
  if (localPath) {
    if (image.hostId && image.hostId !== DEFAULT_CODEX_HOST_ID) return null;
    return localPath;
  }
  return null;
}

export function compileImageEditPromptInput(
  intent: ImageEditSubmissionIntent,
): CodexPromptInput | null {
  const images = intent.attachments.flatMap((attachment) => {
    const source = resolveSubmissionSource(attachment.image);
    return source ? [{ source }] : [];
  });
  if (images.length !== intent.attachments.length) return null;
  return {
    text: intent.promptRaw,
    images,
  };
}

export interface ImageEditSubmissionController {
  isSubmitting: boolean;
  supportsImageInputs: boolean;
  notifyImageInputUnsupported(mode: "comment" | "edit" | "select"): void;
  submit(intent: ImageEditSubmissionIntent): Promise<boolean>;
}

/**
 * Keeps the editor transport-agnostic: an edit is first described as an intent,
 * then this boundary routes it through the existing conversation turn owner.
 */
export function useImageEditSubmission(args: {
  composerTarget: ImageEditComposerTarget | null;
  projectId: string | null;
  threadId: string | null;
}): ImageEditSubmissionController {
  const control = useCodexAppServerControl(args.projectId);
  const hasActiveTurn = useCodexConversationValue(
    args.threadId,
    (conversation) =>
      conversation?.statusType === "active" ||
      conversation?.turns.some((turn) => turn.status === "inProgress") ||
      false,
  );
  const conversationExecutionProfile = useCodexConversationValue(
    args.threadId,
    (conversation) => conversation?.executionProfile ?? null,
  );
  const supportsImageInputs = resolveImageInputSupport({
    models: control.availableModels,
    selectedModel: (conversationExecutionProfile ?? control.executionProfile)?.modelId ?? null,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const notifyImageInputUnsupported = (mode: "comment" | "edit" | "select") => {
    toast.danger(
      mode === "comment"
        ? "Could not add image comment"
        : mode === "select"
          ? "Could not select image"
          : "Could not edit image",
    );
  };

  const submit = async (intent: ImageEditSubmissionIntent): Promise<boolean> => {
    if (isSubmitting) return false;
    const imageSource = intent.attachments[0]?.image.source ?? "uploaded";
    const directRoute = !args.threadId
      ? "new_thread"
      : hasActiveTurn
        ? "queued"
        : "existing_thread";
    if (!supportsImageInputs) {
      trackImageEditSubmitOutcome({
        failureReason: "image-input-unsupported",
        imageSource,
        mode: intent.mode,
        outcome: "unavailable",
        route: directRoute,
      });
      notifyImageInputUnsupported(
        intent.mode === "comment" ? "comment" : intent.mode === "select" ? "select" : "edit",
      );
      return false;
    }
    setIsSubmitting(true);
    let optimisticEdit: ReturnType<typeof beginOptimisticGeneratedImageEdit> | null = null;
    try {
      if (args.composerTarget) {
        const result = await requestImageEditComposerSubmit(args.composerTarget.channelId, {
          intent,
          source: "single",
        });
        if (result.status === "failed") return false;
        if (result.status !== "unavailable") return true;
        if (result.reason === "image-input-unsupported") {
          notifyImageInputUnsupported(
            intent.mode === "comment" ? "comment" : intent.mode === "select" ? "select" : "edit",
          );
          return false;
        }
        if (result.reason === "asset-unresolvable") {
          toast.danger("Could not read image");
          return false;
        }
        if (!args.threadId) {
          trackImageEditSubmitOutcome({
            failureReason: "composer-unmounted",
            imageSource,
            mode: intent.mode,
            outcome: "unavailable",
            route: "new_thread",
          });
          toast.danger("Composer is temporarily unavailable");
          return false;
        }
      }

      if (!args.threadId) {
        trackImageEditSubmitOutcome({
          failureReason: "composer-unmounted",
          imageSource,
          mode: intent.mode,
          outcome: "unavailable",
          route: "new_thread",
        });
        toast.danger("Composer is temporarily unavailable");
        return false;
      }
      optimisticEdit = intent.attachments.some(
        (attachment) => attachment.image.source === "generated",
      )
        ? beginOptimisticGeneratedImageEdit(args.threadId)
        : null;
      const promptInput = compileImageEditPromptInput(intent);
      if (!promptInput) {
        optimisticEdit?.rollback();
        trackImageEditSubmitOutcome({
          failureReason: "asset-unresolvable",
          imageSource,
          mode: intent.mode,
          outcome: "unavailable",
          route: directRoute,
        });
        toast.danger("Could not read image");
        return false;
      }
      const options = {
        ...(args.projectId ? { projectId: args.projectId } : {}),
        promptInput,
      };
      if (hasActiveTurn) {
        await control.enqueueQueuedFollowUp(args.threadId, intent.promptRaw, options);
      } else {
        await control.startTurn(args.threadId, intent.promptRaw, options);
      }
      if (intent.focusComposerAfterSubmit) {
        control.setComposerIntent(args.threadId, {
          focusNonce: Date.now(),
          prompt: "",
        });
      }
      trackImageEditSubmit({
        ...intent.analytics,
        imageSource,
        mode: intent.mode,
      });
      trackImageEditSubmitOutcome({
        imageSource,
        mode: intent.mode,
        outcome: hasActiveTurn ? "queued" : "submitted",
        route: directRoute,
      });
      return true;
    } catch {
      optimisticEdit?.rollback();
      trackImageEditSubmitOutcome({
        failureReason: "transport",
        imageSource,
        mode: intent.mode,
        outcome: "failed",
        route: directRoute,
      });
      notifyImageInputUnsupported(
        intent.mode === "comment" ? "comment" : intent.mode === "select" ? "select" : "edit",
      );
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    isSubmitting,
    notifyImageInputUnsupported,
    submit,
    supportsImageInputs,
  };
}
