import { describe, expect, test } from "vite-plus/test";
import { asciiDirectoryName, asciiSlug } from "./ascii-name";

describe("ASCII names", () => {
  test.each([
    ["Fix the user's login_flow / signup!", {}, "fix-the-users-login-flow-signup"],
    ["Crème brûlée Ångström", {}, "creme-brulee-angstrom"],
    ["ＡＢＣ １２３ ﬁle ℡", {}, "abc-123-file-tel"],
    ["Straße Ærø Łódź", {}, "strasse-aero-lodz"],
    ["帮我修复 login 页面的 bug", {}, "login-bug"],
    ["修复login和signup", {}, "login-signup"],
    ["你好，世界", {}, ""],
    ["한국어 🗂️", {}, ""],
    ["  ---  ", {}, ""],
    ["one two three four", { maxWords: 2 }, "one-two"],
    ["alpha beta gamma", { maxLength: 11 }, "alpha-beta"],
    ["alpha beta gamma", { maxLength: 8 }, "alpha-be"],
  ] as const)("slugs %j with %j", (text, limits, slug) => {
    const result = asciiSlug(text, limits);
    expect(result).toBe(slug);
    expect(result).toMatch(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/u);
  });

  test("names a directory with a fallback and never as a Windows device", () => {
    expect(asciiDirectoryName("Launch Plan", "new-project")).toBe("launch-plan");
    expect(asciiDirectoryName("我的项目", "new-project")).toBe("new-project");
    expect(asciiDirectoryName("CON", "new-project")).toBe("new-project-con");
    expect(asciiDirectoryName("com¹", "new-chat")).toBe("new-chat-com1");
    expect(asciiDirectoryName("console", "new-chat")).toBe("console");
  });
});
