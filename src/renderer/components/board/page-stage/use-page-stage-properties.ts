import { useCallback, useEffect, useMemo, useState } from "react";
import type { DataSourcePropertyOptionRegistryState } from "@/components/database/data-source-property-editor-binding";
import { usePropertyOptionRegistries } from "@/components/database/use-property-option-registries";
import type { DatabasePropertyOption } from "../../../../shared/database-kernel";
import type { ContentAccessContext } from "../../../../shared/content-access-context";
import {
  readDataSourceRelationTargets,
  readDataSourceRelationTargetDescriptor,
  searchDataSourceRelationCandidates,
} from "@/lib/data-source-relation-runtime";
import {
  hasPageStageScheduleCapability,
  isPageStagePrimaryProperty,
  pageStageSectionProperties,
  pageStageSemanticValues,
  type PageStageDataSourceProperty,
  type PageStagePropertyEdit,
} from "@/lib/page-stage-properties";
import type { PageStagePageModel } from "@/lib/page-stage-page";
import { isPageStagePropertyHiddenByLayout } from "@/lib/page-stage-property-layout";
import type { PageStageMetadataMutationResult, PageStageProps } from "./types";

export interface PageStagePropertyControls {
  readonly pageId: string | null;
  readonly properties: readonly PageStageDataSourceProperty[];
  readonly primaryProperties: readonly PageStageDataSourceProperty[];
  readonly sectionProperties: readonly PageStageDataSourceProperty[];
  readonly hiddenLayoutProperties: readonly PageStageDataSourceProperty[];
  readonly semanticValues: ReturnType<typeof pageStageSemanticValues> | null;
  readonly hasScheduleCapability: boolean;
  readonly options: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly optionRegistryStates: Readonly<Record<string, DataSourcePropertyOptionRegistryState>>;
  readonly requestOptions: (property: PageStageDataSourceProperty) => void;
  readonly requestMoreOptions: (property: PageStageDataSourceProperty) => void;
  readonly optionRegistryHasMore: Readonly<Record<string, boolean>>;
  readonly optionRegistryLoadingMore: Readonly<Record<string, boolean>>;
  readonly busyPropertyIds: ReadonlySet<string>;
  readonly errors: Readonly<Record<string, string>>;
  readonly edit: (
    property: PageStageDataSourceProperty,
    edit: PageStagePropertyEdit,
  ) => Promise<PageStageMetadataMutationResult>;
  readonly patchRelation: (
    property: PageStageDataSourceProperty,
    delta: {
      readonly addPageIds: readonly string[];
      readonly removeEdgeIds: readonly string[];
    },
  ) => Promise<PageStageMetadataMutationResult>;
  readonly replaceRelation: (
    property: PageStageDataSourceProperty,
    targetPageId: string | null,
  ) => Promise<PageStageMetadataMutationResult>;
  readonly patchMultiSelect: (
    property: PageStageDataSourceProperty,
    delta: {
      readonly addOptionIds: readonly string[];
      readonly removeOptionIds: readonly string[];
    },
  ) => Promise<PageStageMetadataMutationResult>;
  readonly createOptionAndSelect: (
    property: PageStageDataSourceProperty,
    option: { readonly optionId: string; readonly name: string; readonly color?: string },
  ) => Promise<PageStageMetadataMutationResult>;
  readonly loadRelationTargets: (
    property: PageStageDataSourceProperty,
    after: string | null,
  ) => ReturnType<typeof readDataSourceRelationTargets>;
  readonly searchRelationCandidates: (
    property: PageStageDataSourceProperty,
    query: string,
    after?: string | null,
  ) => ReturnType<typeof searchDataSourceRelationCandidates>;
  readonly loadRelationTargetDescriptor: (
    property: PageStageDataSourceProperty,
  ) => ReturnType<typeof readDataSourceRelationTargetDescriptor>;
  readonly openRelationPage?: (pageId: string, title: string) => void;
  readonly refreshRelationValue: () => Promise<void>;
}

const errorResult = (error: string): PageStageMetadataMutationResult => ({
  status: "error",
  error,
});

const EMPTY_PROPERTIES: readonly PageStageDataSourceProperty[] = [];

