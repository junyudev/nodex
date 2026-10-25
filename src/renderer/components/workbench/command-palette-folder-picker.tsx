import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { FileSearchScope } from "../../../shared/file-search";
import {
  isAbsoluteSearchPath,
  resolveSearchResultPath,
  searchPathsEqual,
} from "../../../shared/file-search-paths";
import { FolderIcon, UpArrowIcon } from "@/components/shared/icons";
import { NodexIconButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { commandPaletteDirectoryQueryOptions } from "@/lib/command-palette-workspace-operations";
import {
  commandPaletteDirectoryCoordinates,
  commandPaletteParentDirectory,
} from "@/lib/command-palette-workspace-paths";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "@/components/ui/tooltip";

export interface CommandPaletteFolderPickerProps {
  readonly scope: FileSearchScope | null;
  readonly onSelect: (scope: FileSearchScope) => void;
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
}

function directorySuggestions(path: string) {
  if (!isAbsoluteSearchPath(path)) return null;
  if (/[\\/]$/u.test(path)) return { directory: path, prefix: null };
  const parent = commandPaletteParentDirectory(path);
  if (!parent) return { directory: path, prefix: null };
  return { directory: parent, prefix: path.replaceAll("\\", "/").split("/").at(-1) ?? "" };
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
  onRestoreFocus,
}: CommandPaletteFolderPickerProps) {
  const hostId = scope?.hostId ?? "local";
  const queryClient = useQueryClient();
  const [directory, setDirectory] = useState(scope?.roots[0] ?? "~");
  const [draft, setDraft] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const invalidId = useId();
  const listId = useId();
  const suggestions =
    draft === null ? { directory, prefix: null } : directorySuggestions(draft.trim());
  const coordinates = suggestions && commandPaletteDirectoryCoordinates(suggestions.directory);
  const canBrowse = coordinates !== null;
  const listing = useQuery({
    ...commandPaletteDirectoryQueryOptions({
      hostId,
      workspaceRoot: coordinates?.workspaceRoot ?? "/",
      directoryPath: coordinates?.directoryPath ?? "",
      directoriesOnly: true,
      includeHidden: true,
    }),
    enabled: canBrowse,
    staleTime: 0,
    retry: false,
    placeholderData: () => {
      if (!coordinates || coordinates.workspaceRoot === "~") return undefined;
      const home = queryClient.getQueryData(
        commandPaletteDirectoryQueryOptions({
          hostId,
          workspaceRoot: "~",
          directoryPath: "",
          directoriesOnly: true,
          includeHidden: true,
        }).queryKey,
      );
      if (!home?.workspaceRoot) return undefined;
      return searchPathsEqual(
        resolveSearchResultPath(coordinates.workspaceRoot, coordinates.directoryPath),
        resolveSearchResultPath(home.workspaceRoot, home.directoryPath),
      )
        ? home
        : undefined;
    },
  });
  const workspaceRoot = listing.data?.workspaceRoot ?? coordinates?.workspaceRoot ?? "/";
  const currentDirectory = listing.data
    ? resolveSearchResultPath(workspaceRoot, listing.data.directoryPath)
    : (suggestions?.directory ?? "");
  const entries =
    coordinates && listing.data
      ? listing.data.entries
          .filter((entry) => entry.type === "directory")
          .map((entry) => ({ ...entry, path: resolveSearchResultPath(workspaceRoot, entry.path) }))
      : [];
  const visibleEntries = entries.filter(
    (entry) =>
      suggestions?.prefix == null ||
      entry.name.toLocaleLowerCase().startsWith(suggestions.prefix.toLocaleLowerCase()),
  );
  const activeEntry = listing.isLoading
    ? null
    : (visibleEntries.find((entry) => entry.path === activePath) ?? null);
  const displayedPath = draft ?? selectedPath ?? currentDirectory;
  const selectedChild = visibleEntries.some((entry) => entry.path === selectedPath);
  const parent =
    draft === null && selectedChild
      ? currentDirectory
      : commandPaletteParentDirectory(displayedPath);
  const optionId = (path: string) => `${listId}-${encodeURIComponent(path)}`;
  const navigate = (path: string) => {
    setActivePath(null);
    setDraft(null);
    setDirectory(path);
  };
  const commitDraft = () => {
    if (draft === null) return;
    const committedPath = draft.trim();
    setSelectedPath(committedPath);
    if (isAbsoluteSearchPath(committedPath)) navigate(committedPath);
  };
  const choose = () => {
    if (selectedPath === null) return;
    onSelect({ hostId, roots: [selectedPath] });
    onClose();
  };

  // Nearby directories are warm when a suggestion is entered, without sharing writable host state.
  useEffect(() => {
    if (!canBrowse || !listing.data) return;
    for (const entry of listing.data.entries) {
      if (entry.type !== "directory") continue;
      const next = commandPaletteDirectoryCoordinates(
        resolveSearchResultPath(workspaceRoot, entry.path),
      );
      if (!next) continue;
      void queryClient.prefetchQuery({
        ...commandPaletteDirectoryQueryOptions({
          hostId,
          ...next,
          directoriesOnly: true,
          includeHidden: true,
        }),
        staleTime: Infinity,
      });
    }
  }, [canBrowse, listing.data, hostId, queryClient, workspaceRoot]);

  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent
        size="wide"
        className="w-[600px]"
        initialFocus={inputRef}
        finalFocus={() => {
          onRestoreFocus();
          return false;
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            choose();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>Choose search folder</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody>
            <div
              className="flex h-70 min-h-56 flex-col gap-3"
              onBlur={(event) => {
                if (
                  event.relatedTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                )
                  return;
                commitDraft();
              }}
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="mt-1 mb-2 flex min-w-0 items-center gap-1">
                  <NodexIconButton
                    icon={UpArrowIcon}
                    size="sm"
                    className="shrink-0 text-tertiary hover:bg-background-primary-ghost-hover hover:text-tertiary"
                    ariaLabel="Go to parent folder"
                    disabled={listing.isLoading || !coordinates || !parent}
                    onClick={() => {
                      if (!parent) return;
                      navigate(parent);
                      setSelectedPath(parent);
                    }}
                  />
                  <NodexTooltip tooltipContent={displayedPath} delayOpen>
                    <input
                      ref={inputRef}
                      role="combobox"
                      aria-label="Selected folder path"
                      aria-autocomplete="list"
                      aria-controls={visibleEntries.length > 0 ? listId : undefined}
                      aria-expanded={visibleEntries.length > 0}
                      aria-activedescendant={activeEntry ? optionId(activeEntry.path) : undefined}
                      aria-describedby={!coordinates ? invalidId : undefined}
                      value={displayedPath}
                      autoComplete="off"
                      spellCheck={false}
                      className="h-9 min-w-0 flex-1 rounded-md border border-border-primary-outline bg-background-primary-soft px-2.5 text-sm outline-none focus:border-token-focus-border"
                      onChange={(event) => {
                        setActivePath(null);
                        setSelectedPath(event.currentTarget.value);
                        setDraft(event.currentTarget.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                          return;
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          if (visibleEntries.length === 0 || listing.isLoading) return;
                          event.preventDefault();
                          const index = activeEntry ? visibleEntries.indexOf(activeEntry) : -1;
                          const next =
                            event.key === "ArrowDown"
                              ? (index + 1) % visibleEntries.length
                              : index < 0
                                ? visibleEntries.length - 1
                                : (index - 1 + visibleEntries.length) % visibleEntries.length;
                          setActivePath(visibleEntries[next]!.path);
                          return;
                        }
                        if (event.key !== "Enter" || !activeEntry) return;
                        event.preventDefault();
                        navigate(currentDirectory);
                        setSelectedPath(activeEntry.path);
                      }}
                    />
                  </NodexTooltip>
                </div>
                {selectedPath === null ? (
                  <button
                    type="button"
                    className="mb-2 self-start rounded-full border border-transparent px-2 py-0.5 text-sm/4.5 text-tertiary whitespace-nowrap outline-hidden hover:bg-background-primary-ghost-hover focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-40"
                    disabled={listing.isLoading || listing.isError || !listing.data}
                    onClick={() => setSelectedPath(currentDirectory)}
                  >
                    Select current folder
                  </button>
                ) : null}
                <div className="flex min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-primary-outline bg-background-primary-soft">
                  {!coordinates ? (
                    <div
                      id={invalidId}
                      className="flex w-full items-center justify-center px-4 text-sm text-token-description-foreground"
                    >
                      Enter a full folder path to browse
                    </div>
                  ) : listing.isLoading && !listing.data ? (
                    <div
                      role="status"
                      className="flex w-full items-center justify-center px-4 text-sm text-token-description-foreground"
                    >
                      Loading folder contents…
                    </div>
                  ) : listing.isError || !listing.data ? (
                    <div
                      role="alert"
                      className="flex w-full items-center justify-center px-4 text-sm text-token-description-foreground"
                    >
                      Unable to load this folder
                    </div>
                  ) : visibleEntries.length === 0 ? (
                    <div
                      role="status"
                      className="flex w-full items-center justify-center px-4 text-sm text-token-description-foreground"
                    >
                      No folders found in this directory.
                    </div>
                  ) : (
                    <div
                      id={listId}
                      role="listbox"
                      aria-label="Folders"
                      className="flex w-full flex-col py-1"
                    >
                      {visibleEntries.map((entry) => (
                        <button
                          key={entry.path}
                          id={optionId(entry.path)}
                          type="button"
                          role="option"
                          aria-selected={selectedPath === entry.path}
                          disabled={listing.isLoading}
                          className={cn(
                            "flex w-full min-w-0 self-stretch items-center gap-2 px-3 py-1.5 text-start text-sm",
                            "enabled:hover:bg-token-foreground/5 disabled:cursor-not-allowed disabled:opacity-50",
                            (activeEntry?.path === entry.path || selectedPath === entry.path) &&
                              "bg-token-foreground/10",
                          )}
                          onClick={() => {
                            navigate(entry.path);
                            setSelectedPath(entry.path);
                          }}
                        >
                          <FolderIcon className="icon-xs shrink-0 text-token-description-foreground" />
                          <span className="truncate">{entry.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction tone="primary" type="submit" disabled={selectedPath === null}>
              Choose
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
