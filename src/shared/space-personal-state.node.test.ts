import { expect, test } from "vite-plus/test";
import { personalStateKeyMatches } from "./space-personal-state";

test("fences device attention state by Space and Member while retaining Desktop preferences", () => {
  const draft = JSON.stringify(["space", "team-a", "alice", "draft:same-page"]);
  expect(personalStateKeyMatches(draft, "team-a", "alice")).toBe(true);
  expect(personalStateKeyMatches(draft, "team-b", "alice")).toBe(false);
  expect(personalStateKeyMatches(draft, "team-a", "bob")).toBe(false);
  expect(personalStateKeyMatches(JSON.stringify(["space", "team-a"]), "team-a")).toBe(false);
  expect(personalStateKeyMatches("app.theme", "team-a", "alice")).toBe(true);
});
