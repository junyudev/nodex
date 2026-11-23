import { getIntl } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { useSyncExternalStore } from "react";
import { nativeConversationImportLedger } from "@/lib/native-conversation-import-ledger";
import {
  nativeConversationCandidate,
  nativeSessionSource,
  nativeConversationImportSelection,
} from "@/lib/native-conversation-import-model";
import { discoverNativeProjects, importNativeConversation } from "@/lib/native-session-catalog";
import { localPathPresentationContextQueryOptions } from "@/lib/query-options";
import { pickProjectSourceRoots } from "@/lib/workbench-shell-operations";
import { abbreviateHomeDirectory } from "../../../shared/local-path-presentation";
import type { ProjectCandidateChat } from "../../../shared/project-discovery";

export const chooseProjectFolders = pickProjectSourceRoots;

/** Shows a folder the person chose the way found folders read, as `~/…` inside their home. */
export function useFolderLabel(): (path: string) => string {
  const context = useQuery(localPathPresentationContextQueryOptions()).data ?? null;
  return (path) => abbreviateHomeDirectory(path, context);
}

/** Scans history when the person reaches this step, which may be what prompts for folder access. */
export function useProjectCandidates(enabled: boolean) {
  return useQuery({
    queryKey: ["first-run", "project-candidates"],
    queryFn: discoverNativeProjects,
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export interface ChatImportProgress {
  readonly total: number;
  readonly settled: number;
  readonly failed: number;
}

const IMPORT_CONCURRENCY = 2;
const listeners = new Set<() => void>();
let progress: ChatImportProgress | null = null;
const publish = (next: ChatImportProgress | null) => {
  progress = next;
  for (const listener of listeners) listener();
};

async function importChat(item: {
  readonly projectId: string;
  readonly chat: ProjectCandidateChat;
}): Promise<boolean> {
  const { chat, projectId } = item;
  const candidate = nativeConversationCandidate(
    nativeSessionSource(chat),
    chat.nativeHome,
    {
      nativeSessionId: chat.nativeSessionId,
      title: chat.title,
      cwd: chat.cwd,
      cwdAvailable: true,
      updatedAt: chat.updatedAt,
    },
    nativeConversationImportLedger.now(),
  );
  const settlement = await nativeConversationImportLedger.submit(
    candidate,
    nativeConversationImportSelection(candidate, projectId, chat.cwd),
    importNativeConversation,
  );
  return settlement.kind === "imported";
}

/**
 * Copies chats behind whatever the person does next, through the same ledger Settings shows, so a
 * chat that fails can be retried there. Each copy appears in the sidebar as it finishes.
 */
export function importRecentChats(
  items: readonly { readonly projectId: string; readonly chat: ProjectCandidateChat }[],
): void {
  if (items.length === 0 || progress) return;
  const queue = [...items];
  let settled = 0;
  let failed = 0;
  publish({ total: items.length, settled, failed });
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const imported = await importChat(item).catch(() => false);
      settled += 1;
      if (!imported) failed += 1;
      publish({ total: items.length, settled, failed });
    }
  };
  void Promise.all(Array.from({ length: IMPORT_CONCURRENCY }, worker)).then(() => {
    publish(null);
    const copied = items.length - failed;
    if (failed === 0) {
      toast.success(
        copied === 1
          ? getIntl().formatMessage({
              id: "firstRun.firstRunProjects.label1ChatImported",
              defaultMessage: "1 chat imported",
            })
          : getIntl().formatMessage(
              {
                id: "firstRun.firstRunProjects.valueChatsImported",
                defaultMessage: "{value1} chats imported",
              },
              { value1: copied },
            ),
      );
    } else {
      toast.warning(
        getIntl().formatMessage(
          {
            id: "firstRun.firstRunProjects.valueOfValueChatsImported",
            defaultMessage: "{value1} of {value2} chats imported",
          },
          { value1: copied, value2: items.length },
        ),
        {
          description: getIntl().formatMessage({
            id: "firstRun.firstRunProjects.retryTheRestInSettings",
            defaultMessage: "Retry the rest in Settings → Import.",
          }),
        },
      );
    }
  });
}

export function useChatImportProgress(): ChatImportProgress | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => progress,
  );
}
