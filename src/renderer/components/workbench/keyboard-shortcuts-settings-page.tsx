import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  resetCommandKeybindings,
  updateCommandKeybinding,
  useCommandKeymapState,
} from "@/lib/use-command-keymap-state";
import { cn } from "@/lib/utils";
import { NodexButton } from "../ui/button";
import { HotkeySettingControl, type HotkeyCaptureMode } from "../ui/hotkey-setting-control";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "../ui/dialog";
import { NodexSettingsPageSurface as SettingsPageSurface } from "../ui/settings";
import { KeystrokeSearchIcon } from "../shared/icons";
import {
  findCommandKeybindingConflict,
  formatAcceleratorLabel,
  keyboardEventToAccelerator,
  normalizeAccelerator,
  validateGlobalDictationShortcut,
  type CommandKeybindingRecord,
  type CommandKeybindingUpdate,
  type CommandKeymapEntry,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";

interface CaptureState {
  commandId: string;
  mode: HotkeyCaptureMode;
  oldKey: string | null;
  conflict: string | null;
}

interface KeybindingRow {
  entry: CommandKeymapEntry;
  binding: CommandKeybindingRecord | null;
  bindingIndex: number;
  isFirst: boolean;
  rowCount: number;
}

interface CommitPayload {
  commandId: string;
  update: CommandKeybindingUpdate;
}

const ROW_ICON_BUTTON_CLASSNAME =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px] aspect-square items-center justify-center !px-0";

function visibleEntries(state: CommandKeymapState | undefined): CommandKeymapEntry[] {
  return state?.entries.filter((entry) => entry.available) ?? [];
}

function buildRows(entries: CommandKeymapEntry[]): KeybindingRow[] {
  return entries.flatMap((entry) => {
    const bindings = entry.keybindings.length > 0 ? entry.keybindings : [null];
    return bindings.map((binding, index) => ({
      entry,
      binding,
      bindingIndex: index,
      isFirst: index === 0,
      rowCount: bindings.length,
    }));
  });
}

function entryMatchesText(
  entry: CommandKeymapEntry,
  query: string,
  state: CommandKeymapState,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const labels = entry.keybindings.map((binding) =>
    binding.key ? formatAcceleratorLabel(binding.key, state.platform) : "",
  );
  return [entry.id, entry.title, entry.description, ...labels]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

function entryMatchesKeystroke(entry: CommandKeymapEntry, accelerator: string | null): boolean {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) return true;
  return entry.keybindings.some((binding) => {
    const key = normalizeAccelerator(binding.key);
    return key === normalized || key.startsWith(normalized) || normalized.startsWith(key);
  });
}

function toKeybindingRecord(key: string): CommandKeybindingRecord {
  return { key: normalizeAccelerator(key) };
}

function mutationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Could not update shortcut";
}

