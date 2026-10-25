import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import type { FileSearchScope } from "../../../shared/file-search";
import { resolveSearchResultPath } from "../../../shared/file-search-paths";
import { FolderIcon, UpArrowIcon } from "@/components/shared/icons";
import { NodexIconButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { commandPaletteDirectoryQueryOptions } from "@/lib/command-palette-workspace-operations";
import {
  commandPaletteDirectoryCoordinates,
  commandPaletteParentDirectory,
} from "@/lib/command-palette-workspace-paths";
import { cn } from "@/lib/utils";

export interface CommandPaletteFolderPickerProps {
  readonly scope: FileSearchScope | null;
  readonly onSelect: (scope: FileSearchScope) => void;
  readonly onClose: () => void;
  readonly focusSearch: () => void;
}

/** The window modal registry owns this chooser independently of its palette toolbar trigger. */
export function CommandPaletteFolderPicker(props: CommandPaletteFolderPickerProps) {
  const identity = JSON.stringify([props.scope?.hostId ?? "local", props.scope?.roots[0] ?? "~"]);
  return <FolderPickerContent key={identity} {...props} />;
}

function FolderPickerContent({
  scope,
  onSelect,
  onClose,
  focusSearch,
}: CommandPaletteFolderPickerProps) {
  const hostId = scope?.hostId ?? "local";
  const initialDirectory = scope?.roots[0] ?? "~";
  const [directory, setDirectory] = useState(initialDirectory);
  const [draft, setDraft] = useState(initialDirectory);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const coordinates = commandPaletteDirectoryCoordinates(directory);
  const listing = useQuery({
    ...commandPaletteDirectoryQueryOptions({
      hostId,
      workspaceRoot: coordinates?.workspaceRoot ?? "/",
      directoryPath: coordinates?.directoryPath ?? "",
      directoriesOnly: true,
      includeHidden,
    }),
    enabled: coordinates !== null,
  });
  const entries = coordinates ? (listing.data?.entries ?? []) : [];
  const workspaceRoot = listing.data?.workspaceRoot ?? coordinates?.workspaceRoot ?? "/";
  const navigate = (path: string) => {
    setDirectory(path);
    setDraft(path);
    setSelectedPath(null);
  };
  const parent =
    coordinates && listing.isSuccess
      ? commandPaletteParentDirectory(
          resolveSearchResultPath(workspaceRoot, listing.data.directoryPath),
        )
      : null;
  const selectedIndex = entries.findIndex((entry) => entry.path === selectedPath);
  const choose = () => {
    if (!coordinates || !listing.isSuccess) return;
    const path = resolveSearchResultPath(
      workspaceRoot,
      selectedIndex >= 0 ? entries[selectedIndex]!.path : listing.data.directoryPath,
    );
    onSelect({ hostId, roots: [path] });
    onClose();
  };
  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent
        size="wide"
        finalFocus={() => {
          focusSearch();
          return false;
        }}
      >
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Choose search folder</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody className="flex flex-col gap-2">
            <div className="flex items-center gap-1">
              <NodexIconButton
                icon={UpArrowIcon}
                size="sm"
                ariaLabel="Parent folder"
                disabled={!parent}
                onClick={() => parent && navigate(parent)}
              />
              <input
                aria-label="Folder path"
                value={draft}
                autoComplete="off"
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-lg bg-token-foreground/5 px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  navigate(draft);
                }}
              />
            </div>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Folders"
              aria-busy={listing.isFetching}
              aria-activedescendant={selectedIndex < 0 ? undefined : `${listId}-${selectedIndex}`}
              tabIndex={0}
              className="h-64 overflow-y-auto rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-token-focus-border"
              onKeyDown={(event) => {
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  const index = Math.max(
                    0,
                    Math.min(
                      entries.length - 1,
                      selectedIndex + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
                  setSelectedPath(entries[index]?.path ?? null);
                  listRef.current
                    ?.querySelector(`#${CSS.escape(`${listId}-${index}`)}`)
                    ?.scrollIntoView({ block: "nearest" });
                  return;
                }
                if (event.key === "ArrowLeft" || event.key === "Backspace") {
                  event.preventDefault();
                  if (parent) navigate(parent);
                  return;
                }
                if (event.key !== "Enter" && event.key !== "ArrowRight") return;
                event.preventDefault();
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  choose();
                  return;
                }
                if (selectedIndex >= 0 && coordinates)
                  navigate(resolveSearchResultPath(workspaceRoot, entries[selectedIndex]!.path));
              }}
            >
              {!coordinates ? (
                <p role="alert" className="p-2 text-sm text-token-description-foreground">
                  Enter an absolute folder path
                </p>
              ) : null}
              {listing.isError ? (
                <p role="alert" className="p-2 text-sm text-token-description-foreground">
                  Unable to read this folder
                </p>
              ) : null}
              {coordinates && listing.isPending ? (
                <p role="status" className="p-2 text-sm text-token-description-foreground">
                  Loading folders…
                </p>
              ) : null}
              {coordinates && listing.isSuccess && entries.length === 0 ? (
                <p role="status" className="p-2 text-sm text-token-description-foreground">
                  No folders
                </p>
              ) : null}
              {coordinates
                ? entries.map((entry, index) => (
                    <button
                      key={entry.path}
                      id={`${listId}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={selectedPath === entry.path}
                      tabIndex={-1}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-token-list-hover-background",
                        selectedPath === entry.path && "bg-token-list-hover-background",
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setSelectedPath(entry.path);
                        listRef.current?.focus();
                      }}
                      onDoubleClick={() =>
                        navigate(resolveSearchResultPath(workspaceRoot, entry.path))
                      }
                    >
                      <FolderIcon className="icon-xs shrink-0 text-token-description-foreground" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ))
                : null}
            </div>
            <label className="flex items-center gap-2 text-sm text-token-description-foreground">
              <input
                type="checkbox"
                checked={includeHidden}
                onChange={(event) => {
                  setSelectedPath(null);
                  setIncludeHidden(event.currentTarget.checked);
                }}
              />
              Show hidden folders
            </label>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction
              tone="primary"
              disabled={!coordinates || !listing.isSuccess}
              onClick={choose}
            >
              Choose folder
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
