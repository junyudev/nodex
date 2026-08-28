import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  readPageStageContentWidthPreference,
  readPageStageShowRawContentPreference,
  writePageStageContentWidthPreference,
  writePageStageShowRawContentPreference,
} from "@/lib/page-stage-layout";
import {
  loadScrollPosition,
  rememberScrollPosition,
  saveScrollPosition,
} from "@/lib/page-stage-scroll";
import { SCROLL_SAVE_DEBOUNCE_MS } from "@/lib/timing";
import type { PageInput } from "@/lib/types";
import type { PageStagePageModel, PageStageCorePage } from "@/lib/page-stage-page";
import {
  hasPageStageScheduleCapability,
  pageStageSemanticValues,
} from "@/lib/page-stage-properties";
import { useScheduleState, type PageScheduleSource } from "@/lib/use-schedule-state";
import {
  contentAccessContextKey,
  projectIdFromContentAccessContext,
  type ContentAccessContext,
} from "../../../../shared/content-access-context";
import type {
  PageStageMetadataMutationResult,
  PageStageProps,
  PageStageSessionSnapshot,
} from "./types";
import {
  usePageStageProperties,
  type PageStagePropertyControls,
} from "./use-page-stage-properties";

interface UsePageStageControllerResult {
  page: PageStageCorePage | null;
  contentAccessContext: ContentAccessContext;
  storeEpoch: string;
  hasDatabaseProperties: boolean;
  propertyControls: PageStagePropertyControls;
  title: string;
  saving: boolean;
  limitMainContentWidth: boolean;
  showRawContent: boolean;
  historyPanelActive: boolean;
  relatedChats: NonNullable<PageStageProps["relatedChats"]>;
  relatedChatsLoading: boolean;
  relatedChatsError: string | null;
  relatedChatsHasMore: boolean;
  relatedChatsLoadingMore: boolean;
  relatedChatCandidates: NonNullable<PageStageProps["relatedChatCandidates"]>;
  hasRelatedChatsRow: boolean;
  currentSessionId: string | null;
  contentBodyClassName: string;
  contentShellClassName: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  setScrollContainerRef: (node: HTMLDivElement | null) => void;
  schedule: ReturnType<typeof useScheduleState>;
  schedulePage: PageScheduleSource | null;
  onCreateRelatedChat?: () => Promise<void> | void;
  onLinkRelatedChat?: (sessionId: string) => Promise<void>;
  onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  onRemoveRelatedChat?: (sessionId: string) => Promise<void>;
  onRetryRelatedChats?: () => Promise<void> | void;
  onLoadMoreRelatedChats?: () => Promise<void> | void;
  handleClose: () => Promise<void>;
  handleDelete: () => Promise<void>;
  handleToggleContentWidth: () => void;
  handleToggleShowRawContent: () => void;
  handleScroll: () => void;
  handleDocumentTitleChange: (value: string) => void;
  handleOpenRelatedChat: (sessionId: string) => Promise<void>;
  handleRemoveRelatedChat: (sessionId: string) => Promise<void>;
}

export interface PageStageControllerDependencies {
  /** Flushes the primary owned Document through its durable provider. */
  readonly persistDocument?: () => Promise<void>;
}

interface PageStageMetadataSourceVersion {
  readonly pageId: string;
  readonly metadataRevision: number;
  readonly databaseMembershipId: string | null;
  readonly propertyVersion: string;
}

function readPageStageMetadataSourceVersion(
  pageModel: PageStagePageModel | null,
): PageStageMetadataSourceVersion | null {
  if (!pageModel) return null;

  const databaseContext = pageModel.databaseContext;
  return {
    pageId: pageModel.page.id,
    metadataRevision: pageModel.page.revision,
    databaseMembershipId: databaseContext.kind === "member" ? databaseContext.membership.id : null,
    propertyVersion:
      databaseContext.kind === "member"
        ? databaseContext.properties
            .map((item) =>
              [item.property.propertyId, item.property.revision, item.valueRevision].join(":"),
            )
            .join("|")
        : "standalone",
  };
}

