import { isHostedChat } from "@/lib/hosted-chat";
import { HOSTED_CHAT_ACTION_REASON } from "../../../../shared/space-connection";
import { useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { codexVisualizationQueryOptions } from "../../../lib/codex-visualizations";
import { INLINE_VISUALIZATION_INITIAL_HEIGHT } from "../../../lib/inline-visualization/inline-visualization-document";
import { resolveInlineVisualizationSourceThreadId } from "../../../lib/inline-visualization/inline-visualization-directives";
import {
  canExpandInlineVisualization,
  type InlineVisualizationMode,
} from "../../../lib/inline-visualization/inline-visualization-presentation";
import {
  useInlineVisualizationFollowUpHandler,
  useInlineVisualizationAnnotationSubmitHandler,
} from "../../../lib/inline-visualization/inline-visualization-follow-up-context";
import { resolveInlineVisualizationStateIdentity } from "../../../lib/inline-visualization/inline-visualization-widget-state";
import {
  inlineVisualizationFrameKey,
  type InlineVisualizationFrameBinding,
  type InlineVisualizationFrameIdentity,
  type InlineVisualizationFrameInput,
  type InlineVisualizationFrameOwner,
} from "../../../lib/inline-visualization/inline-visualization-frame-owner";
import { ConversationVisualizationContext } from "./inline-visualization-context";
import {
  InlineVisualizationSurfaceContext,
  useInlineVisualizationFrameOwner,
} from "./inline-visualization-window";

/** Reads preserve source identity; the mounted leaf only owns an anchor binding. */
export function LocalConversationInlineVisualization({
  file,
  sourceThreadId,
  cacheKey,
  mode = "narrow",
}: {
  readonly file: string;
  readonly sourceThreadId?: string | null;
  readonly cacheKey?: string;
  readonly mode?: InlineVisualizationMode;
}) {
  const context = useContext(ConversationVisualizationContext);
  const owner = useInlineVisualizationFrameOwner();
  const surfaceId = useContext(InlineVisualizationSurfaceContext);
  const instanceId = useId();
  const [attempt, setAttempt] = useState(0);
  if (!context) return null;
  // An interactive response runs in this computer's sandbox from files its chat wrote; a hosted
  // chat's files and sandbox stay on its Space host.
  if (isHostedChat())
    return (
      <div
        role="note"
        data-content-search-skip="true"
        className="flex h-16 items-center justify-center gap-1.5 text-sm text-token-text-secondary"
      >
        <span className="text-token-text-primary">Interactive response</span>
        <span aria-hidden="true">·</span>
        <span>{HOSTED_CHAT_ACTION_REASON}</span>
      </div>
    );
  if (!owner || !surfaceId)
    throw new Error("Interactive responses require a window presentation owner");
  const source = resolveInlineVisualizationSourceThreadId({
    file,
    declaredSourceThreadId: sourceThreadId,
    threadId: context.threadId,
    changedFilePaths: context.readChangedFilePaths(),
  });
  const occurrence = cacheKey ?? context.turnSearchKey ?? instanceId;
  return (
    <LoadedVisualization
      owner={owner}
      identity={{
        surfaceId,
        hostId: context.hostId,
        readHostId: context.hostId,
        threadId: context.threadId,
        sourceThreadId: source,
        file,
        occurrence,
      }}
      turnId={context.turnId}
      attempt={attempt}
      mode={mode}
      retry={() => setAttempt((value) => value + 1)}
    />
  );
}

function LoadedVisualization({
  owner,
  identity,
  turnId,
  attempt,
  retry,
  mode,
}: {
  readonly owner: InlineVisualizationFrameOwner;
  readonly identity: InlineVisualizationFrameIdentity;
  readonly turnId: string | null;
  readonly attempt: number;
  readonly retry: () => void;
  readonly mode: InlineVisualizationMode;
}) {
  const key = inlineVisualizationFrameKey(identity);
  const query = useQuery({
    ...codexVisualizationQueryOptions(
      {
        hostId: identity.readHostId,
        sourceThreadId: identity.sourceThreadId,
        file: identity.file,
        ...(turnId ? { turnId } : {}),
      },
      identity.occurrence,
      "inline",
    ),
    placeholderData: () => owner.readPlaceholder(identity),
  });
  const followUp = useInlineVisualizationFollowUpHandler();
  const submitAnnotations = useInlineVisualizationAnnotationSubmitHandler();
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const binding = useRef<InlineVisualizationFrameBinding | null>(null);
  const [frameId, setFrameId] = useState<string | null>(null);
  const loaded = !query.isError && query.data?.contents != null;
  const input: InlineVisualizationFrameInput | null =
    loaded && query.data?.contents != null
      ? {
          identity,
          fragment: { contents: query.data.contents, path: query.data.path },
          stateIdentity: resolveInlineVisualizationStateIdentity({
            hostId: identity.hostId,
            threadId: identity.threadId,
            file: identity.file,
            resolvedPath: query.data.path,
          }),
          attempt,
          canExpand: canExpandInlineVisualization({ mode, variant: "inline" }),
          retry: () => {
            retry();
            void query.refetch();
          },
          followUp,
          submitAnnotations,
        }
      : null;
  const currentInput = useRef(input);
  useLayoutEffect(() => {
    currentInput.current = input;
  });
  useLayoutEffect(() => {
    const latest = currentInput.current;
    if (!anchor || !loaded || !latest || inlineVisualizationFrameKey(latest.identity) !== key)
      return;
    const value = owner.bind(latest, anchor);
    binding.current = value;
    setFrameId(value.frameId);
    return () => {
      owner.unbind(value);
      if (binding.current === value) binding.current = null;
    };
  }, [owner, key, anchor, loaded]);
  useLayoutEffect(() => {
    if (binding.current && input) owner.updateBinding(binding.current, input);
  });
  const frame = useSyncExternalStore(
    (listener) => (frameId ? owner.subscribeFrame(frameId, listener) : () => {}),
    () => (frameId ? owner.readFrame(frameId) : null),
  );
  if (query.isError || (query.isSuccess && query.data?.contents === null))
    return (
      <div
        role="alert"
        data-content-search-skip="true"
        className="flex h-60 items-center justify-center gap-3 text-sm text-token-text-secondary"
      >
        <span>This response couldn’t load</span>
        <button
          type="button"
          onClick={() => {
            retry();
            void query.refetch();
          }}
        >
          Retry
        </button>
      </div>
    );
  return (
    <div
      ref={setAnchor}
      data-visualization-anchor="true"
      data-visualization-frame-anchor={frameId ?? undefined}
      data-content-search-skip="true"
      style={{ height: frame?.initialHeight ?? INLINE_VISUALIZATION_INITIAL_HEIGHT }}
    >
      {!loaded ? (
        <div
          role="status"
          aria-label="Loading interactive response"
          className="h-full animate-pulse rounded-lg bg-token-foreground/5"
        />
      ) : null}
    </div>
  );
}
