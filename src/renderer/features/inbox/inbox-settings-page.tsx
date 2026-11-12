import { useState } from "react";
import {
  DEFAULT_INBOX_SETTINGS,
  MAX_INBOX_INSTRUCTIONS_CHARS,
  MAX_INBOX_SUGGESTION_CONCURRENCY,
  clampInboxSuggestionConcurrency,
} from "../../../shared/inbox";
import { INBOX_MODEL_GUIDE } from "../../../shared/inbox-model-guide";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexSettingsNumberInput,
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { readableIpcError } from "@/lib/ipc-error-message";
import { resetNodex } from "@/lib/inbox-runtime";
import { useInboxSettingsQuery, useUpdateInboxSettings } from "./use-inbox";
import {
  InboxChatAgentPicker,
  InboxSuggestionAgentPicker,
  useInboxAgents,
} from "./inbox-agent-picker";
import { InboxSuggestionModePicker } from "./inbox-suggestion-mode-picker";
import { INBOX_ROUTING_PREFERENCES_PLACEHOLDER } from "./inbox-presentation";

/** Saved once it is left or confirmed, so typing 12 never first asks for 1. */
function SuggestionConcurrencyInput({
  value,
  disabled,
  onChange,
}: {
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (next: number, settled: () => void) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    const next =
      draft.trim() && Number.isFinite(parsed) ? clampInboxSuggestionConcurrency(parsed) : value;
    if (next === value) return setDraft(null);
    setDraft(String(next));
    onChange(next, () => setDraft(null));
  };
  return (
    <NodexSettingsNumberInput
      aria-label="Suggestions at once"
      className="w-16"
      min={1}
      max={MAX_INBOX_SUGGESTION_CONCURRENCY}
      step={1}
      disabled={disabled}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

export function InboxSettingsPage() {
  const settingsQuery = useInboxSettingsQuery();
  const settings = settingsQuery.data ?? DEFAULT_INBOX_SETTINGS;
  const { useModelGuide: modelGuideEnabled } = settings;
  const update = useUpdateInboxSettings();
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
  const instructions = instructionsDraft ?? settings.instructions;
  // The same Agents, and the same pickers, as the Inbox's own settings panel.
  const agents = useInboxAgents();
  const ready = agents.state === "ready";

  const save = (input: Parameters<typeof update.mutate>[0], settled?: () => void) =>
    update.mutate(input, {
      onSuccess: () => {
        if (input.instructions !== undefined)
          setInstructionsDraft((current) => (current === input.instructions ? null : current));
      },
      onError: (error) => toast.danger(readableIpcError(error, "Inbox settings were not saved")),
      onSettled: settled,
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
      subtitle="How Nodex routes what you capture and hands it to chats."
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
      <SectionBlock title="Nodex">
        <SettingRow
          label="Suggest where messages go"
          description="Nodex suggests where each message goes as you send it, pausing when its Agent’s usage is about to run out. Each suggestion is one request to that Agent."
        >
          <InboxSuggestionModePicker
            trigger="settings"
            value={settings.suggestions}
            onChange={(suggestions) => save({ suggestions })}
          />
        </SettingRow>
        <SettingRow
          label="Let Nodex start chats for me"
          description="When you clearly ask for something to be done, Nodex starts it instead of suggesting it. Notes, plans, filing, and anything an Agent or an automation sent still wait for you."
        >
          <NodexSwitch
            ariaLabel="Let Nodex start chats for me"
            checked={settings.dispatchMode === "act_on_requests"}
            disabled={settings.suggestions === "off"}
            onCheckedChange={(start) =>
              save({ dispatchMode: start ? "act_on_requests" : "suggest" })
            }
          />
        </SettingRow>
        <SettingRow
          label="Nodex runs on"
          description="Nodex routes often and never does the work itself, so on Codex it starts on the economical GPT-6.1 Sol."
        >
          <div className="w-72 max-w-full">
            <InboxSuggestionAgentPicker
              agents={agents}
              trigger="field"
              disabled={settings.suggestions === "off" || !ready}
            />
          </div>
        </SettingRow>
        <SettingRow
          label="Suggestions at once"
          description={`How many can await Nodex at once, up to ${MAX_INBOX_SUGGESTION_CONCURRENCY}. Messages beyond this wait and are suggested together.`}
        >
          <SuggestionConcurrencyInput
            value={settings.suggestionConcurrency}
            disabled={settings.suggestions === "off"}
            onChange={(suggestionConcurrency, settled) => save({ suggestionConcurrency }, settled)}
          />
        </SettingRow>
        <SettingRow
          label="Start Nodex fresh"
          description="Nodex’s conversation is only its working memory; what it decided stays in your Inbox, Pages, and chats. Starting fresh archives the conversation, and the next message begins a new one."
        >
          <NodexButton
            variant="secondary"
            size="sm"
            onClick={() =>
              void resetNodex().then(
                () => toast.success("Nodex will start fresh"),
                (error) => toast.danger(readableIpcError(error, "Nodex could not start fresh")),
              )
            }
          >
            Start fresh
          </NodexButton>
        </SettingRow>
      </SectionBlock>
      <SectionBlock title="Routing preferences">
        <div className="flex items-start justify-between gap-4 p-3 pb-0">
          <p className="text-sm text-token-text-secondary">
            Standing instructions Nodex follows over its own guidance, such as which Project
            research belongs in or which model leads UI work.
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
            placeholder={INBOX_ROUTING_PREFERENCES_PLACEHOLDER}
            onChange={(event) => setInstructionsDraft(event.currentTarget.value)}
            className="mt-1.5 w-full resize-y rounded-md border border-token-input-border bg-token-input-background px-2.5 py-2 text-sm text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border"
          />
        </div>
      </SectionBlock>
      <SectionBlock title="Chats">
        <SettingRow
          label="Show the message beside new chats"
          description="A chat the Inbox starts opens with its message’s Page in the right panel."
        >
          <NodexSwitch
            ariaLabel="Show the message beside new chats"
            checked={settings.showPageBesideNewChats}
            onCheckedChange={(showPageBesideNewChats) => save({ showPageBesideNewChats })}
          />
        </SettingRow>
        <SettingRow
          label="New chats use a worktree"
          description="A chat the Inbox starts for a message works in its Page’s worktree, apart from your checkout. Off, it runs in the Project’s checkout. Each message can still choose."
        >
          <NodexSwitch
            ariaLabel="New chats use a worktree"
            checked={settings.newChatsUseWorktrees}
            onCheckedChange={(newChatsUseWorktrees) => save({ newChatsUseWorktrees })}
          />
        </SettingRow>
        <SettingRow
          label="Suggestions choose models"
          description="Each suggestion picks its new chat's Agent, model and effort, weighing what each does well and how much of each weekly budget is left. When another model suits part of the work, its prompt says so."
        >
          <NodexSwitch
            ariaLabel="Suggestions choose models"
            checked={settings.suggestionsChooseModels}
            onCheckedChange={(suggestionsChooseModels) => save({ suggestionsChooseModels })}
          />
        </SettingRow>
        <SettingRow
          label={
            settings.suggestionsChooseModels ? "Otherwise, new chats run on" : "New chats run on"
          }
          description={
            settings.suggestionsChooseModels
              ? "When a suggestion leaves the choice to the Inbox, and for messages handled by hand. Sending to an existing chat keeps that chat's."
              : "The Agent, model and effort for every chat the Inbox starts; one message can still choose another. Sending to an existing chat keeps that chat's."
          }
        >
          <div className="w-72 max-w-full">
            <InboxChatAgentPicker agents={agents} trigger="field" disabled={!ready} />
          </div>
        </SettingRow>
        <SettingRow
          label="Use Nodex's model guide"
          description="What Nodex knows each model does well, read by suggestions when they choose. Your routing preferences take precedence."
        >
          <NodexSwitch
            ariaLabel="Use Nodex's model guide"
            checked={modelGuideEnabled}
            disabled={!settings.suggestionsChooseModels}
            onCheckedChange={(useModelGuide) => save({ useModelGuide })}
          />
        </SettingRow>
        <InboxModelGuide />
      </SectionBlock>
    </SettingsPageSurface>
  );
}

/** The guide in full, so what suggestions are told about each model is never hidden. */
function InboxModelGuide() {
  return (
    <details className="group px-4 pb-3 text-sm">
      <summary className="cursor-interaction w-fit text-xs text-token-description-foreground hover:text-token-foreground">
        Show the model guide
      </summary>
      <dl className="mt-2 flex flex-col gap-2">
        {INBOX_MODEL_GUIDE.map((entry) => (
          <div key={entry.family} className="flex flex-col gap-0.5">
            <dt className="text-token-foreground">{entry.family}</dt>
            <dd className="text-xs leading-5 text-token-description-foreground">{entry.note}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
