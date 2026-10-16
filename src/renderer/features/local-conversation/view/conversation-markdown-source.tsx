import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useConversationRuntimeOverride,
  type ConversationContentSource,
  type ConversationRuntime,
} from "../conversation-runtime";
import type { CodexComposerSkill, CodexConnectionState } from "../../../../shared/types";
import type { ThreadStageActions } from "../thread-stage-types";
import type { ImageEditComposerTarget } from "@/features/user-attachment-image-editor";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import {
  useCodexAppServerRegistry,
  type CodexAppServerManager,
  type CodexAppServerManagerRegistry,
} from "../local-conversation-store";

export interface ConversationMarkdownSource {
  readonly projectId: string | null;
  readonly hostId: string;
  readonly threadId: string;
  readonly cwd: string | null;
  readonly workspaceRoot: string | null;
  readonly sourceIdentity: string;
  /** Actual resident owner identity. Resource caches may qualify it with a WeakMap. */
  readonly authority: object | null;
  readonly nativeConnection: CodexConnectionState["native"];
  readonly executionSource?: ConversationContentSource;
  readonly sourceRoot: { readonly hostId: string; readonly threadId: string };
  readonly isCurrent: () => boolean;
  /** Shared reads follow the resident source, independently of one mounted consumer. */
  readonly isResourceCurrent: () => boolean;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
  readonly onStartNewChatWithPrompt?: ThreadStageActions["onStartNewChatWithPrompt"];
  readonly imageComposerTarget?: ImageEditComposerTarget;
  readonly skills?: readonly CodexComposerSkill[];
}
export type ConversationMarkdownNativeSource =
  | { readonly kind: "item"; readonly entityKey: string; readonly itemId: string }
  | { readonly kind: "realtime"; readonly itemId: string };

const ConversationMarkdownSourceContext = createContext<ConversationMarkdownSource | null>(null);
export const useConversationMarkdownSource = () => useContext(ConversationMarkdownSourceContext);

/**
 * What a source's consumers are fenced on. Presentation context — navigation callbacks, skills,
 * the image composer target — is replaced on ordinary renders and never retires a source.
 */
interface SourceIdentity {
  readonly owner: CodexTranscriptReadOwner | null;
  readonly hostId: string;
  readonly threadId: string;
  readonly manager: CodexAppServerManager;
  readonly registry: CodexAppServerManagerRegistry;
  readonly connection: CodexConnectionState;
}
function isResourceCurrent(source: SourceIdentity) {
  if (!source.owner || source.registry.readForHostId(source.hostId) !== source.manager)
    return false;
  const live = source.manager.readConnection();
  return (
    live === source.connection &&
    source.manager.getHostId() === source.hostId &&
    source.owner.key.hostId === source.hostId &&
    source.owner.key.threadId === source.threadId &&
    source.owner.readStructure() !== null
  );
}
function createSourceLease() {
  let current: SourceIdentity | null = null;
  return {
    activate(source: SourceIdentity) {
      current = source;
      return () => {
        if (current === source) current = null;
      };
    },
    matches(source: SourceIdentity) {
      return current === source && isResourceCurrent(source);
    },
  };
}

type SourceProviderProps = {
  readonly projectId?: string | null;
  readonly hostId: string;
  readonly threadId: string | null;
  readonly cwd: string | null;
  readonly workspaceRoot: string | null;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
  readonly onStartNewChatWithPrompt?: ThreadStageActions["onStartNewChatWithPrompt"];
  readonly imageComposerTarget?: ImageEditComposerTarget;
  readonly skills?: readonly CodexComposerSkill[];
  readonly children: ReactNode;
};

/** Every presenter reads the owning execution source rather than creating a native writer. */
export function ConversationMarkdownSourceProvider(props: SourceProviderProps) {
  const runtime = useConversationRuntimeOverride();
  return runtime?.contentSource ? (
    <RuntimeMarkdownSourceProvider {...props} runtime={runtime} />
  ) : (
    <NativeMarkdownSourceProvider {...props} />
  );
}

interface RuntimeSourceIdentity {
  readonly owner: CodexTranscriptReadOwner;
  readonly executionSource: ConversationContentSource;
  readonly hostId: string;
  readonly threadId: string;
}
function isRuntimeResourceCurrent(runtime: ConversationRuntime, source: RuntimeSourceIdentity) {
  return (
    source.executionSource.isCurrent() &&
    runtime.transcriptReadOwner?.(source.threadId) === source.owner &&
    source.owner.key.hostId === source.hostId &&
    source.owner.key.threadId === source.threadId
  );
}
function createRuntimeSourceLease() {
  let current: RuntimeSourceIdentity | null = null;
  return {
    activate(source: RuntimeSourceIdentity | null) {
      current = source;
      return () => {
        if (current === source) current = null;
      };
    },
    matches: (runtime: ConversationRuntime, source: RuntimeSourceIdentity) =>
      current === source && isRuntimeResourceCurrent(runtime, source),
  };
}