export function usePageStageProperties(input: {
  readonly pageModel: PageStagePageModel | null;
  readonly contentAccessContext: ContentAccessContext;
  readonly onUpdateProperty: PageStageProps["onUpdateProperty"];
  readonly onOpenPage: PageStageProps["onOpenPage"];
  readonly onRefreshProperties: PageStageProps["onRefreshProperties"];
  readonly beginSaving: () => () => void;
}): PageStagePropertyControls {
  const {
    pageModel,
    contentAccessContext,
    onUpdateProperty,
    onOpenPage,
    onRefreshProperties,
    beginSaving,
  } = input;
  const databaseContext = pageModel?.databaseContext;
  const properties =
    databaseContext?.kind === "member" ? databaseContext.properties : EMPTY_PROPERTIES;
  const semantic = databaseContext?.kind === "member" ? databaseContext.semanticProperties : null;
  const optionProperties = useMemo(() => properties.map((item) => item.property), [properties]);
  const requiredOptionIds = useMemo<Readonly<Record<string, readonly string[]>>>(() => {
    const entries: Array<readonly [string, readonly string[]]> = [];
    for (const item of properties) {
      const { property, value } = item;
      if (property.valueType === "select") {
        if (typeof value === "string") entries.push([property.propertyId, [value]]);
        continue;
      }
      if (property.valueType !== "multi_select" || !Array.isArray(value)) continue;
      entries.push([
        property.propertyId,
        value.filter((entry): entry is string => typeof entry === "string"),
      ]);
    }
    return Object.fromEntries(entries);
  }, [properties]);
  const optionRegistries = usePropertyOptionRegistries({
    accessContext: contentAccessContext,
    properties: optionProperties,
    requiredOptionIds,
  });
  const {
    options,
    states: optionRegistryStates,
    hasMore: optionRegistryHasMore,
    loadingMore: optionRegistryLoadingMore,
  } = optionRegistries;
  const [pendingPropertyCounts, setPendingPropertyCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    const active = new Set<string>(properties.map((item) => item.property.propertyId));
    setPendingPropertyCounts(
      (current) => new Map([...current].filter(([propertyId]) => active.has(propertyId))),
    );
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([propertyId]) => active.has(propertyId))),
    );
  }, [properties]);

  const edit = useCallback(
    async (
      property: PageStageDataSourceProperty,
      editIntent: PageStagePropertyEdit,
      reportFieldError = true,
    ): Promise<PageStageMetadataMutationResult> => {
      const pageId = pageModel?.page.id;
      if (!pageId) return errorResult("Page is unavailable");
      const propertyId = property.property.propertyId;
      setPendingPropertyCounts((current) => {
        const next = new Map(current);
        next.set(propertyId, (next.get(propertyId) ?? 0) + 1);
        return next;
      });
      setErrors((current) => {
        const { [propertyId]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
      const endSaving = beginSaving();
      try {
        const result = await onUpdateProperty(pageId, propertyId, editIntent);
        const resolved = result ?? errorResult("Missing Property update result");
        if (resolved.status === "error") {
          console.error("[page-property:save]", resolved.error);
          if (reportFieldError) {
            setErrors((current) => ({
              ...current,
              [propertyId]: "Couldn’t save this property. Try again.",
            }));
          }
        } else if (resolved.status === "conflict" && reportFieldError) {
          setErrors((current) => ({
            ...current,
            [propertyId]: "Value changed elsewhere. Review and try again.",
          }));
        } else if (resolved.status === "not_found" && reportFieldError) {
          setErrors((current) => ({
            ...current,
            [propertyId]: "Property is no longer available.",
          }));
        }
        return resolved;
      } catch (error) {
        console.error("[page-property:save]", error);
        const message = "Couldn’t save this property. Try again.";
        if (reportFieldError) {
          setErrors((current) => ({ ...current, [propertyId]: message }));
        }
        return errorResult(message);
      } finally {
        endSaving();
        setPendingPropertyCounts((current) => {
          const next = new Map(current);
          const count = next.get(propertyId) ?? 0;
          if (count <= 1) next.delete(propertyId);
          else next.set(propertyId, count - 1);
          return next;
        });
      }
    },
    [beginSaving, onUpdateProperty, pageModel?.page.id],
  );

  const patchRelation = useCallback(
    (
      property: PageStageDataSourceProperty,
      delta: {
        readonly addPageIds: readonly string[];
        readonly removeEdgeIds: readonly string[];
      },
    ) => edit(property, { kind: "patch_relation", ...delta }),
    [edit],
  );

  const replaceRelation = useCallback(
    (property: PageStageDataSourceProperty, targetPageId: string | null) =>
      edit(property, {
        kind: "replace_one_relation",
        targetPageId,
        expectedValueRevision: property.valueRevision,
      }),
    [edit],
  );

  const patchMultiSelect = useCallback(
    (
      property: PageStageDataSourceProperty,
      delta: {
        readonly addOptionIds: readonly string[];
        readonly removeOptionIds: readonly string[];
      },
    ) => edit(property, { kind: "patch_multi_select", ...delta }),
    [edit],
  );

  const createOptionAndSelect = useCallback(
    (
      property: PageStageDataSourceProperty,
      option: { readonly optionId: string; readonly name: string; readonly color?: string },
    ) =>
      edit(
        property,
        {
          kind: "create_option_and_select",
          ...option,
          expectedPropertyRevision: property.property.revision,
          expectedValueRevision: property.valueRevision,
        },
        false,
      ),
    [edit],
  );

  const loadRelationTargets = useCallback(
    (property: PageStageDataSourceProperty, after: string | null) =>
      readDataSourceRelationTargets({
        accessContext: contentAccessContext,
        pageId: pageModel?.page.id ?? "",
        property: property.property,
        after,
      }),
    [contentAccessContext, pageModel?.page.id],
  );

  const searchRelationCandidates = useCallback(
    (property: PageStageDataSourceProperty, query: string, after?: string | null) =>
      searchDataSourceRelationCandidates({
        accessContext: contentAccessContext,
        property: property.property,
        query,
        after,
      }),
    [contentAccessContext],
  );

  const loadRelationTargetDescriptor = useCallback(
    (property: PageStageDataSourceProperty) =>
      readDataSourceRelationTargetDescriptor({
        accessContext: contentAccessContext,
        property: property.property,
      }),
    [contentAccessContext],
  );
  const openRelationPage = useMemo(() => {
    if (!onOpenPage) return undefined;
    return (pageId: string, title: string) => {
      void onOpenPage({
        accessContext: contentAccessContext,
        pageId,
        titleSnapshot: title,
      });
    };
  }, [contentAccessContext, onOpenPage]);
  const refreshRelationValue = useCallback(async () => {
    await onRefreshProperties?.();
  }, [onRefreshProperties]);
  const requestOptions = useCallback(
    (property: PageStageDataSourceProperty) => optionRegistries.requestOptions(property.property),
    [optionRegistries],
  );
  const requestMoreOptions = useCallback(
    (property: PageStageDataSourceProperty) =>
      optionRegistries.requestMoreOptions(property.property),
    [optionRegistries],
  );
  const busyPropertyIds = useMemo<ReadonlySet<string>>(
    () => new Set(pendingPropertyCounts.keys()),
    [pendingPropertyCounts],
  );

  return useMemo(() => {
    const hiddenLayoutProperties = properties.filter(isPageStagePropertyHiddenByLayout);
    const visibleProperties = properties.filter(
      (property) => !isPageStagePropertyHiddenByLayout(property),
    );
    const scheduleVisible =
      semantic !== null &&
      semantic.scheduledStart !== null &&
      semantic.scheduledEnd !== null &&
      !isPageStagePropertyHiddenByLayout(semantic.scheduledStart.item) &&
      !isPageStagePropertyHiddenByLayout(semantic.scheduledEnd.item);
    return {
      pageId: pageModel?.page.id ?? null,
      properties,
      primaryProperties: visibleProperties.filter(isPageStagePrimaryProperty),
      sectionProperties:
        semantic && scheduleVisible
          ? pageStageSectionProperties(visibleProperties, semantic)
          : visibleProperties.filter((property) => !isPageStagePrimaryProperty(property)),
      hiddenLayoutProperties,
      semanticValues: semantic ? pageStageSemanticValues(semantic) : null,
      hasScheduleCapability:
        semantic && scheduleVisible ? hasPageStageScheduleCapability(semantic) : false,
      options,
      optionRegistryStates,
      requestOptions,
      requestMoreOptions,
      optionRegistryHasMore,
      optionRegistryLoadingMore,
      busyPropertyIds,
      errors,
      edit,
      patchRelation,
      replaceRelation,
      patchMultiSelect,
      createOptionAndSelect,
      loadRelationTargets,
      searchRelationCandidates,
      loadRelationTargetDescriptor,
      refreshRelationValue,
      ...(openRelationPage ? { openRelationPage } : {}),
    };
  }, [
    busyPropertyIds,
    edit,
    errors,
    loadRelationTargets,
    options,
    optionRegistryStates,
    requestOptions,
    requestMoreOptions,
    optionRegistryHasMore,
    optionRegistryLoadingMore,
    patchRelation,
    replaceRelation,
    patchMultiSelect,
    createOptionAndSelect,
    properties,
    pageModel?.page.id,
    searchRelationCandidates,
    loadRelationTargetDescriptor,
    refreshRelationValue,
    openRelationPage,
    semantic,
  ]);
}
