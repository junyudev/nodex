import { useState } from "react";
import { DEFAULT_INBOX_SETTINGS, MAX_INBOX_INSTRUCTIONS_CHARS } from "../../../shared/inbox";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { readableIpcError } from "@/lib/ipc-error-message";
import { useInboxSettingsQuery, useUpdateInboxSettings } from "./use-inbox";
import {
  InboxChatAgentPicker,
  InboxSuggestionAgentPicker,
  useInboxAgents,
} from "./inbox-agent-picker";

export function InboxSettingsPage() {
  const settingsQuery = useInboxSettingsQuery();
  const settings = settingsQuery.data ?? DEFAULT_INBOX_SETTINGS;
  const update = useUpdateInboxSettings();
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
  const instructions = instructionsDraft ?? settings.instructions;
  // The same Agents, and the same pickers, as the Inbox's own settings panel.
  const agents = useInboxAgents();
  const ready = agents.state === "ready";

  const save = (input: Parameters<typeof update.mutate>[0]) =>
    update.mutate(input, {
      onSuccess: () => {
        if (input.instructions !== undefined)
          setInstructionsDraft((current) => (current === input.instructions ? null : current));
      },
      onError: (error) => toast.danger(readableIpcError(error, "Inbox settings were not saved")),
    });

  if (!settingsQuery.data)
    return (
      <SettingsPageSurface title="Inbox">
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-token-description-foreground"
        >
          {settingsQuery.error ? "Couldn’t load Inbox settings" : "Loading…"}
          {settingsQuery.error ? (
            <NodexButton size="xs" variant="ghost" onClick={() => void settingsQuery.refetch()}>
              Retry
            </NodexButton>
          ) : null}
        </div>
      </SettingsPageSurface>
    );

  return (
    <SettingsPageSurface
      title="Inbox"
      subtitle="How captured messages are suggested and handed to chats."
    >
      {agents.readFailed ? (
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-token-description-foreground"
        >
          Couldn’t load Agents{" "}
          <NodexButton size="xs" variant="ghost" onClick={agents.reload}>
            Retry
          </NodexButton>
        </div>
      ) : null}
      <SectionBlock title="Suggestions">
        <SettingRow
          label="Suggest where messages go"
          description="Propose what to do with new messages."
        >
          <NodexSwitch
            ariaLabel="Suggest where messages go"
            checked={settings.suggestionsEnabled}
            onCheckedChange={(suggestionsEnabled) => save({ suggestionsEnabled })}
          />
        </SettingRow>
        <SettingRow
          label="Suggest with"
          description="Runs for every message, so on Codex it starts on the economical GPT-6.1 Sol."
        >
          <div className="w-72 max-w-full">
            <InboxSuggestionAgentPicker
              agents={agents}
              trigger="field"
              disabled={!settings.suggestionsEnabled || !ready}
            />
          </div>
        </SettingRow>
      </SectionBlock>
      <SectionBlock title="Routing preferences">
        <div className="flex items-start justify-between gap-4 p-3 pb-0">
          <p className="text-sm text-token-text-secondary">
            Standing instructions suggestions follow over Nodex’s own guidance, such as which
            Project research belongs in.
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
            onChange={(event) => setInstructionsDraft(event.currentTarget.value)}
            className="mt-1.5 w-full resize-y rounded-md border border-token-input-border bg-token-input-background px-2.5 py-2 text-sm text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border"
          />
        </div>
      </SectionBlock>
      <SectionBlock title="Chats">
        <SettingRow
          label="New chats run on"
          description="The Agent, model and effort the Inbox starts chats on. One message can choose another from its decision; sending to an existing chat keeps that chat's."
        >
          <div className="w-72 max-w-full">
            <InboxChatAgentPicker agents={agents} trigger="field" disabled={!ready} />
          </div>
        </SettingRow>
      </SectionBlock>
    </SettingsPageSurface>
  );
}
