import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import {
  ConversationAudio,
  ConversationVideo,
  type ConversationMediaResource,
} from "@/lib/conversation-media/conversation-media";
import { conversationMediaDataUrl } from "@/lib/conversation-media/conversation-media-model";
import { workspaceFileBinaryQueryOptions } from "@/lib/query-options";
import { buildAppFilesystemUrl } from "../../../shared/app-protocol";
import { getWorkspaceFileName } from "./workspace-file-model";
import {
  WorkspaceFileErrorState,
  WorkspaceFileLoadingState,
} from "./workspace-file-preview-states";

export interface WorkspaceFileMediaPreviewProps {
  readonly hostId: string;
  readonly path: string;
  readonly kind: "audio" | "video";
  /** Changes when the file is refreshed, so a remote read fetches current bytes. */
  readonly revision: number;
}

/** Keeps a resource current only while this preview of it stays mounted. */
function useMountedResource(identity: string) {
  const mounted = useRef<string | null>(identity);
  useLayoutEffect(() => {
    mounted.current = identity;
    return () => {
      mounted.current = null;
    };
  }, [identity]);
  return () => mounted.current === identity;
}

/**
 * Local media streams from the host with range requests; a remote host's media is read once as
 * bytes because its files are not reachable through the renderer's filesystem route.
 */
export function WorkspaceFileMediaPreview({
  hostId,
  path,
  kind,
  revision,
}: WorkspaceFileMediaPreviewProps) {
  const identity = `${hostId}:${path}:${revision}`;
  const isCurrent = useMountedResource(identity);
  const local = hostId === "local";
  const remote = useQuery({
    ...workspaceFileBinaryQueryOptions({ hostId, path }),
    enabled: !local,
    gcTime: 0,
    // Each mounted revision reads current bytes once; refocusing the window does not reload.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const resource: ConversationMediaResource = local
    ? {
        identity,
        status: "ready",
        url: buildAppFilesystemUrl(path),
        path,
        isCurrent,
        canMount: () => true,
      }
    : {
        identity,
        status: remote.isError ? "error" : remote.data ? "ready" : "loading",
        url:
          remote.data?.contentsBase64 != null
            ? conversationMediaDataUrl(remote.data.contentsBase64, remote.data.mimeType, path)
            : null,
        path,
        isCurrent,
        canMount: () => true,
      };
  const name = getWorkspaceFileName(path);
  if (!local && remote.isPending) return <WorkspaceFileLoadingState />;
  if (!local && !resource.url) return <WorkspaceFileErrorState />;
  return (
    <div className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden pb-[var(--right-panel-composer-overlay-reserve,0px)]">
      {kind === "video" ? (
        <ConversationVideo
          key={identity}
          resource={resource}
          raw={path}
          alt=""
          sizing="container"
          allowWide
        />
      ) : (
        <ConversationAudio key={identity} resource={resource} raw={path} alt="" title={name} />
      )}
    </div>
  );
}
