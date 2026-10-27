import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { parseAgentHistoryImageSource } from "../../../../../shared/agent-history-images";
import { parseAgentRuntimeAttachmentSource } from "../../../../../shared/agent-runtime-attachments";
import {
  useResolvedImageAsset,
  classifyImageAssetSource,
  type ResolvedImageAsset,
} from "@/features/user-attachment-image-editor";
import {
  requiresConversationImageRead,
  resolveConversationImageRead,
} from "../../conversation-image-assets";
import { useConversationImageAssetContext } from "../conversation-image-asset-context";

export type ConversationImageAssetResolution = Omit<
  ResolvedImageAsset,
  "error" | "localPath" | "materialize"
>;

interface ImageRead {
  identity: string;
  src: string | null;
  failed: boolean;
}

interface ImageReadOwner {
  identity: string;
  request: symbol;
}

/** Read file images once per mounted source and share those exact bytes with its preview. */
export function useConversationImageAsset(
  rawSource: string,
  options?: { shouldLoadFileDataUrl: boolean },
): ConversationImageAssetResolution {
  const context = useConversationImageAssetContext();
  const queryClient = useQueryClient();
  const deferredLocalFile =
    options?.shouldLoadFileDataUrl === false &&
    context.hostId === "local" &&
    classifyImageAssetSource(rawSource).kind === "local";
  const needsRead = requiresConversationImageRead(rawSource) && !deferredLocalFile;
  const resolverAvailable =
    (!parseAgentRuntimeAttachmentSource(rawSource) || !!context.resolveRuntimeAttachment) &&
    (!parseAgentHistoryImageSource(rawSource) || !!context.resolveHistoryImage);
  const identity = JSON.stringify([
    context.hostId,
    context.conversationId,
    rawSource,
    resolverAvailable,
  ]);
  const [read, setRead] = useState<ImageRead | null>(null);
  const ownerRef = useRef<ImageReadOwner | null>(null);
  const load = async (owner: ImageReadOwner, force: boolean) => {
    const request = Symbol();
    owner.request = request;
    let src: string | null = null;
    try {
      src = await resolveConversationImageRead(queryClient, rawSource, context, force);
    } catch {
      // A file can disappear independently of its historical inspection.
    }
    if (ownerRef.current !== owner || owner.request !== request) return;
    setRead({ identity: owner.identity, src, failed: src === null });
  };
  const startRead = useEffectEvent(load);
  const direct = useResolvedImageAsset(needsRead ? "" : rawSource, {
    hostId: context.hostId,
    allowLocalPath: deferredLocalFile,
  });

  useEffect(() => {
    if (!needsRead) return;
    const owner = { identity, request: Symbol() };
    ownerRef.current = owner;
    void startRead(owner, false);
    return () => {
      ownerRef.current = null;
    };
  }, [identity, needsRead]);

  if (!needsRead) return direct;
  const result = read?.identity === identity ? read : null;
  return {
    dataUrl: result?.src ?? null,
    downloadSrc: result?.src ?? null,
    previewSrc: result?.src ?? null,
    isLoading: result === null,
    isError: result?.failed ?? false,
    refetch: async () => {
      const owner = ownerRef.current;
      if (owner?.identity !== identity) return;
      setRead(null);
      await load(owner, true);
    },
  };
}
