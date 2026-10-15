import { ChevronRightIcon } from "@/components/shared/icons";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { CircleAlert } from "@/components/shared/icons/generic-icons";
import type { Awareness } from "y-protocols/awareness";
import type {
  PageDocumentEnvelope,
  OwnedDocumentDescriptor,
} from "../../../shared/block-documents";
import type { OwnedDocumentEnvelope } from "../../../shared/block-documents/document-schema-adapters";
import { NodexButton } from "@/components/ui/button";
import { createDocumentSyncAdapterForContentRouting } from "@/lib/api";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import {
  resolveBlockDocumentSurfaceFailure,
  type BlockDocumentSurfaceFailureReason,
} from "@/lib/block-document-surface-failure";
import { writeTextToClipboard } from "@/lib/clipboard";
import { buildTextPreview, INLINE_TEXT_PREVIEW_MAX_CHARS } from "@/lib/text-preview";
import {
  BlockDocumentSurfaceRuntime,
  type BlockDocumentSurfaceReloadContext,
  type BlockDocumentSurfaceRuntimeOptions,
  type BlockDocumentSurfaceStatus,
} from "@/lib/block-document-surface-runtime";
import type { DocumentSyncAdapter } from "@/lib/nodex-y-provider";
import type { EditorSurfaceAwarenessLease } from "@/lib/document-session-registry";
import type {
  OwnedBlockDocumentModel,
  ReadyPageBlockDocumentDescriptor,
} from "@/lib/owned-block-document";
import {
  PageTitleProjectionPublisher,
  type PageTitleResourceIdentity,
} from "@/lib/page-title-projection-context";

export type PrimaryPageBlockDocumentDescriptor = ReadyPageBlockDocumentDescriptor;

export type PrimaryOwnedBlockDocumentDescriptor = OwnedDocumentDescriptor & {
  readonly ownerLifecycle: "active";
  readonly readiness: "ready";
  readonly sync: { readonly kind: "yjs"; readonly stateVector: Uint8Array };
};

export type BlockDocumentLocalAwarenessState = Readonly<Record<string, unknown>>;

export interface BlockDocumentSurfaceValue extends PageDocumentEnvelope {
  readonly descriptor: PrimaryPageBlockDocumentDescriptor;
  readonly runtime: BlockDocumentSurfaceRuntime;
  readonly awareness: Awareness;
  readonly clientSessionId: string;
  readonly status: BlockDocumentSurfaceStatus;
}

export type OwnedBlockDocumentSurfaceValue = OwnedDocumentEnvelope & {
  readonly descriptor: PrimaryOwnedBlockDocumentDescriptor;
  readonly runtime: BlockDocumentSurfaceRuntime;
  readonly awareness: Awareness;
  readonly clientSessionId: string;
  readonly status: BlockDocumentSurfaceStatus;
};

export interface BlockDocumentSurfaceDependencies {
  readonly createAdapter?: (routingContext: ContentRoutingContext) => DocumentSyncAdapter;
  readonly createRuntime?: (
    options: BlockDocumentSurfaceRuntimeOptions,
  ) => BlockDocumentSurfaceRuntime;
}

export interface BlockDocumentSurfaceProps {
  readonly descriptor: PrimaryPageBlockDocumentDescriptor;
  /** Stable Page identity used only for renderer-local live title projection. */
  readonly pageTitleIdentity?: PageTitleResourceIdentity;
  /** Retained inactive tabs continue syncing content but publish no presence. */
  readonly isActive: boolean;
  readonly localAwarenessState?: BlockDocumentLocalAwarenessState;
  /** Optional lease used when multiple views share one canonical provider. */
  readonly awarenessLease?: EditorSurfaceAwarenessLease;
  readonly onReload?: (context?: BlockDocumentSurfaceReloadContext) => void | Promise<void>;
  readonly dependencies?: BlockDocumentSurfaceDependencies;
  /** Read-only integration seam for flush/checkpoint before closing a stage. */
  readonly runtimeRef?: MutableRefObject<BlockDocumentSurfaceRuntime | null>;
  /** Surface-specific first-sync placeholder; defaults to the generic status text. */
  readonly pendingFallback?: ReactNode;
  /** Surface-specific error composition; defaults to the generic recovery panel. */
  readonly renderFailureFallback?: (failure: BlockDocumentSurfaceFailureStateProps) => ReactNode;
  readonly children: (surface: BlockDocumentSurfaceValue) => ReactNode;
}

