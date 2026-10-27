import { describe, expect, it } from "vitest";
import {
  buildPluginDetailPath,
  buildPluginSettingsPath,
  resolvePluginSettingsTarget,
  buildPluginDirectoryPath,
  buildSkillsPath,
  resolvePluginsRouteState,
} from "./plugins-routes";

describe("plugins routes", () => {
  it("opens the public directory by default and for unknown paths", () => {
    expect(buildPluginDirectoryPath()).toBe("/plugins");
    expect(resolvePluginsRouteState("/plugins")).toEqual({
      page: "directory",
      tab: "openai",
      category: null,
      search: "",
    });
    expect(resolvePluginsRouteState("/plugins/missing-locator")).toEqual({
      page: "directory",
      tab: "openai",
      category: null,
      search: "",
    });
  });

  it("round-trips directory tabs and categories", () => {
    const personal = buildPluginDirectoryPath({ tab: "personal" });
    expect(personal).toBe("/plugins?directoryTab=personal");
    expect(resolvePluginsRouteState(personal)).toEqual({
      page: "directory",
      tab: "personal",
      category: null,
      search: "",
    });

    const category = buildPluginDirectoryPath({ category: "featured" });
    expect(category).toBe("/plugins?directoryTab=openai&category=featured");
    expect(resolvePluginsRouteState(category)).toEqual({
      page: "directory",
      tab: "openai",
      category: "featured",
      search: "",
    });
  });

  it("keeps a search alongside the selected tab and category", () => {
    const path = buildPluginDirectoryPath({ tab: "personal", search: "git hub" });
    expect(resolvePluginsRouteState(path)).toEqual({
      page: "directory",
      tab: "personal",
      category: null,
      search: "git hub",
    });
  });

  it("round-trips plugin detail targets from local and remote marketplaces", () => {
    const remote = {
      pluginId: "github@openai-curated-remote",
      pluginName: "plugin_connector_github",
      marketplace: { kind: "remote", remoteMarketplaceName: "openai-curated-remote" },
    } as const;
    const browse = { tab: "openai", category: null, search: "" };
    expect(resolvePluginsRouteState(buildPluginDetailPath(remote))).toEqual({
      page: "plugin",
      target: remote,
      browse,
    });

    const local = {
      pluginId: "review kit@my market",
      pluginName: "review kit",
      marketplace: { kind: "local", marketplacePath: "/Users/me/.agents/plugins/marketplace.json" },
    } as const;
    expect(resolvePluginsRouteState(buildPluginDetailPath(local))).toEqual({
      page: "plugin",
      target: local,
      browse,
    });
  });

  it("remembers the directory view a plugin was opened from", () => {
    const target = {
      pluginId: "figma@openai-curated",
      pluginName: "figma",
      marketplace: { kind: "remote", remoteMarketplaceName: "openai-curated" },
    } as const;
    const browse = { tab: "personal", category: "plugins-created-by-you", search: "fig" } as const;
    expect(resolvePluginsRouteState(buildPluginDetailPath(target, browse))).toEqual({
      page: "plugin",
      target,
      browse,
    });
  });

  it("opens Skills", () => {
    expect(resolvePluginsRouteState(buildSkillsPath())).toEqual({ page: "skills" });
  });

  it("round-trips an installed plugin's settings page", () => {
    const target = {
      pluginId: "figma@openai-curated",
      pluginName: "figma",
      marketplace: { kind: "local", marketplacePath: "/Users/me/marketplace.json" },
    } as const;
    expect(resolvePluginSettingsTarget(buildPluginSettingsPath(target))).toEqual(target);
    expect(resolvePluginSettingsTarget("/settings/plugins-settings")).toBeNull();
  });
});
