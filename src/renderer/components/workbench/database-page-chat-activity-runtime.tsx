import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { pageChatActivitySummariesQueryOptions } from "@/lib/query-options";
import { queryKeys } from "@/lib/query-keys";
import { unlinkPageChat } from "@/lib/page-chat-runtime";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import type { PageChatActivitySummary } from "@/lib/types";

interface DatabasePageChatActivityRuntimeValue {
  readonly pageAccessProjectId: string | null;
  readonly activityByPageId: ReadonlyMap<string, PageChatActivitySummary>;
  readonly removeRelation: (pageId: string, sessionId: string) => Promise<void>;
}

const DatabasePageChatActivityRuntimeContext =
  createContext<DatabasePageChatActivityRuntimeValue | null>(null);

function DatabasePageChatActivityProvider({
  model,
  children,
}: {
  readonly model: DatabaseViewRenderModel;
  readonly children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const pageAccessProjectId =
    model.accessContext.kind === "project" ? model.accessContext.projectId : null;
  const activity = useQuery(
    pageChatActivitySummariesQueryOptions(
      pageAccessProjectId ?? "",
      model.query.rows.map((row) => row.page.pageId),
    ),
  );
  const activityByPageId = useMemo(
    () =>
      new Map<string, PageChatActivitySummary>(
        activity.data?.summaries.map((summary) => [summary.pageId, summary]) ?? [],
      ),
    [activity.data?.summaries],
  );
  const removeRelation = useCallback(
    async (pageId: string, sessionId: string): Promise<void> => {
      if (!pageAccessProjectId) throw new Error("A Project is required to manage linked chats");
      await unlinkPageChat(sessionId, { pageAccessProjectId, pageId });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pageChats.all() });
    },
    [pageAccessProjectId, queryClient],
  );
  const value = useMemo(
    () => ({ pageAccessProjectId, activityByPageId, removeRelation }),
    [activityByPageId, pageAccessProjectId, removeRelation],
  );
  return (
    <DatabasePageChatActivityRuntimeContext value={value}>
      {children}
    </DatabasePageChatActivityRuntimeContext>
  );
}

export function DatabasePageChatActivityBoundary({
  model,
  children,
}: {
  readonly model: DatabaseViewRenderModel;
  readonly children: ReactNode;
}) {
  const existing = useContext(DatabasePageChatActivityRuntimeContext);
  if (existing) return children;
  return (
    <DatabasePageChatActivityProvider model={model}>{children}</DatabasePageChatActivityProvider>
  );
}

export function useDatabasePageChatActivityRuntime(): DatabasePageChatActivityRuntimeValue {
  const runtime = useContext(DatabasePageChatActivityRuntimeContext);
  if (runtime) return runtime;
  throw new Error("Database Page Chat activity requires its surface boundary");
}
