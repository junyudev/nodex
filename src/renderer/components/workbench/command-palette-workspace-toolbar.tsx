import { useRef, useState, type ComponentPropsWithRef, type Ref } from "react";
import { useMergeRefs } from "@floating-ui/react";
import type { FileSearchScope } from "../../../shared/file-search";
import {
  commandPaletteWorkspaceScope,
  COMMAND_PALETTE_CONTEXT_SELECTION,
  type CommandPaletteWorkspaceSelection,
} from "@/lib/command-palette-workspace-selection";
import { DropdownChevronIcon } from "@/components/shared/icons";
import { NodexOptionPicker } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { CommandPaletteFolderPicker } from "./command-palette-folder-picker";

export interface CommandPaletteWorkspaceToolbarProps {
  readonly selection?: CommandPaletteWorkspaceSelection;
  readonly contextScope?: FileSearchScope | null;
  readonly contextLabel?: string;
  readonly onSelectionChange: (selection: CommandPaletteWorkspaceSelection) => void;
  readonly firstControlRef?: Ref<HTMLButtonElement>;
  readonly onChooseFolder?: () => Promise<FileSearchScope | null>;
}

const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]/u)
    .at(-1) || path;
const CHOOSE_FOLDER = "choose-folder";
export const COMMAND_PALETTE_SEARCH_OPTION_CLASS_NAME =
  "flex h-7 min-w-0 items-center gap-1 rounded-lg border border-transparent px-2 py-0 text-sm/4.5 text-tertiary whitespace-nowrap outline-hidden hover:bg-background-primary-ghost-hover data-[popup-open]:bg-background-primary-ghost-hover focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-40";

function FolderTrigger({
  tooltipContent,
  ...props
}: ComponentPropsWithRef<"button"> & { readonly tooltipContent: string | undefined }) {
  return (
    <NodexTooltip tooltipContent={tooltipContent} disabled={props["aria-expanded"] === true}>
      <button {...props} />
    </NodexTooltip>
  );
}

/** Files and Text share one explicit workspace selection and the same folder action. */
export function CommandPaletteWorkspaceToolbar({
  selection = COMMAND_PALETTE_CONTEXT_SELECTION,
  contextScope = null,
  contextLabel,
  onSelectionChange,
  firstControlRef,
  onChooseFolder,
}: CommandPaletteWorkspaceToolbarProps) {
  const scope = commandPaletteWorkspaceScope(selection, contextScope);
  const appHandle = useScopeHandle(appScope);
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chooseAfterClose = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mergedTriggerRef = useMergeRefs([triggerRef, firstControlRef]);
  const restoreFocus = () => triggerRef.current?.focus();
  const context =
    contextScope?.roots.length && contextScope.hostId === scope?.hostId ? contextScope : null;
  const contextTitle = contextLabel
    ? `Project: ${contextLabel}`
    : context?.roots.length === 1
      ? `Folder: ${folderName(context.roots[0]!)}`
      : "Folders";
  const isContext = selection.kind === "context";
  const title = !scope?.roots.length
    ? "Choose folder"
    : isContext
      ? contextTitle
      : scope.roots.length === 1
        ? `In ${folderName(scope.roots[0]!)}`
        : "Folders";
  const choose = async () => {
    if (choosing) return;
    if (!onChooseFolder) {
      openModal(appHandle, CommandPaletteFolderPicker, {
        scope,
        onSelect: (next) => onSelectionChange({ kind: "directory", scope: next }),
        onRestoreFocus: restoreFocus,
      });
      return;
    }
    setChoosing(true);
    setError(null);
    try {
      const next = await onChooseFolder();
      if (next) onSelectionChange({ kind: "directory", scope: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to choose a folder");
    } finally {
      setChoosing(false);
      restoreFocus();
    }
  };
  return (
    <>
      <NodexOptionPicker
        open={open}
        onOpenChange={setOpen}
        value={isContext ? "context" : "directory"}
        search="none"
        options={[
          ...(context ? [{ value: "context", label: contextTitle }] : []),
          { value: CHOOSE_FOLDER, label: "Choose folder" },
        ]}
        onValueChange={(value) => {
          if (value === CHOOSE_FOLDER) {
            chooseAfterClose.current = true;
            return;
          }
          if (context && value === "context") onSelectionChange({ kind: "context" });
        }}
        finalFocus={() => {
          if (chooseAfterClose.current) {
            chooseAfterClose.current = false;
            void choose();
            return false;
          }
          restoreFocus();
          return false;
        }}
        align="end"
        contentWidth="menuBounded"
        triggerButton={
          <FolderTrigger
            tooltipContent={scope?.roots.join("\n")}
            ref={mergedTriggerRef}
            type="button"
            disabled={choosing}
            aria-label="Search folder"
            className={`${COMMAND_PALETTE_SEARCH_OPTION_CLASS_NAME} max-w-full`}
          >
            <span className="max-w-40 truncate text-start">{title}</span>
            <DropdownChevronIcon className="icon-xs shrink-0" />
          </FolderTrigger>
        }
      />
      {error ? (
        <span role="alert" className="max-w-48 truncate text-xs text-token-description-foreground">
          {error}
        </span>
      ) : null}
    </>
  );
}