export interface OwnedBlockDocumentSurfaceProps extends Omit<
  BlockDocumentSurfaceProps,
  "descriptor" | "children"
> {
  readonly descriptor: PrimaryOwnedBlockDocumentDescriptor;
  readonly children: (surface: OwnedBlockDocumentSurfaceValue) => ReactNode;
}

export interface BlockDocumentSurfaceFailureStateProps {
  readonly descriptor: PrimaryOwnedBlockDocumentDescriptor;
  readonly error: Error;
  readonly reason: BlockDocumentSurfaceFailureReason;
  readonly reloading: boolean;
  readonly reload?: () => Promise<void>;
}

const DEFAULT_DEPENDENCIES: BlockDocumentSurfaceDependencies = {};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const createRuntime = (options: BlockDocumentSurfaceRuntimeOptions): BlockDocumentSurfaceRuntime =>
  new BlockDocumentSurfaceRuntime(options);

function SurfacePending({
  phase,
  fallback,
}: {
  readonly phase?: string;
  readonly fallback?: ReactNode;
}) {
  if (fallback !== undefined) return fallback;
  const label = phase === "connecting" ? "Connecting content…" : "Opening content…";
  return (
    <div
      role="status"
      aria-live="polite"
      data-block-document-surface-state={phase ?? "loading"}
      className="py-8 text-sm text-token-description-foreground"
    >
      {label}
    </div>
  );
}