function RuntimeMarkdownSourceProvider({
  runtime,
  children,
  projectId = null,
  hostId,
  threadId,
  cwd,
  workspaceRoot,
  onOpenThread,
  onStartNewChatWithPrompt,
  imageComposerTarget,
  skills,
}: SourceProviderProps & { readonly runtime: ConversationRuntime }) {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const executionSource = useSyncExternalStore(
    (listener) => runtime.subscribe(threadId, listener),
    () => runtime.contentSource?.(threadId) ?? null,
  );
  const source = useMemo<RuntimeSourceIdentity | null>(
    () =>
      threadId && owner && executionSource ? { owner, executionSource, hostId, threadId } : null,
    [owner, executionSource, hostId, threadId],
  );
  const [lease] = useState(createRuntimeSourceLease);
  useLayoutEffect(() => lease.activate(source), [lease, source]);
  const value = useMemo<ConversationMarkdownSource | null>(
    () =>
      source
        ? {
            projectId,
            hostId,
            threadId: source.threadId,
            cwd,
            workspaceRoot,
            onOpenThread,
            onStartNewChatWithPrompt,
            imageComposerTarget,
            skills,
            sourceIdentity: source.executionSource.identity,
            authority: source.owner,
            nativeConnection: undefined,
            executionSource: source.executionSource,
            sourceRoot: { hostId, threadId: source.threadId },
            isCurrent: () => lease.matches(runtime, source),
            isResourceCurrent: () => isRuntimeResourceCurrent(runtime, source),
          }
        : null,
    [
      projectId,
      hostId,
      cwd,
      workspaceRoot,
      onOpenThread,
      onStartNewChatWithPrompt,
      imageComposerTarget,
      skills,
      source,
      lease,
      runtime,
    ],
  );
  return (
    <ConversationMarkdownSourceContext value={value}>{children}</ConversationMarkdownSourceContext>
  );
}

/** Native observation sources retain their registry and connection generation. */
function NativeMarkdownSourceProvider({
  projectId = null,
  hostId,
  threadId,
  cwd,
  workspaceRoot,
  onOpenThread,
  onStartNewChatWithPrompt,
  imageComposerTarget,
  skills,
  children,
}: SourceProviderProps) {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const registry = useCodexAppServerRegistry();
  const preparedManager = useMemo(() => registry.getForHostId(hostId), [registry, hostId]);
  const manager = useSyncExternalStore(
    (listener) => registry.addRegistryCallback(listener),
    () => registry.readForHostId(hostId) ?? preparedManager,
  );
  const connection = useSyncExternalStore(
    (listener) => manager.subscribeConnection(listener),
    () => manager.readConnection(),
  );
  const [lease] = useState(createSourceLease);
  const source = useMemo<SourceIdentity>(
    () => ({ owner, manager, registry, connection, hostId, threadId: threadId ?? "" }),
    [owner, manager, registry, connection, hostId, threadId],
  );
  useLayoutEffect(() => lease.activate(source), [lease, source]);
  const value = useMemo<ConversationMarkdownSource | null>(
    () =>
      threadId
        ? {
            projectId,
            hostId,
            threadId,
            cwd,
            workspaceRoot,
            sourceIdentity: JSON.stringify([
              hostId,
              threadId,
              connection.native?.sourceEpoch ?? null,
              connection.native?.generation ?? null,
            ]),
            authority: owner,
            nativeConnection: connection.native,
            sourceRoot: { hostId, threadId },
            isCurrent: () => lease.matches(source),
            isResourceCurrent: () => isResourceCurrent(source),
            onOpenThread,
            onStartNewChatWithPrompt,
            imageComposerTarget,
            skills,
          }
        : null,
    [
      threadId,
      projectId,
      hostId,
      cwd,
      workspaceRoot,
      connection.native,
      owner,
      lease,
      source,
      onOpenThread,
      onStartNewChatWithPrompt,
      imageComposerTarget,
      skills,
    ],
  );
  return (
    <ConversationMarkdownSourceContext value={value}>{children}</ConversationMarkdownSourceContext>
  );
}

/** The resident item address, rather than a layout position, fences resource and action consumers. */
export function ConversationMarkdownItemSourceProvider({
  source,
  children,
}: {
  readonly source?: ConversationMarkdownNativeSource;
  readonly children: ReactNode;
}) {
  const parent = useConversationMarkdownSource();
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const value = useMemo(
    () =>
      parent &&
      source &&
      owner?.key.hostId === parent.hostId &&
      owner.key.threadId === parent.threadId
        ? {
            ...parent,
            sourceIdentity: JSON.stringify([
              parent.sourceIdentity,
              source.kind,
              source.kind === "item" ? source.entityKey : null,
              source.itemId,
            ]),
            isCurrent: () => parent.isCurrent() && hasNativeSource(owner, source),
            isResourceCurrent: () => parent.isResourceCurrent() && hasNativeSource(owner, source),
          }
        : null,
    [parent, source, owner],
  );
  return (
    <ConversationMarkdownSourceContext value={value}>{children}</ConversationMarkdownSourceContext>
  );
}

function hasNativeSource(
  owner: CodexTranscriptReadOwner,
  source: ConversationMarkdownNativeSource,
): boolean {
  return (
    (source.kind === "item"
      ? owner.readItem(source.entityKey, source.itemId)
      : owner.readRealtimeItem(source.itemId)) !== null
  );
}
