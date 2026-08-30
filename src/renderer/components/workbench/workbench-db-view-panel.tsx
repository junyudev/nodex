import { CanvasIcon, BoardIcon, DatabaseIcon, PlusIcon } from "@/components/shared/icons";
import { SlidersHorizontal } from "@/components/shared/icons/generic-icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { NodexIconButton } from "@/components/ui/button";
import type { WorkbenchTabProjection } from "@/lib/types";
import { useBoard, type DatabaseViewBoardPageDropIntent } from "@/lib/use-board";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import type {
  DatabaseViewConditionalColorRule,
  DatabaseViewField,
  DatabaseViewLayout,
  DatabaseViewRules,
  EffectiveDatabaseView,
} from "../../../shared/database-kernel";
import {
  compactDatabaseViewPresentationOverride,
  compactDatabaseViewRulesOverride,
  resolveEffectiveDatabaseView,
} from "../../../shared/database-view-presentation";
import {
  clearDatabaseViewRulesOverrideScope,
  effectiveDatabaseViewFilter,
  type DatabaseViewRuleScope,
} from "../../../shared/database-view-rules";
import { useDatabaseViewRulesController } from "@/lib/use-database-view-rules-controller";
import type { ColumnPaginationState } from "@/lib/board-store";
import type {
  DatabaseViewDisclosureTargetV2,
  DatabaseViewRecordV2,
} from "../../../shared/database-module-v2";
import { DbViewToolbar, type DbViewToolbarItem } from "./db-view-toolbar";
import { DatabaseViewSurface } from "./database-view-surface";
import { DatabaseList } from "./database-list/database-list";
import { DatabaseViewRulesBar, DatabaseViewRuleToolbarControls } from "./database-view-rules-bar";
import { usePropertyOptionRegistries } from "@/components/database/use-property-option-registries";
import { collectRequiredPropertyOptionIds } from "@/lib/database-option-registry-requirements";
import { useDatabaseViewPersonalPreference } from "@/lib/database-view-personal-preferences";
import { resolveDatabaseViewPresentationActivity } from "@/lib/database-view-presentation-activity";
import { useWorkbenchProfilePreferences } from "@/lib/use-workbench-profile-preferences";
import { commitDatabaseViewOperations } from "@/lib/database-view-row-mutations";
import {
  duplicateDatabaseViewOperation,
  reorderDatabaseViewOperation,
} from "@/lib/database-settings-operations";
import { writeTextToClipboard } from "@/lib/clipboard";
import type { OpenPageTabHandler } from "./workbench-page-stage-panel";
import { primaryCanvasBlockId } from "../../../shared/block-documents";
import type { OpenCanvasStageHandler } from "@/lib/use-workbench-panel-openers";
import { supportedDatabaseIntrinsicFields } from "@/lib/database-intrinsic-field-registry";
import type { Project } from "@/lib/types";
import type { OpenPageInNewChatInput, SendPageToChatInput } from "@/lib/page-chat-actions";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { materializePageCreateTarget } from "@/lib/page-create-target";
import {
  markPageCreateTargetActive,
  registerPageCreateTarget,
  unregisterPageCreateTarget,
} from "@/lib/page-create-target-registry";
import { requestPageCreate } from "@/lib/page-create-workflow";
import { toast } from "@/components/ui/toast";
import { isWorkflowStatus } from "../../../shared/workflow-status";
import {
  useDatabaseViewMutationHistory,
  type DatabaseViewMutationHistory,
} from "./database-view-mutation-history";
import type { DatabaseViewPageActionPort } from "./database-view-page-actions";
import type { DatabaseViewPageOpenHandler } from "./database-view-page-open";
import {
  DatabasePageChatActivityBoundary,
  useDatabasePageChatActivityRuntime,
} from "./database-page-chat-activity-runtime";
import { useDatabaseSettingsRuntime } from "./database-settings/use-database-settings-runtime";
import { DatabaseSettingsRail } from "./database-settings/database-settings-rail";
import {
  backDatabaseSettingsRoute,
  openDatabaseSettingsRoute,
  pushDatabaseSettingsRoute,
  reconcileDatabaseSettingsRouteStack,
  replaceDatabaseSettingsRoute,
  type DatabaseSettingsRoute,
  type DatabaseSettingsRouteStack,
} from "./database-settings/database-settings-route";
import { parseDatabaseId, parseDatabaseViewId } from "../../../shared/database-identities";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { serializeNfm } from "../../../shared/nfm";
import { DatabaseViewDeleteConfirmationDialog } from "./database-view-action-menu";

const databaseViewLayoutIcon = (
  layout: DatabaseViewLayout,
): ComponentType<{ className?: string }> => (layout === "board" ? BoardIcon : DatabaseIcon);

const EMPTY_DATABASE_PROPERTIES = [] as const;
const EMPTY_DATABASE_VIEW_RULES: DatabaseViewRules = Object.freeze({
  propertyFilters: [],
  advancedFilter: null,
  sorts: [],
});

const durableDatabaseToolbarItem = (
  model: DatabaseViewRenderModel,
  presentationLayout: DatabaseViewLayout = model.query.view.layout,
): DbViewToolbarItem => {
  const presentationId = presentationLayout;
  return {
    id: model.databaseViewId,
    label: model.viewName,
    icon: databaseViewLayoutIcon(presentationId),
    active: true,
    onSelect: () => undefined,
  };
};

export function DatabaseViewTabSurface({
  ...props
}: Parameters<typeof DatabaseViewTabSurfaceContent>[0]) {
  return (
    <DatabasePageChatActivityBoundary model={props.model}>
      <DatabaseViewTabSurfaceContent {...props} />
    </DatabasePageChatActivityBoundary>
  );
}

