import { useIntl } from "@/lib/i18n";
import { agentReadinessActionLabel, agentReadinessView } from "@/lib/agent-readiness-view";
import {
  agentSettingsTarget,
  useAgentSettingsNavigation,
  type AgentSetupTarget,
} from "@/lib/agent-settings-navigation";
import { toastFailure } from "@/lib/failure-toast";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { useBrowserAgentSignIn } from "./use-browser-agent-sign-in";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { buildSettingsAnchorPath } from "@/components/workbench/workbench-settings-routes";
import type { AgentModelSetupPresentation } from "@/components/shared/agent-runtime/agent-model-catalog-presentation";
import { agentRuntimeProviderLabel } from "@/lib/agent-runtime-model-selection";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import { agentDefinition } from "../../../shared/agents/registry";
import {
  agentReadiness,
  agentSignInOffer,
  type AgentReadinessAction,
  type AgentReadinessProvider,
} from "../../../shared/agents/readiness";
import { openCodeAgent } from "../../../shared/agents/opencode";
import { antigravityAgent } from "../../../shared/agents/antigravity";
import { isManagedRuntimeInstanceId } from "../../../shared/managed-runtime-instances";
import { isAppComponentId } from "../../../shared/app-components";
import { acpAgentsOwner } from "../acp-agents/use-acp-agents";
import { openAcpAgentSetupDialog } from "../acp-agents/acp-agent-setup-dialog";
import { APP_COMPONENTS_SETTINGS_ANCHOR } from "../app-components/app-components-settings-section";
import {
  componentInstallationReadiness,
  componentReadinessLabel,
} from "../app-components/provider-component-setup";
import { runAppComponentChange, useAppComponents } from "../app-components/use-app-components";
import { antigravityInstallationReadiness } from "../antigravity-runtime/antigravity-runtime-model";
import {
  antigravityRuntimeOwner,
  useAntigravityRuntime,
} from "../antigravity-runtime/antigravity-runtime-owner";
import { OPENCODE_FREE_MODELS_LABEL } from "../opencode-setup/opencode-setup-model";
import { useHostOpenCodeInstallation } from "../opencode-setup/use-opencode-setup";

interface SetupInstance {
  readonly binding: AgentBackendBinding;
  readonly label: string;
  readonly enabled: boolean;
  readonly usesHostExecutable?: boolean;
}

