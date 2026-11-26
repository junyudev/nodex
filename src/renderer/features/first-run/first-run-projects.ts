import { getIntl } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { useSyncExternalStore } from "react";
import { importNativeAutomation } from "@/lib/native-automation-import";
import type { NativeAutomationSelection } from "../../../shared/native-automation-import";
import { nativeConversationImportLedger } from "@/lib/native-conversation-import-ledger";
import {
  nativeConversationCandidate,
  nativeSessionSource,
  nativeConversationImportSelection,
} from "@/lib/native-conversation-import-model";
import {
  discoverNativeProjects,
  ensureFolderProject,
  importNativeConversation,
} from "@/lib/native-session-catalog";
import { localPathPresentationContextQueryOptions } from "@/lib/query-options";
import { pickProjectSourceRoots } from "@/lib/workbench-shell-operations";
import { abbreviateHomeDirectory } from "../../../shared/local-path-presentation";
import type { ProjectCandidateChat } from "../../../shared/project-discovery";

export const chooseProjectFolders = pickProjectSourceRoots;
export const createFolderProject = ensureFolderProject;

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
    refetchOnMount: "always",
  });
}

type ImportKind = "chats" | "automations";

export interface ChatImportProgress {
  readonly kind: ImportKind | "both";
  readonly total: number;
  readonly settled: number;
  readonly failed: number;
}

const IMPORT_CONCURRENCY = 2;
const listeners = new Set<() => void>();
let progress: ChatImportProgress | null = null;
const active = new Map<ImportKind, Omit<ChatImportProgress, "kind">>();
const publish = (kind: ImportKind, next: Omit<ChatImportProgress, "kind"> | null) => {
  if (next) active.set(kind, next);
  else active.delete(kind);
  progress = active.size
    ? {
        kind: active.size === 2 ? "both" : active.has("chats") ? "chats" : "automations",
        total: [...active.values()].reduce((sum, item) => sum + item.total, 0),
        settled: [...active.values()].reduce((sum, item) => sum + item.settled, 0),
        failed: [...active.values()].reduce((sum, item) => sum + item.failed, 0),
      }
    : null;
  for (const listener of listeners) listener();
};

async function importChat(chat: ProjectCandidateChat): Promise<boolean> {
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
    nativeConversationImportSelection(candidate, chat.cwd),
    importNativeConversation,
  );
  return settlement.kind === "imported";
}

function importInBackground<Item>(
  kind: ImportKind,
  items: readonly Item[],
  importItem: (item: Item) => Promise<boolean>,
  completed: (copied: number, total: number) => void,
): void {
  if (!items.length || active.has(kind)) return;
  const queue = [...items];
  let settled = 0;
  let failed = 0;
  publish(kind, { total: items.length, settled, failed });
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const imported = await importItem(item).catch(() => false);
      settled += 1;
      if (!imported) failed += 1;
      publish(kind, { total: items.length, settled, failed });
    }
  };
  void Promise.all(Array.from({ length: IMPORT_CONCURRENCY }, worker)).then(() => {
    publish(kind, null);
    completed(items.length - failed, items.length);
  });
}

const retryDescription = () =>
  getIntl().formatMessage({
    id: "firstRun.firstRunProjects.retryTheRestInSettings",
    defaultMessage: "Retry the rest in Settings → Import.",
  });

/** Conversation copies keep their usual Settings import ledger while setup continues. */
export function importRecentChats(items: readonly ProjectCandidateChat[]): void {
  importInBackground("chats", items, importChat, (copied, total) => {
    if (copied === total) {
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
          { value1: copied, value2: total },
        ),
        { description: retryDescription() },
      );
    }
  });
}

export function importScheduledTasks(items: readonly NativeAutomationSelection[]): void {
  importInBackground(
    "automations",
    items,
    async (item) => (await importNativeAutomation(item)).kind === "imported",
    (copied, total) => {
      const intl = getIntl();
      if (copied === total) {
        toast.success(
          intl.formatMessage(
            {
              id: "firstRun.firstRunProjects.automationsImported",
              defaultMessage:
                "{count, plural, one {# automation imported} other {# automations imported}}",
            },
            { count: copied },
          ),
        );
        return;
      }
      toast.warning(
        intl.formatMessage(
          {
            id: "firstRun.firstRunProjects.partialAutomations",
            defaultMessage: "{copied} of {total} automations imported",
          },
          { copied, total },
        ),
        { description: retryDescription() },
      );
    },
  );
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
