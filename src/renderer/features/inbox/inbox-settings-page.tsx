import { useState } from "react";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { InboxAgentBinding } from "../../../shared/inbox";
import {
  DEFAULT_INBOX_SETTINGS,
  MAX_INBOX_INSTRUCTIONS_CHARS,
  inboxDefaultSuggestionModel,
  supportsInboxStructuredGeneration,
} from "../../../shared/inbox";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import { readableInboxError } from "./inbox-presentation";
import { useInboxSettingsQuery, useUpdateInboxSettings } from "./use-inbox";

type InboxProvider = AgentRuntimeOperations["providers.read"]["output"][number];
type CatalogState = "loading" | "ready" | "error";

const available = (provider: InboxProvider) =>
  provider.enabled &&
  provider.installed &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.availability !== "unavailable";

function AgentPicker({
  value,
  ariaLabel,
  providers,
  catalogState,
  suggestions = false,
  onChange,
}: {
  readonly value: InboxAgentBinding;
  readonly ariaLabel: string;
  readonly providers: readonly InboxProvider[];
  readonly catalogState: CatalogState;
  readonly suggestions?: boolean;
  readonly onChange: (binding: InboxAgentBinding) => void;
}) {
  const selected = providers.find((provider) => provider.instanceId === value.instanceId);
  const current = selected?.displayName ?? value.instanceId;
  const usable =
    selected &&
    available(selected) &&
    (!suggestions || supportsInboxStructuredGeneration(selected));
  return (
    <NodexOptionPicker
      align="end"
      search="filter"
      searchAriaLabel={`Search ${ariaLabel.toLowerCase()}s`}
      disabled={catalogState !== "ready"}
      triggerButton={
        <NodexSettingsDropdownTrigger aria-label={ariaLabel}>
          {catalogState === "loading" ? "Loading…" : current}
          {catalogState === "ready" && !usable ? " · Unavailable" : ""}
        </NodexSettingsDropdownTrigger>
      }
      value={value.instanceId}
      options={providers
        .filter(
          (provider) =>
            !suggestions ||
            supportsInboxStructuredGeneration(provider) ||
            provider.instanceId === value.instanceId,
        )
        .map((provider) => ({
          value: provider.instanceId,
          label: provider.displayName ?? provider.instanceId,
          disabled:
            !available(provider) || (suggestions && !supportsInboxStructuredGeneration(provider)),
          subText: available(provider) ? undefined : "Unavailable",
        }))}
      onValueChange={(instanceId) => onChange({ instanceId })}
    />
  );
}

export function InboxSettingsPage() {
  const settingsQuery = useInboxSettingsQuery();
  const settings = settingsQuery.data ?? DEFAULT_INBOX_SETTINGS;
  const update = useUpdateInboxSettings();
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
  const instructions = instructionsDraft ?? settings.instructions;
  const catalog = useAgentRuntimeProviders();
  const catalogState: CatalogState = catalog.data ? "ready" : catalog.error ? "error" : "loading";
  const providers = catalog.data ?? [];
  const suggestionProvider = providers.find(
    (provider) => provider.instanceId === settings.suggestionAgent.instanceId,
  );
  const models = suggestionProvider?.models ?? [];
  const defaultModel = suggestionProvider
    ? inboxDefaultSuggestionModel(suggestionProvider)
    : undefined;
  const selectedModel = models.find((model) => model.slug === settings.suggestionModel);
  const modelLabel =
    catalogState === "loading"
      ? "Loading…"
      : settings.suggestionModel === null
        ? `Default${defaultModel ? ` · ${defaultModel.name}` : ""}`
        : (selectedModel?.name ??
          `${settings.suggestionModel}${catalogState === "ready" ? " · Unavailable" : ""}`);

  const save = (input: Parameters<typeof update.mutate>[0]) =>
    update.mutate(input, {
      onSuccess: () => {
        if (input.instructions !== undefined)
          setInstructionsDraft((current) => (current === input.instructions ? null : current));
      },
      onError: (error) => toast.danger(readableInboxError(error, "Inbox settings were not saved")),
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
      {catalog.error ? (
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-token-description-foreground"
        >
          Couldn’t load Agents{" "}
          <NodexButton size="xs" variant="ghost" onClick={() => void catalog.refetch()}>
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
        <SettingRow label="Suggestion agent" description="The runtime that writes suggestions.">
          <AgentPicker
            ariaLabel="Suggestion agent"
            value={settings.suggestionAgent}
            providers={providers}
            catalogState={catalogState}
            suggestions
            onChange={(suggestionAgent) => save({ suggestionAgent, suggestionModel: null })}
          />
        </SettingRow>
        <SettingRow
          label="Model"
          description="Runs for every message, so Default uses GPT-6.1 Sol on Codex."
        >
          <NodexOptionPicker
            align="end"
            search="filter"
            searchAriaLabel="Search suggestion models"
            disabled={
              catalogState !== "ready" ||
              !suggestionProvider ||
              !available(suggestionProvider) ||
              !supportsInboxStructuredGeneration(suggestionProvider)
            }
            value={settings.suggestionModel ?? "default"}
            triggerButton={
              <NodexSettingsDropdownTrigger aria-label="Suggestion model">
                {modelLabel}
              </NodexSettingsDropdownTrigger>
            }
            options={[
              {
                value: "default",
                label: `Default${defaultModel ? ` · ${defaultModel.name}` : ""}`,
              },
              ...models.map((model) => ({ value: model.slug, label: model.name })),
            ]}
            onValueChange={(model) => save({ suggestionModel: model === "default" ? null : model })}
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
            onChange={(event) => setInstructionsDraft(event.currentTarget.value)}
            className="mt-1.5 w-full resize-y rounded-md border border-token-input-border bg-token-input-background px-2.5 py-2 text-sm text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground focus:border-token-focus-border"
          />
        </div>
      </SectionBlock>
      <SectionBlock title="Chats">
        <SettingRow
          label="New chats run on"
          description="The runtime for chats the Inbox starts. Messages sent to an existing chat use that chat's runtime."
        >
          <AgentPicker
            ariaLabel="New chat runtime"
            value={settings.chatAgent}
            providers={providers}
            catalogState={catalogState}
            onChange={(chatAgent) => save({ chatAgent })}
          />
        </SettingRow>
      </SectionBlock>
    </SettingsPageSurface>
  );
}