export function KeyboardShortcutsSettingsPage() {
  const queryClient = useQueryClient();
  const keymapQuery = useCommandKeymapState();
  const state = keymapQuery.data;
  const [searchMode, setSearchMode] = useState<"text" | "keystroke">("text");
  const [searchText, setSearchText] = useState("");
  const [keystrokeQuery, setKeystrokeQuery] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [resetAllOpen, setResetAllOpen] = useState(false);
  const [resetAllError, setResetAllError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const updateMutation = useMutation({
    mutationFn: ({ commandId, update }: CommitPayload) =>
      updateCommandKeybinding(commandId, update),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.settings.commandKeymap(), result.state);
    },
  });

  const resetAllMutation = useMutation({
    mutationFn: resetCommandKeybindings,
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.settings.commandKeymap(), result.state);
      if (result.type === "rejected") {
        setResetAllError(result.reason.message);
        return;
      }
      setResetAllOpen(false);
      setResetAllError(null);
    },
    onError: (error) => {
      setResetAllError(mutationErrorMessage(error));
    },
  });

  const entries = visibleEntries(state).filter((entry) => {
    if (!state) return false;
    return searchMode === "keystroke"
      ? entryMatchesKeystroke(entry, keystrokeQuery)
      : entryMatchesText(entry, searchText, state);
  });
  const rows = buildRows(entries);

  const commitUpdate = async (commandId: string, update: CommandKeybindingUpdate) => {
    setRowErrors((current) => ({ ...current, [commandId]: "" }));
    try {
      const result = await updateMutation.mutateAsync({ commandId, update });
      if (result.type === "rejected") {
        setRowErrors((current) => ({ ...current, [commandId]: result.reason.message }));
        return;
      }
      setCapture(null);
    } catch (error) {
      setRowErrors((current) => ({ ...current, [commandId]: mutationErrorMessage(error) }));
    }
  };

  const beginCapture = (
    entry: CommandKeymapEntry,
    binding: CommandKeybindingRecord | null,
    mode: HotkeyCaptureMode,
  ) => {
    setCapture({
      commandId: entry.id,
      mode,
      oldKey: binding?.key ?? null,
      conflict: null,
    });
    setRowErrors((current) => ({ ...current, [entry.id]: "" }));
  };

  const handleCapture = async (entry: CommandKeymapEntry, accelerator: string) => {
    if (!state || !capture || capture.commandId !== entry.id) return;
    if (entry.shortcutScope === "os-global") {
      const validationError = validateGlobalDictationShortcut(accelerator, state.platform);
      if (validationError) {
        setCapture(null);
        setRowErrors((current) => ({ ...current, [entry.id]: validationError }));
        return;
      }
    }
    const conflict = findCommandKeybindingConflict(state, entry.id, accelerator);
    if (conflict) {
      setCapture({
        ...capture,
        conflict: conflict.commandTitle,
      });
      return;
    }

    const keybinding = toKeybindingRecord(accelerator);
    const update: CommandKeybindingUpdate =
      capture.mode === "append"
        ? { type: "append", keybinding }
        : capture.mode === "replace" && capture.oldKey
          ? {
              type: "replace",
              oldKeybinding: toKeybindingRecord(capture.oldKey),
              newKeybinding: keybinding,
            }
          : { type: "set", keybinding };
    await commitUpdate(entry.id, update);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (searchMode !== "keystroke" || !state) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setKeystrokeQuery(null);
      return;
    }
    const accelerator = keyboardEventToAccelerator(event.nativeEvent, state.platform, {
      allowsBareModifiers: true,
    });
    if (!accelerator) return;
    setKeystrokeQuery(accelerator);
  };

  const searchValue =
    searchMode === "keystroke" && state && keystrokeQuery
      ? formatAcceleratorLabel(keystrokeQuery, state.platform)
      : searchMode === "keystroke"
        ? ""
        : searchText;

  return (
    <SettingsPageSurface
      title="Keyboard shortcuts"
      contentClassName="electron:min-w-[calc(320px*var(--codex-window-zoom))]"
    >
      <div className="relative">
        <input
          ref={searchInputRef}
          aria-label="Search keyboard shortcuts"
          placeholder={searchMode === "keystroke" ? "Press shortcut" : "Search shortcuts"}
          value={searchValue}
          readOnly={searchMode === "keystroke"}
          onChange={(event) => setSearchText(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          className="w-full rounded-md border border-token-border bg-transparent px-3 py-2 text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary pe-11"
        />
        <button
          type="button"
          className={cn(
            ROW_ICON_BUTTON_CLASSNAME,
            "absolute right-1 top-1/2 -translate-y-1/2",
            searchMode === "keystroke" && "bg-token-list-hover-background text-token-text-primary",
          )}
          aria-label="Search by keystrokes"
          aria-pressed={searchMode === "keystroke"}
          onClick={() => {
            const nextMode = searchMode === "keystroke" ? "text" : "keystroke";
            setSearchMode(nextMode);
            setKeystrokeQuery(null);
            requestAnimationFrame(() => searchInputRef.current?.focus());
          }}
        >
          <KeystrokeSearchIcon />
        </button>
      </div>

      <div
        className="flex flex-col divide-y-[0.5px] divide-token-border overflow-hidden rounded-lg border border-token-border"
        style={{ background: "var(--color-background-panel, var(--color-token-bg-fog))" }}
      >
        {keymapQuery.isLoading ? (
          <div className="px-4 py-3 text-sm text-token-text-secondary">Loading shortcuts...</div>
        ) : keymapQuery.isError ? (
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-token-text-secondary">
            <span>Could not load shortcuts.</span>
            <NodexButton variant="outline" size="xs" onClick={() => void keymapQuery.refetch()}>
              Retry
            </NodexButton>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-3 text-sm text-token-text-secondary">No matching shortcuts</div>
        ) : (
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col />
              <col className="w-64" />
              <col className="w-32" />
            </colgroup>
            <thead className="sr-only">
              <tr>
                <th scope="col">Command</th>
                <th scope="col">Keybinding</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y-[0.5px] divide-token-border">
              {rows.map((row) => (
                <ShortcutTableRow
                  key={`${row.entry.id}:${row.binding?.key ?? "unassigned"}:${row.bindingIndex}`}
                  row={row}
                  state={state}
                  capture={
                    capture?.commandId === row.entry.id &&
                    (capture.oldKey ?? null) === (row.binding?.key ?? null)
                      ? capture
                      : null
                  }
                  rowError={row.isFirst ? rowErrors[row.entry.id] : ""}
                  pending={updateMutation.isPending}
                  onCancelCapture={() => setCapture(null)}
                  onBeginCapture={beginCapture}
                  onCapture={handleCapture}
                  onRemove={(entry, binding) =>
                    void commitUpdate(entry.id, { type: "remove", keybinding: binding })
                  }
                  onReset={(entry) => void commitUpdate(entry.id, { type: "reset" })}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {state?.hasCustomBindings ? (
        <div className="flex items-center justify-end gap-2">
          <NodexButton variant="outline" size="sm" onClick={() => setResetAllOpen(true)}>
            Reset all to defaults
          </NodexButton>
        </div>
      ) : null}

      <NodexDialog open={resetAllOpen} onOpenChange={setResetAllOpen}>
        <NodexDialogContent>
          <NodexDialogFrame>
            <NodexDialogHeader>
              <NodexDialogTitle>Reset all keyboard shortcuts?</NodexDialogTitle>
              <NodexDialogDescription>
                This will discard all custom shortcuts and restore the default keyboard shortcuts.
              </NodexDialogDescription>
            </NodexDialogHeader>
            {resetAllError ? (
              <NodexDialogBody>
                <div className="rounded-lg bg-token-charts-red/10 px-3 py-2 text-sm text-token-charts-red">
                  {resetAllError}
                </div>
              </NodexDialogBody>
            ) : null}
            <NodexDialogFooter>
              <NodexDialogAction onClick={() => setResetAllOpen(false)}>Cancel</NodexDialogAction>
              <NodexDialogAction
                tone="danger"
                disabled={resetAllMutation.isPending}
                onClick={() => resetAllMutation.mutate()}
              >
                Reset all
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </SettingsPageSurface>
  );
}

function ShortcutTableRow({
  row,
  state,
  capture,
  rowError,
  pending,
  onCancelCapture,
  onBeginCapture,
  onCapture,
  onRemove,
  onReset,
}: {
  row: KeybindingRow;
  state: CommandKeymapState | undefined;
  capture: CaptureState | null;
  rowError: string | undefined;
  pending: boolean;
  onCancelCapture: () => void;
  onBeginCapture: (
    entry: CommandKeymapEntry,
    binding: CommandKeybindingRecord | null,
    mode: HotkeyCaptureMode,
  ) => void;
  onCapture: (entry: CommandKeymapEntry, accelerator: string) => void;
  onRemove: (entry: CommandKeymapEntry, binding: CommandKeybindingRecord) => void;
  onReset: (entry: CommandKeymapEntry) => void;
}) {
  const { entry, binding, isFirst, rowCount } = row;
  const label = binding?.key && state ? formatAcceleratorLabel(binding.key, state.platform) : "";
  const keybindingPadding =
    isFirst && rowCount > 1
      ? "px-4 pt-2 pb-0.5"
      : !isFirst && rowCount > 1
        ? "px-4 pt-0.5 pb-2"
        : "px-4 py-2";

  return (
    <tr className="group align-middle">
      {isFirst ? (
        <td className="px-4 py-2" rowSpan={rowCount}>
          <span className="block truncate text-token-text-primary">{entry.title}</span>
          <span className="mt-0.5 block truncate text-xs text-token-text-secondary">
            {entry.description}
          </span>
          {rowError ? (
            <span className="mt-1 block text-xs text-token-editor-warning-foreground">
              {rowError}
            </span>
          ) : null}
        </td>
      ) : null}
      <td className={keybindingPadding} colSpan={2}>
        <HotkeySettingControl
          accelerator={binding?.key ?? null}
          acceleratorLabel={label || null}
          allowsBareModifiers={entry.allowsBareModifiers}
          allowsSequences={entry.allowsSequences}
          canAppend={entry.allowsMultiple}
          captureAriaLabel={`${entry.title} hotkey capture`}
          conflict={capture?.conflict}
          disabled={pending}
          hotkeyName={entry.title}
          isCapturing={capture !== null}
          onCancelCapture={onCancelCapture}
          onCapture={(accelerator) => void onCapture(entry, accelerator)}
          onClear={() => {
            if (binding) onRemove(entry, binding);
          }}
          onReset={entry.isCustom && isFirst ? () => onReset(entry) : undefined}
          onStartCapture={(mode) => onBeginCapture(entry, binding, mode)}
          platform={state?.platform ?? "macOS"}
        />
      </td>
    </tr>
  );
}
