import { describe, expect, test } from "vite-plus/test";
import { getIntl } from "@/lib/i18n";
import type { CodexComposerPlugin, CodexComposerSkill } from "@/lib/types";
import {
  formatComposerSkillScopeLabel,
  resolveComposerSkillNames,
} from "./composer-skill-presentation";

const intl = getIntl();

function skill(overrides: Partial<CodexComposerSkill>): CodexComposerSkill {
  return {
    name: "review",
    displayName: "Review",
    description: "",
    iconUrl: null,
    brandColor: null,
    path: "/skills/review/SKILL.md",
    scope: "user",
    ...overrides,
  };
}

const spotify = {
  id: "app-68de829b@openai-curated",
  name: "app-68de829b",
  displayName: "Spotify",
} as CodexComposerPlugin;

describe("composer skill names", () => {
  test("names a plugin's skill after the plugin as listed, not its ID", () => {
    expect(
      resolveComposerSkillNames(
        intl,
        skill({
          name: "app-68de829b:browse-collections",
          displayName: "App 68de829b: Browse Collections",
          pluginId: spotify.id,
        }),
        [spotify],
      ),
    ).toEqual({ title: "Spotify: Browse Collections", pluginLabel: "From Spotify" });
  });

  test("keeps a title the skill declares and formats an unlisted plugin's ID", () => {
    expect(
      resolveComposerSkillNames(
        intl,
        skill({
          name: "app-68de829b:browse-collections",
          displayName: "Browse your library",
          pluginId: spotify.id,
        }),
        [spotify],
      ),
    ).toEqual({ title: "Browse your library", pluginLabel: "From Spotify" });
    expect(
      resolveComposerSkillNames(
        intl,
        skill({ name: "github-pr", displayName: "GitHub PR", pluginId: "github@openai-curated" }),
        [],
      ),
    ).toEqual({ title: "GitHub PR", pluginLabel: "From GitHub" });
    expect(resolveComposerSkillNames(intl, skill({}), [spotify])).toEqual({
      title: "Review",
      pluginLabel: null,
    });
  });

  test("names a repository skill after the longest root that holds it", () => {
    const label = (skillPath: string, roots: readonly string[]) =>
      formatComposerSkillScopeLabel(intl, { scope: "repo", skillPath, roots });

    expect(label("/work/app/web/.agents/skills/x/SKILL.md", ["/work/app/", "/work/app/web"])).toBe(
      "web",
    );
    expect(label("/elsewhere/skills/x/SKILL.md", ["/work/app"])).toBe("Team");
    expect(formatComposerSkillScopeLabel(intl, { scope: "system", skillPath: "", roots: [] })).toBe(
      "System",
    );
  });
});
