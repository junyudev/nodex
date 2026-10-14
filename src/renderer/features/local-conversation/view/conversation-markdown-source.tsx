import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CodexComposerSkill, CodexConnectionState } from "../../../../shared/types";
import type { ThreadStageActions } from "../thread-stage-types";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import type { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import {
  useCodexAppServerRegistry,
  type CodexAppServerManager,
  type CodexAppServerManagerRegistry,
} from "../local-conversation-store";

export interface ConversationMarkdownSource {
  readonly hostId: string;
  readonly threadId: string;
  readonly cwd: string | null;
  readonly workspaceRoot: string | null;
  readonly sourceIdentity: string;
  /** Actual resident owner identity. Resource caches may qualify it with a WeakMap. */
  readonly authority: object | null;
  readonly nativeConnection: CodexConnectionState["native"];
  readonly sourceRoot: { readonly hostId: string; readonly threadId: string };
  readonly isCurrent: () => boolean;
  /** Shared reads follow the resident source, independently of one mounted consumer. */
  readonly isResourceCurrent: () => boolean;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
  readonly skills?: readonly CodexComposerSkill[];
}
export type ConversationMarkdownNativeSource =
  | { readonly kind: "item"; readonly entityKey: string; readonly itemId: string }
  | { readonly kind: "realtime"; readonly itemId: string };

const ConversationMarkdownSourceContext = createContext<ConversationMarkdownSource | null>(null);
export const useConversationMarkdownSource = () => useContext(ConversationMarkdownSourceContext);

interface SourceIdentity {
  readonly owner: CodexTranscriptReadOwner | null;
  readonly hostId: string;
  readonly threadId: string;
  readonly cwd: string | null;
  readonly workspaceRoot: string | null;
  readonly manager: CodexAppServerManager;
  readonly registry: CodexAppServerManagerRegistry;
  readonly connection: CodexConnectionState;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
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

/** A mounted source delegates to existing Files and Thread owners without registering a new session. */
export function ConversationMarkdownSourceProvider({
  hostId,
  threadId,
  cwd,
  workspaceRoot,
  onOpenThread,
  skills,
  children,
}: {
  readonly hostId: string;
  readonly threadId: string | null;
  readonly cwd: string | null;
  readonly workspaceRoot: string | null;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
  readonly skills?: readonly CodexComposerSkill[];
  readonly children: ReactNode;
}) {
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
  const source = useMemo(
    () => ({
      owner,
      manager,
      registry,
      connection,
      hostId,
      threadId: threadId ?? "",
      cwd,
      workspaceRoot,
      onOpenThread,
    }),
    [owner, manager, registry, connection, hostId, threadId, cwd, workspaceRoot, onOpenThread],
  );
  useLayoutEffect(() => lease.activate(source), [lease, source]);
  const value = useMemo<ConversationMarkdownSource | null>(
    () =>
      threadId
        ? {
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
            skills,
          }
        : null,
    [
      threadId,
      hostId,
      cwd,
      workspaceRoot,
      connection.native,
      owner,
      lease,
      source,
      onOpenThread,
      skills,
    ],
  );
  return (
    <ConversationMarkdownSourceContext value={value}>{children}</ConversationMarkdownSourceContext>
  );
}

/** The native item address, rather than a layout position, fences resource and action consumers. */
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
