import { FormattedMessage, defineMessage, useIntl } from "@/lib/i18n";
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
  automatic: defineMessage({
    id: "inbox.inboxAgentsPopover.routesEachMessageAsYou",
    defaultMessage: "Routes each message as you send it.",
  }),
  on_request: defineMessage({
    id: "inbox.inboxAgentsPopover.routesAMessageWhenYou",
    defaultMessage: "Routes a message when you ask.",
  }),
  off: defineMessage({
    id: "inbox.inboxAgentsPopover.youHandleEveryMessageBy",
    defaultMessage: "You handle every message by hand.",
  }),
} as const;

function Section({
  title,
  hint,
  control = null,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  /** Sits at the title's trailing edge: how the whole section works, such as when Nodex routes. */
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

/** A preference inside a section: one quiet line, with a hint only when the label can't say it all. */
function SwitchRow({
  label,
  hint = null,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  readonly label: string;
  readonly hint?: string | null;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-token-text-secondary">
      <span className="min-w-0">
        {label}
        {hint ? <span className="block text-token-description-foreground">{hint}</span> : null}
      </span>
      <NodexSwitch
        size="compact"
        ariaLabel={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}

/**
 * The Inbox's settings gear. What routes, and what new chats run on, where they work and what
 * opens beside them, change in place without leaving the Inbox; routing preferences and what is
 * set once stay in Settings. Each section reads the same way: its model, then its switches.
 */
export function InboxAgentsPopover({
  agents,
  onOpenSettings,
}: {
  readonly agents: InboxAgents;
  readonly onOpenSettings: () => void;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const mode = agents.settings.suggestions;
  const suggestions = mode !== "off";
  const ready = agents.state === "ready";
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexTooltip
        tooltipContent={intl.formatMessage({
          id: "inbox.inboxAgentsPopover.settings",
          defaultMessage: "Inbox settings",
        })}
        side="bottom"
        disabled={open}
      >
        <NodexPopoverTrigger>
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: "inbox.inboxAgentsPopover.inboxSettings",
              defaultMessage: "Inbox settings",
            })}
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
        aria-label={intl.formatMessage({
          id: "inbox.inboxAgentsPopover.inboxSettings",
          defaultMessage: "Inbox settings",
        })}
        className="w-80 overflow-hidden p-0"
      >
        <div className="flex flex-col divide-y divide-token-border/60">
          <Section
            title="Nodex"
            hint={intl.formatMessage(SUGGESTION_HINTS[mode])}
            control={
              <InboxSuggestionModePicker
                trigger="compact"
                value={mode}
                onChange={(next) => void agents.save({ suggestions: next })}
              />
            }
          >
            <InboxSuggestionAgentPicker
              agents={agents}
              trigger="field"
              disabled={!suggestions || !ready}
            />
            <SwitchRow
              label={intl.formatMessage({
                id: "inbox.inboxAgentsPopover.startChats",
                defaultMessage: "Let Nodex start chats for me",
              })}
              hint={intl.formatMessage({
                id: "inbox.inboxAgentsPopover.whatYouClearlyAskFor",
                defaultMessage: "What you clearly ask for starts without a click.",
              })}
              checked={agents.settings.dispatchMode === "act_on_requests"}
              disabled={!suggestions}
              onCheckedChange={(start) =>
                void agents.save({ dispatchMode: start ? "act_on_requests" : "suggest" })
              }
            />
          </Section>
          <Section
            title={intl.formatMessage({
              id: "inbox.inboxAgentsPopover.newChats",
              defaultMessage: "New chats",
            })}
            hint={
              suggestions && agents.settings.suggestionsChooseModels
                ? intl.formatMessage({
                    id: "inbox.inboxAgentsPopover.suggestionsChooseEachOneOtherwise",
                    defaultMessage: "Suggestions choose each one; otherwise they run on this.",
                  })
                : intl.formatMessage({
                    id: "inbox.inboxAgentsPopover.everyNewChatRunsOn",
                    defaultMessage: "Every new chat runs on this.",
                  })
            }
          >
            <InboxChatAgentPicker agents={agents} trigger="field" disabled={!ready} />
            <SwitchRow
              label={intl.formatMessage({
                id: "inbox.inboxAgentsPopover.chooseModels",
                defaultMessage: "Suggestions choose models",
              })}
              checked={agents.settings.suggestionsChooseModels}
              disabled={!suggestions}
              onCheckedChange={(suggestionsChooseModels) =>
                void agents.save({ suggestionsChooseModels })
              }
            />
            {/* Where a chat works and what opens beside it hold for chats started by hand too,
                so they stay on while suggestions are off. */}
            <div className="flex flex-col gap-2 pt-1">
              <SwitchRow
                label={intl.formatMessage({
                  id: "inbox.inboxAgentsPopover.useAWorktree",
                  defaultMessage: "Use a worktree",
                })}
                checked={agents.settings.newChatsUseWorktrees}
                disabled={!agents.settingsReady}
                onCheckedChange={(newChatsUseWorktrees) =>
                  void agents.save({ newChatsUseWorktrees })
                }
              />
              <SwitchRow
                label={intl.formatMessage({
                  id: "inbox.inboxAgentsPopover.openBesideTheirMessage",
                  defaultMessage: "Open beside their message",
                })}
                checked={agents.settings.showPageBesideNewChats}
                disabled={!agents.settingsReady}
                onCheckedChange={(showPageBesideNewChats) =>
                  void agents.save({ showPageBesideNewChats })
                }
              />
            </div>
          </Section>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="cursor-interaction flex items-center justify-between gap-2 px-3 py-2 text-left text-sm text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground"
          >
            <FormattedMessage
              id="inbox.inboxAgentsPopover.routingPreferencesAndMore"
              defaultMessage="Routing preferences and more"
            />
            <ChevronRightIcon className="icon-xs shrink-0" />
          </button>
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}