function arePageStageMetadataSourceVersionsEqual(
  left: PageStageMetadataSourceVersion | null,
  right: PageStageMetadataSourceVersion | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;

  return (
    left.pageId === right.pageId &&
    left.metadataRevision === right.metadataRevision &&
    left.databaseMembershipId === right.databaseMembershipId &&
    left.propertyVersion === right.propertyVersion
  );
}

function buildPageStageSessionSnapshot(
  projectId: string | null,
  page: PageStageCorePage | null,
  title: string,
): PageStageSessionSnapshot | null {
  if (!page || projectId === null) return null;

  const titleSnapshot = title.trim() || page.title.trim() || page.id;
  return {
    projectId,
    pageId: page.id,
    titleSnapshot,
  };
}

function elementHasLayoutBox(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0;
}

export function usePageStageController(
  props: PageStageProps,
  dependencies: PageStageControllerDependencies = {},
): UsePageStageControllerResult {
  const {
    onClose,
    editorSessionKey,
    onLeavePage,
    closeRef,
    persistRef,
    sessionSnapshotRef,
    page: pageModel,
    contentAccessContext,
    onUpdate,
    onDelete,
    onCompleteOccurrence,
    onSkipOccurrence,
    relatedChats = [],
    relatedChatsLoading = false,
    relatedChatsError = null,
    relatedChatsHasMore = false,
    relatedChatsLoadingMore = false,
    relatedChatCandidates = [],
    sessionId = null,
    onOpenRelatedChat,
    onCreateRelatedChat,
    onLinkRelatedChat,
    onRemoveRelatedChat,
    onRetryRelatedChats,
    onLoadMoreRelatedChats,
    historyPanelActive = false,
    isActivePanelTab = true,
  } = props;
  const executionProjectId = projectIdFromContentAccessContext(contentAccessContext);
  const documentScopeKey = contentAccessContextKey(contentAccessContext);
  const page = pageModel?.page ?? null;
  const databaseSemantic =
    pageModel?.databaseContext.kind === "member"
      ? pageModel.databaseContext.semanticProperties
      : null;
  const databaseProperties = databaseSemantic ? pageStageSemanticValues(databaseSemantic) : null;
  const scheduleCapability = databaseSemantic
    ? hasPageStageScheduleCapability(databaseSemantic)
    : false;
  const persistDocument = dependencies.persistDocument;

  const [title, setTitle] = useState(page?.title ?? "");
  const [savingCount, setSavingCount] = useState(0);
  const saving = savingCount > 0;
  const [limitMainContentWidth, setLimitMainContentWidth] = useState(() =>
    readPageStageContentWidthPreference(),
  );
  const [showRawContent, setShowRawContent] = useState(() =>
    readPageStageShowRawContentPreference(),
  );
  const currentPageIdRef = useRef<string | null>(null);
  const appliedMetadataSourceVersionRef = useRef<PageStageMetadataSourceVersion | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastScrollRestorePageRef = useRef<string | null>(null);
  const scrollSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const previousActivePanelTabRef = useRef(isActivePanelTab);
  const lastKnownScrollTopRef = useRef<{ pageId: string; scrollTop: number } | null>(null);
  const scrollRestoreVersionRef = useRef(0);
  const beginSaving = useCallback(() => {
    let finished = false;
    setSavingCount((current) => current + 1);

    return () => {
      if (finished) return;
      finished = true;
      setSavingCount((current) => Math.max(0, current - 1));
    };
  }, []);

  const propertyControls = usePageStageProperties({
    pageModel,
    contentAccessContext,
    onUpdateProperty: props.onUpdateProperty,
    onOpenPage: props.onOpenPage,
    onRefreshProperties: props.onRefreshProperties,
    beginSaving,
  });

  const runUpdate = useCallback(
    async (
      nextPageId: string,
      updates: Partial<PageInput>,
    ): Promise<PageStageMetadataMutationResult> => {
      const result = await onUpdate(nextPageId, updates);
      if (!result) {
        return {
          status: "error",
          error: "Missing update result",
        };
      }
      return result;
    },
    [onUpdate],
  );
  const saveProperty = useCallback(
    (updates: Partial<PageInput>) => {
      if (!page) return;
      const endSaving = beginSaving();
      void runUpdate(page.id, updates).finally(endSaving);
    },
    [beginSaving, page, runUpdate],
  );

  const schedulePage =
    page && databaseProperties && scheduleCapability ? { ...page, ...databaseProperties } : null;
  const schedule = useScheduleState({
    page: schedulePage,
    saveProperty,
    onCompleteOccurrence: scheduleCapability ? onCompleteOccurrence : undefined,
    onSkipOccurrence: scheduleCapability ? onSkipOccurrence : undefined,
  });
  const applyRecurrenceState = schedule.applyRecurrenceState;
  const applyScheduleState = schedule.applyScheduleState;

  const rememberScrollTopForPage = useCallback(
    (pageId: string | null, scrollTop: number) => {
      if (!pageId) return;
      lastKnownScrollTopRef.current = { pageId, scrollTop };
      rememberScrollPosition(documentScopeKey, pageId, scrollTop, editorSessionKey);
    },
    [documentScopeKey, editorSessionKey],
  );

  const saveScrollTopForPage = useCallback(
    (pageId: string | null, scrollTop: number) => {
      if (!pageId) return;
      lastKnownScrollTopRef.current = { pageId, scrollTop };
      saveScrollPosition(documentScopeKey, pageId, scrollTop, editorSessionKey);
    },
    [documentScopeKey, editorSessionKey],
  );

  const readCurrentScrollTopForPage = useCallback(
    (pageId: string, element: HTMLDivElement | null) => {
      if (element && elementHasLayoutBox(element)) {
        return element.scrollTop;
      }

      const lastKnown = lastKnownScrollTopRef.current;
      if (lastKnown?.pageId === pageId) return lastKnown.scrollTop;
      if (element && element.scrollTop > 0) return element.scrollTop;
      return null;
    },
    [],
  );

  const saveCurrentScrollPosition = useCallback(() => {
    const pageId = currentPageIdRef.current;
    const element = scrollContainerRef.current;
    if (!pageId) return;
    const scrollTop = readCurrentScrollTopForPage(pageId, element);
    if (scrollTop === null) return;
    saveScrollTopForPage(pageId, scrollTop);
  }, [readCurrentScrollTopForPage, saveScrollTopForPage]);

  const restoreScrollPositionForPage = useCallback(
    (pageId: string, options: { resetWhenMissing: boolean }) => {
      const element = scrollContainerRef.current;
      if (!element) return;

      scrollRestoreVersionRef.current += 1;
      const restoreVersion = scrollRestoreVersionRef.current;
      const saved = loadScrollPosition(documentScopeKey, pageId, editorSessionKey);
      if (saved === null) {
        if (options.resetWhenMissing) element.scrollTop = 0;
        return;
      }

      element.scrollTop = saved;
      lastKnownScrollTopRef.current = { pageId, scrollTop: saved };

      if (typeof requestAnimationFrame !== "function") return;
      let remainingFrames = 2;
      const retryRestore = () => {
        if (scrollRestoreVersionRef.current !== restoreVersion) return;
        const currentPageId = currentPageIdRef.current;
        if (currentPageId !== null && currentPageId !== pageId) return;
        const currentElement = scrollContainerRef.current;
        if (!currentElement) return;
        currentElement.scrollTop = saved;
        lastKnownScrollTopRef.current = { pageId, scrollTop: saved };
        remainingFrames -= 1;
        if (remainingFrames > 0) requestAnimationFrame(retryRestore);
      };
      requestAnimationFrame(retryRestore);
    },
    [documentScopeKey, editorSessionKey],
  );

  const setScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      const previousNode = scrollContainerRef.current;
      if (previousNode && previousNode !== node) {
        saveCurrentScrollPosition();
      }

      scrollContainerRef.current = node;
      const pageId = currentPageIdRef.current;
      if (!node || !pageId) return;
      restoreScrollPositionForPage(pageId, { resetWhenMissing: false });
    },
    [restoreScrollPositionForPage, saveCurrentScrollPosition],
  );

  useEffect(() => {
    const pageId = page?.id ?? null;
    const metadataSourceVersion = readPageStageMetadataSourceVersion(pageModel);
    const prevPageId = currentPageIdRef.current;
    if (
      pageId === prevPageId &&
      arePageStageMetadataSourceVersionsEqual(
        appliedMetadataSourceVersionRef.current,
        metadataSourceVersion,
      )
    )
      return;

    if (prevPageId && prevPageId !== pageId) {
      const scrollTop = readCurrentScrollTopForPage(prevPageId, scrollContainerRef.current);
      if (scrollTop !== null) saveScrollTopForPage(prevPageId, scrollTop);
    }

    currentPageIdRef.current = pageId;
    appliedMetadataSourceVersionRef.current = metadataSourceVersion;

    if (page) {
      setTitle(page.title);
      if (databaseProperties && scheduleCapability) {
        const schedulePage = { ...page, ...databaseProperties };
        applyScheduleState(schedulePage);
        applyRecurrenceState(schedulePage);
      }
      return;
    }
  }, [
    page,
    pageModel,
    databaseProperties,
    scheduleCapability,
    readCurrentScrollTopForPage,
    saveScrollTopForPage,
    applyRecurrenceState,
    applyScheduleState,
  ]);

  useLayoutEffect(() => {
    const pageId = page?.id ?? null;
    if (!pageId) return;

    const resetWhenMissing = lastScrollRestorePageRef.current !== pageId;
    lastScrollRestorePageRef.current = pageId;
    restoreScrollPositionForPage(pageId, { resetWhenMissing });
  }, [page?.id, restoreScrollPositionForPage]);

  const handleScroll = useCallback(() => {
    const pageId = currentPageIdRef.current;
    const element = scrollContainerRef.current;
    if (!pageId || !element) return;

    const scrollTop = element.scrollTop;
    rememberScrollTopForPage(pageId, scrollTop);
    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = setTimeout(() => {
      saveScrollTopForPage(pageId, scrollTop);
      scrollSaveTimerRef.current = null;
    }, SCROLL_SAVE_DEBOUNCE_MS);
  }, [rememberScrollTopForPage, saveScrollTopForPage]);

  useLayoutEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      saveCurrentScrollPosition();
    };
  }, [saveCurrentScrollPosition]);

  const handleDocumentTitleChange = useCallback((value: string) => {
    setTitle(value);
  }, []);

  const handlePersist = useCallback(async () => {
    saveCurrentScrollPosition();
    await (persistDocument?.() ?? Promise.resolve());
  }, [persistDocument, saveCurrentScrollPosition]);

  const handleClose = useCallback(async () => {
    await handlePersist();
    const sessionSnapshot = buildPageStageSessionSnapshot(executionProjectId, page, title);
    if (sessionSnapshot) {
      onLeavePage?.(sessionSnapshot);
    }
    onClose();
  }, [executionProjectId, handlePersist, onClose, onLeavePage, page, title]);

  useEffect(() => {
    if (!closeRef || !isActivePanelTab) return;
    closeRef.current = handleClose;
    return () => {
      if (closeRef.current === handleClose) {
        closeRef.current = null;
      }
    };
  }, [closeRef, handleClose, isActivePanelTab]);

  useEffect(() => {
    if (!persistRef || !isActivePanelTab) return;
    persistRef.current = handlePersist;
    return () => {
      if (persistRef.current === handlePersist) {
        persistRef.current = null;
      }
    };
  }, [persistRef, handlePersist, isActivePanelTab]);

  useEffect(() => {
    if (!sessionSnapshotRef || !isActivePanelTab) return;
    const snapshot = buildPageStageSessionSnapshot(executionProjectId, page, title);
    sessionSnapshotRef.current = snapshot;
    return () => {
      if (sessionSnapshotRef.current === snapshot) {
        sessionSnapshotRef.current = null;
      }
    };
  }, [executionProjectId, isActivePanelTab, page, sessionSnapshotRef, title]);

  useEffect(() => {
    const wasActive = previousActivePanelTabRef.current;
    previousActivePanelTabRef.current = isActivePanelTab;
    if (!wasActive || isActivePanelTab) return;
    void handlePersist();
  }, [handlePersist, isActivePanelTab]);

  const handleDelete = useCallback(async () => {
    if (!page || !onDelete) return;
    const endSaving = beginSaving();
    try {
      await onDelete(page.id);
      onClose();
    } finally {
      endSaving();
    }
  }, [beginSaving, page, onDelete, onClose]);

  const handleOpenRelatedChat = useCallback(
    async (sessionId: string) => {
      if (!onOpenRelatedChat) return;
      const endSaving = beginSaving();
      try {
        await onOpenRelatedChat(sessionId);
      } finally {
        endSaving();
      }
    },
    [beginSaving, onOpenRelatedChat],
  );

  const handleRemoveRelatedChat = useCallback(
    async (sessionId: string) => {
      if (!onRemoveRelatedChat) return;
      const endSaving = beginSaving();
      try {
        await onRemoveRelatedChat(sessionId);
      } finally {
        endSaving();
      }
    },
    [beginSaving, onRemoveRelatedChat],
  );

  const handleToggleContentWidth = useCallback(() => {
    setLimitMainContentWidth((current) => {
      const next = !current;
      writePageStageContentWidthPreference(next);
      return next;
    });
  }, []);

  const handleToggleShowRawContent = useCallback(() => {
    setShowRawContent((current) => {
      const next = !current;
      writePageStageShowRawContentPreference(next);
      return next;
    });
  }, []);

  const hasRelatedChatsRow =
    relatedChats.length > 0 ||
    relatedChatsLoading ||
    Boolean(relatedChatsError) ||
    Boolean(onCreateRelatedChat) ||
    Boolean(onLinkRelatedChat);

  const contentBodyClassName = [
    "mx-auto w-full px-(--page-stage-body-gutter-inline)",
    limitMainContentWidth ? "max-w-(--page-stage-body-max-width)" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const contentShellClassName = "w-full";

  return {
    page,
    contentAccessContext,
    storeEpoch: props.documentAuthority.descriptor.storeEpoch,
    hasDatabaseProperties: propertyControls.properties.length > 0,
    propertyControls,
    title,
    saving,
    limitMainContentWidth,
    showRawContent,
    historyPanelActive,
    relatedChats,
    relatedChatsLoading,
    relatedChatsError,
    relatedChatsHasMore,
    relatedChatsLoadingMore,
    relatedChatCandidates,
    hasRelatedChatsRow,
    currentSessionId: sessionId,
    contentBodyClassName,
    contentShellClassName,
    scrollContainerRef,
    setScrollContainerRef,
    schedule,
    schedulePage,
    onCreateRelatedChat,
    onLinkRelatedChat,
    onOpenRelatedChat,
    onRemoveRelatedChat,
    onRetryRelatedChats,
    onLoadMoreRelatedChats,
    handleClose,
    handleDelete,
    handleToggleContentWidth,
    handleToggleShowRawContent,
    handleScroll,
    handleDocumentTitleChange,
    handleOpenRelatedChat,
    handleRemoveRelatedChat,
  };
}

export type PageStageController = UsePageStageControllerResult;
