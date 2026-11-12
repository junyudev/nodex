import { describe, expect, it } from "vitest";
import {
  effectivePluginContributions,
  emptyPluginRegistry,
  pluginInstallationId,
  publishPluginInstallation,
  setPluginInstallationEnabled,
  setPluginProjectEnabled,
  type LocalPluginSource,
  type PluginProject,
} from "./installation-registry";
import type { AgentPluginPackage } from "./types";

const source: LocalPluginSource = { kind: "local", locator: "/plugins/organizer" };
const project: PluginProject = { spaceId: "personal", projectId: "work" };

const pkg: AgentPluginPackage = {
  identity: { name: "organizer", version: "1.0" },
  layout: "codex",
  digest: "a".repeat(64),
  skills: [
    { name: "sort", description: "", directory: "skills/sort", valid: true, diagnostics: [] },
    { name: "broken", description: "", directory: "skills/broken", valid: false, diagnostics: [] },
  ],
  mcpServers: [
    {
      key: "organizer",
      transport: { type: "stdio", command: "organizer", args: [], env: {}, cwd: "./" },
      variables: [],
    },
  ],
  hooks: [
    {
      source: { kind: "file", path: "hooks/hooks.json" },
      events: [{ name: "PostToolUse", commands: ["organizer check"] }],
    },
  ],
  apps: [{ kind: "openai-hosted", key: "catalog", id: "connector_sample" }],
  extensions: {},
  diagnostics: [],
};

function applied(transition: ReturnType<typeof publishPluginInstallation>) {
  if (!transition.ok) throw new Error(transition.error.code);
  return transition;
}

describe("plugin installation registry", () => {
  it("derives identity from the manifest name and source coordinate", () => {
    const id = pluginInstallationId("organizer", source);
    expect(pluginInstallationId("other", source)).not.toBe(id);
    expect(pluginInstallationId("organizer", { ...source, locator: "/other" })).not.toBe(id);
    expect(pluginInstallationId("organizer", { ...source, kind: "git" })).not.toBe(id);
  });

  it("projects only valid contributions and records hook and app availability", () => {
    const installed = applied(publishPluginInstallation(emptyPluginRegistry, source, pkg, "first"));
    const { id } = installed.installation;
    const { registry } = applied(setPluginProjectEnabled(installed.registry, id, project, true));
    const [effective] = effectivePluginContributions(registry, project);
    expect(effective?.skills).toEqual([
      { name: "sort", directory: effective?.packageDirectory + "/skills/sort" },
    ]);
    expect(effective?.mcpServers).toEqual(pkg.mcpServers);
    expect(effective?.hooks).toEqual([{ ...pkg.hooks[0], status: "inert" }]);
    expect(effective?.apps).toEqual([{ ...pkg.apps[0], status: "requires-hosted-services" }]);

    const disabled = applied(setPluginInstallationEnabled(registry, id, false));
    expect(effectivePluginContributions(disabled.registry, project)).toEqual([]);
    const reinstated = applied(setPluginInstallationEnabled(disabled.registry, id, true));
    expect(effectivePluginContributions(reinstated.registry, project)).toEqual([effective]);
  });

  it("deactivates only the selected Space and Project and keeps duplicate commands idempotent", () => {
    const installed = applied(publishPluginInstallation(emptyPluginRegistry, source, pkg, "first"));
    const { id } = installed.installation;
    const enabled = applied(setPluginProjectEnabled(installed.registry, id, project, true));
    const repeated = applied(setPluginProjectEnabled(enabled.registry, id, project, true));
    expect(repeated.registry.revision).toBe(enabled.registry.revision);

    const otherSpace = { ...project, spaceId: "team" };
    const both = applied(setPluginProjectEnabled(repeated.registry, id, otherSpace, true));
    const disabled = applied(setPluginProjectEnabled(both.registry, id, project, false));
    expect(effectivePluginContributions(disabled.registry, project)).toEqual([]);
    expect(effectivePluginContributions(disabled.registry, otherSpace)).toHaveLength(1);
  });
});
