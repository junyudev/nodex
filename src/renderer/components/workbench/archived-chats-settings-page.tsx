import { presentSessionTitle } from "@/lib/session-title-presentation";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { getIntl, useIntl } from "@/lib/i18n";
import { projectAutomationPromptPreview } from "../../../shared/automation-heartbeat";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { startTransition, useDeferredValue, useEffect, useEffectEvent, useState } from "react";
import { Archive16Icon, DeleteIcon, SearchIcon } from "@/components/shared/icons";
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
import { isHostedChat } from "@/lib/hosted-chat";
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

function chatTitle(chat: CodexSidebarThreadItem, intl = getIntl()): string {
  const title = projectAutomationPromptPreview(chat.title).trim();
  if (title) return presentSessionTitle(title, intl);
  return (
    projectAutomationPromptPreview(chat.preview).trim() ||
    intl.formatMessage({
      id: "settings.archivedChats.untitledChat",
      defaultMessage: "Untitled chat",
    })
  );
}

function isNativeThreadChat(chat: CodexSidebarThreadItem): boolean {
  return isCodexAgentBackendBinding(chat.backendBinding) && !chat.runtimeBound;
}

function requireSessionId(chat: CodexSidebarThreadItem): string {
  if (chat.sessionId) return chat.sessionId;
  throw new Error(`Archived ${chat.backendBinding.kind} chat has no durable Session identity.`);
}

export function selectArchivedRootChats(snapshot: CodexSidebarSnapshot): CodexSidebarThreadItem[] {
  return snapshot.items.filter((item) => item.archived && item.parentThreadId === null);
}

