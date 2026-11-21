import { NodexButton } from "@/components/ui/button";
import { AppComponentRequirement } from "@/features/app-components/app-component-requirement";
import { providerComponentReadiness } from "@/features/app-components/provider-component-setup";
import { useAppComponent } from "@/features/app-components/use-app-components";
import { PageEmptyState } from "@/components/ui/section-header";
import { useIntl } from "@/lib/i18n";
import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import type { CustomizeNavigation } from "../customize-navigation";
import { resolvePluginsRouteState } from "../plugins-routes";
import { PluginAppsOnboarding } from "./plugin-apps-onboarding";
import { PluginDetailPage } from "./plugin-detail-page";
import { PluginsDirectoryPage } from "./plugins-directory-page";
import { SkillRoutePage } from "./skill-route-page";
import { SkillsPage } from "./skills-page";

export interface PluginsRouteProps {
  readonly path: string;
  readonly navigation: CustomizeNavigation;
}

/** Customize's main surface: the plugin directory, a plugin's details, or Skills. */
export function PluginsRoute({ path, navigation }: PluginsRouteProps) {
  const intl = useIntl();
  const state = resolvePluginsRouteState(path);
  const codex = useAgentRuntimeProviders().data?.find(({ instanceId }) => instanceId === "codex");
  const component = useAppComponent("codex");
  const readiness = providerComponentReadiness(component);
  const pluginsUnavailable =
    codex?.componentUnavailableReason !== undefined ||
    (!codex?.installed && (readiness === "installing" || readiness === "failed"));
  if (pluginsUnavailable && (state.page === "directory" || state.page === "plugin")) {
    const external = codex?.componentUnavailableReason === "external-unusable";
    if (!component)
      return (
        <PageEmptyState
          title={intl.formatMessage({
            id: "plugins.pluginsRoute.requiresCodex",
            defaultMessage: "Plugins require Codex",
          })}
        />
      );
    return (
      <PageEmptyState
        title={intl.formatMessage({
          id: "plugins.pluginsRoute.needsCodex",
          defaultMessage: "Plugins need Codex",
        })}
        description={
          external
            ? codex.message
            : intl.formatMessage({
                id: "plugins.pluginsRoute.installDescription",
                defaultMessage:
                  "Plugins, skills and MCP servers are managed through Codex. Install it to browse and add them.",
              })
        }
        actions={
          external ? (
            <NodexButton size="xs" variant="secondary" onClick={navigation.onOpenAgentsSettings}>
              {intl.formatMessage({
                id: "conversation.agentReadinessNotice.settings",
                defaultMessage: "Settings",
              })}
            </NodexButton>
          ) : (
            <AppComponentRequirement id="codex" />
          )
        }
      />
    );
  }
  const context = { hostId: "local", projectId: navigation.projectId };
  // Grids switch to two columns from the page's width, not the content column's.
  return (
    <div className="@container/skills-grid flex h-full w-full min-w-0 flex-1 flex-col">
      {state.page === "directory" ? (
        <PluginsDirectoryPage
          context={context}
          navigation={navigation}
          tab={state.tab}
          category={state.category}
          search={state.search}
        />
      ) : state.page === "plugin" ? (
        <PluginDetailPage
          key={state.target.pluginId}
          context={context}
          navigation={navigation}
          target={state.target}
          browse={state.browse}
        />
      ) : state.page === "skill" ? (
        <SkillRoutePage
          context={context}
          navigation={navigation}
          skillId={state.skillId}
          created={state.created}
        />
      ) : (
        <SkillsPage context={context} navigation={navigation} />
      )}
      {!pluginsUnavailable && <PluginAppsOnboarding context={context} navigation={navigation} />}
    </div>
  );
}
