import { getIntl, type IntlShape } from "@/lib/i18n";
import type {
  PluginAppRow,
  PluginAppTool,
  PluginDetailApp,
} from "../../../../shared/codex-plugin-settings";
import { markdownLink } from "./skill-model";

/** What an app's switch, tools and Try now need, from a settings row or a plugin's page. */
export interface AppView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly logoUrl: string | null;
  readonly logoDarkUrl: string | null;
  readonly accessible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly restriction: string | null;
}

export function appViewFromRow(app: PluginAppRow): AppView {
  return {
    id: app.id,
    name: app.metadata?.name ?? app.name,
    description: app.metadata?.description ?? null,
    logoUrl: app.logoUrl,
    logoDarkUrl: app.logoDarkUrl,
    accessible: app.accessible === true,
    enabled: app.enabled,
    editable: app.editable,
    restriction: app.editRestriction?.message ?? null,
  };
}

export function appViewFromDetail(app: PluginDetailApp): AppView {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    logoUrl: app.logoUrl,
    logoDarkUrl: app.logoDarkUrl,
    accessible: app.accessible ?? app.connectionState === "connected",
    enabled: app.enabled !== false,
    editable: app.editable,
    restriction: app.editRestriction?.message ?? null,
  };
}

/** Why an app's switch can't be used, or why it is off; null when the switch explains itself. */
export function appSwitchExplanation(app: AppView, intl: IntlShape = getIntl()): string | null {
  if (!app.editable && app.restriction != null) return app.restriction;
  if (app.accessible && !app.enabled)
    return intl.formatMessage({
      id: "plugins.appModel.appDisabled",
      defaultMessage: "This app is disabled",
    });
  return null;
}

/** Only apps you have connected are listed in settings, matching name or description. */
export function connectedApps(apps: readonly AppView[], search: string): AppView[] {
  const query = search.trim().toLowerCase();
  return apps.filter(
    (app) =>
      app.accessible &&
      (query.length === 0 || `${app.name} ${app.description ?? ""}`.toLowerCase().includes(query)),
  );
}

export interface AppToolSection {
  readonly title: "Write" | "Read";
  readonly tools: readonly PluginAppTool[];
}

/**
 * An app's tools by what they do: tools that change things, then tools that only read. Tools
 * switched off are left out unless an administrator turned them off; each section is sorted by
 * name and an empty one is dropped.
 */
export function appToolSections(tools: readonly PluginAppTool[]): AppToolSection[] {
  const shown = tools
    .filter((tool) => tool.isEnabled || tool.disabledReason === "disabled_by_admin")
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return (
    [
      { title: "Write", tools: shown.filter((tool) => !tool.isReadOnly) },
      { title: "Read", tools: shown.filter((tool) => tool.isReadOnly) },
    ] as const
  ).filter((section) => section.tools.length > 0);
}

export function appToolsSummary(
  appName: string,
  sections: readonly AppToolSection[],
  intl: IntlShape = getIntl(),
): string {
  const total = sections.reduce((count, section) => count + section.tools.length, 0);

  const kinds = sections
    .map(({ title, tools }) =>
      intl.formatMessage(
        {
          id: "plugins.appModel.toolKindCount",
          defaultMessage: "{count} {kind, select, Write {write} other {read}}",
        },
        { count: tools.length, kind: title },
      ),
    )
    .join(intl.locale === "zh-CN" ? "、" : ", ");
  return intl.formatMessage(
    {
      id: "plugins.appModel.toolSummary",
      defaultMessage: "The {app} app contains {count} tools ({kinds})",
    },
    { app: appName, count: total, kinds },
  );
}

/** The note under a tool that can't be used. */
export function appToolRestrictionLabel(tool: PluginAppTool, intl = getIntl()): string | null {
  if (tool.disabledReason === "disabled_by_admin")
    return intl.formatMessage({
      id: "plugins.appModel.adminDisabled",
      defaultMessage: "Disabled by admin",
    });
  if (!tool.isEnabled)
    return intl.formatMessage({
      id: "plugins.appModel.unavailable",
      defaultMessage: "Unavailable",
    });
  return null;
}

/** A new chat's draft that mentions the app. */
export function appTryPrompt(app: Pick<AppView, "id" | "name">): string {
  return markdownLink(`@${app.name}`, `app://${app.id}`);
}

export type RequiredAppStatus = "pending" | "waitingForCallback" | "connected";

/**
 * Where connecting a just-installed plugin's app stands: connected once its account link shows
 * up, waiting after its connection page was opened, and pending before that.
 */
export function requiredAppStatus(
  app: Pick<PluginAppRow, "accessible" | "connectionState"> | undefined,
  opened: boolean,
): RequiredAppStatus {
  if (app?.accessible === true || app?.connectionState === "connected") return "connected";
  return opened ? "waitingForCallback" : "pending";
}
