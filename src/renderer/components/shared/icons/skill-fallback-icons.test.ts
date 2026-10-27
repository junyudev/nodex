import { describe, expect, it } from "vitest";
import { AppActivityIcon } from "./activity-icons";
import { SlashCodeReviewIcon } from "./app-icons";
import {
  SkillBrowserIcon,
  SkillBuildkiteIcon,
  SkillContext7Icon,
  SkillCubeColorIcon,
  SkillFigmaColorIcon,
  SkillGitHubIcon,
  SkillOpenAIIcon,
  SkillPlanIcon,
  SkillPlaywrightColorIcon,
  SkillSentryIcon,
  SkillSlackIcon,
  skillFallbackIcon,
} from "./skill-fallback-icons";
import { WebsiteLinearIcon, WebsiteNotionIcon } from "./website-icons";

describe("skillFallbackIcon", () => {
  it("matches a keyword anywhere in the name, ignoring case and surrounding space", () => {
    expect(skillFallbackIcon({ name: "review" })).toBe(SlashCodeReviewIcon);
    expect(skillFallbackIcon({ name: "  PR Reviewer  " })).toBe(SlashCodeReviewIcon);
    expect(skillFallbackIcon({ name: "code-review-helper" })).toBe(SlashCodeReviewIcon);
    expect(skillFallbackIcon({ name: "Linear triage" })).toBe(WebsiteLinearIcon);
    expect(skillFallbackIcon({ name: "openai-docs" })).toBe(SkillOpenAIIcon);
    expect(skillFallbackIcon({ name: "chrome-devtools" })).toBe(SkillBrowserIcon);
    expect(skillFallbackIcon({ name: "web browser" })).toBe(SkillBrowserIcon);
    expect(skillFallbackIcon({ name: "slack-digest" })).toBe(SkillSlackIcon);
    expect(skillFallbackIcon({ name: "notion-sync" })).toBe(WebsiteNotionIcon);
    expect(skillFallbackIcon({ name: "sentry-observability" })).toBe(SkillSentryIcon);
  });

  it("treats whitespace as a hyphen, so a spaced gh prefix reads as GitHub", () => {
    expect(skillFallbackIcon({ name: "gh-address-comments" })).toBe(SkillGitHubIcon);
    expect(skillFallbackIcon({ name: "GH  fix ci" })).toBe(SkillGitHubIcon);
    expect(skillFallbackIcon({ name: "ghost" })).toBe(SkillCubeColorIcon);
  });

  it("applies the keyword order when a name contains several", () => {
    expect(skillFallbackIcon({ name: "codex-review" })).toBe(AppActivityIcon);
    expect(skillFallbackIcon({ name: "linear-review" })).toBe(WebsiteLinearIcon);
    expect(skillFallbackIcon({ name: "review-plan" })).toBe(SlashCodeReviewIcon);
    expect(skillFallbackIcon({ name: "github-planner" })).toBe(SkillGitHubIcon);
    expect(skillFallbackIcon({ name: "plan-in-notion" })).toBe(SkillPlanIcon);
    expect(skillFallbackIcon({ name: "buildkite-sentry" })).toBe(SkillBuildkiteIcon);
    expect(skillFallbackIcon({ name: "figma-implement-design" })).toBe(SkillFigmaColorIcon);
    expect(skillFallbackIcon({ name: "linear-implement-ticket" })).toBe(WebsiteLinearIcon);
  });

  it("reads the description only for GitHub, Playwright, and Context7", () => {
    expect(skillFallbackIcon({ name: "triage", description: "Uses the GitHub CLI" })).toBe(
      SkillGitHubIcon,
    );
    expect(skillFallbackIcon({ name: "e2e", description: "Drives PLAYWRIGHT tests" })).toBe(
      SkillPlaywrightColorIcon,
    );
    expect(skillFallbackIcon({ name: "docs", description: "Fetches Context7 docs" })).toBe(
      SkillContext7Icon,
    );
    expect(skillFallbackIcon({ name: "digest", description: "Posts to Slack" })).toBe(
      SkillCubeColorIcon,
    );
    expect(skillFallbackIcon({ name: "notes", description: "A review checklist" })).toBe(
      SkillCubeColorIcon,
    );
  });

  it("checks a description keyword at its own place in the keyword order", () => {
    expect(skillFallbackIcon({ name: "plan", description: "Opens a GitHub issue" })).toBe(
      SkillGitHubIcon,
    );
    expect(skillFallbackIcon({ name: "sentry", description: "Then runs Playwright" })).toBe(
      SkillSentryIcon,
    );
  });

  it("falls back to the cube when nothing matches", () => {
    expect(skillFallbackIcon({ name: "skill-creator" })).toBe(SkillCubeColorIcon);
    expect(skillFallbackIcon({ name: "" })).toBe(SkillCubeColorIcon);
    expect(skillFallbackIcon({ name: "constructor", description: null })).toBe(SkillCubeColorIcon);
    expect(skillFallbackIcon({ name: "pdf-tools", description: undefined })).toBe(
      SkillCubeColorIcon,
    );
  });
});
