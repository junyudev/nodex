import { startTransition, useDeferredValue, useEffect, useState } from "react";
import { DeleteIcon, SearchIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexSettingsPageSurface, NodexSettingsSection } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { subscribeCodexEvents, subscribeProjectSessionChanges } from "@/lib/api";
import { workspaceSessionCommands } from "@/lib/workspace-catalog-commands";
import {
  deleteArchivedChat,
  readArchivedChats,
  unarchiveChat,
} from "@/lib/workbench-settings-runtime";
import { isCodexAgentBackendBinding } from "../../../shared/agent-backend";
import type { CodexSidebarSnapshot, CodexSidebarThreadItem } from "../../../shared/types";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

type ArchivedChatGrouping = "project" | "none";
type ArchivedChatSort = "updated" | "created";

type DeleteConfirmation =
  | { readonly kind: "all"; readonly chats: readonly CodexSidebarThreadItem[] }
  | {
      readonly kind: "project";
      readonly label: string;
      readonly chats: readonly CodexSidebarThreadItem[];
    }
  | { readonly kind: "single"; readonly chats: readonly [CodexSidebarThreadItem] };

interface ArchivedChatGroup {
  readonly id: string;
  readonly label: string;
  readonly chats: readonly CodexSidebarThreadItem[];
}

