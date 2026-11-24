import { expect, test } from "vite-plus/test";
import { readChangelogHeadline, splitChangelogReleaseBody } from "./changelog-headline";

test("reads a single headline separately from the categories below it", () => {
  const { beforeCategories, categories } = splitChangelogReleaseBody(
    "\r\nGoogle Antigravity and a smaller Nodex\r\n\r\n### Added\r\n\r\n- Added a note.\r\n",
  );
  expect(readChangelogHeadline(beforeCategories, "0.5.11")).toBe(
    "Google Antigravity and a smaller Nodex",
  );
  expect(categories).toBe("### Added\n\n- Added a note.\n");
});

test("requires a headline for dated releases or when a caller is preparing Unreleased to ship", () => {
  expect(readChangelogHeadline("\n\n", "Unreleased")).toBeNull();
  expect(() => readChangelogHeadline("\n\n", "Unreleased", { required: true })).toThrow(
    "Unreleased needs a headline",
  );
  expect(() => readChangelogHeadline("\n\n", "0.5.11")).toThrow(
    /Release 0\.5\.11 needs a headline: .*at most 48 characters/u,
  );
});

test.each(["x".repeat(48), "Ready?", "Ready!", "See Settings > Agents", "Use MY_SETTING"])(
  "allows a plain headline such as %s",
  (headline) => {
    expect(readChangelogHeadline(`\n${headline}\n\n`, "0.5.11")).toBe(headline);
  },
);

test.each([
  "x".repeat(49),
  "Wrapped\n\nheadline",
  "Trailing space ",
  " Leading space",
  "Closing period.",
  "Open `Settings`",
  "Use *emphasis*",
  "Use _emphasis_",
  "__Open Settings__",
  "Read [the guide](https://example.test)",
  "Read ~~old news~~",
  "Open <em>Settings</em>",
  "# Heading",
  "- Bullet",
  "1. List item",
  "> Quote",
])("rejects invalid headline %j even in Unreleased", (headline) => {
  expect(() => readChangelogHeadline(`\n${headline}\n\n`, "Unreleased")).toThrow(
    "Unreleased needs a headline",
  );
});