function DatabaseViewTabSurfaceContent({
  model,
  presentationLayout = model.query.view.layout,
  effectivePresentation,
  toolbarItems,
  destinationItems,
  groupPagination,
  onLoadMoreGroup,
  activeSearchQuery,
  taskSearchOpen,
  searchShortcutLabel,
  taskSearchInputRef,
  managementControl,
  databaseViewControls,
  rulesBar,
  overlay,
  settingsRail,
  onSearchQueryChange,
  onOpenTaskSearch,
  onCloseTaskSearch,
  onReorderViews,
  onOpenPage,
  pageActionPort,
  onCommitted,
  onMoveBoardPages,
  keyboardSurface,
  presentedPageIds,
  initialSelectedPageIds,
  onSelectedPageIdsChange,
  collapsedOccurrenceKeys,
  onOccurrenceDisclosureChange,
  forcedDisplayField,
  pageCreateSurfaceId,
  onRequestCreatePage,
  mutationHistory: providedMutationHistory,
}: {
  readonly model: DatabaseViewRenderModel;
  readonly presentationLayout?: DatabaseViewLayout;
  readonly effectivePresentation?: EffectiveDatabaseView;
  readonly toolbarItems?: DbViewToolbarItem[];
  readonly destinationItems?: DbViewToolbarItem[];
  readonly groupPagination?: ReadonlyMap<string, ColumnPaginationState>;
  readonly onLoadMoreGroup?: (scopeKey: string) => Promise<void> | void;
  readonly activeSearchQuery: string;
  readonly taskSearchOpen: boolean;
  readonly searchShortcutLabel: string;
  readonly taskSearchInputRef: RefObject<HTMLInputElement | null>;
  readonly managementControl?: ReactNode;
  readonly databaseViewControls?: ReactNode;
  readonly rulesBar?: ReactNode;
  readonly overlay?: ReactNode;
  readonly settingsRail?: ReactNode;
  readonly onSearchQueryChange: (value: string) => void;
  readonly onOpenTaskSearch: (selectQuery?: boolean) => void;
  readonly onCloseTaskSearch: () => void;
  readonly onReorderViews?: (
    movedViewId: string,
    orderedViewIds: readonly string[],
  ) => boolean | Promise<boolean>;
  readonly onOpenPage: DatabaseViewPageOpenHandler;
  readonly pageActionPort?: DatabaseViewPageActionPort;
  readonly onCommitted?: () => void | Promise<void>;
  readonly onMoveBoardPages?: (input: DatabaseViewBoardPageDropIntent) => Promise<boolean>;
  readonly keyboardSurface?: {
    readonly surfaceId: string;
    readonly presentationId: string;
  };
  readonly presentedPageIds?: ReadonlySet<string>;
  readonly initialSelectedPageIds?: ReadonlySet<string>;
  readonly onSelectedPageIdsChange?: (pageIds: ReadonlySet<string>) => void;
  readonly collapsedOccurrenceKeys?: readonly string[];
  readonly onOccurrenceDisclosureChange?: (
    target: DatabaseViewDisclosureTargetV2,
    collapsed: boolean,
  ) => void;
  readonly forcedDisplayField?: DatabaseViewField | null;
  readonly pageCreateSurfaceId?: string;
  readonly onRequestCreatePage?: (groupKey: string) => void;
  readonly mutationHistory?: DatabaseViewMutationHistory;
}) {
  const pageChatRuntime = useDatabasePageChatActivityRuntime();
  const localMutationHistory = useDatabaseViewMutationHistory(
    `${model.storeEpoch}:${model.databaseViewId}`,
  );
  const mutationHistory = providedMutationHistory ?? localMutationHistory;
  const presentation = effectivePresentation ?? {
    layout: presentationLayout,
    rules: model.query.view.config.rules,
    presentation: model.query.view.config.presentation,
  };
  const activeToolbarItems = toolbarItems ?? [
    durableDatabaseToolbarItem(model, presentation.layout),
  ];
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-token-main-surface-primary">
      <DbViewToolbar
        items={activeToolbarItems}
        destinationItems={destinationItems}
        activeSearchQuery={activeSearchQuery}
        taskSearchOpen={taskSearchOpen}
        showSearchControls
        searchShortcutLabel={searchShortcutLabel}
        taskSearchInputRef={taskSearchInputRef}
        managementControl={managementControl}
        databaseViewControls={databaseViewControls}
        onSearchQueryChange={onSearchQueryChange}
        onOpenTaskSearch={onOpenTaskSearch}
        onCloseTaskSearch={onCloseTaskSearch}
        onReorderViews={onReorderViews}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {rulesBar}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {overlay}
            {presentation.layout === "list" ? (
              <DatabaseList
                model={model}
                effectivePresentation={presentation}
                groupPagination={groupPagination}
                onLoadMoreGroup={onLoadMoreGroup}
                searchQuery={activeSearchQuery}
                onOpenPage={onOpenPage}
                pageActionPort={pageActionPort}
                onCommitted={onCommitted}
                presentedPageIds={presentedPageIds}
                initialSelectedPageIds={initialSelectedPageIds}
                onSelectedPageIdsChange={onSelectedPageIdsChange}
                collapsedOccurrenceKeys={collapsedOccurrenceKeys}
                onOccurrenceDisclosureChange={onOccurrenceDisclosureChange}
                forcedDisplayField={forcedDisplayField}
                pageCreateSurfaceId={pageCreateSurfaceId}
                onRequestCreatePage={onRequestCreatePage}
                scrollStateKey={`database-view:${model.databaseViewId}:list`}
                mutationHistory={mutationHistory}
                pageChatActivityByPageId={pageChatRuntime.activityByPageId}
                onRemovePageChatRelation={pageChatRuntime.removeRelation}
              />
            ) : (
              <DatabaseViewSurface
                model={model}
                effectivePresentation={presentation}
                groupPagination={groupPagination}
                onLoadMoreGroup={onLoadMoreGroup}
                searchQuery={activeSearchQuery}
                onOpenPage={onOpenPage}
                pageActionPort={pageActionPort}
                onCommitted={onCommitted}
                onMoveBoardPages={onMoveBoardPages}
                keyboardSurface={keyboardSurface}
                presentedPageIds={presentedPageIds}
                initialSelectedPageIds={initialSelectedPageIds}
                onSelectedPageIdsChange={onSelectedPageIdsChange}
                pageCreateSurfaceId={pageCreateSurfaceId}
                onRequestCreatePage={onRequestCreatePage}
                mutationHistory={mutationHistory}
              />
            )}
          </div>
        </div>
        {settingsRail}
      </div>
    </div>
  );
}

