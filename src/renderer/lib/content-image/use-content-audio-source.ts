import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { readContentAudio } from "./content-image-read";
import { useContentImageScope } from "./content-image-scope";

export type ContentAudioSource =
  | { readonly status: "loading" | "error"; readonly url: null }
  | { readonly status: "ready"; readonly url: string };

/** Resolve tool-result audio only while the surrounding content owner holds its source. */
export function useContentAudioSource(source: string | undefined): ContentAudioSource {
  const scope = useContentImageScope();
  const queryClient = useQueryClient();
  const hasResolver = !!scope.resolveRuntimeAttachment;
  const admitted = scope.isResourceCurrent();
  const identity = JSON.stringify([
    scope.hostId,
    scope.conversationId,
    scope.sourceIdentity,
    source,
  ]);
  const [read, setRead] = useState<{ identity: string; url: string | null } | null>(null);

  const load = useEffectEvent((source: string) => readContentAudio(queryClient, source, scope));
  useEffect(() => {
    if (!source || !admitted || !hasResolver) return;
    let active = true;
    void load(source).then(
      (url) => {
        if (active) setRead({ identity, url });
      },
      () => {
        if (active) setRead({ identity, url: null });
      },
    );
    return () => {
      active = false;
    };
  }, [source, identity, hasResolver, admitted]);

  if (!source) return { status: "error", url: null };
  if (!admitted) return { status: "loading", url: null };
  if (!hasResolver) return { status: "error", url: null };
  if (read?.identity !== identity) return { status: "loading", url: null };
  return read.url === null ? { status: "error", url: null } : { status: "ready", url: read.url };
}
