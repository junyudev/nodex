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
import { InboxSuggestionModePicker } from "./inbox-suggestion-mode-picker";

const SUGGESTION_HINTS = {
  automatic: "Names and routes each message as you send it.",
  on_request: "Names and routes a message when you ask.",
  off: "You handle every message by hand.",
} as const;

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
  const mode = agents.settings.suggestions;
  const suggestions = mode !== "off";
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
            hint={SUGGESTION_HINTS[mode]}
            control={
              <InboxSuggestionModePicker
                trigger="compact"
                value={mode}
                onChange={(next) => agents.save({ suggestions: next })}
              />
            }
          >
            <InboxSuggestionAgentPicker
              agents={agents}
              trigger="field"
              disabled={!suggestions || !ready}
            />
          </Section>
          <Section
            title="New chats"
            hint={
              suggestions && agents.settings.suggestionsChooseModels
                ? "Suggestions choose each one; otherwise they run on this."
                : "Every new chat runs on this."
            }
            control={
              <NodexSwitch
                size="compact"
                ariaLabel="Suggestions choose models"
                checked={agents.settings.suggestionsChooseModels}
                disabled={!suggestions}
                onCheckedChange={(suggestionsChooseModels) =>
                  agents.save({ suggestionsChooseModels })
                }
              />
            }
          >
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
