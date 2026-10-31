import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { NfmEditor } from "./editor/nfm-editor";
import {
  BlockDocumentSurface,
  type BlockDocumentSurfaceValue,
} from "@/components/block-documents/block-document-surface";
import { PageEditorSessionSurface } from "@/components/block-documents/page-editor-session-surface";
import { BlockDocumentSyncStatus } from "@/components/block-documents/block-document-sync-status";
import { CollaborativePageTitle } from "@/components/block-documents/collaborative-page-title";
import type { ContentInteractionHistoryScope } from "@/lib/content-interaction-history";
import {
  PageStageBodyPlaceholder,
  PageStageContentLayout,
  PageStageFrame,
  PageTitlePlaceholder,
} from "./page-stage/frame";
import { PageStagePropertiesSection } from "./page-stage/properties-section";
import { PageStageRawContent } from "./page-stage/raw-content";
import { PageStageToolbar } from "./page-stage/toolbar";
import { PageStageReferencedBy } from "./page-stage/referenced-by-section";
import { usePageStageController } from "./page-stage/use-page-stage-controller";
import type { PageStageProps } from "./page-stage/types";
import { toast } from "@/components/ui/toast";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import { writeTextToClipboard } from "@/lib/clipboard";
import type { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import type { EditorSurfaceLease } from "@/lib/document-session-registry";
import { materializePageDocument } from "../../../shared/block-documents/block-document-codec";
import { PAGE_DESCRIPTION_PLACEHOLDER } from "@/lib/page-description-placeholder";
import {
  consumePageBlockFocus,
  type PageBlockFocusIntent,
  usePageBlockFocusIntent,
} from "@/lib/page-block-focus-intents";
import type { NfmEditorBoundaryHandle } from "./editor/nfm-editor";
import {
  PageStageViewportSession,
  type PageStageViewportLease,
} from "@/lib/page-stage-viewport-session";
import { contentRoutingContextKey } from "../../../shared/content-routing-context";
import { ApplicationPending } from "@/bootstrap/application-surface";
import { useScheduledNavigation } from "@/features/scheduled/scheduled-navigation";

export type { PageStageProps } from "./page-stage/types";

async function copyPageDeeplink(pageId: string): Promise<void> {
  const copied = await writeTextToClipboard(buildPageDeepLink({ pageId: pageId }));
  if (copied) {
    toast.success("Copied deeplink");
    return;
  }

  toast.danger("Failed to copy deeplink");
}

interface PageStageDescriptionEditorProps {
  readonly contentRoutingContext: PageStageProps["contentRoutingContext"];
  readonly projectName?: string | null;
  readonly projectWorkspacePath?: string | null;
  readonly pageId: string;
  readonly showRawContent: boolean;
  readonly documentId: string;
  readonly generation: number;
  readonly document: Y.Doc;
  readonly body: Y.XmlFragment;
  readonly awareness: Awareness;
  readonly surfaceMutationBarrier: BlockDocumentSurfaceRuntime;
  readonly sessionId?: string | null;
  readonly sessionThread: PageStageProps["sessionThread"];
  readonly canStartThreadInSession: PageStageProps["canStartThreadInSession"];
  readonly sessionTitle?: PageStageProps["sessionTitle"];
  readonly onOpenCodexThread: PageStageProps["onOpenCodexThread"];
  readonly onOpenSession: PageStageProps["onOpenRelatedChat"];
  readonly onOpenPage: PageStageProps["onOpenPage"];
  readonly onOpenDatabase: PageStageProps["onOpenDatabase"];
  readonly onOpenCanvas: PageStageProps["onOpenCanvas"];
  readonly onStartNewSessionThreadFromEditor: PageStageProps["onStartNewSessionThreadFromEditor"];
  readonly onSendPagePrompt: PageStageProps["onSendPagePrompt"];
  readonly isActivePanelTab: boolean;
  readonly headingRailPortalElement: HTMLElement | null;
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
  readonly viewportSessionRef: RefObject<PageStageViewportSession | null>;
  readonly editorSession?: EditorSurfaceLease;
  readonly focusIntent: PageBlockFocusIntent | null;
}

const useLivePageDocumentNfm = (document: Y.Doc): string => {
  const subscribe = useCallback(
    (listener: () => void) => {
      document.on("update", listener);
      return () => document.off("update", listener);
    },
    [document],
  );
  const getSnapshot = useCallback(() => materializePageDocument(document).markdown, [document]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

function CollaborativePageStageRawContent({ document }: { readonly document: Y.Doc }) {
  return <PageStageRawContent content={useLivePageDocumentNfm(document)} />;
}

const PageStageDescriptionEditor = memo(function PageStageDescriptionEditor({
  contentRoutingContext,
  projectName,
  projectWorkspacePath,
  pageId,
  showRawContent,
  documentId,
  generation,
  document,
  body,
  awareness,
  surfaceMutationBarrier,
  sessionId,
  sessionThread,
  canStartThreadInSession,
  sessionTitle,
  onOpenCodexThread,
  onOpenSession,
  onOpenPage,
  onOpenDatabase,
  onOpenCanvas,
  onStartNewSessionThreadFromEditor,
  onSendPagePrompt,
  isActivePanelTab,
  headingRailPortalElement,
  scrollContainerRef,
  viewportSessionRef,
  editorSession,
  focusIntent,
}: PageStageDescriptionEditorProps) {
  const navigationRef = useRef<NfmEditorBoundaryHandle | null>(null);
  const consumedFocusIntentRef = useRef<number | null>(null);
  const rawContentRootRef = useRef<HTMLDivElement | null>(null);
  const viewportLeaseRef = useRef<PageStageViewportLease | null>(null);
  const documentScopeKey = contentRoutingContextKey(contentRoutingContext);
  const viewportSession = useMemo(
    () =>
      editorSession?.getOrCreateRetainedResource(
        "page-stage-viewport-session-v2",
        () =>
          new PageStageViewportSession({
            documentScopeKey,
            pageId,
            editorSessionKey: editorSession.key,
          }),
      ) ?? new PageStageViewportSession({ documentScopeKey, pageId }),
    [documentScopeKey, editorSession, pageId],
  );

  useLayoutEffect(() => {
    viewportSessionRef.current = viewportSession;
    return () => {
      if (viewportSessionRef.current === viewportSession) {
        viewportSessionRef.current = null;
      }
    };
  }, [viewportSession, viewportSessionRef]);

  const focusPendingBlock = useCallback(() => {
    if (!focusIntent || consumedFocusIntentRef.current === focusIntent.id) return;
    if (!viewportLeaseRef.current) return;
    if (!navigationRef.current?.focusBlock(focusIntent.blockId)) return;
    consumedFocusIntentRef.current = focusIntent.id;
    viewportSession.adoptCurrentViewport();
    consumePageBlockFocus(focusIntent);
  }, [focusIntent, viewportSession]);
  useEffect(focusPendingBlock, [focusPendingBlock]);

  // Navigation and mounted DOM become ready in separate child layout effects.
  // Either arrival retries the intent, after viewport restoration has finished.
  const bindNavigation = useCallback(
    (handle: NfmEditorBoundaryHandle | null) => {
      navigationRef.current = handle;
      if (handle) focusPendingBlock();
    },
    [focusPendingBlock],
  );

  useEffect(
    () => () => {
      // View cleanup can be replayed while React retains this session. Its
      // listeners/timers belong to the view, not to terminal model disposal.
      // Only release this session: a replacement view may already own the ref.
      if (!editorSession) viewportSession.unmount();
    },
    [editorSession, viewportSession],
  );

  useLayoutEffect(() => {
    if (!showRawContent) return;
    const scrollElement = scrollContainerRef.current;
    const contentRoot = rawContentRootRef.current;
    if (!scrollElement || !contentRoot) return;
    const lease = viewportSession.mount(scrollElement, contentRoot);
    viewportLeaseRef.current = lease;
    return () => {
      lease.release();
      if (viewportLeaseRef.current === lease) viewportLeaseRef.current = null;
    };
  }, [scrollContainerRef, showRawContent, viewportSession]);

  const handleEditorViewMount = useCallback(
    (editorRoot: HTMLElement) => {
      const scrollElement = scrollContainerRef.current;
      if (!scrollElement) return;
      viewportLeaseRef.current?.release();
      viewportLeaseRef.current = viewportSession.mount(scrollElement, editorRoot);
      focusPendingBlock();
    },
    [focusPendingBlock, scrollContainerRef, viewportSession],
  );
  const handleEditorViewUnmount = useCallback(() => {
    viewportLeaseRef.current?.release();
    viewportLeaseRef.current = null;
  }, []);

  if (showRawContent) {
    return (
      <div ref={rawContentRootRef}>
        <CollaborativePageStageRawContent document={document} />
      </div>
    );
  }

  return (
    <NfmEditor
      contentRoutingContext={contentRoutingContext}
      projectName={projectName}
      projectWorkspacePath={projectWorkspacePath}
      source={{
        kind: "collaborative-document",
        documentId,
        storeEpoch: surfaceMutationBarrier.descriptor.storeEpoch,
        generation,
        clientSessionId: surfaceMutationBarrier.clientSessionId,
        fragment: body,
        user: { name: "You", color: "#3b82f6" },
        provider: { awareness },
        ...(editorSession ? { transactionOrigin: editorSession.transactionOrigin } : {}),
      }}
      sourcePageContext={{ pageId }}
      surfaceMutationBarrier={surfaceMutationBarrier}
      sessionId={sessionId}
      sessionThread={sessionThread}
      canStartThreadInSession={canStartThreadInSession}
      sessionTitle={sessionTitle}
      onOpenCodexThread={onOpenCodexThread}
      onOpenSession={onOpenSession}
      onOpenPage={onOpenPage}
      onOpenDatabase={onOpenDatabase}
      onOpenCanvas={onOpenCanvas}
      onStartNewSessionThreadFromEditor={onStartNewSessionThreadFromEditor}
      onSendPagePrompt={onSendPagePrompt}
      isActivePanelTab={isActivePanelTab}
      headingRail={{
        portalElement: headingRailPortalElement,
        scrollContainerRef,
      }}
      placeholder={PAGE_DESCRIPTION_PLACEHOLDER}
      editorSession={editorSession}
      navigationRef={bindNavigation}
      onEditorViewMount={handleEditorViewMount}
      onEditorViewUnmount={handleEditorViewUnmount}
    />
  );
});

type PageStageController = ReturnType<typeof usePageStageController>;

interface PageStageContentProps {
  readonly controller: PageStageController;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly referencedBy?: ReactNode;
  readonly syncStatus?: ReactNode;
}

function PageStageContent({
  controller,
  title,
  description,
  referencedBy,
  syncStatus,
}: PageStageContentProps) {
  return (
    <PageStageContentLayout
      title={title}
      syncStatus={syncStatus}
      properties={<PageStagePropertiesSection controller={controller} />}
      body={
        <>
          {description}
          {referencedBy}
        </>
      }
    />
  );
}

function PageStageDocumentTitle({
  title,
  pageId,
  historyScope,
  onValueChange,
  autoFocus,
}: {
  readonly title: Y.Text;
  readonly pageId: string;
  readonly historyScope: ContentInteractionHistoryScope;
  readonly onValueChange: (title: string) => void;
  readonly autoFocus?: boolean;
}) {
  return (
    <CollaborativePageTitle
      pageId={pageId}
      title={title}
      historyScope={historyScope}
      autoFocus={autoFocus}
      onValueChange={onValueChange}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
        }
      }}
    />
  );
}

