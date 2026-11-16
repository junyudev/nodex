import { defineMessages, useIntl } from "@/lib/i18n";
import { useCallback, useSyncExternalStore } from "react";
import { MoreActionsIcon } from "@/components/shared/icons";
import { Target16Glyph } from "@/components/shared/icons/outline-glyphs";
import {
  CheckmarkSquareLightIcon,
  LadybugLightIcon,
  PersonPairLightIcon,
} from "@/components/shared/icons/page-chrome-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { PAGE_STARTERS, type PageStarterId } from "@/lib/page-starters";
import { cn } from "@/lib/utils";
import type { NfmEditorCommands } from "../editor/nfm-editor-commands";

const starterLabels = defineMessages({
  "task-brief": { id: "lib.pageStarters.taskBrief", defaultMessage: "Task brief" },
  "bug-report": { id: "lib.pageStarters.bugReport", defaultMessage: "Bug report" },
  "todo-list": { id: "lib.pageStarters.todoList", defaultMessage: "To-do list" },
  "meeting-notes": { id: "lib.pageStarters.meetingNotes", defaultMessage: "Meeting notes" },
});

/** Neutral reference chips: a hairline outline at rest, a tint on hover. */
const STARTER_CHIP_CLASS_NAME = cn(
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm",
  "text-token-text-secondary ring-[0.5px] ring-token-border ring-inset outline-none select-none",
  "hover:bg-token-foreground/5 hover:text-token-text-primary",
  "focus-visible:ring-2 focus-visible:ring-token-focus-border",
);

function PageStarterIcon({ id }: { readonly id: PageStarterId }) {
  switch (id) {
    case "task-brief":
      return <Target16Glyph />;
    case "bug-report":
      return <LadybugLightIcon />;
    case "todo-list":
      return <CheckmarkSquareLightIcon />;
    case "meeting-notes":
      return <PersonPairLightIcon />;
  }
}

/**
 * Shapes an empty Page can start from, offered under its first line until the body has
 * anything in it. Choosing one writes the shape and puts the caret where writing begins.
 */
export function PageStageStarters({
  commands,
  className,
}: {
  readonly commands: NfmEditorCommands;
  readonly className?: string;
}) {
  const intl = useIntl();

  const subscribe = useCallback((listener: () => void) => commands.subscribe(listener), [commands]);
  const empty = useSyncExternalStore(subscribe, commands.isEmpty, () => false);
  if (!empty) return null;
  return (
    <div
      role="group"
      aria-label={intl.formatMessage({
        id: "board.pageStarters.startWith",
        defaultMessage: "Start with",
      })}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      data-page-stage-starters="true"
    >
      {PAGE_STARTERS.map((starter) => (
        <button
          key={starter.id}
          type="button"
          className={STARTER_CHIP_CLASS_NAME}
          onClick={() => {
            commands.fillEmptyBody(starter.blocks);
          }}
        >
          <PageStarterIcon id={starter.id} />
          {intl.formatMessage(starterLabels[starter.id])}
        </button>
      ))}
      <NodexTooltip
        tooltipContent={intl.formatMessage({
          id: "board.pageStarters.moreBlocks",
          defaultMessage: "More blocks",
        })}
        shortcutLabel="/"
        side="bottom"
      >
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "board.pageStarters.moreBlocks",
            defaultMessage: "More blocks",
          })}
          className={cn(STARTER_CHIP_CLASS_NAME, "w-7 justify-center px-0")}
          onClick={() => {
            commands.openInsertMenu();
          }}
        >
          <MoreActionsIcon className="icon-xs" />
        </button>
      </NodexTooltip>
    </div>
  );
}
