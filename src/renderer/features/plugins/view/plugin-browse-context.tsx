import { createContext, useContext } from "react";
import type { CustomizeNavigation } from "../customize-navigation";
import { pluginDisplayName } from "../model/plugin-labels";
import { rememberPluginTitle } from "../model/plugin-title-hints";
import { selectorToRouteTarget, type PluginRow } from "../plugin-management";
import { buildPluginDetailPath, type PluginDirectoryBrowse } from "../plugins-routes";

/** The directory view rows are listed in, so a plugin's breadcrumb can lead back to it. */
export const PluginBrowseContext = createContext<Partial<PluginDirectoryBrowse>>({});

/** Opens a row's page from where it is listed, titling the page's breadcrumb right away. */
export function useOpenPluginDetail(navigation: CustomizeNavigation): (row: PluginRow) => void {
  const browse = useContext(PluginBrowseContext);
  return (row) => {
    const target = selectorToRouteTarget(row);
    rememberPluginTitle(target.pluginId, pluginDisplayName(row));
    navigation.onNavigate(buildPluginDetailPath(target, browse));
  };
}