function timestampMs(value: number): number {
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function chatTitle(chat: CodexSidebarThreadItem): string {
  return chat.title.trim() || chat.preview.trim() || "Untitled chat";
}

function requireSessionId(chat: CodexSidebarThreadItem): string {
  if (chat.sessionId) return chat.sessionId;
  throw new Error(`Archived ${chat.backendBinding.kind} chat has no durable Session identity.`);
}

export function selectArchivedRootChats(snapshot: CodexSidebarSnapshot): CodexSidebarThreadItem[] {
  return snapshot.items.filter((item) => item.archived && item.parentThreadId === null);
}

export function projectArchivedChatGroups(input: {
  readonly chats: readonly CodexSidebarThreadItem[];
  readonly grouping: ArchivedChatGrouping;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly query: string;
  readonly sort: ArchivedChatSort;
}): ArchivedChatGroup[] {
  const query = input.query.trim().toLocaleLowerCase();
  const timestamp = (chat: CodexSidebarThreadItem) =>
    input.sort === "created" ? chat.createdAt : (chat.recencyAt ?? chat.updatedAt);
  const filtered = input.chats
    .filter((chat) => {
      if (!query) return true;
      const projectName = chat.projectId ? (input.projectNames.get(chat.projectId) ?? "") : "";
      return [chatTitle(chat), chat.preview, chat.cwd ?? "", projectName]
        .join("\n")
        .toLocaleLowerCase()
        .includes(query);
    })
    .toSorted((left, right) => timestamp(right) - timestamp(left));
  if (input.grouping === "none") {
    return [{ id: "all", label: "Archived chats", chats: filtered }];
  }

  const groups = new Map<string, CodexSidebarThreadItem[]>();
  for (const chat of filtered) {
    const id = chat.projectId ?? "projectless";
    const group = groups.get(id) ?? [];
    group.push(chat);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, chats]) => ({
      id,
      label:
        id === "projectless" ? "No project" : (input.projectNames.get(id) ?? "Unknown project"),
      chats,
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<ReadonlyArray<{ readonly value: T; readonly cause: unknown }>> {
  let cursor = 0;
  const failures: Array<{ readonly value: T; readonly cause: unknown }> = [];
  const worker = async () => {
    while (cursor < values.length) {
      const value = values[cursor];
      cursor += 1;
      if (value === undefined) return;
      try {
        await operation(value);
      } catch (cause) {
        failures.push({ value, cause });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return failures;
}

function ArchivedChatDeleteDialog({
  confirmation,
  busy,
  onClose,
  onConfirm,
}: {
  readonly confirmation: DeleteConfirmation | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  if (!confirmation) return null;
  const title =
    confirmation.kind === "all"
      ? "Delete all archived local chats?"
      : confirmation.kind === "project"
        ? "Delete all in project?"
        : "Delete archived chat?";
  const description =
    confirmation.kind === "all"
      ? "This permanently deletes all local archived chats."
      : confirmation.kind === "project"
        ? `This permanently deletes ${confirmation.chats.length} archived ${confirmation.chats.length === 1 ? "chat" : "chats"} in ${confirmation.label}.`
        : "This permanently deletes the archived chat.";

  return (
    <NodexDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>{title}</NodexDialogTitle>
            <NodexDialogDescription>{description}</NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction disabled={busy} onClick={onClose}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction tone="danger" disabled={busy} onClick={onConfirm}>
              {busy ? "Deleting…" : "Delete"}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function ArchivedChatsSettingsPage({
  onOpenThread,
  open,
  projects,
}: SettingsSectionPageProps) {
  const [chats, setChats] = useState<readonly CodexSidebarThreadItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [grouping, setGrouping] = useState<ArchivedChatGrouping>("project");
  const [sort, setSort] = useState<ArchivedChatSort>("updated");
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<DeleteConfirmation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const groups = projectArchivedChatGroups({
    chats,
    grouping,
    projectNames,
    query: deferredQuery,
    sort,
  });
  const matchingCount = groups.reduce((count, group) => count + group.chats.length, 0);

  const load = async (refresh: boolean) => {
    const snapshot = await readArchivedChats(refresh);
    startTransition(() => {
      setChats(selectArchivedRootChats(snapshot));
      setLoadError(null);
    });
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    void load(true)
      .catch((cause) => {
        if (!active) return;
        setLoadError(cause instanceof Error ? cause.message : "Could not load archived chats.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const unsubscribeCodex = subscribeCodexEvents((event) => {
      if (event.type !== "threadArchivedState" && event.type !== "threadDeleted") return;
      void load(false).catch(() => undefined);
    });
    const unsubscribeSessions = subscribeProjectSessionChanges(() => {
      void load(false).catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribeCodex();
      unsubscribeSessions();
    };
  }, [open]);

  const unarchive = async (chat: CodexSidebarThreadItem) => {
    setBusyThreadId(chat.threadId);
    try {
      const restored = isCodexAgentBackendBinding(chat.backendBinding)
        ? await unarchiveChat(chat.threadId)
        : await workspaceSessionCommands.unarchive(requireSessionId(chat));
      setChats((current) => current.filter((candidate) => candidate.threadId !== chat.threadId));
      toast.success("Unarchived chat", {
        ...(restored && onOpenThread
          ? {
              action: {
                label: "Open",
                onClick: () => {
                  void onOpenThread(chat.threadId);
                },
              },
            }
          : {}),
      });
    } catch (cause) {
      toast.danger("Failed to unarchive chat", {
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setBusyThreadId(null);
    }
  };

  const deleteConfirmed = async () => {
    if (!confirmation) return;
    const target = confirmation;
    setDeleting(true);
    setChats((current) =>
      current.filter(
        (candidate) => !target.chats.some((chat) => chat.threadId === candidate.threadId),
      ),
    );
    try {
      const failures = await runWithConcurrency(target.chats, 4, async (chat) => {
        if (!isCodexAgentBackendBinding(chat.backendBinding)) {
          await workspaceSessionCommands.delete(requireSessionId(chat));
          return;
        }
        if (await deleteArchivedChat(chat.threadId)) return;
        throw new Error(`Could not delete ${chatTitle(chat)}`);
      });
      if (failures.length > 0) {
        const firstCause = failures[0]?.cause;
        const firstMessage = firstCause instanceof Error ? firstCause.message : null;
        throw new AggregateError(
          failures.map(({ cause }) => cause),
          [
            `${failures.length} archived ${failures.length === 1 ? "chat" : "chats"} could not be deleted.`,
            firstMessage,
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
      setConfirmation(null);
      toast.success(
        target.chats.length === 1
          ? "Deleted archived chat"
          : `Deleted ${target.chats.length} archived chats`,
      );
    } catch (cause) {
      await load(true).catch(() => undefined);
      // The original confirmation snapshot may now contain successfully deleted
      // Threads. Close it so a retry is always formed from the refreshed authority.
      setConfirmation(null);
      toast.danger(
        target.chats.length === 1
          ? "Failed to delete archived chat"
          : "Failed to delete archived chats",
        {
          description: cause instanceof Error ? cause.message : undefined,
        },
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <NodexSettingsPageSurface
      title="Data controls"
      subtitle="Manage archived chats and permanent local deletion."
      fullWidth
      action={
        chats.length > 0 ? (
          <NodexButton
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={() => setConfirmation({ kind: "all", chats })}
          >
            Delete all
          </NodexButton>
        ) : null
      }
    >
      <NodexSettingsSection title="Archived chats" cardClassName="overflow-visible">
        {loading ? (
          <p role="status" className="px-4 py-3 text-sm text-token-text-secondary">
            Loading archived chats…
          </p>
        ) : loadError ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <p role="alert" className="text-sm text-token-error-foreground">
              Could not load archived chats.
            </p>
            <NodexButton size="xs" variant="secondary" onClick={() => void load(true)}>
              Retry
            </NodexButton>
          </div>
        ) : chats.length === 0 ? (
          <p className="px-4 py-3 text-sm text-token-text-secondary">No archived chats.</p>
        ) : (
          <div className="flex flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-token-border p-3">
              <label className="relative min-w-48 flex-1">
                <span className="sr-only">Search archived chats</span>
                <SearchIcon className="icon-2xs pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-token-text-tertiary" />
                <input
                  aria-label="Search archived chats"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search archived chats"
                  className="h-8 w-full rounded-lg border border-token-border bg-token-input-background pr-3 pl-8 text-sm text-token-text-primary outline-none focus-visible:ring-2 focus-visible:ring-token-focus"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-token-text-secondary">
                Group
                <select
                  aria-label="Group archived chats"
                  value={grouping}
                  onChange={(event) =>
                    setGrouping(event.currentTarget.value as ArchivedChatGrouping)
                  }
                  className="h-8 rounded-lg border border-token-border bg-token-input-background px-2 text-sm text-token-text-primary outline-none focus-visible:ring-2 focus-visible:ring-token-focus"
                >
                  <option value="project">Project</option>
                  <option value="none">None</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-token-text-secondary">
                Sort
                <select
                  aria-label="Sort archived chats"
                  value={sort}
                  onChange={(event) => setSort(event.currentTarget.value as ArchivedChatSort)}
                  className="h-8 rounded-lg border border-token-border bg-token-input-background px-2 text-sm text-token-text-primary outline-none focus-visible:ring-2 focus-visible:ring-token-focus"
                >
                  <option value="updated">Updated</option>
                  <option value="created">Created</option>
                </select>
              </label>
            </div>
            {matchingCount === 0 ? (
              <p className="px-4 py-3 text-sm text-token-text-secondary">
                No matching archived chats
              </p>
            ) : (
              groups.map((group) =>
                group.chats.length === 0 ? null : (
                  <div key={group.id} className="flex flex-col">
                    {grouping === "project" ? (
                      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-token-main-surface-primary px-4 py-2 text-xs text-token-text-secondary">
                        <span className="truncate font-medium">{group.label}</span>
                        <div className="flex items-center gap-2">
                          <span>
                            {group.chats.length} {group.chats.length === 1 ? "chat" : "chats"}
                          </span>
                          <NodexButton
                            aria-label={`Delete archived chats in ${group.label}`}
                            size="xs"
                            variant="ghost"
                            disabled={deleting}
                            onClick={() =>
                              setConfirmation({
                                kind: "project",
                                label: group.label,
                                chats: group.chats,
                              })
                            }
                          >
                            Delete all
                          </NodexButton>
                        </div>
                      </div>
                    ) : null}
                    {group.chats.map((chat) => {
                      const date = new Date(timestampMs(chat.recencyAt ?? chat.updatedAt));
                      const projectName = chat.projectId ? projectNames.get(chat.projectId) : null;
                      return (
                        <div
                          key={chat.threadId}
                          className="group flex items-center justify-between gap-3 border-t border-token-border px-4 py-3 first:border-t-0 hover:bg-token-list-hover-background"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-token-text-primary">
                              {chatTitle(chat)}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-token-text-secondary">
                              {Number.isFinite(date.getTime())
                                ? date.toLocaleString(undefined, {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  })
                                : null}
                              {grouping === "none" && projectName ? ` • ${projectName}` : ""}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                            <NodexButton
                              aria-label={`Delete archived chat ${chatTitle(chat)}`}
                              size="icon-xs"
                              variant="ghost"
                              disabled={deleting || busyThreadId !== null}
                              onClick={() => setConfirmation({ kind: "single", chats: [chat] })}
                              className="text-token-error-foreground hover:bg-token-error-background/10"
                            >
                              <DeleteIcon />
                            </NodexButton>
                            <NodexButton
                              size="xs"
                              variant="secondary"
                              disabled={deleting || busyThreadId !== null}
                              onClick={() => void unarchive(chat)}
                            >
                              {busyThreadId === chat.threadId ? "Unarchiving…" : "Unarchive"}
                            </NodexButton>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ),
              )
            )}
          </div>
        )}
      </NodexSettingsSection>
      <ArchivedChatDeleteDialog
        confirmation={confirmation}
        busy={deleting}
        onClose={() => setConfirmation(null)}
        onConfirm={() => void deleteConfirmed()}
      />
    </NodexSettingsPageSurface>
  );
}
