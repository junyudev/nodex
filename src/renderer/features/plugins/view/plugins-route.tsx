import type { CustomizeNavigation } from "../customize-navigation";
import { resolvePluginsRouteState } from "../plugins-routes";
import { PluginAppsOnboarding } from "./plugin-apps-onboarding";
import { PluginDetailPage } from "./plugin-detail-page";
import { PluginsDirectoryPage } from "./plugins-directory-page";
import { SkillsPage } from "./skills-page";

export interface PluginsRouteProps {
  readonly path: string;
  readonly navigation: CustomizeNavigation;
}

/** Customize's main surface: the plugin directory, a plugin's details, or Skills. */
export function PluginsRoute({ path, navigation }: PluginsRouteProps) {
  const state = resolvePluginsRouteState(path);
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
      ) : (
        <SkillsPage context={context} navigation={navigation} />
      )}
      <PluginAppsOnboarding context={context} navigation={navigation} />
    </div>
  );
}
