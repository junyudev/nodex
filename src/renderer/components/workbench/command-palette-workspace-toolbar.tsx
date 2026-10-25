import { useRef, useState, type Ref } from "react";
import type { FileSearchScope } from "../../../shared/file-search";
import { FolderIcon } from "@/components/shared/icons";
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "@/components/ui/dropdown";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { CommandPaletteFolderPicker } from "./command-palette-folder-picker";

export interface CommandPaletteWorkspaceOption {
  readonly label: string;
  readonly scope: FileSearchScope;
}

export interface CommandPaletteWorkspaceToolbarProps {
  readonly scope: FileSearchScope | null;
  readonly contextScope?: FileSearchScope | null;
  readonly contextLabel?: string;
  readonly scopeOptions?: readonly CommandPaletteWorkspaceOption[];
  readonly onScopeChange: (scope: FileSearchScope) => void;
  readonly focusSearch: () => void;
  readonly firstControlRef?: Ref<HTMLButtonElement>;
  readonly onChooseFolder?: () => Promise<FileSearchScope | null>;
}

const scopeKey = (scope: FileSearchScope | null | undefined) =>
  scope ? JSON.stringify([scope.hostId, scope.roots]) : "";
const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .at(-1) || path;
const CHOOSE_FOLDER = "choose-folder";
const EMPTY_SCOPE_OPTIONS: readonly CommandPaletteWorkspaceOption[] = [];

/** Files and Text share one explicit workspace selection and the same folder action. */
export function CommandPaletteWorkspaceToolbar({
  scope,
  contextScope = scope,
  contextLabel,
  scopeOptions = EMPTY_SCOPE_OPTIONS,
  onScopeChange,
  focusSearch,
  firstControlRef,
  onChooseFolder,
}: CommandPaletteWorkspaceToolbarProps) {
  const appHandle = useScopeHandle(appScope);
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chooseAfterClose = useRef(false);
  const options = [
    ...new Map(
      [
        ...(contextScope?.roots.length
          ? [
              {
                label: contextLabel
                  ? `Project: ${contextLabel}`
                  : contextScope.roots.length > 1
                    ? "Project folders"
                    : `Folder: ${folderName(contextScope.roots[0]!)}`,
                scope: contextScope,
              },
            ]
          : []),
        ...(contextScope && contextScope.roots.length > 1
          ? contextScope.roots.map((root) => ({
              label: folderName(root),
              scope: { hostId: contextScope.hostId, roots: [root] },
            }))
          : []),
        ...scopeOptions,
        ...(scope?.roots.length && scopeKey(scope) !== scopeKey(contextScope)
          ? [
              {
                label: scope.roots.length === 1 ? `In ${folderName(scope.roots[0]!)}` : "Folders",
                scope,
              },
            ]
          : []),
      ].map((option) => [scopeKey(option.scope), option] as const),
    ).values(),
  ];
  const selected = options.find((option) => scopeKey(option.scope) === scopeKey(scope));
  const choose = async () => {
    if (choosing) return;
    if (!onChooseFolder) {
      openModal(appHandle, CommandPaletteFolderPicker, {
        scope,
        onSelect: onScopeChange,
        focusSearch,
      });
      return;
    }
    setChoosing(true);
    setError(null);
    try {
      const next = await onChooseFolder();
      if (next) onScopeChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to choose a folder");
    } finally {
      setChoosing(false);
      focusSearch();
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <NodexOptionPicker
        open={open}
        onOpenChange={setOpen}
        value={scopeKey(scope)}
        search={options.length > 6 ? "filter" : "none"}
        options={[
          ...options.map((option) => ({ value: scopeKey(option.scope), label: option.label })),
          { value: CHOOSE_FOLDER, label: "Choose folder" },
        ]}
        onValueChange={(value) => {
          if (value === CHOOSE_FOLDER) {
            chooseAfterClose.current = true;
            return;
          }
          const option = options.find((candidate) => scopeKey(candidate.scope) === value);
          if (option) onScopeChange(option.scope);
        }}
        finalFocus={() => {
          if (chooseAfterClose.current) {
            chooseAfterClose.current = false;
            void choose();
            return false;
          }
          focusSearch();
          return false;
        }}
        align="end"
        contentWidth="menuBounded"
        triggerButton={
          <NodexDropdownButtonTrigger
            ref={firstControlRef}
            size="sm"
            chrome="transparent"
            disabled={choosing}
            aria-label="Search folder"
            leadingVisual={<FolderIcon className="icon-xs" />}
            className="max-w-48"
          >
            <span className="truncate">{selected?.label ?? "Choose folder"}</span>
          </NodexDropdownButtonTrigger>
        }
      />
      {error ? (
        <span role="alert" className="max-w-48 truncate text-xs text-token-description-foreground">
          {error}
        </span>
      ) : null}
    </div>
  );
}
