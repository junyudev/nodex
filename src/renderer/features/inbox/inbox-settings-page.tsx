import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InboxAgentBinding } from "../../../shared/inbox";
import { MAX_INBOX_INSTRUCTIONS_CHARS } from "../../../shared/inbox";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { readClaudeAgentSettings } from "@/lib/workbench-settings-runtime";
import { readableInboxError } from "./inbox-presentation";
import { useInboxSettings, useUpdateInboxSettings } from "./use-inbox";

const sameBinding = (left: InboxAgentBinding, right: InboxAgentBinding) =>
  left.kind === right.kind &&
  (left.kind === "codex" ||
    (right.kind === "claude" && left.instanceConfigId === right.instanceConfigId));

function AgentPicker({
  value,
  ariaLabel,
  onChange,
}: {
  readonly value: InboxAgentBinding;
  readonly ariaLabel: string;
  readonly onChange: (binding: InboxAgentBinding) => void;
}) {
  const claude = useQuery({
    queryKey: ["settings", "claudeAgents", "inbox"],
    queryFn: readClaudeAgentSettings,
    staleTime: 30_000,
  });
  const options: { readonly binding: InboxAgentBinding; readonly label: string }[] = [
    { binding: { kind: "codex" }, label: "Codex" },
    ...(claude.data?.instances ?? [])
      .filter((instance) => instance.enabled)
      .map((instance) => ({
        binding: { kind: "claude" as const, instanceConfigId: instance.id },
        label: instance.displayName,
      })),
  ];
  const current = options.find((option) => sameBinding(option.binding, value))?.label ?? "Codex";
  return (
    <NodexDropdownMenu
      align="end"
      triggerButton={
        <NodexSettingsDropdownTrigger aria-label={ariaLabel}>
          {current}
        </NodexSettingsDropdownTrigger>
      }
    >
      {options.map((option) => (
        <NodexDropdownItem
          key={option.label + option.binding.kind}
          rightSlot={sameBinding(option.binding, value) ? <NodexDropdownSelectedIcon /> : null}
          onSelect={() => onChange(option.binding)}
        >
          {option.label}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

export function InboxSettingsPage() {
  const settings = useInboxSettings();
  const update = useUpdateInboxSettings();
  const [instructions, setInstructions] = useState(settings.instructions);
  const [model, setModel] = useState(settings.suggestionModel ?? "");
  useEffect(() => setInstructions(settings.instructions), [settings.instructions]);
  useEffect(() => setModel(settings.suggestionModel ?? ""), [settings.suggestionModel]);

  const save = (input: Parameters<typeof update.mutate>[0]) =>
    update.mutate(input, {
      onError: (error) => toast.danger(readableInboxError(error, "Inbox settings were not saved")),
    });

  return (
    <SettingsPageSurface
      title="Inbox"
      subtitle="How messages you capture are suggested and dispatched. Nothing runs until you confirm."
    >
      <SectionBlock title="Suggestions">
        <SettingRow
          label="Suggest where messages go"
          description="An Agent reads new messages and proposes a chat, a Project, or keeping them. It never acts on its own."
        >
          <NodexSwitch
            ariaLabel="Suggest where messages go"
            checked={settings.suggestionsEnabled}
            onCheckedChange={(suggestionsEnabled) => save({ suggestionsEnabled })}
          />
        </SettingRow>
        <SettingRow label="Suggestion agent" description="The runtime that writes suggestions.">
          <AgentPicker
            ariaLabel="Suggestion agent"
            value={settings.suggestionAgent}
            onChange={(suggestionAgent) => save({ suggestionAgent, suggestionModel: null })}
          />
        </SettingRow>
        <SettingRow
          label="Model"
          description="Optional exact model for suggestions. Leave empty for the runtime's helper default."
        >
          <input
            aria-label="Suggestion model"
            value={model}
            placeholder="Default"
            onChange={(event) => setModel(event.currentTarget.value)}
            onBlur={() => {
              const next = model.trim() || null;
              if (next !== settings.suggestionModel) save({ suggestionModel: next });
            }}
            className="h-8 w-48 rounded-lg border border-token-input-border bg-token-input-background px-2.5 text-sm text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border"
          />
        </SettingRow>
      </SectionBlock>
      <SectionBlock title="Routing preferences">
        <div className="flex items-start justify-between gap-4 p-3 pb-0">
          <p className="text-sm text-token-text-secondary">
            Standing guidance the suggestion agent follows, such as which Project research belongs
            in.
          </p>
          <NodexButton
            variant="secondary"
            size="sm"
            disabled={instructions === settings.instructions || update.isPending}
            onClick={() => save({ instructions })}
          >
            Save
          </NodexButton>
        </div>
        <div className="p-3 pt-2">
          <textarea
            aria-label="Routing preferences"
            maxLength={MAX_INBOX_INSTRUCTIONS_CHARS}
            rows={5}
            value={instructions}
            placeholder="Research and comparisons go to new read-only chats. UI fixes for Nodex go to the Nodex Project."
            onChange={(event) => setInstructions(event.currentTarget.value)}
            className="mt-1.5 w-full resize-y rounded-md border border-token-input-border bg-token-input-background px-2.5 py-2 text-sm text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border"
          />
        </div>
      </SectionBlock>
      <SectionBlock title="Dispatch">
        <SettingRow
          label="New chats run on"
          description="The runtime for chats the Inbox starts. Messages sent to an existing chat use that chat's runtime."
        >
          <AgentPicker
            ariaLabel="New chat runtime"
            value={settings.chatAgent}
            onChange={(chatAgent) => save({ chatAgent })}
          />
        </SettingRow>
      </SectionBlock>
    </SettingsPageSurface>
  );
}
