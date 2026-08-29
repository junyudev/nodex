import {
  DATABASE_CHANGE_EVENT_VERSION,
  type DatabaseChangeEvent,
} from "../../shared/database-events";
import { parseDatabaseId, parseDatabaseViewId } from "../../shared/database-identities";
import {
  LIBRARY_NAVIGATION_EVENT_VERSION,
  type LibraryNavigationChangedEvent,
} from "../../shared/library-events";
import type { ProjectCatalogChangeKind } from "../../shared/core-modules/project-workspace-module";
import type { ProjectSessionInvalidationScope } from "../../shared/core-modules/project-workspace-module";
import {
  fromCoreDatabaseViewPresentationOverride,
  fromCoreDatabaseViewRulesOverride,
} from "../core-client/database-presentation-adapter";
import type { CoreAuthorizedDeliveryAtom, CoreEventEnvelope } from "../core-client/types";

export interface CoreAutomationInvalidation {
  readonly automationIds: readonly string[];
  readonly runIds: readonly string[];
}

export interface CoreProjectWorkspaceInvalidation {
  readonly projectCatalogChange?: ProjectCatalogChangeKind;
  readonly projectIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly threadIds: readonly string[];
  readonly sessionSummaryScopes: readonly ProjectSessionInvalidationScope[];
  readonly sessionDetailIds: readonly string[];
}

export interface CoreStoreAdministrationInvalidation {
  readonly backupIds: readonly string[];
  readonly readinessChanged: boolean;
}

export type CoreApplicationInvalidation =
  | {
      readonly kind: "store-administration";
      readonly value: CoreStoreAdministrationInvalidation;
    }
  | { readonly kind: "automation"; readonly value: CoreAutomationInvalidation }
  | { readonly kind: "database"; readonly value: DatabaseChangeEvent }
  | { readonly kind: "library-navigation"; readonly value: LibraryNavigationChangedEvent }
  | { readonly kind: "project-workspace"; readonly value: CoreProjectWorkspaceInvalidation };

export const projectCoreStoreAdministrationEvent = (
  atom: CoreAuthorizedDeliveryAtom,
): CoreStoreAdministrationInvalidation | null => {
  const payload = atom.payload;
  if (payload.module !== "store_administration") return null;
  return {
    backupIds: payload.event.backup_ids,
    readinessChanged: payload.event.readiness_changed,
  };
};

export const projectCoreAutomationEvent = (
  atom: CoreAuthorizedDeliveryAtom,
): CoreAutomationInvalidation | null => {
  const payload = atom.payload;
  if (payload.module !== "automation") return null;
  return {
    automationIds: payload.event.automation_ids,
    runIds: payload.event.run_ids,
  };
};

export const projectCoreDatabaseEvent = (
  envelope: CoreEventEnvelope,
  atom: CoreAuthorizedDeliveryAtom,
  libraryId: string,
): DatabaseChangeEvent | null => {
  const payload = atom.payload;
  if (payload.module !== "database") return null;
  const operationId = envelope.packet.manifest.operation_id;
  const projectId = payload.event.project_id;
  if (!operationId || !projectId) return null;
  return {
    version: DATABASE_CHANGE_EVENT_VERSION,
    projectId,
    libraryId,
    storeEpoch: envelope.packet.manifest.identity.store_epoch,
    operationId,
    sourceKind: "database_module",
    affectedDatabaseIds: payload.event.database_ids,
    affectedDataSourceIds: payload.event.data_source_ids,
    affectedPageIds: payload.event.page_ids,
    affectedViewIds: payload.event.view_ids,
    personalViewChanges: (payload.event.personal_view_changes ?? []).map((change) =>
      change.kind === "preferences"
        ? {
            kind: change.kind,
            viewId: parseDatabaseViewId(change.view_id),
            rulesOverride: fromCoreDatabaseViewRulesOverride(change.value.rules_override),
            presentationOverride: fromCoreDatabaseViewPresentationOverride(
              change.value.presentation_override,
            ),
            revision: change.value.revision,
          }
        : {
            kind: change.kind,
            viewId: parseDatabaseViewId(change.view_id),
            target: {
              kind: change.target.kind,
              occurrenceKey: change.target.occurrence_key,
            },
            collapsed: change.collapsed,
          },
    ),
    commitSeq: envelope.packet.manifest.identity.commit_seq,
  };
};

