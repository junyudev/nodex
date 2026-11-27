import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChatIcon, FolderIcon, ProjectActionsIcon } from "@/components/shared/icons";
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
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { toastFailure } from "@/lib/failure-toast";
import { useIntl } from "@/lib/i18n";
import { readableIpcError } from "@/lib/ipc-error-message";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { previewSortChatsIntoProjects, sortChatsIntoProjects } from "@/lib/session-folders";
import { toast } from "@/components/ui/toast";
import { CodexSidebarActionButton } from "./codex-sidebar";

export function SidebarChatsSectionMenu() {
  const intl = useIntl();
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ["session-folder", "preview-sort"],
    queryFn: previewSortChatsIntoProjects,
    enabled: open,
    retry: false,
    staleTime: 0,
  });
  const title = intl.formatMessage({
    id: "workbench.sidebarChatsSection.sortTitle",
    defaultMessage: "Sort chats into projects",
  });
  const destinations = preview.data?.destinations ?? [];
  const moving = destinations.reduce(
    (total, { placement, count }) => total + (placement.kind === "chats" ? 0 : count),
    0,
  );
  const sort = async () => {
    if (!preview.data || busy) return;
    setBusy(true);
    const { planId } = preview.data;
    await runWithCleanup(
      async () => {
        const { moved, skipped } = await sortChatsIntoProjects(planId);
        setOpen(false);
        const message = intl.formatMessage(
          {
            id: "workbench.sidebarChatsSection.sorted",
            defaultMessage: "{moved, plural, one {# chat moved} other {# chats moved}}",
          },
          { moved },
        );
        if (skipped > 0) {
          toast.warning(message, {
            description: intl.formatMessage(
              {
                id: "workbench.sidebarChatsSection.sortSkipped",
                defaultMessage:
                  "{skipped, plural, one {# chat couldn't be moved} other {# chats couldn't be moved}}",
              },
              { skipped },
            ),
          });
        } else {
          toast.success(message);
        }
      },
      {
        onError: (cause) => {
          toastFailure(title, cause);
          void preview.refetch();
        },
        cleanup: () => setBusy(false),
      },
    );
  };

  return (
    <>
      <NodexDropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        side="bottom"
        align="end"
        triggerButton={
          <CodexSidebarActionButton
            label={intl.formatMessage({
              id: "workbench.sidebarChatsSection.options",
              defaultMessage: "Chats options",
            })}
          >
            <ProjectActionsIcon />
          </CodexSidebarActionButton>
        }
      >
        <NodexDropdownItem
          leftSlot={<FolderIcon className="icon-xs" />}
          onSelect={() => setOpen(true)}
        >
          {title}
        </NodexDropdownItem>
      </NodexDropdownMenu>
      <NodexDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <NodexDialogContent size="compact">
          <NodexDialogFrame>
            <NodexDialogHeader>
              <NodexDialogTitle>{title}</NodexDialogTitle>
              {preview.isError ? (
                <NodexDialogDescription role="alert">
                  {readableIpcError(preview.error, String(preview.error))}
                </NodexDialogDescription>
              ) : preview.isFetching ? (
                <NodexDialogDescription role="status">
                  {intl.formatMessage({
                    id: "workbench.sidebarChatsSection.sortLoading",
                    defaultMessage: "Checking chat folders…",
                  })}
                </NodexDialogDescription>
              ) : destinations.length ? (
                <>
                  <NodexDialogDescription>
                    {intl.formatMessage({
                      id: "workbench.sidebarChatsSection.sortDescription",
                      defaultMessage:
                        "Each chat moves to the project for the folder it works in. New projects are made for folders that have none.",
                    })}
                  </NodexDialogDescription>
                  <ul className="mt-1 flex flex-col overflow-hidden rounded-lg border-[0.5px] border-token-border">
                    {destinations.map(({ placement, count }) => {
                      const Icon = placement.kind === "chats" ? ChatIcon : FolderIcon;
                      return (
                        <li
                          key={placement.kind === "chats" ? "chats" : placement.projectId}
                          className="flex min-w-0 items-center gap-2 border-token-border px-3 py-2 text-sm not-last:border-b-[0.5px]"
                        >
                          <Icon className="icon-xs shrink-0 text-token-description-foreground" />
                          <span
                            className={
                              placement.kind === "chats"
                                ? "min-w-0 truncate text-token-description-foreground"
                                : "min-w-0 truncate text-token-text-primary"
                            }
                          >
                            {placement.kind === "chats"
                              ? intl.formatMessage({
                                  id: "workbench.sidebarChatsSection.staysInChats",
                                  defaultMessage: "Stays in Chats",
                                })
                              : placement.name}
                          </span>
                          {placement.kind === "new-project" ? (
                            <span className="shrink-0 rounded-sm bg-token-foreground/[0.06] px-1 text-[10px] leading-4 text-token-description-foreground">
                              {intl.formatMessage({
                                id: "workbench.sidebarChatsSection.newTag",
                                defaultMessage: "New",
                              })}
                            </span>
                          ) : null}
                          <span className="ms-auto shrink-0 text-xs text-token-description-foreground tabular-nums">
                            {intl.formatMessage(
                              {
                                id: "workbench.sidebarChatsSection.chatCount",
                                defaultMessage: "{count, plural, one {# chat} other {# chats}}",
                              },
                              { count },
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <NodexDialogDescription>
                  {intl.formatMessage({
                    id: "workbench.sidebarChatsSection.sortEmpty",
                    defaultMessage: "No chats with available folders.",
                  })}
                </NodexDialogDescription>
              )}
            </NodexDialogHeader>
            <NodexDialogFooter>
              <NodexDialogAction disabled={busy} onClick={() => setOpen(false)}>
                {intl.formatMessage({
                  id: "workbench.sidebarChatsSection.cancel",
                  defaultMessage: "Cancel",
                })}
              </NodexDialogAction>
              <NodexDialogAction
                tone="primary"
                disabled={busy || preview.isFetching || preview.isError || moving === 0}
                onClick={() => void sort()}
              >
                {moving > 0
                  ? intl.formatMessage(
                      {
                        id: "workbench.sidebarChatsSection.moveChats",
                        defaultMessage: "{count, plural, one {Move # chat} other {Move # chats}}",
                      },
                      { count: moving },
                    )
                  : intl.formatMessage({
                      id: "workbench.sidebarChatsSection.sort",
                      defaultMessage: "Sort chats",
                    })}
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </>
  );
}
