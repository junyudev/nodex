import { describe, expect, it } from "vitest";
import type { PluginAppTool } from "../../../../shared/codex-plugin-settings";
import {
  appSwitchExplanation,
  appToolRestrictionLabel,
  appToolSections,
  appToolsSummary,
  appTryPrompt,
  connectedApps,
  requiredAppStatus,
  type AppView,
} from "./app-model";

const app = (overrides: Partial<AppView> = {}): AppView => ({
  id: "connector_linear",
  name: "Linear",
  description: "Issues and projects",
  logoUrl: null,
  logoDarkUrl: null,
  accessible: true,
  enabled: true,
  editable: true,
  restriction: null,
  ...overrides,
});

const tool = (name: string, overrides: Partial<PluginAppTool> = {}): PluginAppTool => ({
  name,
  title: null,
  description: "",
  isEnabled: true,
  disabledReason: null,
  isReadOnly: false,
  editable: true,
  editRestriction: null,
  destructiveHint: null,
  ...overrides,
});

describe("apps in settings", () => {
  it("lists connected apps matching the search", () => {
    const apps = [app(), app({ id: "gmail", name: "Gmail", accessible: false })];
    expect(connectedApps(apps, "").map((item) => item.id)).toEqual(["connector_linear"]);
    expect(connectedApps(apps, "ISSUES")).toHaveLength(1);
    expect(connectedApps(apps, "calendar")).toHaveLength(0);
  });

  it("explains a locked or disabled switch", () => {
    expect(appSwitchExplanation(app())).toBeNull();
    expect(appSwitchExplanation(app({ enabled: false }))).toBe("This app is disabled");
    expect(
      appSwitchExplanation(app({ editable: false, restriction: "Disabled by your administrator" })),
    ).toBe("Disabled by your administrator");
  });
});

describe("app tools", () => {
  it("groups tools that change things before tools that read, sorted by name", () => {
    const sections = appToolSections([
      tool("update_issue"),
      tool("search", { isReadOnly: true }),
      tool("create_issue"),
      tool("hidden", { isEnabled: false }),
      tool("admin_only", { isEnabled: false, disabledReason: "disabled_by_admin" }),
    ]);
    expect(
      sections.map((section) => [section.title, section.tools.map((item) => item.name)]),
    ).toEqual([
      ["Write", ["admin_only", "create_issue", "update_issue"]],
      ["Read", ["search"]],
    ]);
    expect(appToolsSummary("Linear", sections)).toBe(
      "The Linear app contains 4 tools (3 write, 1 read)",
    );
    expect(appToolRestrictionLabel(sections[0]!.tools[0]!)).toBe("Disabled by admin");
  });

  it("drafts a chat that mentions the app", () => {
    expect(appTryPrompt({ id: "connector_x)", name: "X" })).toBe("[@X](app://connector_x\\))");
  });
});

describe("connecting a new plugin's apps", () => {
  it("waits after a connection page opens until the account link appears", () => {
    expect(requiredAppStatus(undefined, false)).toBe("pending");
    expect(
      requiredAppStatus({ accessible: false, connectionState: "authentication_required" }, true),
    ).toBe("waitingForCallback");
    expect(requiredAppStatus({ accessible: true, connectionState: "connected" }, true)).toBe(
      "connected",
    );
  });
});
