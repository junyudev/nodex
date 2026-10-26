import { describe, expect, it } from "vite-plus/test";
import {
  resolveThoughtExcerpt,
  resolveThoughtHeading,
  resolveThoughtStatusLine,
} from "./thought-presentation";

describe("resolveThoughtHeading", () => {
  it("names the latest heading of sectioned reasoning", () => {
    expect(
      resolveThoughtHeading(
        "**Inspecting the bundle**\n\nReading the entry chunk.\n\n**Checking the live path**\n\nTracing the reducer.",
      ),
    ).toBe("Checking the live path");
    expect(resolveThoughtHeading("## Planning the patch\nTwo files change.")).toBe(
      "Planning the patch",
    );
  });

  it("names a quoted heading", () => {
    expect(resolveThoughtHeading("> **Checking files.**")).toBe("Checking files.");
  });

  it("names a heading that is still streaming", () => {
    expect(resolveThoughtHeading("**Drafting the pa")).toBe("Drafting the pa");
  });

  it("derives no heading from prose thinking", () => {
    const prose =
      "I need to check whether the label clamps. The group header path renders the summary " +
      "inside an inline span, so a long paragraph wraps across many lines.";
    expect(resolveThoughtHeading(prose)).toBeNull();
    expect(resolveThoughtHeading(`${prose}\n\n${prose}`)).toBeNull();
    expect(resolveThoughtStatusLine(prose)).toBe("Thinking");
  });

  it("does not treat bold emphasis inside a sentence or a list as a heading", () => {
    expect(resolveThoughtHeading("**Note:** the cache is cold.")).toBeNull();
    expect(resolveThoughtHeading("- **Checking the live path**")).toBeNull();
  });

  it("ignores HTML comments, including one still streaming", () => {
    expect(resolveThoughtHeading("**Applying changes**\n<!-- internal\nstate -->")).toBe(
      "Applying changes",
    );
    expect(resolveThoughtHeading("**Still visible**\n<!-- streaming internal")).toBe(
      "Still visible",
    );
    expect(resolveThoughtHeading("<!-- **Hidden** -->")).toBeNull();
  });

  it("projects heading Markdown to plain text", () => {
    expect(resolveThoughtHeading("# Reading `reducer.ts`")).toBe("Reading reducer.ts");
  });

  it("has no heading for empty text", () => {
    expect(resolveThoughtHeading("")).toBeNull();
    expect(resolveThoughtHeading(null)).toBeNull();
    expect(resolveThoughtStatusLine(undefined)).toBe("Thinking");
  });
});

describe("resolveThoughtExcerpt", () => {
  it("previews sectioned reasoning by its latest heading", () => {
    expect(resolveThoughtExcerpt("**Reading the reducer**\n\nTracing `apply`.")).toBe(
      "Reading the reducer",
    );
  });

  it("previews prose thinking by its opening text as plain text", () => {
    expect(resolveThoughtExcerpt("I need to check `reducer.ts`.\n\nThen the *store*.")).toBe(
      "I need to check reducer.ts. Then the store.",
    );
  });

  it("reads only a bounded prefix of long thinking", () => {
    const excerpt = resolveThoughtExcerpt(`Checking ${"a".repeat(20_000)}`);
    expect(excerpt?.startsWith("Checking a")).toBe(true);
    expect(excerpt?.length).toBeLessThanOrEqual(600);
  });

  it("has no excerpt for empty or comment-only text", () => {
    expect(resolveThoughtExcerpt("")).toBeNull();
    expect(resolveThoughtExcerpt("<!-- internal -->")).toBeNull();
  });
});