export function useComposerAgentSetup({
  hosted,
  instances,
  refreshCatalog,
  checkCatalogAgain,
  acpOwner = acpAgentsOwner,
}: {
  readonly acpOwner?: typeof acpAgentsOwner;
  readonly hosted: boolean;
  readonly instances: readonly SetupInstance[];
  readonly refreshCatalog: () => void;
  readonly checkCatalogAgain: () => Promise<void>;
}) {
  const intl = useIntl();
  const appHandle = useScopeHandle(appScope);
  const workbench = useWorkbenchWindowOwner();
  const openAgentSettings = useAgentSettingsNavigation();
  const browserSignIn = useBrowserAgentSignIn(refreshCatalog, !hosted);
  const components = useAppComponents();
  const hostInstallation = useHostOpenCodeInstallation({
    instances: hosted ? [] : instances,
    onReady: refreshCatalog,
  });
  const managedRuntime = useAntigravityRuntime(
    antigravityRuntimeOwner,
    !hosted &&
      instances.some(
        ({ binding }) =>
          agentDefinition(binding.driver).setup?.installation?.id ===
          antigravityAgent.setup.installation.id,
      ),
  );

  const openSettings = (binding: AgentSetupTarget) => {
    const target = agentSettingsTarget(binding);
    if (target.instanceId === undefined) openAgentSettings?.(target.kind);
    else openAgentSettings?.(target.kind, target.instanceId);
  };
  const read = (
    binding: AgentBackendBinding,
    provider?: AgentReadinessProvider,
    model?: string,
  ) => {
    const definition = agentDefinition(binding.driver);
    const instance = instances.find(
      ({ binding: entry }) => entry.instanceId === binding.instanceId,
    );
    const source =
      provider?.installationSource ??
      (instance?.usesHostExecutable ? definition.setup?.installation : undefined);
    const component =
      !hosted && source?.kind === "component"
        ? components.state?.components.find(({ id }) => id === source.id)
        : undefined;
    const inspector = definition.setup?.installation?.id;
    const managedInstallation = () => {
      if (hosted) return undefined;
      if (source?.kind === "managed" && source.id === openCodeAgent.setup.installation.id)
        return hostInstallation.installation;
      if (
        inspector === antigravityAgent.setup.installation.id &&
        (!provider?.installed || provider.status === "error")
      )
        return antigravityInstallationReadiness(managedRuntime, binding.instanceId);
      return undefined;
    };
    const installation = component
      ? componentInstallationReadiness(component, provider?.installed === true)
      : managedInstallation();
    return agentReadiness({
      definition,
      provider,
      source,
      installation,
      ...(model === undefined ? {} : { model }),
    });
  };
  const run = (
    binding: AgentSetupTarget,
    action: AgentReadinessAction | null,
    showModels?: () => void,
  ) => {
    if (!action) return;
    if (action.kind === "check-again") return checkCatalogAgain();
    if (hosted) return;
    switch (action.kind) {
      case "components":
        workbench.openRoute({
          kind: "settings",
          path: buildSettingsAnchorPath("general-settings", APP_COMPONENTS_SETTINGS_ANCHOR),
        });
        return;
      case "retry-installation":
        if (isAppComponentId(action.sourceId)) {
          const { sourceId } = action;
          return runAppComponentChange(sourceId, undefined, () => components.retry(sourceId));
        }
        break;
      case "install":
        if (isAppComponentId(action.sourceId)) return components.request(action.sourceId);
        break;
      case "sign-in":
        if (action.via === "browser" && action.owner === browserSignIn.owner)
          return browserSignIn.begin();
        if (action.via !== "dialog") break;
      // The same dialog handles installation, connection and authentication.
      // fall through
      case "connect":
        if (binding.instanceId) {
          openAcpAgentSetupDialog(appHandle, {
            owner: acpOwner,
            instanceId: binding.instanceId,
            ...(showModels ? { onShowModels: showModels } : {}),
            onOpenSettings: () => openSettings(binding),
          });
        }
        return;
      case "settings":
        break;
    }
    if (
      (action.kind === "install" || action.kind === "retry-installation") &&
      action.sourceId === openCodeAgent.setup.installation.id
    )
      return hostInstallation.open(showModels);
    openSettings(binding);
  };

  const setupRows = (
    providers: readonly AgentReadinessProvider[],
  ): readonly AgentModelSetupPresentation[] => {
    if (hosted) return [];
    const seen = new Set<string>();
    const rows = providers.flatMap((provider): AgentModelSetupPresentation[] => {
      if (
        isManagedRuntimeInstanceId(provider.instanceId) &&
        (provider.installed || provider.installationSource?.kind !== "component")
      )
        return [];
      const binding = { driver: provider.driver, instanceId: provider.instanceId };
      const problem = read(binding, provider);
      if (!problem) {
        const offer = agentSignInOffer(agentDefinition(provider.driver), provider);
        if (!offer || seen.has(provider.instanceId)) return [];
        seen.add(provider.instanceId);
        return [
          {
            key: provider.instanceId,
            kind: binding.driver,
            instanceId: provider.instanceId,
            label: agentRuntimeProviderLabel(provider, instances),
            hint: agentReadinessActionLabel(offer, intl),
            tone: "default",
            action: {
              kind: "open",
              open: ({ showModels }) => void run(binding, offer, showModels),
            },
          },
        ];
      }
      if (problem.problem.kind === "checking") return [];
      if (problem.problem.kind === "not-installed" && problem.problem.onDemand) return [];
      if (problem.problem.kind === "turned-off" && !problem.problem.supplier) return [];
      const source = provider.installationSource;
      const sharedComponent = source?.kind === "component" && !provider.installed;
      const key = sharedComponent ? source.id : provider.instanceId;
      if (seen.has(key)) return [];
      seen.add(key);
      const label = componentReadinessLabel(
        provider,
        agentRuntimeProviderLabel(provider, instances),
        intl,
      );
      const view = agentReadinessView(label, problem, intl);
      const action = problem.action;
      return [
        {
          key,
          kind: binding.driver,
          instanceId: provider.instanceId,
          label: sharedComponent ? view.title : label,
          ...(sharedComponent
            ? action
              ? { hint: agentReadinessActionLabel(action, intl) }
              : {}
            : { hint: view.hint }),
          tone: view.tone === "danger" ? "danger" : "default",
          ...(action
            ? {
                action: {
                  kind: "open",
                  open: ({ showModels }) => {
                    void Promise.resolve(run(binding, action, showModels)).catch(
                      (cause: unknown) => {
                        const title =
                          action.kind === "sign-in"
                            ? intl.formatMessage(
                                {
                                  id: "agentReadiness.couldNotSignIn",
                                  defaultMessage: "Couldn’t start signing in to {label}",
                                },
                                { label },
                              )
                            : view.title;
                        toastFailure(title, cause);
                      },
                    );
                  },
                },
              }
            : {}),
        },
      ];
    });
    // Host executable setup can be offered before the Runtime knows its model inventory.
    const hostReadiness = agentReadiness({
      definition: openCodeAgent,
      source: openCodeAgent.setup.installation,
      installation: hostInstallation.installation,
    });
    if (!hostReadiness || hostReadiness.problem.kind === "checking" || !hostReadiness.action)
      return rows;
    const label = intl.formatMessage(OPENCODE_FREE_MODELS_LABEL);
    const view = agentReadinessView(label, hostReadiness, intl);
    const binding = { driver: openCodeAgent.driver };
    return [
      ...rows.filter(
        ({ instanceId }) =>
          !instances.some(
            (instance) =>
              instance.binding.instanceId === instanceId &&
              instance.usesHostExecutable &&
              agentDefinition(instance.binding.driver) === openCodeAgent,
          ),
      ),
      {
        kind: binding.driver,
        label,
        hint: view.hint,
        tone: view.tone === "danger" ? "danger" : "default",
        action: {
          kind: "open",
          open: ({ showModels }: { showModels: () => void }) => {
            void run(binding, hostReadiness.action, showModels);
          },
        },
      },
    ];
  };

  return { read, run, setupRows, openSettings, refreshInstallation: hostInstallation.refresh };
}
