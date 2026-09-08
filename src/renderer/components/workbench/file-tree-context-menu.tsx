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
import { toast } from "@/components/ui/toast";
import { setLocalConversationComposerIntent } from "@/features/local-conversation";
import { getFileTreeEventPath } from "@/lib/file-tree-paths";
import { listAvailableFileLinkOpeners } from "@/lib/file-system-operations";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { useFileLinkOpener } from "@/lib/use-file-link-opener";
import { saveWorkspaceFileCopy } from "@/lib/workspace-file-operations";
import { FILE_LINK_OPENER_OPTIONS, type FileLinkOpenerId } from "../../../shared/file-link-openers";

/** A file's menu keeps its real identity even when tree labels are compressed or disambiguated. */
export function FileTreeContextMenu({
  children,
  resolvePath,
  threadId,
}: {
  readonly children: ReactNode;
  readonly resolvePath: (treePath: string) => string | null;
  readonly threadId?: string | null;
}) {
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
  const preferred = options.find((item) => item.id === opener) ?? options[0];
  const run = (operation: () => Promise<unknown>) => {
    void operation().catch((error: unknown) =>
      toast.danger(error instanceof Error ? error.message : "Unable to complete file action"),
    );
  };
  const openExternal = (target: FileLinkOpenerId) => {
    if (!path) return;
    run(async () => {
      if (!(await router.open({ path }, { external: true, opener: target })))
        throw new Error("Unable to open file");
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
          <NodexContextMenuItem
            disabled={!preferred}
            onSelect={() => preferred && openExternal(preferred.id)}
          >
            {preferred ? `Open in ${preferred.label}` : "Open"}
          </NodexContextMenuItem>
          <NodexContextMenuSubmenu
            disabled={options.length === 0}
            trigger={<NodexContextMenuSubmenuTrigger>Open with</NodexContextMenuSubmenuTrigger>}
            renderContent={() =>
              options.map((item) => (
                <NodexContextMenuItem key={item.id} onSelect={() => openExternal(item.id)}>
                  {item.label}
                </NodexContextMenuItem>
              ))
            }
          />
          <div role="separator" className="my-1 h-px bg-border" />
          <NodexContextMenuItem onSelect={() => path && run(() => saveWorkspaceFileCopy({ path }))}>
            Save as…
          </NodexContextMenuItem>
          <NodexContextMenuItem
            onSelect={() =>
              path &&
              run(async () => {
                if (!(await writeTextToClipboard(path))) throw new Error("Unable to copy path");
              })
            }
          >
            Copy path
          </NodexContextMenuItem>
          <NodexContextMenuItem
            disabled={!threadId}
            onSelect={() => {
              if (!path || !threadId) return;
              setLocalConversationComposerIntent(threadId, {
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
            Add to chat
          </NodexContextMenuItem>
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}
