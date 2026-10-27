import { describe, expect, it } from "vitest";
import {
  pluginInterface,
  pluginRow,
  pluginSummary,
} from "../../../../shared/test-fixtures/plugins";
import {
  includedItemsShowMoreLabel,
  pluginDeveloperSubtitle,
  pluginLegalNoticeVariant,
  pluginLongDescription,
  pluginPrimaryAction,
  pluginStarterPrompts,
  pluginTagline,
  sanitizePluginDescription,
  skillDisplayName,
  skillMarkdownBody,
} from "./plugin-detail-model";

const described = (
  meta: Parameters<typeof pluginInterface>[0] | null,
  description: string | null = null,
) => ({
  summary: pluginSummary({ interface: meta == null ? null : pluginInterface(meta) }),
  description,
});

describe("plugin detail text", () => {
  it("shows the short description as the tagline and a distinct long description below", () => {
    const plugin = described({
      shortDescription: "Triage PRs",
      longDescription: "Use GitHub to inspect repositories.",
    });
    expect(pluginTagline(plugin)).toBe("Triage PRs");
    expect(pluginLongDescription(plugin)).toBe("Use GitHub to inspect repositories.");
  });

  it("drops the long description when it would repeat the tagline", () => {
    const plugin = described({ shortDescription: null, longDescription: null }, "  Zero risk ");
    expect(pluginTagline(plugin)).toBe("Zero risk");
    expect(pluginLongDescription(plugin)).toBeNull();
  });

  it("trims starter prompts and skips blank ones", () => {
    const plugin = described({ defaultPrompt: [" Summarize this PR ", "  ", "Explain auth"] });
    expect(pluginStarterPrompts(plugin)).toEqual(["Summarize this PR", "Explain auth"]);
  });

  it("joins the developer and tagline into one subtitle", () => {
    expect(pluginDeveloperSubtitle(" OpenAI ", "Triage PRs")).toBe("By OpenAI • Triage PRs");
    expect(pluginDeveloperSubtitle("OpenAI", null)).toBe("By OpenAI");
    expect(pluginDeveloperSubtitle(null, "Triage PRs")).toBe("Triage PRs");
    expect(pluginDeveloperSubtitle("  ", null)).toBeNull();
  });

  it("reduces descriptions to inline Markdown", () => {
    expect(
      sanitizePluginDescription(
        "## Setup\r\n![shot](a.png)Install <b>it</b>.\n\n---\n- [x] done\n- [ ] next\n[](https://x)",
      ),
    ).toBe("Setup\nInstall it.\n\n\n- \\[x\\] done\n- \\[ \\] next");
  });
});

describe("plugin primary action", () => {
  const action = (
    summary: Parameters<typeof pluginSummary>[0],
    actionState: ReturnType<typeof pluginRow>["actionState"] = "installed_menu",
    pending?: "installing" | "uninstalling",
  ) => pluginPrimaryAction({ row: { summary: pluginSummary(summary), actionState }, pending });

  it("prefers a running action over the plugin's state", () => {
    expect(action({ installed: true }, "installed_menu", "uninstalling")).toBe("uninstalling");
    expect(action({ installed: false }, "install", "installing")).toBe("installing");
  });

  it("blocks admin-disabled and unavailable plugins", () => {
    expect(action({ availability: "DISABLED_BY_ADMIN", installed: false }, "admin_disabled")).toBe(
      "disabled_by_admin",
    );
    expect(action({ installed: false }, "unavailable")).toBe("unavailable");
  });

  it("installs, enables, or tries the plugin", () => {
    expect(action({ installed: false }, "install")).toBe("install");
    expect(action({ installed: true, enabled: false })).toBe("enable");
    expect(action({ installed: true, enabled: true })).toBe("try");
  });
});

describe("included items", () => {
  it("previews the next two names, then counts the rest", () => {
    expect(includedItemsShowMoreLabel(["Figma", "Notion", "Slack", "Linear"], 4)).toBe(
      "See Figma, Notion, and 2 more",
    );
    expect(includedItemsShowMoreLabel(["Figma", "Notion"], 2)).toBe("See Figma, Notion");
    expect(includedItemsShowMoreLabel(null, 3)).toBe("Show 3 more");
  });

  it("chooses the data-sharing notice from the app count", () => {
    expect(pluginLegalNoticeVariant(0)).toBe("none");
    expect(pluginLegalNoticeVariant(1)).toBe("single");
    expect(pluginLegalNoticeVariant(3)).toBe("multiple");
  });

  it("humanizes namespaced skill names unless a display name is set", () => {
    expect(skillDisplayName({ name: "github:gh-fix-ci" })).toBe("GH Fix CI");
    expect(skillDisplayName({ name: "pdf_tools", interface: { displayName: " PDFs " } })).toBe(
      "PDFs",
    );
    expect(skillDisplayName({ name: "openai-docs-and-apis" })).toBe("OpenAI Docs and APIs");
  });
});

describe("skill preview", () => {
  it("drops front matter and the title line the dialog already shows", () => {
    expect(
      skillMarkdownBody("---\r\nname: fix-ci\r\n---\r\n\r\n# Fix CI\r\n\r\nRun the checks.\n"),
    ).toBe("Run the checks.\n");
    expect(skillMarkdownBody("Intro without a title")).toBe("Intro without a title");
  });
});
