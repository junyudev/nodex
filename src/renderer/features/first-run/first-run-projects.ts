import { useQuery } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { useSyncExternalStore } from "react";
import { nativeConversationImportLedger } from "@/lib/native-conversation-import-ledger";
import {
  nativeConversationCandidate,
  nativeConversationImportSelection,
} from "@/lib/native-conversation-import-model";
import { discoverNativeProjects, importNativeConversation } from "@/lib/native-session-catalog";
import { pickProjectSourceRoots } from "@/lib/workbench-shell-operations";
import type { ProjectCandidateChat } from "../../../shared/project-discovery";

export const chooseProjectFolders = pickProjectSourceRoots;

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
    {
      backendKind: chat.backendKind,
      ...(chat.instanceConfigId ? { instanceConfigId: chat.instanceConfigId } : {}),
    },
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
      toast.success(copied === 1 ? "1 chat imported" : `${copied} chats imported`);
    } else {
      toast.warning(`${copied} of ${items.length} chats imported`, {
        description: "Retry the rest in Settings → Conversations.",
      });
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
