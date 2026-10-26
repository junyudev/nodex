import { useState, type ReactNode } from "react";
import { ChevronRightIcon, SettingsGeneralIcon } from "@/components/shared/icons";
import { NodexSwitch } from "@/components/ui/button";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
  TOOLBAR_BUTTON_SECONDARY_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import { cn } from "@/lib/utils";
import {
  InboxChatAgentPicker,
  InboxSuggestionAgentPicker,
  type InboxAgents,
} from "./inbox-agent-picker";

function Section({
  title,
  hint,
  control = null,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  /** Sits at the title's trailing edge, such as the switch that turns the section on. */
  readonly control?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h3 className="text-sm font-medium text-token-foreground">{title}</h3>
          <p className="text-xs leading-4 text-token-description-foreground">{hint}</p>
        </div>
        {control}
      </div>
      {children}
    </section>
  );
}

/**
 * The Inbox's settings gear. What writes suggestions and what new chats run on change in place,
 * without leaving the Inbox; routing preferences and the rest stay in Settings.
 */
export function InboxAgentsPopover({
  agents,
  onOpenSettings,
}: {
  readonly agents: InboxAgents;
  readonly onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const suggestions = agents.settings.suggestionsEnabled;
  const ready = agents.state === "ready";
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexTooltip tooltipContent="Inbox settings" side="bottom" disabled={open}>
        <NodexPopoverTrigger>
          <button
            type="button"
            aria-label="Inbox settings"
            className={cn(
              TOOLBAR_BUTTON_BASE_CLASS,
              open ? TOOLBAR_BUTTON_SECONDARY_CLASS : TOOLBAR_BUTTON_GHOST_CLASS,
            )}
          >
            <SettingsGeneralIcon className="icon-sm" />
          </button>
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent
        side="bottom"
        align="end"
        aria-label="Inbox settings"
        className="w-80 overflow-hidden p-0"
      >
        <div className="flex flex-col divide-y divide-token-border/60">
          <Section
            title="Suggestions"
            hint="Names and routes each new message."
            control={
              <NodexSwitch
                size="compact"
                ariaLabel="Suggest where messages go"
                checked={suggestions}
                onCheckedChange={(suggestionsEnabled) => agents.save({ suggestionsEnabled })}
              />
            }
          >
            <InboxSuggestionAgentPicker
              agents={agents}
              trigger="field"
              disabled={!suggestions || !ready}
            />
          </Section>
          <Section title="New chats" hint="Any suggestion can still choose another.">
            <InboxChatAgentPicker agents={agents} trigger="field" disabled={!ready} />
          </Section>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="cursor-interaction flex items-center justify-between gap-2 px-3 py-2 text-left text-sm text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground"
          >
            Routing preferences and more
            <ChevronRightIcon className="icon-xs shrink-0" />
          </button>
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}