export function projectArchivedChatGroups(
  input: {
    readonly chats: readonly CodexSidebarThreadItem[];
    readonly grouping: ArchivedChatGrouping;
    readonly projectNames: ReadonlyMap<string, string>;
    readonly query: string;
    readonly sort: ArchivedChatSort;
  },
  intl = getIntl(),
): ArchivedChatGroup[] {
  const query = input.query.trim().toLocaleLowerCase();
  const timestamp = (chat: CodexSidebarThreadItem) =>
    input.sort === "created" ? chat.createdAt : (chat.recencyAt ?? chat.updatedAt);
  const filtered = input.chats
    .filter((chat) => {
      if (!query) return true;
      const projectName = chat.projectId ? (input.projectNames.get(chat.projectId) ?? "") : "";
      return [
        chatTitle(chat, intl),
        projectAutomationPromptPreview(chat.preview),
        chat.cwd ?? "",
        projectName,
      ]
        .join("\n")
        .toLocaleLowerCase()
        .includes(query);
    })
    .toSorted((left, right) => timestamp(right) - timestamp(left));
  if (input.grouping === "none") {
    return [
      {
        id: "all",
        label: intl.formatMessage(settingsMessages.archivedChatsArchivedChats),
        chats: filtered,
      },
    ];
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
        id === "projectless"
          ? intl.formatMessage({
              id: "settings.archivedChats.noProject",
              defaultMessage: "No project",
            })
          : (input.projectNames.get(id) ??
            intl.formatMessage({
              id: "settings.archivedChats.unknownProject",
              defaultMessage: "Unknown project",
            })),
      chats,
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
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
  const intl = useIntl();
  if (!confirmation) return null;
  const title =
    confirmation.kind === "all"
      ? intl.formatMessage({
          id: "settings.archivedChats.deleteAllArchivedLocalChats",
          defaultMessage: "Delete all archived local chats?",
        })
      : confirmation.kind === "project"
        ? intl.formatMessage({
            id: "settings.archivedChats.deleteAllInProject",
            defaultMessage: "Delete all in project?",
          })
        : intl.formatMessage({
            id: "settings.archivedChats.deleteArchivedChat",
            defaultMessage: "Delete archived chat?",
          });
  const description =
    confirmation.kind === "all"
      ? intl.formatMessage({
          id: "settings.archivedChats.thisPermanentlyDeletesAllLocalArchived",
          defaultMessage: "This permanently deletes all local archived chats.",
        })
      : confirmation.kind === "project"
        ? intl.formatMessage(
            {
              id: "settings.archivedChats.confirmDeleteGroup",
              defaultMessage:
                "This permanently deletes {count, plural, one {# archived chat} other {# archived chats}} in {label}.",
            },
            { count: confirmation.chats.length, label: confirmation.label },
          )
        : intl.formatMessage({
            id: "settings.archivedChats.thisPermanentlyDeletesTheArchivedChat",
            defaultMessage: "This permanently deletes the archived chat.",
          });

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
              {intl.formatMessage({
                id: "settings.archivedChats.cancel",
                defaultMessage: "Cancel",
              })}
            </NodexDialogAction>
            <NodexDialogAction tone="danger" disabled={busy} onClick={onConfirm}>
              {busy
                ? intl.formatMessage({
                    id: "settings.archivedChats.deleting",
                    defaultMessage: "Deleting…",
                  })
                : intl.formatMessage({
                    id: "settings.archivedChats.delete",
                    defaultMessage: "Delete",
                  })}
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
  const intl = useIntl();
  const [chats, setChats] = useState<readonly CodexSidebarThreadItem[]>([]);
  const [loading, setLoading] = useState(open);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [grouping, setGrouping] = useState<ArchivedChatGrouping>("project");
  const [sort, setSort] = useState<ArchivedChatSort>("updated");
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<DeleteConfirmation | null>(null);
  const [deleting, setDeleting] = useState(false);
  // A team Space's archived chats stay on its host; a Member restores the ones Core lets them.
  const deletable = !isHostedChat();

  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const groups = projectArchivedChatGroups(
    {
      chats,
      grouping,
      projectNames,
      query: deferredQuery,
      sort,
    },
    intl,
  );
  const matchingCount = groups.reduce((count, group) => count + group.chats.length, 0);

  const load = async (refresh: boolean, isCurrent = () => true) => {
    const snapshot = await readArchivedChats(refresh);
    if (!isCurrent()) return;
    startTransition(() => {
      setChats(selectArchivedRootChats(snapshot));
      setLoadError(null);
    });
  };

  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (open) setLoading(true);
  }
  const loadFromSubscription = useEffectEvent(load);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const isCurrent = () => active;
    void loadFromSubscription(true, isCurrent)
      .catch((cause) => {
        if (!active) return;
        setLoadError(
          cause instanceof Error
            ? cause.message
            : getIntl().formatMessage({
                id: "settings.archivedChats.couldNotLoadArchivedChats",
                defaultMessage: "Could not load archived chats.",
              }),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const unsubscribeCodex = subscribeCodexEvents((event) => {
      if (event.type !== "threadArchivedState" && event.type !== "threadDeleted") return;
      void loadFromSubscription(false, isCurrent).catch(() => undefined);
    });
    const unsubscribeSessions = subscribeProjectSessionChanges(() => {
      void loadFromSubscription(false, isCurrent).catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribeCodex();
      unsubscribeSessions();
    };
  }, [open]);

  const unarchive = async (chat: CodexSidebarThreadItem) => {
    setBusyThreadId(chat.threadId);
    return runWithCleanup(
      async () => {
        const restored = isNativeThreadChat(chat)
          ? await unarchiveChat(chat.threadId)
          : await workspaceSessionCommands.unarchive(requireSessionId(chat));
        setChats((current) => current.filter((candidate) => candidate.threadId !== chat.threadId));
        toast.info(
          intl.formatMessage({
            id: "settings.archivedChats.unarchivedChat",
            defaultMessage: "Unarchived chat",
          }),
          {
            leading: <Archive16Icon className="size-4 shrink-0" />,
            ...(restored && onOpenThread
              ? {
                  action: {
                    label: intl.formatMessage({
                      id: "settings.archivedChats.view",
                      defaultMessage: "View",
                    }),
                    onClick: () => {
                      void onOpenThread(chat.threadId);
                    },
                  },
                }
              : {}),
          },
        );
      },
      {
        onError: (cause) => {
          toast.danger(
            intl.formatMessage({
              id: "settings.archivedChats.failedToUnarchiveChat",
              defaultMessage: "Failed to unarchive chat",
            }),
            {
              description: cause instanceof Error ? cause.message : undefined,
            },
          );
        },
        cleanup: () => {
          setBusyThreadId(null);
        },
      },
    );
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
    return runWithCleanup(
      async () => {
        for (const chat of target.chats) {
          if (!isNativeThreadChat(chat)) {
            await workspaceSessionCommands.delete(requireSessionId(chat));
            continue;
          }
          if (!(await deleteArchivedChat(chat.threadId))) {
            throw new Error(
              intl.formatMessage(
                {
                  id: "settings.archivedChats.couldNotDelete",
                  defaultMessage: "Could not delete {value}",
                },
                { value: chatTitle(chat, intl) },
              ),
            );
          }
        }
        setConfirmation(null);
        toast.success(
          target.chats.length === 1
            ? intl.formatMessage({
                id: "settings.archivedChats.deletedArchivedChat",
                defaultMessage: "Deleted archived chat",
              })
            : intl.formatMessage(
                {
                  id: "settings.archivedChats.deletedArchivedChats",
                  defaultMessage: "Deleted {length} archived chats",
                },
                { length: target.chats.length },
              ),
        );
      },
      {
        onError: async (cause) => {
          await load(true).catch(() => undefined);
          // The original confirmation snapshot may now contain successfully deleted
          // Threads. Close it so a retry is always formed from the refreshed authority.
          setConfirmation(null);
          toast.danger(
            target.chats.length === 1
              ? intl.formatMessage({
                  id: "settings.archivedChats.failedToDeleteArchivedChat",
                  defaultMessage: "Failed to delete archived chat",
                })
              : intl.formatMessage({
                  id: "settings.archivedChats.failedToDeleteArchivedChats",
                  defaultMessage: "Failed to delete archived chats",
                }),
            {
              description: cause instanceof Error ? cause.message : undefined,
            },
          );
        },
        cleanup: () => {
          setDeleting(false);
        },
      },
    );
  };

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage(settingsMessages.archivedChatsTitle)}
      subtitle={
        deletable
          ? intl.formatMessage(settingsMessages.archivedChatsManageArchivedChatsAndPermanentLocal)
          : intl.formatMessage({
              id: "settings.archivedChats.restoreArchivedChatsThisSpaceLets",
              defaultMessage: "Restore archived chats this Space lets you change.",
            })
      }
      fullWidth
      action={
        deletable && chats.length > 0 ? (
          <NodexButton
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={() => setConfirmation({ kind: "all", chats })}
          >
            {intl.formatMessage({
              id: "settings.archivedChats.deleteAll",
              defaultMessage: "Delete all",
            })}
          </NodexButton>
        ) : null
      }
    >
      <NodexSettingsSection
        title={intl.formatMessage(settingsMessages.archivedChatsArchivedChats)}
        cardClassName="overflow-visible"
      >
        {loading ? (
          <p role="status" className="px-4 py-3 text-sm text-token-text-secondary">
            {intl.formatMessage({
              id: "settings.archivedChats.loadingArchivedChats",
              defaultMessage: "Loading archived chats…",
            })}
          </p>
        ) : loadError ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <p role="alert" className="text-sm text-token-error-foreground">
              {intl.formatMessage({
                id: "settings.archivedChats.couldNotLoadArchivedChats",
                defaultMessage: "Could not load archived chats.",
              })}
            </p>
            <NodexButton size="xs" variant="secondary" onClick={() => void load(true)}>
              {intl.formatMessage({ id: "settings.archivedChats.retry", defaultMessage: "Retry" })}
            </NodexButton>
          </div>
        ) : chats.length === 0 ? (
          <p className="px-4 py-3 text-sm text-token-text-secondary">
            {intl.formatMessage({
              id: "settings.archivedChats.noArchivedChats",
              defaultMessage: "No archived chats.",
            })}
          </p>
        ) : (
          <div className="flex flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-token-border p-3">
              <label className="relative min-w-48 flex-1">
                <span className="sr-only">
                  {intl.formatMessage(settingsMessages.archivedChatsSearchArchivedChats)}
                </span>
                <SearchIcon className="icon-2xs pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-token-text-tertiary" />
                <input
                  aria-label={intl.formatMessage(settingsMessages.archivedChatsSearchArchivedChats)}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={intl.formatMessage(
                    settingsMessages.archivedChatsSearchArchivedChats,
                  )}
                  className="h-8 w-full rounded-lg border border-token-border bg-token-input-background pr-3 pl-8 text-sm text-token-text-primary outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-token-text-secondary">
                {intl.formatMessage({
                  id: "settings.archivedChats.group",
                  defaultMessage: "Group",
                })}
                <select
                  aria-label={intl.formatMessage(settingsMessages.archivedChatsGroupArchivedChats)}
                  value={grouping}
                  onChange={(event) =>
                    setGrouping(event.currentTarget.value as ArchivedChatGrouping)
                  }
                  className="h-8 rounded-lg border border-token-border bg-token-input-background px-2 text-sm text-token-text-primary outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
                >
                  <option value="project">
                    {intl.formatMessage({
                      id: "settings.archivedChats.project",
                      defaultMessage: "Project",
                    })}
                  </option>
                  <option value="none">
                    {intl.formatMessage({
                      id: "settings.archivedChats.none",
                      defaultMessage: "None",
                    })}
                  </option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-token-text-secondary">
                {intl.formatMessage({ id: "settings.archivedChats.sort", defaultMessage: "Sort" })}
                <select
                  aria-label={intl.formatMessage(settingsMessages.archivedChatsSortArchivedChats)}
                  value={sort}
                  onChange={(event) => setSort(event.currentTarget.value as ArchivedChatSort)}
                  className="h-8 rounded-lg border border-token-border bg-token-input-background px-2 text-sm text-token-text-primary outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
                >
                  <option value="updated">
                    {intl.formatMessage({
                      id: "settings.archivedChats.updated",
                      defaultMessage: "Updated",
                    })}
                  </option>
                  <option value="created">
                    {intl.formatMessage({
                      id: "settings.archivedChats.created",
                      defaultMessage: "Created",
                    })}
                  </option>
                </select>
              </label>
            </div>
            {matchingCount === 0 ? (
              <p className="px-4 py-3 text-sm text-token-text-secondary">
                {intl.formatMessage({
                  id: "settings.archivedChats.noMatchingArchivedChats",
                  defaultMessage: "No matching archived chats",
                })}
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
                            {intl.formatMessage(
                              {
                                id: "settings.archivedChats.chatCount",
                                defaultMessage: "{count, plural, one {# chat} other {# chats}}",
                              },
                              { count: group.chats.length },
                            )}
                          </span>
                          {deletable ? (
                            <NodexButton
                              aria-label={intl.formatMessage(
                                {
                                  id: "settings.archivedChats.deleteArchivedChatsIn",
                                  defaultMessage: "Delete archived chats in {label}",
                                },
                                { label: group.label },
                              )}
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
                              {intl.formatMessage({
                                id: "settings.archivedChats.deleteAll",
                                defaultMessage: "Delete all",
                              })}
                            </NodexButton>
                          ) : null}
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
                              {chatTitle(chat, intl)}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-token-text-secondary">
                              {Number.isFinite(date.getTime())
                                ? date.toLocaleString(intl.locale, {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  })
                                : null}
                              {grouping === "none" && projectName ? ` • ${projectName}` : ""}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                            {deletable ? (
                              <NodexButton
                                aria-label={intl.formatMessage(
                                  {
                                    id: "settings.archivedChats.deleteArchivedChat2",
                                    defaultMessage: "Delete archived chat {value}",
                                  },
                                  { value: chatTitle(chat, intl) },
                                )}
                                size="icon-xs"
                                variant="ghost"
                                disabled={deleting || busyThreadId !== null}
                                onClick={() => setConfirmation({ kind: "single", chats: [chat] })}
                                className="text-token-error-foreground hover:bg-token-error-background/10"
                              >
                                <DeleteIcon />
                              </NodexButton>
                            ) : null}
                            <NodexButton
                              size="xs"
                              variant="secondary"
                              disabled={deleting || busyThreadId !== null}
                              onClick={() => void unarchive(chat)}
                            >
                              {busyThreadId === chat.threadId
                                ? intl.formatMessage({
                                    id: "settings.archivedChats.unarchiving",
                                    defaultMessage: "Unarchiving…",
                                  })
                                : intl.formatMessage(settingsMessages.archivedChatsUnarchive)}
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
