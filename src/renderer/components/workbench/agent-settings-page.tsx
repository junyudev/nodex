import { CODEX_BINDING } from "../../../shared/agents/codex";
import { agentSettingsSections } from "../../../shared/agents/registry";
import { AgentProfileSettingsSection } from "./agent-instance-settings-control";
import { providerComponentSetup } from "@/features/app-components/provider-component-setup";
import {
  runAppComponentChange,
  useAppComponents,
} from "@/features/app-components/use-app-components";
import { APP_COMPONENTS_SETTINGS_ANCHOR } from "@/features/app-components/app-components-settings-section";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { useId, useState } from "react";
import { buildSettingsAnchorPath, buildSettingsPath } from "./workbench-settings-routes";
import {
  AgentModelsProvider,
  ModelFilterResults,
  NodexModelsSection,
} from "@/features/model-policy/agent-models";
import { NODEX_MODELS_ANCHOR } from "@/lib/agent-settings-navigation";
import { PageSearchInput } from "../ui/page-search-input";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { AcpAgentsSettingsSection } from "@/features/acp-agents/acp-agents-settings-section";
import { ProviderKeysSettingsSection } from "@/features/provider-keys/provider-keys-settings-section";
import { agentSettingsKindForAnchor } from "@/lib/agent-settings-navigation";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  useNodexSettingsDisclosures,
} from "../ui/settings";
import { CodexAgentSettingsSection } from "./codex-home-settings-control";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

/**
 * Every Agent and model Nodex can run, Nodex's own models first and then each coding Agent, most
 * common first. Each card opens to its setup and its models; a filter finds models across them.
 */
export function AgentSettingsPage({
  open,
  settingsAnchor,
  onPathChange,
}: SettingsSectionPageProps) {
  const intl = useIntl();
  const [query, setQuery] = useState("");
  const filterId = useId();
  const codex = useAgentRuntimeProviders().data?.find(
    ({ instanceId }) => instanceId === CODEX_BINDING.instanceId,
  );
  const components = useAppComponents();
  const workbench = useWorkbenchWindowOwner();
  const component = components.state?.components.find(({ id }) => id === CODEX_BINDING.driver);
  const externalUnavailable = codex?.componentUnavailableReason === "external-unusable";
  const setup = externalUnavailable ? null : providerComponentSetup(codex, component, intl);
  const handleSetupAction = () => {
    if (setup?.action === "settings")
      return workbench.openRoute({
        kind: "settings",
        path: buildSettingsAnchorPath("general-settings", APP_COMPONENTS_SETTINGS_ANCHOR),
      });
    if (setup?.action === "retry")
      return runAppComponentChange(setup.id, undefined, () => components.retry(setup.id));
  };
  const disclosure = useNodexSettingsDisclosures(
    settingsAnchor === NODEX_MODELS_ANCHOR
      ? NODEX_MODELS_ANCHOR
      : agentSettingsKindForAnchor(settingsAnchor),
  );
  const filtering = query.trim() !== "";
  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.agentsTitle)}
      subtitle={intl.formatMessage(settingsMessages.agentsTheCodingAgentsNodexCanRun)}
      action={
        <PageSearchInput
          id={filterId}
          className="w-48"
          label={intl.formatMessage(settingsMessages.agentsFilterModels)}
          placeholder={intl.formatMessage(settingsMessages.agentsFilterModels)}
          searchQuery={query}
          onSearchQueryChange={setQuery}
        />
      }
    >
      <AgentModelsProvider onOpenAccount={() => onPathChange(buildSettingsPath("account"))}>
        {filtering ? <ModelFilterResults query={query} /> : null}
        {/* The cards stay mounted while a filter shows, so an unsaved profile edit survives it. */}
        <div className={filtering ? "hidden" : "flex flex-col gap-3"}>
          <NodexModelsSection disclosure={disclosure(NODEX_MODELS_ANCHOR)} />
          {agentSettingsSections.map((section) => {
            const anchor = section.settingsAnchor;
            const state = disclosure(anchor);
            const location = settingsAnchor ?? null;
            if ("profile" in section)
              return (
                <AgentProfileSettingsSection
                  key={anchor}
                  definition={section}
                  disclosure={state}
                  anchor={location}
                  open={open}
                />
              );
            if (anchor === "keys")
              return (
                <ProviderKeysSettingsSection key={anchor} disclosure={state} anchor={location} />
              );
            if (anchor === CODEX_BINDING.driver)
              return (
                <CodexAgentSettingsSection
                  key={anchor}
                  open={open}
                  disclosure={state}
                  unavailable={
                    setup?.title ??
                    ((!component || externalUnavailable) && codex?.componentUnavailableReason
                      ? codex.message
                      : undefined)
                  }
                  setupAction={
                    setup?.actionLabel ? { label: setup.actionLabel, run: handleSetupAction } : null
                  }
                />
              );
            return <AcpAgentsSettingsSection key={anchor} disclosure={state} anchor={location} />;
          })}
        </div>
      </AgentModelsProvider>
    </SettingsPageSurface>
  );
}
