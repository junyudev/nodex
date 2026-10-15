import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  BlockDocumentSurfaceFailureState,
  OwnedBlockDocumentRuntimeSurface,
  type BlockDocumentSurfaceProps,
  type BlockDocumentSurfaceValue,
} from "./block-document-surface";
import { createDocumentSyncAdapterForContentRouting } from "@/lib/api";
import {
  BlockDocumentSurfaceRuntime,
  type BlockDocumentSurfaceRuntimeOptions,
} from "@/lib/block-document-surface-runtime";
import {
  makeDocumentSessionIdentity,
  documentSessionRegistry,
  type EditorSurfaceLease,
  type DocumentSessionRegistry,
} from "@/lib/document-session-registry";
import { PageTitleProjectionPublisher } from "@/lib/page-title-projection-context";

interface PageEditorSessionSurfaceProps extends Omit<BlockDocumentSurfaceProps, "children"> {
  readonly sessionKey: string;
  readonly retainModelOnUnmount?: boolean;
  readonly registry?: DocumentSessionRegistry;
  readonly children: (surface: BlockDocumentSurfaceValue, session: EditorSurfaceLease) => ReactNode;
}

interface SessionOwnerState {
  readonly session: EditorSurfaceLease | null;
  readonly startupError: Error | null;
}

const EMPTY_SESSION_OWNER_STATE: SessionOwnerState = {
  session: null,
  startupError: null,
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const createRuntime = (options: BlockDocumentSurfaceRuntimeOptions): BlockDocumentSurfaceRuntime =>
  new BlockDocumentSurfaceRuntime(options);

/**
 * Attaches the active Page Stage to a PageTab-owned editor session. View
 * cleanup always releases presence and DOM; durable tabs leave model disposal
 * to the registry, while an unpromoted preview disposes on final unmount.
 */
export function PageEditorSessionSurface({
  sessionKey,
  retainModelOnUnmount = true,
  registry = documentSessionRegistry,
  descriptor,
  pageTitleIdentity,
  isActive,
  localAwarenessState,
  onReload,
  dependencies,
  runtimeRef,
  pendingFallback,
  renderFailureFallback,
  children,
}: PageEditorSessionSurfaceProps) {
  const [revision, setRevision] = useState(0);
  const [ownerState, setOwnerState] = useState<SessionOwnerState>(EMPTY_SESSION_OWNER_STATE);
  const descriptorRef = useRef(descriptor);
  descriptorRef.current = descriptor;
  const retainModelOnUnmountRef = useRef(retainModelOnUnmount);
  retainModelOnUnmountRef.current = retainModelOnUnmount;
  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;
  const identity = makeDocumentSessionIdentity(descriptor);
  const adapterFactory = dependencies?.createAdapter ?? createDocumentSyncAdapterForContentRouting;
  const runtimeFactory = dependencies?.createRuntime ?? createRuntime;

  useLayoutEffect(() => {
    let live = true;
    let session: EditorSurfaceLease | null = null;
    let viewGeneration = 0;
    setOwnerState(EMPTY_SESSION_OWNER_STATE);

    try {
      const currentDescriptor = descriptorRef.current;
      session = registry.acquire({
        key: sessionKey,
        descriptor: currentDescriptor,
        createRuntime: () =>
          runtimeFactory({
            descriptor: currentDescriptor,
            adapter: adapterFactory(currentDescriptor.routingContext),
          }),
      });
      viewGeneration = session.claimView();
      if (runtimeRef) runtimeRef.current = session.runtime;
      setOwnerState({ session, startupError: null });
      void session.connect().catch((error) => {
        if (!live) return;
        setOwnerState((current) =>
          current.session === session ? { session, startupError: toError(error) } : current,
        );
      });
    } catch (error) {
      setOwnerState({ session: null, startupError: toError(error) });
    }

    return () => {
      live = false;
      if (runtimeRef && runtimeRef.current === session?.runtime) {
        runtimeRef.current = null;
      }
      if (!session) return;
      const retainModel = retainModelOnUnmountRef.current;
      const released = session.releaseView(viewGeneration, {
        persist: retainModel,
      });
      if (!released || retainModel) return;
      void registry.dispose(sessionKey, session).catch(() => undefined);
    };
  }, [adapterFactory, identity, registry, revision, runtimeFactory, runtimeRef, sessionKey]);

  const restart = async (): Promise<void> => {
    const session = ownerState.session;
    setOwnerState(EMPTY_SESSION_OWNER_STATE);
    if (session) await registry.dispose(sessionKey, session);
    await onReloadRef.current?.();
    setRevision((current) => current + 1);
  };

  const { session, startupError } = ownerState;
  if (!session) {
    if (startupError) {
      const failure = {
        descriptor,
        error: startupError,
        reason: "startup" as const,
        reloading: false,
        reload: restart,
      };
      return renderFailureFallback ? (
        renderFailureFallback(failure)
      ) : (
        <BlockDocumentSurfaceFailureState {...failure} />
      );
    }
    if (pendingFallback !== undefined) return pendingFallback;
    return (
      <div
        role="status"
        aria-live="polite"
        data-block-document-surface-state="loading"
        className="py-8 text-sm text-token-description-foreground"
      >
        Opening content…
      </div>
    );
  }

  return (
    <OwnedBlockDocumentRuntimeSurface
      runtime={session.runtime}
      descriptor={descriptor}
      isActive={isActive}
      localAwarenessState={localAwarenessState}
      awarenessLease={session.awarenessLease}
      startupError={startupError}
      onReload={restart}
      pendingFallback={pendingFallback}
      renderFailureFallback={renderFailureFallback}
    >
      {(surface) => {
        if (surface.kind !== "page") {
          throw new TypeError("Page editor session resolved a non-Page Document schema");
        }
        const pageSurface = {
          ...surface,
          descriptor,
        };
        const content = children(pageSurface, session);
        if (!pageTitleIdentity) return content;
        return (
          <PageTitleProjectionPublisher
            identity={pageTitleIdentity}
            publisherId={`${session.key}:${surface.clientSessionId}`}
            title={surface.title}
            runtime={session.runtime}
            retentionOwner={session}
          >
            {content}
          </PageTitleProjectionPublisher>
        );
      }}
    </OwnedBlockDocumentRuntimeSurface>
  );
}
