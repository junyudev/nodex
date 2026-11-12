import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type {
  DatabaseApplyOperationV2,
  DatabaseContainerDescriptorV2,
  DatabaseModuleReadSnapshotV2,
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
  readonly database: DatabaseContainerDescriptorV2 | null;
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
  const { projectId, activeViewId } = input;
  const [retainedDatabase, setRetainedDatabase] = useState<{
    readonly snapshot: DatabaseModuleReadSnapshotV2;
    readonly descriptor: DatabaseContainerDescriptorV2;
  } | null>(null);
  const descriptor =
    retainedDatabase?.snapshot.projectId === projectId ? retainedDatabase.descriptor : null;
  // While the View body resolves, the Database descriptor can prove that the
  // requested View is a sibling. Unknown targets must resolve their own Database.
  const database =
    descriptor &&
    (input.databaseId
      ? descriptor.database.databaseId === input.databaseId
      : descriptor.views.some(
          (view) => view.viewId === activeViewId && view.lifecycle === "active",
        ))
      ? descriptor
      : null;
  const databaseId = input.databaseId ?? database?.database.databaseId ?? null;
  const [resolvedAuthority, setAuthority] = useState<DatabaseSettingsAuthority | null>(null);
  const authority =
    resolvedAuthority?.snapshot.projectId === projectId &&
    resolvedAuthority.database.database.databaseId === databaseId &&
    resolvedAuthority.view.viewId === activeViewId
      ? resolvedAuthority
      : null;
  const [loading, setLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageLayout, setPageLayout] = useState<DatabasePageLayoutV2 | null>(null);
  const [pageLayoutLoading, setPageLayoutLoading] = useState(false);
  const authorityRef = useRef(authority);
  const readSequence = useRef(0);
  const layoutSequence = useRef(0);
  const readOwner = useRef<{
    readonly projectId: string;
    readonly databaseId: string | null;
    readonly activeViewId: string;
    readonly refresh: DatabaseSettingsRuntime["refresh"];
  } | null>(null);

  const applyAuthority = useCallback((next: DatabaseSettingsAuthority) => {
    authorityRef.current = next;
    setAuthority(next);
  }, []);

  const refresh = useCallback(async (): Promise<DatabaseSettingsAuthority | null> => {
    const owner = readOwner.current;
    if (
      !databaseId ||
      owner?.projectId !== projectId ||
      owner.databaseId !== databaseId ||
      owner.activeViewId !== activeViewId
    )
      return null;
    const sequence = ++readSequence.current;
    const isCurrent = () => readOwner.current === owner && sequence === readSequence.current;
    setLoading(authorityRef.current === null);
    return runWithCleanup<DatabaseSettingsAuthority | null>(
      async () => {
        const next = await readDatabaseSettingsAuthority({
          projectId,
          databaseId,
          preferredViewId: activeViewId,
          onReadDatabase: (descriptor, snapshot) => {
            if (isCurrent()) setRetainedDatabase({ descriptor, snapshot });
          },
        });
        if (!isCurrent()) return null;
        applyAuthority(next);
        setError(null);
        return next;
      },
      {
        onError: (nextError) => {
          if (!isCurrent()) return null;
          console.error("[database-settings:read]", nextError);
          setError(settingsErrorMessage(nextError));
          return null;
        },
        cleanup: () => {
          if (isCurrent()) setLoading(false);
        },
      },
    );
  }, [activeViewId, applyAuthority, databaseId, projectId]);

  const refreshIdentity = JSON.stringify([projectId, databaseId, activeViewId]);
  const [previousIdentity, setPreviousIdentity] = useState(refreshIdentity);
  if (previousIdentity !== refreshIdentity) {
    setPreviousIdentity(refreshIdentity);
    setPageLayout(null);
    setPageLayoutLoading(false);
  }
  useLayoutEffect(() => {
    authorityRef.current = null;
    readOwner.current = { projectId, databaseId, activeViewId, refresh };
    void refresh();
    return () => {
      readOwner.current = null;
    };
  }, [activeViewId, databaseId, projectId, refresh]);

  const loadPageLayout = useCallback(
    async (dataSourceId: string): Promise<DatabasePageLayoutV2 | null> => {
      const owner = readOwner.current;
      if (owner?.refresh !== refresh) return null;
      const sequence = ++layoutSequence.current;
      const isCurrent = () => readOwner.current === owner && sequence === layoutSequence.current;
      setPageLayoutLoading(true);
      return runWithCleanup<DatabasePageLayoutV2 | null>(
        async () => {
          const next = await readDatabasePageLayout({
            projectId,
            dataSourceId,
            minimumCommitSeq: authorityRef.current?.snapshot.commitSeq,
          });
          if (!isCurrent()) return null;
          setPageLayout(next);
          return next;
        },
        {
          onError: (nextError) => {
            if (!isCurrent()) return null;
            console.error("[database-settings:page-layout]", nextError);
            setError(settingsErrorMessage(nextError));
            return null;
          },
          cleanup: () => {
            if (isCurrent()) setPageLayoutLoading(false);
          },
        },
      );
    },
    [projectId, refresh],
  );

  const projectionRegistration: ProjectionRegistration | null =
    database && retainedDatabase
      ? {
          scope: {
            kind: "project" as const,
            libraryId: database.database.libraryId,
            projectId,
          },
          consumerKey: `database-settings:${projectId}:${databaseId}`,
          getDependencies: () => ({
            aggregate: false as const,
            databaseIds: [database.database.databaseId],
            dataSourceIds: database.views
              .filter((view) => view.viewId === activeViewId)
              .map((view) => view.dataSourceId),
            viewIds: database.views.map((view) => view.viewId),
          }),
          getCursor: () => {
            const { storeEpoch, commitSeq } = retainedDatabase.snapshot;
            return { storeEpoch, commitSeq };
          },
          invalidate: async () => {
            const next = await refresh();
            if (pageLayout && next) await loadPageLayout(next.dataSource.dataSourceId);
          },
        }
      : null;
  useProjectionRegistration(projectionRegistration);

  const mutate = async (request: {
    readonly pendingKey: string;
    readonly preferredViewId?: string | null;
    readonly buildOperations: (
      authority: DatabaseSettingsAuthority,
    ) => readonly DatabaseApplyOperationV2[];
  }): Promise<DatabaseSettingsAuthority | null> => {
    if (!databaseId || pendingKey !== null) return null;
    const sameDatabase = () =>
      readOwner.current?.projectId === projectId && readOwner.current.databaseId === databaseId;
    setPendingKey(request.pendingKey);
    setError(null);
    return runWithCleanup<DatabaseSettingsAuthority | null>(
      async () => {
        const next = await commitDatabaseSettingsOperations({
          projectId,
          databaseId,
          preferredViewId: request.preferredViewId ?? activeViewId,
          operationId: createUuidV7(),
          buildOperations: request.buildOperations,
        });
        if (!sameDatabase()) return null;
        readSequence.current++;
        setRetainedDatabase({ descriptor: next.database, snapshot: next.snapshot });
        applyAuthority(next);
        setLoading(false);
        if (readOwner.current?.refresh !== refresh) void readOwner.current?.refresh();
        return next;
      },
      {
        onError: (nextError) => {
          console.error("[database-settings:mutation]", nextError);
          if (sameDatabase()) {
            setError(settingsErrorMessage(nextError));
            void readOwner.current?.refresh();
          }
          return null;
        },
        cleanup: () => {
          setPendingKey(null);
        },
      },
    );
  };

  return {
    database,
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
