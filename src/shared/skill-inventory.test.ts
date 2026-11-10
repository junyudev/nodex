import { expect, it } from "vite-plus/test";
import { SkillSlugSchema, skillInput } from "./skill-inventory";

it("accepts portable skill slugs and rejects reserved or multi-segment names", () => {
  expect(SkillSlugSchema.safeParse("my-skill-2").success).toBe(true);
  for (const slug of [
    "",
    ".",
    "..",
    ".system",
    "con",
    "com1",
    "lpt9",
    "trail.",
    "trail ",
    "/a",
    "a/b",
    "a\\b",
    "a\0b",
    "A",
    "a".repeat(65),
  ]) {
    expect(SkillSlugSchema.safeParse(slug).success, slug).toBe(false);
  }
  expect(skillInput.list.safeParse({ hostId: "local", projectId: null }).success).toBe(true);
});
