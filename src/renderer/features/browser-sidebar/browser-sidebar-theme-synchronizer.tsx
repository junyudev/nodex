import { useEffect } from "react";
import { useTheme } from "@/lib/use-theme";
import { invokeBrowserSidebarCommand } from "./browser-sidebar-commands";

export function BrowserSidebarThemeSynchronizer() {
  const { resolved } = useTheme();

  useEffect(() => {
    if (!window.api || window.__NODEX_STORYBOOK__) return;
    void invokeBrowserSidebarCommand({
      type: "sync-theme",
      themeVariant: resolved,
    });
  }, [resolved]);

  return null;
}