export function PageStage(props: PageStageProps) {
  const { onToggleHistoryPanel } = props;
  const scheduledNavigation = useScheduledNavigation();
  const documentRuntimeRef = useRef<BlockDocumentSurfaceRuntime | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const viewportSessionRef = useRef<PageStageViewportSession | null>(null);
  const persistDocument = useCallback(async () => {
    const runtime = documentRuntimeRef.current;
    if (!runtime || runtime.getStatus().reloadRequired) return;
    try {
      await runtime.persist();
    } catch (error) {
      if (runtime.getStatus().reloadRequired) return;
      throw error;
    }
  }, []);
  const persistViewport = useCallback(() => viewportSessionRef.current?.persist(), []);
  const controller = usePageStageController(props, {
    persistDocument,
    persistViewport,
  });
  const focusIntent = usePageBlockFocusIntent(
    props.contentRoutingContext.kind === "project" ? props.contentRoutingContext.projectId : null,
    controller.page?.id ?? "",
  );
  const handleToggleHistoryPanel = useCallback(() => {
    void (async () => {
      await persistDocument();
      const runtime = documentRuntimeRef.current;
      const markdown = runtime ? materializePageDocument(runtime.document).markdown : "";
      onToggleHistoryPanel?.({
        title: controller.title,
        markdown,
      });
    })().catch(() => {
      toast.danger("Couldn’t prepare Page history");
    });
  }, [controller.title, onToggleHistoryPanel, persistDocument]);
  const [headingRailPortalElement, setHeadingRailPortalElement] = useState<HTMLDivElement | null>(
    null,
  );

  if (!controller.page) return null;
  const page = controller.page;
  const renderDocumentSurface = (
    surface: BlockDocumentSurfaceValue,
    editorSession?: EditorSurfaceLease,
  ): ReactNode => (
    <PageStageContent
      controller={controller}
      title={
        <PageStageDocumentTitle
          title={surface.title}
          historyScope={surface.descriptor}
          pageId={surface.descriptor.ownerBlockId}
          onValueChange={controller.handleDocumentTitleChange}
          autoFocus={props.autoFocusTitle}
        />
      }
      syncStatus={
        <BlockDocumentSyncStatus runtime={surface.runtime} status={surface.status.provider} />
      }
      description={
        <PageStageDescriptionEditor
          contentRoutingContext={props.contentRoutingContext}
          projectName={props.projectName}
          projectWorkspacePath={props.projectWorkspacePath}
          pageId={page.id}
          showRawContent={controller.showRawContent}
          documentId={surface.documentId}
          generation={surface.descriptor.generation}
          document={surface.document}
          body={surface.body}
          awareness={surface.awareness}
          surfaceMutationBarrier={surface.runtime}
          sessionId={props.sessionId}
          sessionThread={props.sessionThread}
          canStartThreadInSession={props.canStartThreadInSession}
          sessionTitle={props.sessionTitle}
          onOpenCodexThread={props.onOpenCodexThread}
          onOpenSession={props.onOpenRelatedChat}
          onOpenPage={props.onOpenPage}
          onOpenDatabase={props.onOpenDatabase}
          onOpenCanvas={props.onOpenCanvas}
          onStartNewSessionThreadFromEditor={props.onStartNewSessionThreadFromEditor}
          onSendPagePrompt={props.onSendPagePrompt}
          isActivePanelTab={props.isActivePanelTab ?? true}
          headingRailPortalElement={headingRailPortalElement}
          scrollContainerRef={scrollContainerRef}
          viewportSessionRef={viewportSessionRef}
          editorSession={editorSession}
          focusIntent={focusIntent}
        />
      }
      referencedBy={
        <PageStageReferencedBy
          routingContext={props.contentRoutingContext}
          pageId={page.id}
          onOpenPage={props.onOpenPage}
        />
      }
    />
  );
  const isActivePanelTab = props.isActivePanelTab ?? true;
  // Page Detail is readable before the Document: properties render now, while the title
  // and body hold their exact places until the collaborative editor is ready.
  const pendingDocumentContent = (
    <ApplicationPending active={isActivePanelTab}>
      <PageStageContent
        controller={controller}
        title={<PageTitlePlaceholder title={controller.title} />}
        description={<PageStageBodyPlaceholder seed={page.id} />}
      />
    </ApplicationPending>
  );
  const documentAuthority = props.documentAuthority;
  const surfaceProps = documentAuthority
    ? ({
        descriptor: documentAuthority.descriptor,
        pageTitleIdentity: props.pageTitleIdentity,
        isActive: isActivePanelTab,
        runtimeRef: documentRuntimeRef,
        onReload: documentAuthority.reload,
        dependencies: documentAuthority.surfaceDependencies,
        pendingFallback: pendingDocumentContent,
        localAwarenessState: {
          user: { name: "You", color: "#3b82f6" },
        },
      } as const)
    : null;
  const documentSurface = !surfaceProps ? (
    pendingDocumentContent
  ) : props.editorSessionKey ? (
    <PageEditorSessionSurface
      {...surfaceProps}
      sessionKey={props.editorSessionKey}
      retainModelOnUnmount={props.retainEditorSession !== false}
    >
      {renderDocumentSurface}
    </PageEditorSessionSurface>
  ) : (
    <BlockDocumentSurface {...surfaceProps}>
      {(surface) => renderDocumentSurface(surface)}
    </BlockDocumentSurface>
  );

  return (
    <PageStageFrame
      data-page-stage-surface="true"
      data-page-stage-page-id={page.id}
      limitMainContentWidth={controller.limitMainContentWidth}
      headingRailPortalRef={setHeadingRailPortalElement}
      scrollContainerRef={scrollContainerRef}
      toolbar={
        <PageStageToolbar
          onNavigateBack={props.onNavigateBack}
          saving={controller.saving}
          pending={!documentAuthority}
          historyPanelActive={controller.historyPanelActive}
          limitMainContentWidth={controller.limitMainContentWidth}
          showRawContent={controller.showRawContent}
          onCopyDeeplink={() => {
            void copyPageDeeplink(page.id);
          }}
          onSchedule={
            scheduledNavigation
              ? () =>
                  scheduledNavigation.scheduleRunbook({
                    pageId: page.id,
                    title: controller.title,
                    projectId:
                      controller.contentRoutingContext.kind === "project"
                        ? controller.contentRoutingContext.projectId
                        : null,
                  })
              : undefined
          }
          onDelete={() => {
            void controller.handleDelete();
          }}
          showDelete={Boolean(props.onDelete)}
          onToggleContentWidth={controller.handleToggleContentWidth}
          onToggleShowRawContent={controller.handleToggleShowRawContent}
          onToggleHistoryPanel={handleToggleHistoryPanel}
          breadcrumb={
            props.breadcrumb
              ? {
                  ...props.breadcrumb,
                  currentTitle: controller.title,
                }
              : undefined
          }
        />
      }
    >
      {documentSurface}
    </PageStageFrame>
  );
}
