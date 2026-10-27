import { forwardRef, type ComponentPropsWithoutRef, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  inboxSuggestionChoice,
  type InboxChatAgent,
  type InboxSettings,
  type UpdateInboxSettingsInput,
} from "../../../shared/inbox";
import { AgentModelPicker } from "@/components/shared/agent-runtime/agent-model-picker";
import { AgentProviderIcon, CompactChevronDownIcon } from "@/components/shared/icons";
import { NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { useAgentSettingsNavigation } from "@/lib/agent-settings-navigation";
import { readableIpcError } from "@/lib/ipc-error-message";
import { queryKeys } from "@/lib/query-keys";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import { cn } from "@/lib/utils";
import { useAgentInstances } from "../local-conversation/use-agent-instances";
import { useInboxSettings, useUpdateInboxSettings } from "./use-inbox";
import {
  chooseInboxChatOptions,
  chooseInboxModel,
  describeInboxAgent,
  inboxAgentLine,
  inboxAgentPickerModel,
  inboxAgentShortLine,
  sameInboxChatAgent,
  type InboxAgentCatalog,
  type InboxAgentPresentation,
  type InboxAgentPurpose,
} from "./inbox-agent-model";

/** The catalog and configured Agents, with the Inbox's own suggestion and chat Agents. */
export interface InboxAgents extends InboxAgentCatalog {
  /** The latest read failed, even when an earlier catalog is still shown. */
  readonly readFailed: boolean;
  /** The Inbox's preferences; a chat runs on `chatAgent` unless its message chooses another. */
  readonly settings: InboxSettings;
  readonly save: (input: UpdateInboxSettingsInput) => void;
  /** Reads the catalog as it is now without forcing a check. */
  readonly reload: () => void;
  /** Asks every Agent to check its models again. */
  readonly refresh: () => void;
}

/** One read of the Runtime catalog and Agent settings serves the whole Inbox. */
export function useInboxAgents(): InboxAgents {
  const client = useQueryClient();
  const catalog = useAgentRuntimeProviders();
  const { instances } = useAgentInstances();
  const settings = useInboxSettings();
  const update = useUpdateInboxSettings();
  return {
    providers: catalog.data ?? [],
    state: catalog.data ? "ready" : catalog.error ? "error" : "loading",
    readFailed: Boolean(catalog.error),
    instances,
    settings,
    save: (input) =>
      update.mutate(input, {
        onError: (error) => toast.danger(readableIpcError(error, "Inbox settings were not saved")),
      }),
    reload: () => void catalog.refetch(),
    refresh: () =>
      void agentRuntimeRuntime
        .catalog({ refresh: true })
        .then((providers) => client.setQueryData(queryKeys.agentRuntime.providers(), providers))
        .catch((error: unknown) =>
          toast.danger(readableIpcError(error, "Agents could not be checked")),
        ),
  };
}

/**
 * The Agent's mark, then what it runs. A tooltip spells out the whole line and wraps; a trigger
 * names the Agent only when its mark does not, and truncates.
 */
export function InboxAgentLabel({
  presentation,
  full = false,
  className,
}: {
  readonly presentation: InboxAgentPresentation;
  readonly full?: boolean;
  readonly className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {presentation.kind ? (
        <AgentProviderIcon kind={presentation.kind} className="size-3.5 shrink-0" />
      ) : null}
      <span className={cn("min-w-0", !full && "truncate")}>
        {full ? inboxAgentLine(presentation) : inboxAgentShortLine(presentation)}
      </span>
    </span>
  );
}

/** A quiet inline trigger, as the composer's model selector sits beside its send button. */
const InboxAgentInlineTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { readonly presentation: InboxAgentPresentation }
>(function InboxAgentInlineTrigger({ presentation, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Runs on ${inboxAgentLine(presentation)}`}
      {...props}
      className={cn(
        "cursor-interaction inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground aria-expanded:bg-token-list-hover-background",
        presentation.status === "unavailable" && "text-token-error-foreground",
        className,
      )}
    >
      <InboxAgentLabel presentation={presentation} />
      <CompactChevronDownIcon className="icon-2xs shrink-0" />
    </button>
  );
});

const PURPOSE_LABELS: Readonly<Record<InboxAgentPurpose, string>> = {
  chat: "New chat model",
  suggestion: "Suggestion model",
};

/**
 * Chooses what an Inbox Agent runs on, with the same model menu as the composer. Chats choose
 * effort and speed too; suggestions run each model at a fixed, economical effort.
 */
export function InboxAgentPicker({
  agents,
  purpose,
  scope,
  value,
  onChange,
  trigger,
  disabled = false,
}: {
  readonly agents: InboxAgents;
  readonly purpose: InboxAgentPurpose;
  /**
   * `inbox` for the Inbox's own choice; `message` for one decision's chat, which can become the
   * Inbox's; `delegate` for one part a chat hands to another Agent.
   */
  readonly scope: "inbox" | "message" | "delegate";
  readonly value: InboxChatAgent;
  readonly onChange: (next: InboxChatAgent) => void;
  /** `field` fills a form or panel row, `inline` sits beside a send button, or a caller's trigger. */
  readonly trigger: "field" | "inline" | ReactElement;
  readonly disabled?: boolean;
}) {
  const openAgentSettings = useAgentSettingsNavigation();
  const model = inboxAgentPickerModel(agents, value, purpose);
  const presentation = describeInboxAgent(agents, value, purpose);
  const differs =
    scope === "message" &&
    purpose === "chat" &&
    !sameInboxChatAgent(value, agents.settings.chatAgent);
  const triggerButton =
    trigger === "field" ? (
      <NodexSettingsDropdownTrigger
        aria-label={PURPOSE_LABELS[purpose]}
        className={cn(
          "w-full min-w-0 justify-between",
          presentation.status === "unavailable" && "text-token-error-foreground",
        )}
      >
        <InboxAgentLabel presentation={presentation} />
      </NodexSettingsDropdownTrigger>
    ) : trigger === "inline" ? (
      <InboxAgentInlineTrigger presentation={presentation} />
    ) : (
      trigger
    );
  return (
    <AgentModelPicker
      disabled={disabled}
      modelOnly={purpose === "suggestion"}
      triggerStyle={trigger === "field" ? "settings" : "composer"}
      triggerButton={triggerButton}
      models={model.models}
      selection={{
        kind: model.kind,
        model: model.selected.model,
        reasoningEffort: model.reasoningEffort,
        serviceTier: model.fast ? "fast" : null,
      }}
      onSelectionChange={(next, change) => {
        if (change === "reasoningEffort")
          onChange(chooseInboxChatOptions(value, { reasoningEffort: next.reasoningEffort }));
        else if (change === "serviceTier")
          onChange(chooseInboxChatOptions(value, { fast: next.serviceTier === "fast" }));
      }}
      catalog={{
        entries: model.entries,
        selected: model.selected,
        loading: agents.state === "loading",
        error: agents.state === "error" ? "Couldn’t load Agents" : null,
        choose: (selection) => onChange(chooseInboxModel(agents, value, selection)),
        refresh: agents.refresh,
        reload: agents.reload,
        manage: () => openAgentSettings?.(model.kind),
        configOptions: model.configOptions,
        changeConfig: async (_id, next) => {
          if (typeof next === "string")
            onChange(chooseInboxChatOptions(value, { reasoningEffort: next }));
        },
        // A choice for one decision can become the Inbox's own, so the two never drift apart unseen.
        actions: differs
          ? [{ label: "Use for all Inbox chats", run: () => agents.save({ chatAgent: value }) }]
          : [],
      }}
    />
  );
}

/** The suggestion Agent and model as a picker reads and writes them. */
export function InboxSuggestionAgentPicker({
  agents,
  trigger,
  disabled,
}: {
  readonly agents: InboxAgents;
  readonly trigger: "field" | ReactElement;
  readonly disabled?: boolean;
}) {
  return (
    <InboxAgentPicker
      agents={agents}
      purpose="suggestion"
      scope="inbox"
      value={inboxSuggestionChoice(agents.settings)}
      trigger={trigger}
      disabled={disabled}
      onChange={(next) =>
        agents.save({
          suggestionAgent: { instanceId: next.instanceId },
          suggestionModel: next.model,
        })
      }
    />
  );
}

/** What every chat the Inbox starts runs on. */
export function InboxChatAgentPicker({
  agents,
  trigger,
  disabled,
}: {
  readonly agents: InboxAgents;
  readonly trigger: "field" | ReactElement;
  readonly disabled?: boolean;
}) {
  return (
    <InboxAgentPicker
      agents={agents}
      purpose="chat"
      scope="inbox"
      value={agents.settings.chatAgent}
      trigger={trigger}
      disabled={disabled}
      onChange={(chatAgent) => agents.save({ chatAgent })}
    />
  );
}
