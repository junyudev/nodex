import { expect, test } from "vite-plus/test";
import {
  canonicalGitRemote,
  localProjectSourceRoots,
  projectSourceFromIdentity,
} from "./project-sources";

test.each([
  ["git@github.com:acme/repo.git", "https://github.com/acme/repo"],
  ["ssh://git@git.example:22/acme/repo.git", "https://git.example/acme/repo"],
  ["https://GIT.EXAMPLE/acme/repo.git/", "https://git.example/acme/repo"],
  ["https://git.example:8443/acme/repo", "https://git.example:8443/acme/repo"],
])("normalizes remote %s without a clone path", (input, expected) =>
  expect(canonicalGitRemote(input)).toBe(expected),
);

test.each([
  "/srv/repo",
  "file:///srv/repo",
  "https://token@git.example/repo",
  "https://user:secret@git.example/repo",
  "https://git.example/repo?token=secret",
  "https://git.example/repo#ref",
  "ssh://git@git.example:2222/repo",
  "https://git.example:0/repo",
])("refuses a noncanonical or credential-bearing identity: %s", (input) =>
  expect(canonicalGitRemote(input)).toBeNull(),
);

test("repository identities cannot become local source paths", () => {
  const sources = [
    projectSourceFromIdentity("/srv/personal", 0),
    projectSourceFromIdentity("https://git.example/acme/repo", 1),
  ];
  expect(sources[1]).toEqual({
    kind: "repository",
    remote: "https://git.example/acme/repo",
    order: 1,
  });
  expect(localProjectSourceRoots(sources)).toEqual(["/srv/personal"]);
});
