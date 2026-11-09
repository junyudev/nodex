import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  readPageStageContentWidthPreference,
  readPageStageShowRawContentPreference,
  writePageStageContentWidthPreference,
  writePageStageShowRawContentPreference,
} from "@/lib/page-stage-layout";
import type { PageInput } from "@/lib/types";
import type { PageStagePageModel, PageStageCorePage } from "@/lib/page-stage-page";
import {
  hasPageStageScheduleCapability,
  pageStageSemanticValues,
} from "@/lib/page-stage-properties";
import { useScheduleState, type PageScheduleSource } from "@/lib/use-schedule-state";
import {
  projectIdFromContentRoutingContext,
  type ContentRoutingContext,
} from "../../../../shared/content-routing-context";
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
  contentRoutingContext: ContentRoutingContext;
  propertyControls: PageStagePropertyControls;
  savePage: (updates: Partial<PageInput>) => void;
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
  schedule: ReturnType<typeof useScheduleState>;
  schedulePage: PageScheduleSource | null;
  onCreateRelatedChat?: () => Promise<void> | void;
  onLinkRelatedChat?: (sessionId: string) => Promise<void>;
  onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  onRemoveRelatedChat?: (sessionId: string) => Promise<void>;
  onRetryRelatedChats?: () => Promise<void> | void;
  onLoadMoreRelatedChats?: () => Promise<void> | void;
  openPageFile?: PageStageProps["onOpenPageFile"];
  handleClose: () => Promise<void>;
  handleDelete: () => Promise<void>;
  handleToggleContentWidth: () => void;
  handleToggleShowRawContent: () => void;
  handleDocumentTitleChange: (value: string) => void;
  handleOpenRelatedChat: (sessionId: string) => Promise<void>;
  handleRemoveRelatedChat: (sessionId: string) => Promise<void>;
}

export interface PageStageControllerDependencies {
  /** Flushes the primary owned Document through its durable provider. */
  readonly persistDocument?: () => Promise<void>;
  /** Flushes the PageTab-owned presentation snapshot without blocking Document persistence. */
  readonly persistViewport?: () => void;
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

/** Keep each saving claim until its command settles, including synchronous rejection. */
async function runPageStageSavingCommand(
  beginSaving: () => () => void,
  command: () => void | Promise<void>,
): Promise<void> {
  const endSaving = beginSaving();
  try {
    await command();
  } finally {
    endSaving();
  }
}

export function usePageStageController(
  props: PageStageProps,
  dependencies: PageStageControllerDependencies = {},
): UsePageStageControllerResult {
  const {
    onClose,
    onLeavePage,
    closeRef,
    persistRef,
    sessionSnapshotRef,
    page: pageModel,
    contentRoutingContext,
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
  const executionProjectId = projectIdFromContentRoutingContext(contentRoutingContext);
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
  const persistViewport = dependencies.persistViewport;

  const [title, setTitle] = useState(page?.title ?? "");
  const [savingCount, setSavingCount] = useState(0);
  const saving = savingCount > 0;
  const [limitMainContentWidth, setLimitMainContentWidth] = useState(() =>
    readPageStageContentWidthPreference(),
  );
  const [showRawContent, setShowRawContent] = useState(() =>
    readPageStageShowRawContentPreference(),
  );
  const [appliedMetadataSourceVersion, setAppliedMetadataSourceVersion] =
    useState<PageStageMetadataSourceVersion | null>(null);
  const previousActivePanelTabRef = useRef(isActivePanelTab);
  const beginSaving = () => {
    let finished = false;
    setSavingCount((current) => current + 1);

    return () => {
      if (finished) return;
      finished = true;
      setSavingCount((current) => Math.max(0, current - 1));
    };
  };

  const propertyControls = usePageStageProperties({
    pageModel,
    contentRoutingContext,
    onUpdateProperty: props.onUpdateProperty,
    onOpenPage: props.onOpenPage,
    onRefreshProperties: props.onRefreshProperties,
    beginSaving,
  });

  const runUpdate = async (
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
  };
  const saveProperty = (updates: Partial<PageInput>) => {
    if (!page) return;
    const endSaving = beginSaving();
    void runUpdate(page.id, updates).finally(endSaving);
  };

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

  const metadataSourceVersion = readPageStageMetadataSourceVersion(pageModel);
  if (
    !arePageStageMetadataSourceVersionsEqual(appliedMetadataSourceVersion, metadataSourceVersion)
  ) {
    setAppliedMetadataSourceVersion(metadataSourceVersion);
    if (page) {
      setTitle(page.title);
      if (schedulePage) {
        applyScheduleState(schedulePage);
        applyRecurrenceState(schedulePage);
      }
    }
  }

  const handleDocumentTitleChange = (value: string) => {
    setTitle(value);
  };

  const handlePersist = async () => {
    persistViewport?.();
    await (persistDocument?.() ?? Promise.resolve());
  };

  const handleClose = async () => {
    await handlePersist();
    const sessionSnapshot = buildPageStageSessionSnapshot(executionProjectId, page, title);
    if (sessionSnapshot) {
      onLeavePage?.(sessionSnapshot);
    }
    onClose();
  };

  const closeFromRegistration = useEffectEvent(handleClose);
  const persistFromRegistration = useEffectEvent(handlePersist);
  useEffect(() => {
    if (!closeRef || !isActivePanelTab) return;
    const close = () => closeFromRegistration();
    closeRef.current = close;
    return () => {
      if (closeRef.current === close) {
        closeRef.current = null;
      }
    };
  }, [closeRef, isActivePanelTab]);

  useEffect(() => {
    if (!persistRef || !isActivePanelTab) return;
    const persist = () => persistFromRegistration();
    persistRef.current = persist;
    return () => {
      if (persistRef.current === persist) {
        persistRef.current = null;
      }
    };
  }, [persistRef, isActivePanelTab]);

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
    void persistFromRegistration();
  }, [isActivePanelTab]);

