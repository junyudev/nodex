import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
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
import { PageStageInlinePropertyStrip } from "./page-stage/inline-property-strip";
import { PageStageContentSkeleton } from "./page-stage/content-skeleton";
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
import { RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE } from "@/lib/right-panel-composer-overlay-reserve";
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
import { contentAccessContextKey } from "../../../shared/content-access-context";

export type { PageStageProps } from "./page-stage/types";

export const PAGE_STAGE_SCROLL_CONTAINER_TEST_ID = "page-stage-scroll-container";

const PAGE_STAGE_SCROLL_CONTAINER_STYLE = {
  ...RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE,
  overflowAnchor: "none",
} satisfies CSSProperties;

async function copyPageDeeplink(pageId: string): Promise<void> {
  const copied = await writeTextToClipboard(buildPageDeepLink({ pageId: pageId }));
  if (copied) {
    toast.success("Copied deeplink");
    return;
  }

  toast.danger("Failed to copy deeplink");
}

interface PageStageDescriptionEditorProps {
  readonly contentAccessContext: PageStageProps["contentAccessContext"];
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
  readonly relatedChats: PageStageProps["relatedChats"];
  readonly onOpenCodexThread: PageStageProps["onOpenCodexThread"];
  readonly onOpenPage: PageStageProps["onOpenPage"];
  readonly onOpenDatabase: PageStageProps["onOpenDatabase"];
  readonly onOpenCanvas: PageStageProps["onOpenCanvas"];
  readonly onStartNewSessionThreadFromEditor: PageStageProps["onStartNewSessionThreadFromEditor"];
  readonly onSendThreadSectionPrompt: PageStageProps["onSendThreadSectionPrompt"];
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
  const getSnapshot = useCallback(() => materializePageDocument(document).nfm, [document]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

function CollaborativePageStageRawContent({ document }: { readonly document: Y.Doc }) {
  return <PageStageRawContent content={useLivePageDocumentNfm(document)} />;
}

const PageStageDescriptionEditor = memo(function PageStageDescriptionEditor({
  contentAccessContext,
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
  relatedChats,
  onOpenCodexThread,
  onOpenPage,
  onOpenDatabase,
  onOpenCanvas,
  onStartNewSessionThreadFromEditor,
  onSendThreadSectionPrompt,
  isActivePanelTab,
  headingRailPortalElement,
  scrollContainerRef,
  viewportSessionRef,
  editorSession,
  focusIntent,
}: PageStageDescriptionEditorProps) {
  const navigationRef = useRef<NfmEditorBoundaryHandle | null>(null);
  const rawContentRootRef = useRef<HTMLDivElement | null>(null);
  const viewportLeaseRef = useRef<PageStageViewportLease | null>(null);
  const documentScopeKey = contentAccessContextKey(contentAccessContext);
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

  useEffect(() => {
    if (!focusIntent) return;
    if (!navigationRef.current?.focusBlock(focusIntent.blockId)) return;
    viewportSession.adoptCurrentViewport();
    consumePageBlockFocus(focusIntent);
  }, [focusIntent, viewportSession]);

  useEffect(
    () => () => {
      viewportLeaseRef.current?.release();
      viewportLeaseRef.current = null;
      if (!editorSession) viewportSession.dispose();
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
    },
    [scrollContainerRef, viewportSession],
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

  const linkedCodexThreads = relatedChats?.flatMap((chat) => {
    if (!chat.threadId) return [];
    return [
      {
        threadId: chat.threadId,
        title: chat.displayTitle,
        preview: chat.threadPreview || undefined,
        statusType: chat.threadStatus?.statusType ?? "idle",
        statusActiveFlags: chat.threadStatus?.activeFlags ?? [],
        archived: chat.threadArchived,
        updatedAt: chat.conversationRecencyAt ?? Date.parse(chat.linkedAt),
      },
    ];
  });

  return (
    <NfmEditor
      contentAccessContext={contentAccessContext}
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
      linkedCodexThreads={linkedCodexThreads}
      onOpenCodexThread={onOpenCodexThread}
      onOpenPage={onOpenPage}
      onOpenDatabase={onOpenDatabase}
      onOpenCanvas={onOpenCanvas}
      onStartNewSessionThreadFromEditor={onStartNewSessionThreadFromEditor}
      onSendThreadSectionPrompt={onSendThreadSectionPrompt}
      isActivePanelTab={isActivePanelTab}
      headingRail={{
        portalElement: headingRailPortalElement,
        scrollContainerRef,
      }}
      placeholder={PAGE_DESCRIPTION_PLACEHOLDER}
      editorSession={editorSession}
      navigationRef={navigationRef}
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
    <div className={controller.contentShellClassName}>
      <div className="h-toolbar-sm" />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">{title}</div>
        {syncStatus ? <div className="shrink-0 pt-1">{syncStatus}</div> : null}
      </div>

      <div className="h-2" />

      {controller.hasDatabaseProperties ? (
        <PageStageInlinePropertyStrip controls={controller.propertyControls} />
      ) : null}

      <PageStagePropertiesSection controller={controller} />

      <div className="pt-2 pb-8">
        {description}
        {referencedBy}
      </div>
    </div>
  );
}

function PageStageDocumentTitle({
  title,
  historyScope,
  onValueChange,
  autoFocus,
}: {
  readonly title: Y.Text;
  readonly historyScope: ContentInteractionHistoryScope;
  readonly onValueChange: (title: string) => void;
  readonly autoFocus?: boolean;
}) {
  return (
    <CollaborativePageTitle
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
    props.contentAccessContext.kind === "project" ? props.contentAccessContext.projectId : null,
    controller.page?.id ?? "",
  );
  const handleToggleHistoryPanel = useCallback(() => {
    void (async () => {
      await persistDocument();
      const runtime = documentRuntimeRef.current;
      const nfm = runtime ? materializePageDocument(runtime.document).nfm : "";
      onToggleHistoryPanel?.({
        title: controller.title,
        nfm,
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
          onValueChange={controller.handleDocumentTitleChange}
          autoFocus={props.autoFocusTitle}
        />
      }
      syncStatus={
        <BlockDocumentSyncStatus runtime={surface.runtime} status={surface.status.provider} />
      }
      description={
        <PageStageDescriptionEditor
          contentAccessContext={props.contentAccessContext}
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
          relatedChats={props.relatedChats}
          onOpenCodexThread={props.onOpenCodexThread}
          onOpenPage={props.onOpenPage}
          onOpenDatabase={props.onOpenDatabase}
          onOpenCanvas={props.onOpenCanvas}
          onStartNewSessionThreadFromEditor={props.onStartNewSessionThreadFromEditor}
          onSendThreadSectionPrompt={props.onSendThreadSectionPrompt}
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
          accessContext={props.contentAccessContext}
          pageId={page.id}
          onOpenPage={props.onOpenPage}
        />
      }
    />
  );
  const surfaceProps = {
    descriptor: props.documentAuthority.descriptor,
    pageTitleIdentity: props.pageTitleIdentity,
    isActive: props.isActivePanelTab ?? true,
    runtimeRef: documentRuntimeRef,
    onReload: props.documentAuthority.reload,
    dependencies: props.documentAuthority.surfaceDependencies,
    pendingFallback: <PageStageContentSkeleton titleSnapshot={page.title} />,
    localAwarenessState: {
      user: { name: "You", color: "#3b82f6" },
    },
  } as const;
  const documentSurface = props.editorSessionKey ? (
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
  const toolbar = (
    <PageStageToolbar
      onNavigateBack={props.onNavigateBack}
      saving={controller.saving}
      historyPanelActive={controller.historyPanelActive}
      limitMainContentWidth={controller.limitMainContentWidth}
      showRawContent={controller.showRawContent}
      onCopyDeeplink={() => {
        void copyPageDeeplink(page.id);
      }}
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
  );

  return (
    <div
      className="flex h-full w-full flex-col bg-(--background)"
      data-page-stage-surface="true"
      data-page-stage-page-id={page.id}
    >
      {props.toolbarPlacement?.kind === "external"
        ? props.toolbarPlacement.render(toolbar)
        : toolbar}

      <div
        ref={setHeadingRailPortalElement}
        className="relative min-h-0 flex-1"
        data-page-stage-heading-navigation-portal-target="true"
      >
        <div
          ref={scrollContainerRef}
          className="scrollbar-token h-full min-h-0 overflow-y-auto"
          data-testid={PAGE_STAGE_SCROLL_CONTAINER_TEST_ID}
          style={PAGE_STAGE_SCROLL_CONTAINER_STYLE}
        >
          <div
            className={controller.contentBodyClassName}
            data-page-stage-body="true"
            data-page-stage-body-width={controller.limitMainContentWidth ? "constrained" : "full"}
          >
            {documentSurface}
          </div>
        </div>
      </div>
    </div>
  );
}
