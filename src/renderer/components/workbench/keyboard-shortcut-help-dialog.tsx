import { useMemo, useState } from "react";
import { SearchIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { ShortcutKeycaps, ShortcutKeycapSequence } from "@/components/ui/shortcut-keycaps";
import { resolveCodexRendererCommandPlatform } from "@/lib/codex-window-runtime";
import {
  createCommandKeymapState,
  formatAcceleratorLabel,
  type CommandKeymapEntry,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";

interface KeyboardShortcutHelpDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly onCustomize: () => void;
}

const GROUP_LABELS: Record<string, string> = {
  general: "General",
  navigation: "Navigation",
  board: "Board",
  page: "Pages",
  application: "Application",
};

const GROUP_ORDER = ["general", "navigation", "board", "page", "application"];

const resolveGroup = (entry: CommandKeymapEntry): string =>
  entry.commandMenuGroupKey ?? "application";

function ShortcutBinding({
  accelerator,
  state,
}: {
  readonly accelerator: string;
  readonly state: CommandKeymapState;
}) {
  const chords = accelerator
    .split(/\s+/)
    .map((chord) => formatAcceleratorLabel(chord, state.platform));
  return <ShortcutKeycapSequence chords={chords} density="compact" />;
}

export function KeyboardShortcutHelpDialog({
  open,
  onOpenChange,
  commandKeymapState,
  onCustomize,
}: KeyboardShortcutHelpDialogProps) {
  const [query, setQuery] = useState("");
  const state =
    commandKeymapState ?? createCommandKeymapState({}, resolveCodexRendererCommandPlatform());
  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const entries = state.entries.filter((entry) => {
      if (!entry.available || entry.keybindings.every((binding) => !binding.key)) return false;
      if (!normalizedQuery) return true;
      return `${entry.title} ${entry.description}`.toLowerCase().includes(normalizedQuery);
    });
    return GROUP_ORDER.flatMap((group) => {
      const items = entries.filter((entry) => resolveGroup(entry) === group);
      return items.length > 0 ? [{ group, items }] : [];
    });
  }, [query, state]);

  return (
    <NodexDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <NodexDialogContent
        size="wide"
        className="flex max-h-[min(680px,82vh)] flex-col rounded-2xl"
        aria-describedby="keyboard-shortcut-help-description"
      >
        <div className="border-b border-token-border/70 px-5 pt-5 pb-3.5">
          <NodexDialogTitle>Keyboard shortcuts</NodexDialogTitle>
          <NodexDialogDescription
            id="keyboard-shortcut-help-description"
            className="mt-0.5 text-sm"
          >
            Actions adapt to the active surface. Bare keys stay local while you type.
          </NodexDialogDescription>
          <label className="mt-3 flex h-8 items-center gap-2 rounded-lg bg-token-foreground/5 px-2.5 text-token-description-foreground ring-[0.5px] ring-token-border/70 focus-within:ring-token-focus-border">
            <SearchIcon className="icon-2xs shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search shortcuts…"
              className="min-w-0 flex-1 bg-transparent text-sm text-token-foreground outline-none placeholder:text-token-description-foreground"
              aria-label="Search keyboard shortcuts"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {groups.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-token-description-foreground">
              No matching shortcuts
            </div>
          ) : (
            groups.map(({ group, items }) => (
              <section key={group} className="pb-2">
                <h3 className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-token-description-foreground uppercase">
                  {GROUP_LABELS[group] ?? group}
                </h3>
                {items.map((entry) => (
                  <div
                    key={entry.id}
                    className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-lg px-3 py-1.5 hover:bg-token-list-hover-background"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-token-foreground">
                        {entry.title}
                      </span>
                      <span className="block truncate text-xs text-token-description-foreground">
                        {entry.description}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      {entry.keybindings.flatMap((binding) =>
                        binding.key
                          ? [
                              <ShortcutBinding
                                key={binding.key}
                                accelerator={binding.key}
                                state={state}
                              />,
                            ]
                          : [],
                      )}
                    </span>
                  </div>
                ))}
              </section>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-token-border/70 px-4 py-3">
          <span className="text-xs text-token-description-foreground">
            Press <ShortcutKeycaps keys={["?"]} density="compact" /> anytime to reopen
          </span>
          <NodexDialogAction
            size="compact"
            onClick={() => {
              setQuery("");
              onOpenChange(false);
              onCustomize();
            }}
          >
            Customize shortcuts
          </NodexDialogAction>
        </div>
      </NodexDialogContent>
    </NodexDialog>
  );
}
