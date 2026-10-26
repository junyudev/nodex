import { expect, it } from "vitest";
import type { SkillSummary } from "@nodex/codex-app-server-protocol/v2/SkillSummary";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import { matchPluginDetailSkill, projectPluginMcpServers } from "./PluginDetailModel";
import { authorizedPluginAsset } from "./PluginInventoryPolicy";

const manifest = (patch: Partial<SkillSummary> = {}): SkillSummary => ({
  name: "make_art",
  description: "",
  shortDescription: null,
  path: null,
  interface: null,
  enabled: true,
  ...patch,
});
const local = (patch: Partial<SkillMetadata> = {}): SkillMetadata => ({
  name: "image-tools:make-art",
  path: "/skills/art/SKILL.md",
  enabled: false,
  scope: "user",
  description: "",
  pluginId: "image-tools@custom",
  ...patch,
});

it("matches paths first, then qualified names, then a unique per-segment comparable name", () => {
  const path = local({ name: "renamed", path: "/match" });
  const exact = local({ name: "image-tools:make_art", path: "/exact" });
  expect(matchPluginDetailSkill("image-tools", manifest({ path: "/match" }), [exact, path])).toBe(
    path,
  );
  expect(matchPluginDetailSkill("image-tools", manifest(), [local(), exact])).toBe(exact);
  expect(matchPluginDetailSkill("Image Tools", manifest(), [local()])).toEqual(local());
  expect(
    matchPluginDetailSkill("ignored", manifest({ name: "Image Tools:make art" }), [local()]),
  ).toEqual(local());
  expect(
    matchPluginDetailSkill(
      "image-tools",
      manifest({ path: "/old", name: "image-tools:make_art" }),
      [local()],
    ),
  ).toEqual(local());
});

it("leaves ambiguous or unrelated local skills unavailable and deduplicates roots", () => {
  const skill = local();
  expect(matchPluginDetailSkill("image-tools", manifest(), [skill, skill])).toBe(skill);
  expect(
    matchPluginDetailSkill("image-tools", manifest(), [skill, local({ path: "/other" })]),
  ).toBeNull();
  expect(matchPluginDetailSkill("", manifest(), [skill])).toBeNull();
  expect(matchPluginDetailSkill("image-tools", manifest({ name: "other" }), [skill])).toBeNull();
});

it("authorizes local skill icons before HTTPS fallback", () => {
  expect(
    authorizedPluginAsset(
      "/icons/skill.svg",
      "https://cdn.test/skill.svg",
      (path) => `app://asset${path}`,
    ),
  ).toBe("app://asset/icons/skill.svg");
  expect(authorizedPluginAsset("relative.svg", "https://cdn.test/skill.svg", () => null)).toBe(
    "https://cdn.test/skill.svg",
  );
  expect(authorizedPluginAsset(null, "file:///secret", () => null)).toBeNull();
});

it("projects only unique MCP config keys and fences installation and other plugin owners", () => {
  const config = {
    config: {
      mcp_servers: {
        "art.with.dot": { name: "Art Tools", enabled: false },
        "duplicate-a": { name: "Duplicate" },
        "duplicate-b": { name: "Duplicate" },
      },
    },
  } as unknown as import("@nodex/codex-app-server-protocol/v2/ConfigReadResponse").ConfigReadResponse;
  const view = projectPluginMcpServers(
    ["Art Tools", "Duplicate"],
    "art@custom",
    true,
    true,
    config,
    [],
  );
  expect(view[0]).toEqual({
    name: "Art Tools",
    configKey: "art.with.dot",
    enabled: false,
    installed: true,
    canSetEnabled: true,
  });
  expect(view[1]?.configKey).toBeNull();
  expect(
    projectPluginMcpServers(["Art Tools"], "art@custom", false, true, config, [])[0],
  ).toMatchObject({ installed: false, configKey: null, canSetEnabled: false });
  expect(
    projectPluginMcpServers(["Art Tools"], "art@custom", true, true, config, [
      { name: "art.with.dot", pluginId: "other@custom" } as never,
    ])[0]?.canSetEnabled,
  ).toBe(false);
});
