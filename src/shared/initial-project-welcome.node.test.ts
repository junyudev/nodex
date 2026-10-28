import { describe, expect, test } from "vite-plus/test";
import { extractMarkdownText, readMarkdown } from "./nodex-markdown";
import {
  INITIAL_PROJECT_WELCOME_TITLE,
  renderInitialProjectWelcomePage,
} from "./initial-project-welcome";

describe("initial Project welcome Page", () => {
  test.each([
    "/Users/alex/Documents/Nodex/My Project",
    "C:\\Users\\Alex\\Documents\\Nodex\\My Project",
    "/tmp/Nodex/My Project `draft` [one] *two*",
    "/用户/文档/Nodex/默认",
  ])("round-trips the visible source root through valid NFM: %s", (sourceRoot) => {
    const page = renderInitialProjectWelcomePage({ sourceRoot });
    const blocks = readMarkdown(page.markdown);
    const text = extractMarkdownText(page.markdown);

    expect(page.titleMarkdown).toBe(INITIAL_PROJECT_WELCOME_TITLE);
    expect(blocks.length).toBeGreaterThan(8);
    expect(text).toContain(sourceRoot);
    expect(text).toContain("Welcome to My Project");
    expect(text).toContain("Connect your model");
    expect(text).toContain("Try your first task");
    expect(text).toContain("A quick tour");
    expect(text).toContain("Explore next");
    expect(text).toContain("Send to chat");
    expect(text).toContain("Projectless chats");
    expect(text).toContain("DB Views");
  });

  test("rejects paths that cannot be represented by the Project source contract", () => {
    expect(() => renderInitialProjectWelcomePage({ sourceRoot: "" })).toThrow("bounded path");
    expect(() => renderInitialProjectWelcomePage({ sourceRoot: "/tmp/a\nb" })).toThrow(
      "bounded path",
    );
  });
});