export function BlockDocumentSurfaceFailureState({
  descriptor,
  error,
  reason,
  reloading,
  reload,
}: BlockDocumentSurfaceFailureStateProps) {
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const presentation = resolveBlockDocumentSurfaceFailure({
    descriptor,
    error,
    reason,
  });
  const diagnosticsPreview = buildTextPreview(
    presentation.diagnostics,
    INLINE_TEXT_PREVIEW_MAX_CHARS,
  );

  const copyDiagnostics = async (): Promise<void> => {
    const copied = await writeTextToClipboard(presentation.diagnostics);
    setCopyState(copied ? "copied" : "failed");
  };

  return (
    <div role="alert" data-block-document-surface-state={reason} className="py-8 text-sm">
      <div className="max-w-xl">
        <div className="flex items-start gap-2">
          <CircleAlert
            aria-hidden="true"
            className="icon-2xs mt-0.5 shrink-0 text-token-error-foreground"
          />
          <div className="min-w-0">
            <p className="text-token-text-primary">{presentation.title}</p>
            <p className="mt-0.5 break-words text-token-description-foreground">
              {presentation.description}
            </p>
          </div>
        </div>

        <div className="mt-2.5 flex items-center gap-1.5 pl-5">
          {reload ? (
            <NodexButton
              type="button"
              size="xs"
              variant="secondary"
              disabled={reloading}
              onClick={() => void reload()}
            >
              {reloading ? "Reloading…" : "Reload"}
            </NodexButton>
          ) : null}
          <NodexButton
            type="button"
            size="xs"
            variant="ghost"
            aria-controls={detailsId}
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((current) => !current)}
          >
            <ChevronRightIcon
              className={
                detailsOpen
                  ? "rotate-90 transition-transform duration-150"
                  : "transition-transform duration-150"
              }
            />
            Details
          </NodexButton>
        </div>

        {detailsOpen ? (
          <div id={detailsId} className="mt-2.5 ml-5 rounded-md bg-token-foreground/5 p-2.5">
            <div className="mb-1.5 flex justify-end">
              <NodexButton
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void copyDiagnostics()}
              >
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "failed"
                    ? "Copy failed"
                    : "Copy diagnostics"}
              </NodexButton>
            </div>
            <pre className="scrollbar-token overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-token-description-foreground">
              {diagnosticsPreview.text}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeActiveAwarenessState = (
  runtime: BlockDocumentSurfaceRuntime,
  routingContext: ContentRoutingContext,
  descriptor: PrimaryOwnedBlockDocumentDescriptor,
  configured: BlockDocumentLocalAwarenessState | undefined,
  retained: Record<string, unknown> | null,
): Record<string, unknown> => {
  const current = runtime.awareness.getLocalState();
  const base = retained ?? (isRecord(current) ? current : {});
  const configuredNodex = isRecord(configured?.nodex) ? configured.nodex : {};
  const retainedNodex = isRecord(base.nodex) ? base.nodex : {};
  return {
    ...base,
    ...configured,
    nodex: {
      ...retainedNodex,
      ...configuredNodex,
      routingContext,
      ...(routingContext.kind === "project" ? { projectId: routingContext.projectId } : {}),
      ownerBlockId: descriptor.ownerBlockId,
      clientSessionId: runtime.clientSessionId,
    },
  };
};

const useSurfaceAwareness = (
  runtime: BlockDocumentSurfaceRuntime,
  routingContext: ContentRoutingContext,
  descriptor: PrimaryOwnedBlockDocumentDescriptor,
  isActive: boolean,
  configured: BlockDocumentLocalAwarenessState | undefined,
  awarenessLease?: EditorSurfaceAwarenessLease,
): void => {
  const retainedStateRef = useRef<Record<string, unknown> | null>(null);
  const configuredRef = useRef(configured);
  configuredRef.current = configured;

  useEffect(() => {
    const awareness = runtime.awareness;
    const localClientId = runtime.document.clientID;

    if (isActive) {
      const activeState = makeActiveAwarenessState(
        runtime,
        routingContext,
        descriptor,
        configuredRef.current,
        awarenessLease?.getRetainedState() ?? retainedStateRef.current,
      );
      if (awarenessLease) {
        awarenessLease.publish(activeState);
      } else {
        awareness.setLocalState(activeState);
      }
      return () => awarenessLease?.release();
    }

    awarenessLease?.release();
    if (awarenessLease) return;

    const clearPresence = (): void => {
      const current = awareness.getLocalState();
      if (!isRecord(current)) return;
      retainedStateRef.current = current;
      runtime.clearLocalAwareness();
    };
    const handleAwarenessUpdate = (changes: {
      readonly added: readonly number[];
      readonly updated: readonly number[];
    }): void => {
      if (!changes.added.includes(localClientId) && !changes.updated.includes(localClientId)) {
        return;
      }
      clearPresence();
    };

    awareness.on("update", handleAwarenessUpdate);
    clearPresence();
    return () => awareness.off("update", handleAwarenessUpdate);
  }, [routingContext, awarenessLease, descriptor, isActive, runtime]);
};

export interface OwnedBlockDocumentRuntimeSurfaceProps {
  readonly runtime: BlockDocumentSurfaceRuntime;
  readonly descriptor: PrimaryOwnedBlockDocumentDescriptor;
  readonly isActive: boolean;
  readonly localAwarenessState?: BlockDocumentLocalAwarenessState;
  readonly awarenessLease?: EditorSurfaceAwarenessLease;
  readonly startupError: Error | null;
  readonly onReload: () => Promise<void>;
  readonly pendingFallback?: ReactNode;
  readonly renderFailureFallback?: OwnedBlockDocumentSurfaceProps["renderFailureFallback"];
  readonly children: OwnedBlockDocumentSurfaceProps["children"];
}

export function OwnedBlockDocumentRuntimeSurface({
  runtime,
  descriptor,
  isActive,
  localAwarenessState,
  awarenessLease,
  startupError,
  onReload,
  pendingFallback,
  renderFailureFallback,
  children,
}: OwnedBlockDocumentRuntimeSurfaceProps) {
  const status = useSyncExternalStore(runtime.subscribe, runtime.getStatus, runtime.getStatus);
  const [reloading, setReloading] = useState(false);
  const reloadInFlightRef = useRef(false);
  useSurfaceAwareness(
    runtime,
    descriptor.routingContext,
    descriptor,
    isActive,
    localAwarenessState,
    awarenessLease,
  );

  const reload = async (): Promise<void> => {
    if (reloadInFlightRef.current) return;
    reloadInFlightRef.current = true;
    setReloading(true);
    try {
      if (status.reloadRequired) {
        await runtime.reload();
      } else {
        await runtime.close();
      }
    } finally {
      await onReload();
    }
  };

  useEffect(() => {
    if (status.phase !== "reset-required" || reloadInFlightRef.current) return;
    reloadInFlightRef.current = true;
    setReloading(true);
    void runtime
      .reload()
      .finally(onReload)
      .catch(() => {
        reloadInFlightRef.current = false;
        setReloading(false);
      });
  }, [onReload, runtime, status.error, status.phase]);

  const failure = startupError ?? status.error;
  if (failure) {
    const failureState: BlockDocumentSurfaceFailureStateProps = {
      descriptor,
      error: failure,
      reason: status.phase === "reset-required" ? "reset-required" : "fatal",
      reloading,
      reload,
    };
    return renderFailureFallback ? (
      renderFailureFallback(failureState)
    ) : (
      <BlockDocumentSurfaceFailureState {...failureState} />
    );
  }

  const document = status.ready ? runtime.getReadyDocument() : null;
  if (!document) {
    return <SurfacePending phase={status.phase} fallback={pendingFallback} />;
  }

  return children({
    ...document,
    descriptor,
    runtime,
    awareness: runtime.awareness,
    clientSessionId: runtime.clientSessionId,
    status,
  });
}

interface RuntimeOwnerProps extends OwnedBlockDocumentSurfaceProps {
  readonly restart: () => void;
}

interface RuntimeOwnerState {
  readonly runtime: BlockDocumentSurfaceRuntime | null;
  readonly startupError: Error | null;
}

const EMPTY_RUNTIME_OWNER_STATE: RuntimeOwnerState = {
  runtime: null,
  startupError: null,
};

function RuntimeOwner({
  descriptor: descriptorProp,
  isActive,
  localAwarenessState,
  awarenessLease,
  onReload,
  dependencies = DEFAULT_DEPENDENCIES,
  runtimeRef,
  pendingFallback,
  renderFailureFallback,
  children,
  restart,
}: RuntimeOwnerProps) {
  const [descriptor] = useState(descriptorProp);
  const [ownerState, setOwnerState] = useState<RuntimeOwnerState>(EMPTY_RUNTIME_OWNER_STATE);
  const closeTailRef = useRef<Promise<void>>(Promise.resolve());
  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;
  const adapterFactory = dependencies.createAdapter ?? createDocumentSyncAdapterForContentRouting;
  const runtimeFactory = dependencies.createRuntime ?? createRuntime;

  useLayoutEffect(() => {
    let live = true;
    let ownedRuntime: BlockDocumentSurfaceRuntime | null = null;
    setOwnerState(EMPTY_RUNTIME_OWNER_STATE);

    const openAfterPreviousClose = async (): Promise<void> => {
      await closeTailRef.current;
      if (!live) return;

      try {
        const adapter = adapterFactory(descriptor.routingContext);
        ownedRuntime = runtimeFactory({
          descriptor,
          adapter,
          reload: (context) => onReloadRef.current?.(context),
        });
        if (runtimeRef) runtimeRef.current = ownedRuntime;
        setOwnerState({ runtime: ownedRuntime, startupError: null });
        await ownedRuntime.connect();
      } catch (error) {
        if (!live) return;
        setOwnerState((current) => ({
          runtime: current.runtime,
          startupError: toError(error),
        }));
      }
    };

    void openAfterPreviousClose();

    return () => {
      live = false;
      if (runtimeRef?.current === ownedRuntime) runtimeRef.current = null;
      setOwnerState((current) =>
        current.runtime === ownedRuntime ? EMPTY_RUNTIME_OWNER_STATE : current,
      );
      if (!ownedRuntime) return;
      closeTailRef.current = ownedRuntime.close().then(
        () => undefined,
        () => undefined,
      );
    };
  }, [adapterFactory, descriptor, runtimeFactory, runtimeRef]);

  const { runtime, startupError } = ownerState;

  const reloadWithoutRuntime = async (): Promise<void> => {
    try {
      await onReloadRef.current?.();
    } finally {
      restart();
    }
  };

  if (!runtime) {
    if (startupError) {
      const failureState: BlockDocumentSurfaceFailureStateProps = {
        descriptor,
        error: startupError,
        reason: "startup",
        reloading: false,
        reload: reloadWithoutRuntime,
      };
      return renderFailureFallback ? (
        renderFailureFallback(failureState)
      ) : (
        <BlockDocumentSurfaceFailureState {...failureState} />
      );
    }
    return <SurfacePending fallback={pendingFallback} />;
  }

  const handleReload = async (): Promise<void> => {
    try {
      if (!runtime.getStatus().reloadRequired) {
        await onReloadRef.current?.();
      }
    } finally {
      restart();
    }
  };

  return (
    <OwnedBlockDocumentRuntimeSurface
      runtime={runtime}
      descriptor={descriptor}
      isActive={isActive}
      localAwarenessState={localAwarenessState}
      awarenessLease={awarenessLease}
      startupError={startupError}
      onReload={handleReload}
      pendingFallback={pendingFallback}
      renderFailureFallback={renderFailureFallback}
    >
      {children}
    </OwnedBlockDocumentRuntimeSurface>
  );
}

const surfaceIdentity = (descriptor: PrimaryOwnedBlockDocumentDescriptor): string =>
  [
    descriptor.libraryId,
    JSON.stringify(descriptor.routingContext),
    descriptor.documentId,
    descriptor.storeEpoch,
    descriptor.generation,
  ].join("\u0000");

/**
 * Owns one independent Y.Doc/provider pair for one mounted writable surface.
 * The authoritative roots are withheld until the initial state-vector sync and
 * schema validation have completed.
 */
export function OwnedBlockDocumentSurface(props: OwnedBlockDocumentSurfaceProps) {
  const [revision, setRevision] = useState(0);
  const identity = surfaceIdentity(props.descriptor);
  return (
    <RuntimeOwner
      key={`${identity}\u0000${revision}`}
      {...props}
      restart={() => setRevision((current) => current + 1)}
    />
  );
}

/** Legacy-named compatibility surface with a statically typed Page title root. */
export function BlockDocumentSurface(props: BlockDocumentSurfaceProps) {
  return (
    <OwnedBlockDocumentSurface {...props}>
      {(surface) => {
        if (surface.kind !== "page") {
          throw new TypeError("Page surface resolved a non-Page Document schema");
        }
        const pageSurface = {
          ...surface,
          descriptor: props.descriptor,
        };
        const content = props.children(pageSurface);
        if (!props.pageTitleIdentity) return content;
        return (
          <PageTitleProjectionPublisher
            identity={props.pageTitleIdentity}
            publisherId={surface.clientSessionId}
            title={surface.title}
            runtime={surface.runtime}
          >
            {content}
          </PageTitleProjectionPublisher>
        );
      }}
    </OwnedBlockDocumentSurface>
  );
}

export const isPrimaryOwnedBlockDocumentModel = (
  model: OwnedBlockDocumentModel,
): model is Extract<OwnedBlockDocumentModel, { readonly status: "ready" }> =>
  model.status === "ready";
