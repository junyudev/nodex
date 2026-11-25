import { lazySurface } from "@/bootstrap/application-surface";

// Surfaces that load with the first tab, panel or overlay that shows them, not with the Workbench.

export const DbViewSessionTab = lazySurface(
  async () => (await import("./workbench-db-view-panel")).DbViewSessionTab,
);
export const InboxRoute = lazySurface(
  async () => (await import("@/features/inbox/inbox-route")).InboxRoute,
);
export const WorkbenchDatabaseViewSurface = lazySurface(
  async () => (await import("./workbench-database-view-surface")).WorkbenchDatabaseViewSurface,
);
export const WorkbenchLibraryResourceSurface = lazySurface(
  async () =>
    (await import("./workbench-library-resource-surface")).WorkbenchLibraryResourceSurface,
);
export const WorkbenchSkillPageSurface = lazySurface(
  async () => (await import("./workbench-skill-page-surface")).WorkbenchSkillPageSurface,
);
export const WorkbenchPageFileSurface = lazySurface(
  async () => (await import("./workbench-page-file-surface")).WorkbenchPageFileSurface,
);
export const WorkbenchBrowserSidebarPanel = lazySurface(
  async () => (await import("./workbench-new-tab-page")).WorkbenchBrowserSidebarPanel,
);
export const PluginAppView = lazySurface(
  async () => (await import("@/features/plugins/view/plugin-app-view")).PluginAppView,
);
export const PluginAppBreadcrumb = lazySurface(
  async () => (await import("@/features/plugins/view/plugin-app-view")).PluginAppBreadcrumb,
);
export const ThreadPluginAppView = lazySurface(
  async () => (await import("@/features/plugins/view/plugin-app-view")).ThreadPluginAppView,
);
export const FirstRunOverlay = lazySurface(
  async () => (await import("@/features/first-run/first-run-overlay")).FirstRunOverlay,
);