export const projectCoreLibraryDatabaseEvent = (
  envelope: CoreEventEnvelope,
  atom: CoreAuthorizedDeliveryAtom,
  libraryId: string,
): LibraryNavigationChangedEvent | null => {
  const payload = atom.payload;
  if (payload.module !== "database" || payload.event.project_id) return null;
  if (
    payload.event.database_ids.length === 0 &&
    payload.event.data_source_ids.length === 0 &&
    payload.event.page_ids.length === 0 &&
    payload.event.view_ids.length === 0
  ) {
    return null;
  }
  return {
    version: LIBRARY_NAVIGATION_EVENT_VERSION,
    libraryId,
    storeEpoch: envelope.packet.manifest.identity.store_epoch,
    commitSeq: envelope.packet.manifest.identity.commit_seq,
    changeKind: "database",
    affectedParentKeys: [
      "library",
      "catalog",
      ...payload.event.database_ids.map((id) => `database:${id}`),
    ],
    affectedPageIds: payload.event.page_ids,
    affectedDatabaseIds: payload.event.database_ids.map(parseDatabaseId),
    affectedViewIds: payload.event.view_ids.map(parseDatabaseViewId),
  };
};

export const projectCoreLibraryEvent = (
  envelope: CoreEventEnvelope,
  atom: CoreAuthorizedDeliveryAtom,
  libraryId: string,
): LibraryNavigationChangedEvent | null => {
  const payload = atom.payload;
  if (payload.module !== "library") return null;
  if (
    payload.event.page_ids.length === 0 &&
    payload.event.database_ids.length === 0 &&
    payload.event.view_ids.length === 0 &&
    payload.event.parent_keys.length === 0
  ) {
    return null;
  }
  return {
    version: LIBRARY_NAVIGATION_EVENT_VERSION,
    libraryId,
    storeEpoch: envelope.packet.manifest.identity.store_epoch,
    commitSeq: envelope.packet.manifest.identity.commit_seq,
    changeKind: "content",
    affectedParentKeys: payload.event.parent_keys,
    affectedPageIds: payload.event.page_ids,
    affectedDatabaseIds: payload.event.database_ids.map(parseDatabaseId),
    affectedViewIds: [],
  };
};

export const projectCoreProjectWorkspaceEvent = (
  atom: CoreAuthorizedDeliveryAtom,
): CoreProjectWorkspaceInvalidation | null => {
  const payload = atom.payload;
  if (payload.module !== "project_workspace") return null;
  return {
    projectCatalogChange: payload.event.project_catalog_change ?? undefined,
    projectIds: payload.event.project_ids,
    sessionIds: payload.event.session_ids,
    threadIds: payload.event.thread_ids,
    sessionSummaryScopes: payload.event.session_summary_scopes.map((scope) =>
      scope.kind === "project" ? { kind: scope.kind, projectId: scope.project_id } : scope,
    ),
    sessionDetailIds: payload.event.session_detail_ids,
  };
};

/** Projects one authorized Core atom into exactly one application invalidation family. */
export const projectCoreApplicationEvent = (
  envelope: CoreEventEnvelope,
  atom: CoreAuthorizedDeliveryAtom,
  libraryId: string,
): CoreApplicationInvalidation | null => {
  const storeAdministration = projectCoreStoreAdministrationEvent(atom);
  if (storeAdministration) return { kind: "store-administration", value: storeAdministration };

  const automation = projectCoreAutomationEvent(atom);
  if (automation) return { kind: "automation", value: automation };

  const database = projectCoreDatabaseEvent(envelope, atom, libraryId);
  if (database) return { kind: "database", value: database };

  const libraryDatabase = projectCoreLibraryDatabaseEvent(envelope, atom, libraryId);
  if (libraryDatabase) return { kind: "library-navigation", value: libraryDatabase };

  const library = projectCoreLibraryEvent(envelope, atom, libraryId);
  if (library) return { kind: "library-navigation", value: library };

  const projectWorkspace = projectCoreProjectWorkspaceEvent(atom);
  return projectWorkspace ? { kind: "project-workspace", value: projectWorkspace } : null;
};
