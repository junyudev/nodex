import { useMemo } from "react";
import { useCodexConversationValue } from "@/features/local-conversation/local-conversation-store";
import {
  useCodexTranscriptReadOwner,
  useCodexTranscriptGeneratedImages,
} from "@/features/local-conversation/normalized-transcript-hooks";
import type { CodexTranscriptReadOwner } from "@/features/local-conversation/normalized-transcript-read-owner";
import { projectGeneratedImageTranscriptGroups } from "@/features/local-conversation/projection/generated-image-transcript-groups";
import {
  areGeneratedImageLiveGroupsEqual,
  projectGeneratedImageCanonicalGroups,
  type GeneratedImageLiveGroupInput,
} from "./generated-image-collection-store";

const emptyGroups: readonly GeneratedImageLiveGroupInput[] = Object.freeze([]);

/** Gallery and editor share the resident image query; only non-native sources use whole conversation projection. */
export function useGeneratedImageCollectionGroups(
  threadId: string | null,
  suppliedOwner?: CodexTranscriptReadOwner | null,
) {
  const managerOwner = useCodexTranscriptReadOwner(threadId);
  const owner = suppliedOwner?.key.threadId === threadId ? suppliedOwner : managerOwner;
  const images = useCodexTranscriptGeneratedImages(owner);
  const title = useCodexConversationValue(
    threadId,
    (conversation) => conversation?.threadName ?? "",
  );
  const legacyGroups = useCodexConversationValue(
    threadId,
    owner ? () => emptyGroups : projectGeneratedImageCanonicalGroups,
    areGeneratedImageLiveGroupsEqual,
  );
  return useMemo(
    () => (owner ? projectGeneratedImageTranscriptGroups(images, title) : legacyGroups),
    [images, legacyGroups, owner, title],
  );
}
