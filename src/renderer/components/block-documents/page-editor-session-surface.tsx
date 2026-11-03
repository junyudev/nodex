import { PageEditorSessionObservation } from "./page-editor-session-owner";
import {
  useEffectEvent,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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

const createRuntime = (options: BlockDocumentSurfaceRuntimeOptions): BlockDocumentSurfaceRuntime =>
  new BlockDocumentSurfaceRuntime(options);

/**
 * Attaches the active Page Stage to a PageTab-owned editor session. View
 * cleanup always releases presence and DOM; durable tabs leave model disposal
 * to the registry, while an unpromoted preview disposes on final unmount.
 */
function PageEditorSessionOwner({
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
  restartOwner,
}: PageEditorSessionSurfaceProps & { readonly restartOwner: () => void }) {
  const [observation] = useState(() => new PageEditorSessionObservation());
  const ownerState = useSyncExternalStore(observation.subscribe, observation.getSnapshot);
  const [ownedDescriptor] = useState(descriptor);
  const shouldRetainModel = useEffectEvent(() => retainModelOnUnmount);
  const adapterFactory = dependencies?.createAdapter ?? createDocumentSyncAdapterForContentRouting;
  const runtimeFactory = dependencies?.createRuntime ?? createRuntime;

  useLayoutEffect(
    () =>
      observation.attach({
        registry,
        sessionKey,
        descriptor: ownedDescriptor,
        createRuntime: () =>
          runtimeFactory({
            descriptor: ownedDescriptor,
            adapter: adapterFactory(ownedDescriptor.routingContext),
          }),
        runtimeRef,
        retainModel: () => shouldRetainModel(),
      }),
    [
      observation,
      adapterFactory,
      ownedDescriptor,
      registry,
      runtimeFactory,
      runtimeRef,
      sessionKey,
    ],
  );

  const restart = async (): Promise<void> => {
    const session = ownerState.session;
    observation.clear();
    if (session) await registry.dispose(sessionKey, session);
    await onReload?.();
    restartOwner();
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

export function PageEditorSessionSurface(props: PageEditorSessionSurfaceProps) {
  const [revision, setRevision] = useState(0);
  const identity = makeDocumentSessionIdentity(props.descriptor);
  return (
    <PageEditorSessionOwner
      key={`${props.sessionKey}\u0000${identity}\u0000${revision}`}
      {...props}
      restartOwner={() => setRevision((current) => current + 1)}
    />
  );
}
