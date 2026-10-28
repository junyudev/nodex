import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { usePageChatActivitySummaries } from "@/lib/use-page-chat-activity-summaries";
import { queryKeys } from "@/lib/query-keys";
import { unlinkPageChat } from "@/lib/page-chat-runtime";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import type { PageChatActivitySummary } from "@/lib/types";

interface DatabasePageChatActivityRuntimeValue {
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
  const activityByPageId = usePageChatActivitySummaries(
    model.query.rows.map((row) => row.page.pageId),
  );
  const removeRelation = useCallback(
    async (pageId: string, sessionId: string): Promise<void> => {
      await unlinkPageChat(sessionId, { pageId });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pageChats.all() });
    },
    [queryClient],
  );
  const value = useMemo(
    () => ({ activityByPageId, removeRelation }),
    [activityByPageId, removeRelation],
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
