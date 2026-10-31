import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { parseAgentHistoryImageSource } from "../../../shared/agent-history-images";
import { parseAgentRuntimeAttachmentSource } from "../../../shared/agent-runtime-attachments";
import { useResolvedImageAsset, type ResolvedImageAsset } from "./use-resolved-image-asset";
import { classifyImageAssetSource } from "./image-source";
import { readContentImage, requiresContentImageRead } from "./content-image-read";
import { useContentImageScope } from "./content-image-scope";

export type ContentImage = Omit<ResolvedImageAsset, "error" | "localPath" | "materialize">;

interface ImageRead {
  identity: string;
  src: string | null;
  failed: boolean;
}

interface ImageReadOwner {
  identity: string;
  request: symbol;
}

/**
 * An image in content, read where the content lives (`ContentImageScope`): once per mounted
 * source, sharing those exact bytes with its preview.
 */
export function useContentImage(
  rawSource: string,
  options?: { shouldLoadFileDataUrl: boolean },
): ContentImage {
  const context = useContentImageScope();
  const queryClient = useQueryClient();
  const deferredLocalFile =
    options?.shouldLoadFileDataUrl === false &&
    context.hostId === "local" &&
    classifyImageAssetSource(rawSource).kind === "local";
  const needsRead = requiresContentImageRead(rawSource) && !deferredLocalFile;
  const resolverAvailable =
    (!parseAgentRuntimeAttachmentSource(rawSource) || !!context.resolveRuntimeAttachment) &&
    (!parseAgentHistoryImageSource(rawSource) || !!context.resolveHistoryImage);
  const identity = JSON.stringify([
    context.hostId,
    context.conversationId,
    context.sourceIdentity,
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
      src = await readContentImage(queryClient, rawSource, context, force);
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

  // An owner that does not hold the content's source yet, such as a chat whose transcript is still
  // loading, keeps the image waiting; the read starts once a render finds the source held.
  const admitted = context.isResourceCurrent();
  useEffect(() => {
    if (!needsRead || !admitted) return;
    const owner = { identity, request: Symbol() };
    ownerRef.current = owner;
    void startRead(owner, false);
    return () => {
      ownerRef.current = null;
    };
  }, [identity, needsRead, admitted]);

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
