import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { type ComposerChatKey, composerDraftIntents } from "@/lib/composer-draft-intents";
import { useState, type ReactNode } from "react";
import { writeTextToClipboard } from "@/lib/clipboard";
import { useQuery } from "@tanstack/react-query";
import {
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
  NodexContextMenuPortal,
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuSubmenu,
  NodexContextMenuSubmenuTrigger,
} from "@/components/ui/context-menu";
import {
  AttachmentIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  OpenInIcon,
} from "@/components/shared/icons";
import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
import { NodexDropdownSeparator } from "@/components/ui/dropdown";
import { FILE_LINK_OPENER_ICON_URLS } from "@/lib/file-link-opener-icons";
import { toast } from "@/components/ui/toast";
import { getFileTreeEventPath } from "@/lib/file-tree-paths";
import { listAvailableFileLinkOpeners } from "@/lib/file-system-operations";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { useFileLinkOpener } from "@/lib/use-file-link-opener";
import { saveWorkspaceFileCopy } from "@/lib/workspace-file-operations";
import {
  FILE_LINK_OPENER_LABEL_MESSAGES,
  FILE_LINK_OPENER_OPTIONS,
  type FileLinkOpenerId,
} from "../../../shared/file-link-openers";

function FileOpenerIcon({ opener }: { readonly opener: FileLinkOpenerId }) {
  const iconUrl = FILE_LINK_OPENER_ICON_URLS[opener];
  return iconUrl ? <img alt="" src={iconUrl} className="icon-xs object-contain" /> : <OpenInIcon />;
}

/** A file's menu keeps its real identity even when tree labels are compressed or disambiguated. */
export function FileTreeContextMenu({
  children,
  resolvePath,
  composerChatKey,
}: {
  readonly children: ReactNode;
  readonly resolvePath: (treePath: string) => string | null;
  readonly composerChatKey?: ComposerChatKey | null;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const router = useFileReferenceRouter();
  const { opener } = useFileLinkOpener();
  const available = useQuery({
    queryKey: ["file-tree-openers"],
    queryFn: listAvailableFileLinkOpeners,
    enabled: open,
    staleTime: 30_000,
  });
  const options = FILE_LINK_OPENER_OPTIONS.filter((item) => available.data?.includes(item.id));
  const openerLabel = (item: (typeof options)[number]) => {
    const message = FILE_LINK_OPENER_LABEL_MESSAGES[item.id];
    return message ? intl.formatMessage(message) : item.label;
  };
  const preferred = options.find((item) => item.id === opener) ?? options[0];
  const alternatives = options.filter((item) => item.id !== preferred?.id);
  const run = (operation: () => Promise<unknown>) => {
    void operation().catch((error: unknown) =>
      toast.danger(
        error instanceof Error
          ? error.message
          : getIntl().formatMessage({
              id: "workbench.fileTreeContextMenu.actionFailed",
              defaultMessage: "Unable to complete file action",
            }),
      ),
    );
  };
  const openExternal = (target: FileLinkOpenerId) => {
    if (!path) return;
    run(async () => {
      if (!(await router.open({ path }, { external: true, opener: target })))
        throw new Error(
          getIntl().formatMessage({
            id: "workbench.fileTreeContextMenu.openFailed",
            defaultMessage: "Unable to open file",
          }),
        );
    });
  };
  return (
    <NodexContextMenuRoot open={open} onOpenChange={setOpen}>
      <NodexContextMenuTrigger>
        <div
          className="h-full min-h-0"
          onContextMenuCapture={(event) => {
            const treePath = getFileTreeEventPath(event.nativeEvent, true);
            const next = treePath ? resolvePath(treePath) : null;
            if (!next) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            setPath(next);
          }}
        >
          {children}
        </div>
      </NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent>
          {preferred ? (
            <>
              <NodexContextMenuItem
                leftSlot={<FileOpenerIcon opener={preferred.id} />}
                onSelect={() => openExternal(preferred.id)}
              >
                {intl.formatMessage(
                  { id: "workbench.fileTreeContextMenu.openIn", defaultMessage: "Open in {app}" },
                  { app: openerLabel(preferred) },
                )}
              </NodexContextMenuItem>
              {alternatives.length > 0 ? (
                <NodexContextMenuSubmenu
                  trigger={
                    <NodexContextMenuSubmenuTrigger
                      leftSlot={<NativeMenuIcon iconKey="window" />}
                      rightSlot={<ChevronRightIcon className="icon-xs opacity-75" />}
                    >
                      <FormattedMessage
                        id="workbench.fileTreeContextMenu.openWith"
                        defaultMessage="Open with"
                      />
                    </NodexContextMenuSubmenuTrigger>
                  }
                  renderContent={() =>
                    alternatives.map((item) => (
                      <NodexContextMenuItem
                        key={item.id}
                        leftSlot={<FileOpenerIcon opener={item.id} />}
                        onSelect={() => openExternal(item.id)}
                      >
                        {openerLabel(item)}
                      </NodexContextMenuItem>
                    ))
                  }
                />
              ) : null}
              <NodexDropdownSeparator />
            </>
          ) : null}
          <NodexContextMenuItem
            leftSlot={<DownloadIcon />}
            onSelect={() => path && run(() => saveWorkspaceFileCopy({ path }))}
          >
            <FormattedMessage
              id="workbench.fileTreeContextMenu.saveAs"
              defaultMessage="Save a copy"
            />
          </NodexContextMenuItem>
          <NodexContextMenuItem
            leftSlot={<CopyIcon />}
            onSelect={() =>
              path &&
              run(async () => {
                if (!(await writeTextToClipboard(path)))
                  throw new Error(
                    getIntl().formatMessage({
                      id: "workbench.fileTreeContextMenu.copyPathFailed",
                      defaultMessage: "Unable to copy path",
                    }),
                  );
              })
            }
          >
            <FormattedMessage
              id="workbench.fileTreeContextMenu.copyPath"
              defaultMessage={"Copy path"}
            />
          </NodexContextMenuItem>
          {composerChatKey ? (
            <NodexContextMenuItem
              leftSlot={<AttachmentIcon />}
              onSelect={() => {
                if (!path) return;
                composerDraftIntents.set(composerChatKey, {
                  prompt: "",
                  focusNonce: Date.now(),
                  attachmentMode: "append",
                  promptInput: {
                    text: "",
                    addedFiles: [
                      {
                        label: path.split(/[\\/]/).at(-1) ?? path,
                        path,
                        fsPath: path,
                        hostId: "local",
                      },
                    ],
                  },
                });
              }}
            >
              <FormattedMessage
                id="workbench.fileTreeContextMenu.addToChat"
                defaultMessage={"Add to chat"}
              />
            </NodexContextMenuItem>
          ) : null}
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}
