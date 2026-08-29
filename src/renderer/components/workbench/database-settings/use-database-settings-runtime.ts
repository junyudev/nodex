import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DatabaseApplyOperationV2,
  DatabasePageLayoutV2,
} from "../../../../shared/database-module-v2";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import {
  commitDatabaseSettingsOperations,
  DatabaseSettingsMutationError,
  DatabaseSettingsReadError,
  readDatabaseSettingsAuthority,
  readDatabasePageLayout,
  type DatabaseSettingsAuthority,
} from "@/lib/database-settings-runtime";
import { useProjectionRegistration } from "@/lib/projection-invalidation-context";
import type { ProjectionRegistration } from "@/lib/projection-invalidation-registry";

export interface DatabaseSettingsRuntime {
  readonly authority: DatabaseSettingsAuthority | null;
  readonly loading: boolean;
  readonly pendingKey: string | null;
  readonly error: string | null;
  readonly pageLayout: DatabasePageLayoutV2 | null;
  readonly pageLayoutLoading: boolean;
  readonly loadPageLayout: (dataSourceId: string) => Promise<DatabasePageLayoutV2 | null>;
  readonly refresh: () => Promise<DatabaseSettingsAuthority | null>;
  readonly mutate: (input: {
    readonly pendingKey: string;
    readonly preferredViewId?: string | null;
    readonly buildOperations: (
      authority: DatabaseSettingsAuthority,
    ) => readonly DatabaseApplyOperationV2[];
  }) => Promise<DatabaseSettingsAuthority | null>;
}

const settingsErrorMessage = (error: unknown): string => {
  if (
    error instanceof DatabaseSettingsMutationError &&
    error.commandError.code === "revision_conflict"
  ) {
    return "Settings changed elsewhere. Review the latest values and try again.";
  }
  if (error instanceof DatabaseSettingsMutationError) return error.commandError.message;
  if (error instanceof DatabaseSettingsReadError) return "Couldn’t load database settings.";
  return "Couldn’t save database settings.";
};

export function useDatabaseSettingsRuntime(input: {
  readonly projectId: string;
  readonly databaseId: string | null;
  readonly activeViewId: string;
}): DatabaseSettingsRuntime {
  const [authority, setAuthority] = useState<DatabaseSettingsAuthority | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageLayout, setPageLayout] = useState<DatabasePageLayoutV2 | null>(null);
  const [pageLayoutLoading, setPageLayoutLoading] = useState(false);
  const authorityRef = useRef(authority);
  const readSequence = useRef(0);
  authorityRef.current = authority;

  const applyAuthority = useCallback((next: DatabaseSettingsAuthority) => {
    authorityRef.current = next;
    setAuthority(next);
  }, []);

  const refresh = useCallback(async (): Promise<DatabaseSettingsAuthority | null> => {
    if (!input.databaseId) return null;
    const sequence = ++readSequence.current;
    setLoading(authorityRef.current === null);
    try {
      const next = await readDatabaseSettingsAuthority({
        projectId: input.projectId,
        databaseId: input.databaseId,
        preferredViewId: input.activeViewId,
      });
      if (sequence !== readSequence.current) return null;
      applyAuthority(next);
      setError(null);
      return next;
    } catch (nextError) {
      if (sequence !== readSequence.current) return null;
      console.error("[database-settings:read]", nextError);
      setError(settingsErrorMessage(nextError));
      return null;
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  }, [applyAuthority, input.activeViewId, input.databaseId, input.projectId]);

  useEffect(() => {
    setAuthority(null);
    authorityRef.current = null;
    setPageLayout(null);
    void refresh();
  }, [input.databaseId, input.projectId, refresh]);

  const loadPageLayout = useCallback(
    async (dataSourceId: string): Promise<DatabasePageLayoutV2 | null> => {
      setPageLayoutLoading(true);
      try {
        const next = await readDatabasePageLayout({
          projectId: input.projectId,
          dataSourceId,
          minimumCommitSeq: authorityRef.current?.snapshot.commitSeq,
        });
        setPageLayout(next);
        return next;
      } catch (nextError) {
        console.error("[database-settings:page-layout]", nextError);
        setError(settingsErrorMessage(nextError));
        return null;
      } finally {
        setPageLayoutLoading(false);
      }
    },
    [input.projectId],
  );

  const projectionRegistration: ProjectionRegistration | null = authority
    ? {
        scope: {
          kind: "project" as const,
          libraryId: authority.snapshot.libraryId,
          projectId: input.projectId,
        },
        consumerKey: `database-settings:${input.projectId}:${input.databaseId}`,
        getDependencies: () => {
          const current = authorityRef.current;
          return {
            aggregate: false as const,
            databaseIds: current ? [current.database.database.databaseId] : [],
            dataSourceIds: current ? [current.dataSource.dataSourceId] : [],
            viewIds: current?.database.views.map((view) => view.viewId).filter(Boolean) ?? [],
          };
        },
        getCursor: () => {
          const snapshot = authorityRef.current?.snapshot;
          return snapshot
            ? { storeEpoch: snapshot.storeEpoch, commitSeq: snapshot.commitSeq }
            : null;
        },
        invalidate: async () => {
          const next = await refresh();
          if (pageLayout && next) await loadPageLayout(next.dataSource.dataSourceId);
        },
      }
    : null;
  useProjectionRegistration(projectionRegistration);

  const mutate = useCallback(
    async (request: {
      readonly pendingKey: string;
      readonly preferredViewId?: string | null;
      readonly buildOperations: (
        authority: DatabaseSettingsAuthority,
      ) => readonly DatabaseApplyOperationV2[];
    }): Promise<DatabaseSettingsAuthority | null> => {
      if (!input.databaseId || pendingKey !== null) return null;
      setPendingKey(request.pendingKey);
      setError(null);
      try {
        const next = await commitDatabaseSettingsOperations({
          projectId: input.projectId,
          databaseId: input.databaseId,
          preferredViewId: request.preferredViewId ?? input.activeViewId,
          operationId: createUuidV7(),
          buildOperations: request.buildOperations,
        });
        applyAuthority(next);
        return next;
      } catch (nextError) {
        console.error("[database-settings:mutation]", nextError);
        setError(settingsErrorMessage(nextError));
        void refresh();
        return null;
      } finally {
        setPendingKey(null);
      }
    },
    [applyAuthority, input.activeViewId, input.databaseId, input.projectId, pendingKey, refresh],
  );

  return {
    authority,
    loading,
    pendingKey,
    error,
    pageLayout,
    pageLayoutLoading,
    loadPageLayout,
    refresh,
    mutate,
  };
}