  const handleDelete = async () => {
    if (!page || !onDelete) return;
    return runPageStageSavingCommand(beginSaving, async () => {
      await onDelete(page.id);
      onClose();
    });
  };

  const handleOpenRelatedChat = async (sessionId: string) => {
    if (!onOpenRelatedChat) return;
    return runPageStageSavingCommand(beginSaving, () => onOpenRelatedChat(sessionId));
  };

  const handleRemoveRelatedChat = async (sessionId: string) => {
    if (!onRemoveRelatedChat) return;
    return runPageStageSavingCommand(beginSaving, () => onRemoveRelatedChat(sessionId));
  };

  const handleToggleContentWidth = () => {
    setLimitMainContentWidth((current) => {
      const next = !current;
      writePageStageContentWidthPreference(next);
      return next;
    });
  };

  const handleToggleShowRawContent = () => {
    setShowRawContent((current) => {
      const next = !current;
      writePageStageShowRawContentPreference(next);
      return next;
    });
  };

  const hasRelatedChatsRow =
    relatedChats.length > 0 ||
    relatedChatsLoading ||
    Boolean(relatedChatsError) ||
    Boolean(onCreateRelatedChat) ||
    Boolean(onLinkRelatedChat);

  return {
    page,
    contentRoutingContext,
    propertyControls,
    /** Saves Page metadata outside Source Properties, such as its Agent work. */
    savePage: saveProperty,
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
    schedule,
    schedulePage,
    onCreateRelatedChat,
    onLinkRelatedChat,
    onOpenRelatedChat,
    onRemoveRelatedChat,
    onRetryRelatedChats,
    onLoadMoreRelatedChats,
    openPageFile: props.onOpenPageFile,
    handleClose,
    handleDelete,
    handleToggleContentWidth,
    handleToggleShowRawContent,
    handleDocumentTitleChange,
    handleOpenRelatedChat,
    handleRemoveRelatedChat,
  };
}

export type PageStageController = UsePageStageControllerResult;