export function DbViewSessionTab({
  sessionId,
  tab,
  projects,
  activeSearchQuery,
  searchByProject,
  presentedPageIds,
  taskSearchOpenTick,
  setSearchQuery,
  onOpenPageTab,
  onOpenPageInNewChat,
  onOpenRelatedChat,
  onSendPageToChat,
  onOpenCanvasStage,
  onSelectDatabaseView,
  targetLeafId,
}: {
  readonly sessionId: string;
  readonly tab: WorkbenchTabProjection;
  readonly projects: Project[];
  readonly activeSearchQuery: string;
  readonly searchByProject: Readonly<Record<string, string>>;
  readonly presentedPageIds: ReadonlySet<string>;
  readonly pageStageCloseRef: RefObject<(() => Promise<void>) | null>;
  readonly taskSearchOpenTick: number;
  readonly setSearchQuery: (projectId: string, value: string) => void;
  readonly onOpenPageTab: OpenPageTabHandler;
  readonly onOpenPageInNewChat?: (input: OpenPageInNewChatInput) => Promise<void> | void;
  readonly onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  readonly onSendPageToChat?: (input: SendPageToChatInput) => Promise<void> | void;
  readonly onOpenCanvasStage: OpenCanvasStageHandler;
  readonly onSelectDatabaseView?: (viewId: string, title: string) => void;
  readonly targetLeafId: string;
}) {
  if (tab.kind !== "db_view") {
    throw new Error("Database view tabs require a db_view descriptor");
  }
  const { projectId, databaseViewId } = tab.config;
  const appHandle = useScopeHandle(appScope);
  const surfaceId = `database-view:${sessionId}:${tab.id}:${databaseViewId}`;
  const listClientSessionId = `${tab.id}:database-view`;
  const [listPageCreateRegistrationToken] = useState(() => crypto.randomUUID());
  const personalPreference = useDatabaseViewPersonalPreference(projectId, String(databaseViewId));
  const { databaseViewTabs, setDatabaseViewTabDisplayMode, setDatabaseViewRuleBarOpen } =
    useWorkbenchProfilePreferences();
  const presentationOverride = personalPreference.presentationOverride;
  const rulesOverride = personalPreference.rulesOverride;
  const synchronizePreferenceStoreEpoch = personalPreference.synchronizeStoreEpoch;
  const runtime = useBoard({
    projectId,
    databaseViewId,
    sessionId: listClientSessionId,
    presentationOverride,
    rulesOverride,
    presentationOverrideReady: !personalPreference.loading,
    enabled: !personalPreference.loading,
  });
  const databaseView = runtime.databaseView;
  const settings = useDatabaseSettingsRuntime({
    projectId,
    databaseId: databaseView?.databaseId ?? null,
    activeViewId: String(databaseViewId),
  });
  const mutationHistory = useDatabaseViewMutationHistory(
    `${databaseView?.storeEpoch ?? "pending"}:${databaseViewId}`,
  );
  const [publishingPresentation, setPublishingPresentation] = useState(false);
  const [rulePublishError, setRulePublishError] = useState<string | null>(null);
  const [conditionalColorPreview, setConditionalColorPreview] = useState<{
    readonly viewId: string;
    readonly rules: readonly DatabaseViewConditionalColorRule[];
  } | null>(null);
  const presentationActivity = resolveDatabaseViewPresentationActivity({
    loading: personalPreference.loading,
    saving: personalPreference.saving,
    publishing: publishingPresentation,
  });
  const [taskSearchOpen, setTaskSearchOpen] = useState(false);
  const [settingsRouteStack, setSettingsRouteStack] = useState<DatabaseSettingsRouteStack | null>(
    null,
  );
  const [viewNameFocusRequest, setViewNameFocusRequest] = useState(0);
  const [deleteViewRequest, setDeleteViewRequest] = useState<{
    readonly viewId: string;
    readonly viewName: string;
  } | null>(null);
  const settingsTriggerRef = useRef<HTMLDivElement | null>(null);
  const previousSettingsOwnerRef = useRef<{
    viewId: ReturnType<typeof parseDatabaseViewId>;
    dataSourceId: DatabaseViewRenderModel["dataSourceId"];
  } | null>(null);
  const ruleOptionRequirements = useMemo(
    () =>
      databaseView
        ? collectRequiredPropertyOptionIds({
            properties: databaseView.query.properties,
            rows: databaseView.query.rows,
            filter: effectiveDatabaseViewFilter(databaseView.query.view.config.rules),
          })
        : {},
    [databaseView],
  );
  const ruleOptionRegistries = usePropertyOptionRegistries({
    accessContext: databaseView?.accessContext ?? { kind: "project", projectId },
    properties: databaseView?.query.properties ?? EMPTY_DATABASE_PROPERTIES,
    requiredOptionIds: ruleOptionRequirements,
  });
  const [selectedPageIds, setSelectedPageIds] = useState<ReadonlySet<string>>(() => new Set());
  const taskSearchInputRef = useRef<HTMLInputElement | null>(null);
  const lastHandledTaskSearchOpenTickRef = useRef(taskSearchOpenTick);
  const searchQuery =
    searchByProject[projectId] ?? (projectId === tab.projectId ? activeSearchQuery : "");
  const presentationCapabilities = useMemo(
    () => ({
      properties:
        databaseView?.query.properties.map((property) => ({
          propertyId: property.propertyId,
          sortable: property.capabilities.sortable,
          groupable: property.capabilities.groupable,
          finite: property.valueType === "select" || property.valueType === "checkbox",
        })) ?? [],
      intrinsicFields: supportedDatabaseIntrinsicFields(),
      ...(databaseView?.query.properties.some((property) => property.propertyId === "status")
        ? { taskStatusPropertyId: "status" }
        : {}),
    }),
    [databaseView],
  );
  const durableEffectivePresentation = useMemo(
    () =>
      databaseView
        ? resolveEffectiveDatabaseView(
            databaseView.query.view.layout,
            databaseView.query.view.config.presentation,
            undefined,
            presentationCapabilities,
            databaseView.query.view.config.rules,
          )
        : null,
    [databaseView, presentationCapabilities],
  );
  const resolvedEffectivePresentation = useMemo(
    () =>
      databaseView
        ? resolveEffectiveDatabaseView(
            databaseView.query.view.layout,
            databaseView.query.view.config.presentation,
            presentationOverride,
            presentationCapabilities,
            databaseView.query.view.config.rules,
            rulesOverride,
          )
        : null,
    [databaseView, presentationCapabilities, presentationOverride, rulesOverride],
  );
  const effectivePresentation = useMemo(() => {
    if (
      !resolvedEffectivePresentation ||
      conditionalColorPreview?.viewId !== String(databaseViewId)
    ) {
      return resolvedEffectivePresentation;
    }
    return {
      ...resolvedEffectivePresentation,
      presentation: {
        ...resolvedEffectivePresentation.presentation,
        conditionalColors: conditionalColorPreview.rules,
      },
    };
  }, [conditionalColorPreview, databaseViewId, resolvedEffectivePresentation]);
  const effectiveFilter = effectivePresentation
    ? effectiveDatabaseViewFilter(effectivePresentation.rules)
    : null;
  const currentProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projectId, projects],
  );
  const listPageCreateTarget = useMemo(
    () =>
      currentProject
        ? materializePageCreateTarget({
            surfaceId,
            panelTabId: tab.id,
            project: currentProject,
            databaseView,
            board: runtime.board,
            clientSessionId: listClientSessionId,
          })
        : null,
    [currentProject, databaseView, listClientSessionId, runtime.board, surfaceId, tab.id],
  );
  useEffect(() => {
    if (!listPageCreateTarget) {
      unregisterPageCreateTarget(appHandle, surfaceId, listPageCreateRegistrationToken);
      return;
    }
    registerPageCreateTarget(appHandle, listPageCreateRegistrationToken, listPageCreateTarget);
    return () => unregisterPageCreateTarget(appHandle, surfaceId, listPageCreateRegistrationToken);
  }, [
    appHandle,
    effectivePresentation?.layout,
    listPageCreateRegistrationToken,
    listPageCreateTarget,
    surfaceId,
  ]);
  const requestListPageCreate = useCallback(
    (groupKey: string) => {
      if (!isWorkflowStatus(groupKey)) return;
      if (!listPageCreateTarget) {
        toast.danger("Page creation is unavailable until the Project is loaded.");
        return;
      }
      if (listPageCreateTarget.readOnlyReason) {
        toast.danger(listPageCreateTarget.readOnlyReason);
        return;
      }
      markPageCreateTargetActive(appHandle, surfaceId, groupKey);
      requestPageCreate(appHandle, {
        target: listPageCreateTarget,
        origin: {
          surfaceId,
          panelTabId: tab.id,
          projectId,
          databaseViewId,
          kind: "header",
          columnId: groupKey,
        },
      });
    },
    [appHandle, databaseViewId, listPageCreateTarget, projectId, surfaceId, tab.id],
  );
  useEffect(() => {
    if (!databaseView) return;
    synchronizePreferenceStoreEpoch(databaseView.storeEpoch);
  }, [databaseView, synchronizePreferenceStoreEpoch]);
  const updateEffectivePresentation = useCallback(
    (next: EffectiveDatabaseView) => {
      if (!durableEffectivePresentation) return;
      const presentation = compactDatabaseViewPresentationOverride(
        durableEffectivePresentation,
        next,
      );
      runtime.setPresentationOverride(presentation);
      void personalPreference.setPresentationOverride(presentation);
    },
    [durableEffectivePresentation, personalPreference, runtime],
  );
  const updateEffectiveRules = useCallback(
    (next: DatabaseViewRules) => {
      if (!databaseView) return;
      const compact = compactDatabaseViewRulesOverride(databaseView.query.view.config.rules, next);
      runtime.setRulesOverride(compact);
      void personalPreference.setRulesOverride(compact);
    },
    [databaseView, personalPreference, runtime],
  );
  const ruleBarOpen = databaseViewTabs.ruleBarOpenByViewId[String(databaseViewId)] ?? false;
  const resetEffectiveRules = useCallback(
    (scope: DatabaseViewRuleScope) => {
      const remaining = clearDatabaseViewRulesOverrideScope(rulesOverride ?? {}, scope);
      runtime.setRulesOverride(remaining);
      void personalPreference.setRulesOverride(remaining);
    },
    [personalPreference, rulesOverride, runtime],
  );
  const publishEffectiveRules = useCallback(
    async (scope: DatabaseViewRuleScope) => {
      if (!databaseView || !effectivePresentation || publishingPresentation) return;
      setPublishingPresentation(true);
      setRulePublishError(null);
      try {
        const currentPreferences = await personalPreference.flushPreferences();
        const publishFilters = scope === "filters" || scope === "all";
        const publishSorts = scope === "sorts" || scope === "all";
        const durableRules = databaseView.query.view.config.rules;
        const nextRules: DatabaseViewRules = {
          propertyFilters: publishFilters
            ? effectivePresentation.rules.propertyFilters
            : durableRules.propertyFilters,
          advancedFilter: publishFilters
            ? effectivePresentation.rules.advancedFilter
            : durableRules.advancedFilter,
          sorts: publishSorts ? effectivePresentation.rules.sorts : durableRules.sorts,
        };
        const remainingRulesOverride = clearDatabaseViewRulesOverrideScope(
          currentPreferences.rulesOverride,
          scope,
        );
        const receipt = await runtime.publishDatabaseViewDefinition({
          kind: "rules",
          patch: { rules: nextRules },
          commit: async (canonicalModel, operationId) => {
            const committed = await commitDatabaseViewOperations({
              model: canonicalModel,
              operationId,
              operations: [
                {
                  kind: "put_view",
                  databaseId: canonicalModel.databaseId,
                  dataSourceId: canonicalModel.dataSourceId,
                  viewId: canonicalModel.databaseViewId,
                  expectedRevision: canonicalModel.query.view.revision,
                  name: canonicalModel.query.view.name,
                  layout: canonicalModel.query.view.layout,
                  config: { ...canonicalModel.query.view.config, rules: nextRules },
                  isDefault: canonicalModel.query.view.isDefault,
                },
                {
                  kind: "put_view_personal_preferences",
                  viewId: canonicalModel.databaseViewId,
                  expectedRevision: currentPreferences.revision,
                  rulesOverride: remainingRulesOverride ?? {},
                  presentationOverride: currentPreferences.presentationOverride,
                },
              ],
            });
            if (!committed) throw new Error("The View rules no longer require publication");
            return committed;
          },
        });
        const preferenceRevision =
          Object.entries(receipt.committedRevisions).find(
            ([key]) =>
              key.startsWith("view_preferences:") &&
              key.endsWith(`:${databaseView.databaseViewId}`),
          )?.[1] ?? currentPreferences.revision;
        runtime.setRulesOverride(remainingRulesOverride);
        personalPreference.acceptPreferencesCommitted({
          rulesOverride: remainingRulesOverride,
          presentationOverride: currentPreferences.presentationOverride,
          revision: preferenceRevision,
          commitSeq: receipt.commitSeq,
        });
      } catch (cause) {
        setRulePublishError(
          cause instanceof Error ? cause.message : "View rules could not be saved for everyone",
        );
      } finally {
        setPublishingPresentation(false);
      }
    },
    [databaseView, effectivePresentation, personalPreference, publishingPresentation, runtime],
  );
  const rulesController = useDatabaseViewRulesController({
    ownerKey: String(databaseViewId),
    rules: effectivePresentation?.rules ?? EMPTY_DATABASE_VIEW_RULES,
    barOpen: ruleBarOpen,
    onBarOpenChange: (open) => setDatabaseViewRuleBarOpen(String(databaseViewId), open),
    onRulesChange: updateEffectiveRules,
    filtersPersonal:
      rulesOverride?.propertyFilters !== undefined || rulesOverride?.advancedFilter !== undefined,
    sortsPersonal: rulesOverride?.sorts !== undefined,
    busy: presentationActivity.interactionLocked,
    error: rulePublishError ?? personalPreference.error,
    onReset: resetEffectiveRules,
    onPublish: (scope) => void publishEffectiveRules(scope),
  });
  const publishEffectivePresentation = useCallback(async () => {
    if (
      !databaseView ||
      !effectivePresentation ||
      !durableEffectivePresentation ||
      publishingPresentation
    )
      return;
    setPublishingPresentation(true);
    try {
      const currentPresentation = await personalPreference.flushPreferences();
      const receipt = await runtime.publishDatabaseViewDefinition({
        kind: "presentation",
        patch: {
          layout: effectivePresentation.layout,
          presentation: effectivePresentation.presentation,
        },
        commit: async (canonicalModel, operationId) => {
          const committed = await commitDatabaseViewOperations({
            model: canonicalModel,
            operationId,
            operations: [
              {
                kind: "put_view",
                databaseId: canonicalModel.databaseId,
                dataSourceId: canonicalModel.dataSourceId,
                viewId: canonicalModel.databaseViewId,
                expectedRevision: canonicalModel.query.view.revision,
                name: canonicalModel.query.view.name,
                layout: effectivePresentation.layout,
                config: {
                  ...canonicalModel.query.view.config,
                  presentation: effectivePresentation.presentation,
                },
                isDefault: canonicalModel.query.view.isDefault,
              },
              {
                kind: "put_view_personal_preferences",
                viewId: canonicalModel.databaseViewId,
                expectedRevision: currentPresentation.revision,
                rulesOverride: currentPresentation.rulesOverride,
                presentationOverride: {},
              },
            ],
          });
          if (!committed) throw new Error("The View presentation no longer requires publication");
          return committed;
        },
      });
      const preferenceRevision =
        Object.entries(receipt.committedRevisions).find(
          ([key]) =>
            key.startsWith("view_preferences:") && key.endsWith(`:${databaseView.databaseViewId}`),
        )?.[1] ?? currentPresentation.revision;
      runtime.setPresentationOverride(null);
      personalPreference.acceptPreferencesCommitted({
        rulesOverride: currentPresentation.rulesOverride,
        presentationOverride: null,
        revision: preferenceRevision,
        commitSeq: receipt.commitSeq,
      });
    } finally {
      setPublishingPresentation(false);
    }
  }, [
    databaseView,
    durableEffectivePresentation,
    effectivePresentation,
    publishingPresentation,
    personalPreference,
    runtime,
  ]);
  const publishConditionalColors = useCallback(
    async (conditionalColors: readonly DatabaseViewConditionalColorRule[]) => {
      if (!databaseView) throw new Error("The Database View is not loaded");
      await runtime.publishDatabaseViewDefinition({
        kind: "conditional-colors",
        patch: { conditionalColors },
        commit: async (canonicalModel, operationId) => {
          const presentation = {
            ...canonicalModel.query.view.config.presentation,
            conditionalColors,
          };
          const committed = await commitDatabaseViewOperations({
            model: canonicalModel,
            operationId,
            operations: [
              {
                kind: "put_view",
                databaseId: canonicalModel.databaseId,
                dataSourceId: canonicalModel.dataSourceId,
                viewId: canonicalModel.databaseViewId,
                expectedRevision: canonicalModel.query.view.revision,
                name: canonicalModel.query.view.name,
                layout: canonicalModel.query.view.layout,
                config: { ...canonicalModel.query.view.config, presentation },
                isDefault: canonicalModel.query.view.isDefault,
              },
            ],
          });
          if (!committed) {
            throw new Error("The conditional colors no longer require publication");
          }
          return committed;
        },
      });
    },
    [databaseView, runtime],
  );
  const previewConditionalColors = useCallback(
    (rules: readonly DatabaseViewConditionalColorRule[] | null) => {
      setConditionalColorPreview(rules ? { viewId: String(databaseViewId), rules } : null);
    },
    [databaseViewId],
  );
  const openTaskSearch = useCallback((selectQuery = false) => {
    setTaskSearchOpen(true);
    window.requestAnimationFrame(() => {
      const input = taskSearchInputRef.current;
      input?.focus();
      if (selectQuery) input?.select();
    });
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsRouteStack(null);
    window.requestAnimationFrame(() => {
      settingsTriggerRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
  }, []);

  const openSettingsForView = useCallback(
    (viewId: string, route?: DatabaseSettingsRoute) => {
      if (!databaseView) return;
      const root: DatabaseSettingsRoute = {
        kind: "root",
        databaseId: parseDatabaseId(databaseView.databaseId),
        viewId: parseDatabaseViewId(viewId),
      };
      setSettingsRouteStack(
        route && route.kind !== "root"
          ? pushDatabaseSettingsRoute(openDatabaseSettingsRoute(root), route)
          : openDatabaseSettingsRoute(root),
      );
    },
    [databaseView],
  );
  const openSettings = useCallback(
    (route?: DatabaseSettingsRoute) => {
      if (!databaseView) return;
      openSettingsForView(databaseView.databaseViewId, route);
    },
    [databaseView, openSettingsForView],
  );

  useEffect(() => {
    if (!databaseView) return;
    const nextOwner = {
      viewId: parseDatabaseViewId(databaseView.databaseViewId),
      dataSourceId: databaseView.dataSourceId,
    };
    const previousOwner = previousSettingsOwnerRef.current;
    previousSettingsOwnerRef.current = nextOwner;
    if (!previousOwner || !settingsRouteStack) return;
    setSettingsRouteStack(
      reconcileDatabaseSettingsRouteStack({
        stack: settingsRouteStack,
        databaseId: parseDatabaseId(databaseView.databaseId),
        previousViewId: previousOwner.viewId,
        nextViewId: nextOwner.viewId,
        previousDataSourceId: previousOwner.dataSourceId,
        nextDataSourceId: nextOwner.dataSourceId,
      }),
    );
  }, [databaseView, settingsRouteStack]);

  useEffect(() => {
    if (taskSearchOpenTick <= 0 || taskSearchOpenTick === lastHandledTaskSearchOpenTickRef.current)
      return;
    lastHandledTaskSearchOpenTickRef.current = taskSearchOpenTick;
    openTaskSearch(true);
  }, [openTaskSearch, taskSearchOpenTick]);

  if (
    !databaseView ||
    !effectiveFilter ||
    !effectivePresentation ||
    !durableEffectivePresentation
  ) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-token-description-foreground">
        {runtime.error ?? "Opening Database…"}
      </div>
    );
  }

  const activeViews =
    settings.authority?.database.views.filter((view) => view.lifecycle === "active") ?? [];
  const tabDisplayMode =
    databaseViewTabs.displayModeByDatabaseId[databaseView.databaseId] ?? "icon_and_text";
  const selectTargetView = (view: DatabaseViewRecordV2): void => {
    if (view.viewId === databaseView.databaseViewId) return;
    onSelectDatabaseView?.(view.viewId, view.name);
  };
  const openTargetViewSettings = (view: DatabaseViewRecordV2, focusName = false): void => {
    selectTargetView(view);
    openSettingsForView(view.viewId);
    if (focusName) setViewNameFocusRequest((request) => request + 1);
  };
  const toolbarItems = settings.authority?.database.views
    .filter((view) => view.lifecycle === "active")
    .map((view): DbViewToolbarItem => ({
      id: view.viewId,
      label: view.name,
      icon: databaseViewLayoutIcon(view.layout),
      active: view.viewId === databaseView.databaseViewId,
      onSelect: () => selectTargetView(view),
      actionMenu: {
        viewId: view.viewId,
        viewName: view.name,
        viewIcon: databaseViewLayoutIcon(view.layout),
        dataSourceName:
          settings.authority?.database.dataSources.find(
            (source) => source.dataSourceId === view.dataSourceId,
          )?.name ?? "Data source",
        displayMode: tabDisplayMode,
        busy: settings.pendingKey !== null,
        canDelete: activeViews.length > 1,
        onRename: () => openTargetViewSettings(view, true),
        onEdit: () => openTargetViewSettings(view),
        onOpenSource: () => {
          selectTargetView(view);
          const root: DatabaseSettingsRoute = {
            kind: "root",
            databaseId: parseDatabaseId(databaseView.databaseId),
            viewId: view.viewId,
          };
          setSettingsRouteStack(
            pushDatabaseSettingsRoute(openDatabaseSettingsRoute(root), {
              kind: "source_properties",
              dataSourceId: view.dataSourceId,
            }),
          );
        },
        onCopyLink: async () => {
          const copied = await writeTextToClipboard(
            serializeNfm([
              {
                type: "databaseViewRef",
                databaseViewId: view.viewId,
                displayHint: view.name,
                children: [],
              },
            ]),
          );
          if (copied) toast.success("Copied exact View link");
          else toast.danger("Couldn’t copy the View link");
        },
        onDuplicate: async () => {
          const viewId = parseDatabaseViewId(createUuidV7());
          const next = await settings.mutate({
            pendingKey: `duplicate-view:${view.viewId}`,
            preferredViewId: viewId,
            buildOperations: (authority) => {
              const current = authority.database.views.find(
                (candidate) => candidate.lifecycle === "active" && candidate.viewId === view.viewId,
              );
              return current ? [duplicateDatabaseViewOperation({ view: current, viewId })] : [];
            },
          });
          const duplicate = next?.database.views.find((candidate) => candidate.viewId === viewId);
          if (!duplicate) return;
          onSelectDatabaseView?.(duplicate.viewId, duplicate.name);
          openSettingsForView(duplicate.viewId);
          setViewNameFocusRequest((request) => request + 1);
          void runtime.refresh();
        },
        onRequestDelete: () => setDeleteViewRequest({ viewId: view.viewId, viewName: view.name }),
        onDisplayModeChange: (mode) => setDatabaseViewTabDisplayMode(databaseView.databaseId, mode),
      },
    })) ?? [durableDatabaseToolbarItem(databaseView, effectivePresentation.layout)];
  const activeViewActionMenu = toolbarItems.find((item) => item.active)?.actionMenu;
  const reorderViews = async (
    movedViewId: string,
    orderedViewIds: readonly string[],
  ): Promise<boolean> => {
    if (!settings.authority || settings.pendingKey !== null) return false;
    const operation = reorderDatabaseViewOperation(
      settings.authority.database.views,
      movedViewId,
      orderedViewIds,
    );
    if (!operation) return false;
    const next = await settings.mutate({
      pendingKey: `reorder-view:${movedViewId}`,
      preferredViewId: databaseView.databaseViewId,
      buildOperations: (authority) => {
        const current = reorderDatabaseViewOperation(
          authority.database.views,
          movedViewId,
          orderedViewIds,
        );
        return current ? [current] : [];
      },
    });
    if (!next) return false;
    void runtime.refresh();
    return true;
  };
  const searchShortcutLabel =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC")
      ? "⌘F"
      : "Ctrl+F";
  const pageActionPort: DatabaseViewPageActionPort = {
    ...(onOpenPageInNewChat ? { openInNewChat: onOpenPageInNewChat } : {}),
    ...(onOpenRelatedChat ? { openRelatedChat: onOpenRelatedChat } : {}),
    ...(onSendPageToChat ? { sendToChat: onSendPageToChat } : {}),
    deletePage: async ({ pageId }) => {
      const deleted = await runtime.deletePage(undefined, pageId);
      if (!deleted) throw new Error(`Page ${pageId} delete did not commit`);
    },
  };

  return (
    <>
      <DatabaseViewTabSurface
        model={databaseView}
        presentationLayout={effectivePresentation.layout}
        effectivePresentation={effectivePresentation}
        toolbarItems={toolbarItems}
        onReorderViews={reorderViews}
        destinationItems={[
          {
            id: "new-database-view",
            label: "New view",
            icon: PlusIcon,
            onSelect: () =>
              openSettings({
                kind: "create_view",
                databaseId: parseDatabaseId(databaseView.databaseId),
                dataSourceId: databaseView.dataSourceId,
              }),
          },
          {
            id: "primary-canvas",
            label: "Canvas",
            icon: CanvasIcon,
            onSelect: () => {
              void onOpenCanvasStage(projectId, primaryCanvasBlockId(projectId), "Canvas", {
                targetPanelId: tab.panelId,
                targetLeafId,
              });
            },
          },
        ]}
        groupPagination={runtime.groupPagination}
        onLoadMoreGroup={runtime.loadMoreGroup}
        activeSearchQuery={searchQuery}
        taskSearchOpen={taskSearchOpen}
        searchShortcutLabel={searchShortcutLabel}
        taskSearchInputRef={taskSearchInputRef}
        managementControl={
          <div ref={settingsTriggerRef}>
            <NodexIconButton
              icon={SlidersHorizontal}
              size="sm"
              active={settingsRouteStack !== null}
              ariaLabel="Database settings"
              title="Database settings"
              onClick={() => (settingsRouteStack ? closeSettings() : openSettings())}
            />
          </div>
        }
        databaseViewControls={
          <>
            <DatabaseViewRuleToolbarControls
              controller={rulesController}
              properties={databaseView.query.properties}
            />
            <NodexIconButton
              icon={SlidersHorizontal}
              size="sm"
              active={settingsRouteStack?.at(-1)?.kind === "view_display"}
              ariaLabel="Display options"
              title="Display options"
              onClick={() =>
                openSettings({
                  kind: "view_display",
                  viewId: parseDatabaseViewId(databaseView.databaseViewId),
                })
              }
            />
          </>
        }
        rulesBar={
          <DatabaseViewRulesBar
            controller={rulesController}
            config={databaseView.query.view.config}
            properties={databaseView.query.properties}
            optionRegistries={ruleOptionRegistries.options}
            onRequestPropertyOptions={ruleOptionRegistries.requestOptions}
            accessContext={databaseView.accessContext}
          />
        }
        settingsRail={
          settingsRouteStack ? (
            <DatabaseSettingsRail
              runtime={settings}
              routeStack={settingsRouteStack}
              model={databaseView}
              effectivePresentation={effectivePresentation}
              durablePresentation={durableEffectivePresentation}
              viewNameFocusRequest={viewNameFocusRequest}
              viewActionMenu={activeViewActionMenu}
              presentationActivity={presentationActivity}
              presentationError={personalPreference.error}
              optionRegistries={ruleOptionRegistries.options}
              onRequestPropertyOptions={ruleOptionRegistries.requestOptions}
              onChangePresentation={updateEffectivePresentation}
              onResetPresentation={() => void personalPreference.setPresentationOverride(null)}
              onPublishPresentation={publishEffectivePresentation}
              onPreviewConditionalColors={previewConditionalColors}
              onPublishConditionalColors={publishConditionalColors}
              onProjectionCommitted={runtime.refresh}
              onSelectView={(viewId, title) => onSelectDatabaseView?.(viewId, title)}
              onPush={(route) =>
                setSettingsRouteStack((current) =>
                  current ? pushDatabaseSettingsRoute(current, route) : current,
                )
              }
              onReplace={(route) =>
                setSettingsRouteStack((current) =>
                  current ? replaceDatabaseSettingsRoute(current, route) : current,
                )
              }
              onBack={() =>
                setSettingsRouteStack((current) => {
                  if (!current) return null;
                  const next = backDatabaseSettingsRoute(current);
                  if (next) return next;
                  window.requestAnimationFrame(() => {
                    settingsTriggerRef.current?.querySelector<HTMLElement>("button")?.focus();
                  });
                  return null;
                })
              }
              onClose={closeSettings}
            />
          ) : null
        }
        onSearchQueryChange={(value) => setSearchQuery(projectId, value)}
        onOpenTaskSearch={openTaskSearch}
        onCloseTaskSearch={() => setTaskSearchOpen(false)}
        onOpenPage={(pageId, titleSnapshot, openMode) => {
          void onOpenPageTab(projectId, pageId, titleSnapshot, {
            placement: { kind: "adjacent-right", sourceSurfaceId: tab.id },
            openMode,
          });
        }}
        pageActionPort={pageActionPort}
        onCommitted={runtime.refresh}
        onMoveBoardPages={runtime.moveDatabaseViewPages}
        keyboardSurface={{ surfaceId, presentationId: tab.id }}
        presentedPageIds={presentedPageIds}
        initialSelectedPageIds={selectedPageIds}
        onSelectedPageIdsChange={setSelectedPageIds}
        collapsedOccurrenceKeys={personalPreference.collapsedOccurrenceKeys}
        onOccurrenceDisclosureChange={(target, collapsed) => {
          void personalPreference.setOccurrenceDisclosure(target, collapsed);
        }}
        pageCreateSurfaceId={surfaceId}
        onRequestCreatePage={requestListPageCreate}
        mutationHistory={mutationHistory}
      />
      {deleteViewRequest ? (
        <DatabaseViewDeleteConfirmationDialog
          viewName={deleteViewRequest.viewName}
          busy={settings.pendingKey !== null}
          onClose={() => setDeleteViewRequest(null)}
          onConfirm={async () => {
            const target = settings.authority?.database.views.find(
              (view) => view.lifecycle === "active" && view.viewId === deleteViewRequest.viewId,
            );
            if (!target || activeViews.length <= 1) {
              setDeleteViewRequest(null);
              return;
            }
            const next = await settings.mutate({
              pendingKey: `delete-view:${target.viewId}`,
              preferredViewId: databaseView.databaseViewId,
              buildOperations: (authority) => {
                const current = authority.database.views.find(
                  (view) => view.lifecycle === "active" && view.viewId === target.viewId,
                );
                return current
                  ? [
                      {
                        kind: "delete_view" as const,
                        databaseId: current.databaseId,
                        viewId: current.viewId,
                        expectedRevision: current.revision,
                      },
                    ]
                  : [];
              },
            });
            if (!next) return;
            setDeleteViewRequest(null);
            onSelectDatabaseView?.(next.view.viewId, next.view.name);
            void runtime.refresh();
          }}
        />
      ) : null}
    </>
  );
}
