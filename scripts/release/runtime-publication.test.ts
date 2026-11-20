import { expect, test, vi } from "vite-plus/test";
import { publishRuntimeArchive } from "./runtime-publication";
import { assertWorkspaceRuntimePublicationTarget } from "./workspace-runtime";

const target = {
  repo: "example/nodex",
  tag: "workspace-runtime-vfixture",
  title: "Document Tools",
  notes: "Fixture",
};
const asset = { digest: `sha256:${"a".repeat(64)}`, size: 20, name: "fixture.tar.gz" };
const expected = new Map([[asset.name, { sha256: "a".repeat(64), size: 20 }]]);
const paths = new Map([[asset.name, `/tmp/${asset.name}`]]);

function githubFixture({
  assets = [] as (typeof asset)[],
  exists = false,
  latestAfter = "v0.5.10",
} = {}) {
  const release = { assets, draft: true, prerelease: false, tag_name: target.tag };
  let existsRemotely = exists;
  return vi.fn((args: readonly string[]) => {
    if (args[0] === "api") {
      if (args[1]?.endsWith("latest"))
        return JSON.stringify({ tag_name: release.draft ? "v0.5.10" : latestAfter });
      return JSON.stringify([existsRemotely ? [release] : []]);
    }
    if (args[1] === "create") existsRemotely = true;
    if (args[1] === "upload") release.assets = [asset];
    if (args[1] === "edit") release.draft = false;
    return "";
  });
}

test("creates a draft, uploads only missing assets and verifies stable Latest after publication", async () => {
  const github = githubFixture();
  await publishRuntimeArchive(target, expected, paths, github);
  const mutations = github.mock.calls.map(([args]) => args).filter(([verb]) => verb === "release");
  expect(mutations.map((args) => args[1])).toEqual(["create", "upload", "edit"]);
  expect(mutations[0]).toEqual(
    expect.arrayContaining(["--verify-tag", "--draft", "--latest=false"]),
  );
  expect(mutations[1]).toContain(paths.get(asset.name));
  expect(mutations[2]).toEqual(expect.arrayContaining(["--draft=false", "--latest=false"]));
  expect(github.mock.calls.at(0)?.[0][1]).toContain("/releases/latest");
  expect(github.mock.calls.at(-1)?.[0][1]).toContain("/releases/latest");
});

test("resumes an exact draft without replacing its asset and rejects a changed Latest", async () => {
  const github = githubFixture({ assets: [asset], exists: true, latestAfter: target.tag });
  await expect(publishRuntimeArchive(target, expected, paths, github)).rejects.toThrow(
    /changed.*Latest/,
  );
  expect(github.mock.calls.map(([args]) => args[1])).not.toContain("upload");
});

test("rejects conflicting assets before mutating a release", async () => {
  const github = githubFixture({ assets: [{ ...asset, size: 21 }], exists: true });
  await expect(publishRuntimeArchive(target, expected, paths, github)).rejects.toThrow(
    "does not match its lock",
  );
  expect(github.mock.calls.every(([args]) => args[0] === "api")).toBe(true);
});

test("requires a remote annotated tag at the chosen commit and immutable releases", () => {
  const commit = "a".repeat(40);
  const github = vi
    .fn()
    .mockReturnValueOnce(JSON.stringify({ object: { type: "commit", sha: commit } }));
  expect(() =>
    assertWorkspaceRuntimePublicationTarget(target.repo, target.tag, commit, github),
  ).toThrow("annotated");
  github
    .mockReturnValueOnce(JSON.stringify({ object: { type: "tag", sha: "b".repeat(40) } }))
    .mockReturnValueOnce(JSON.stringify({ object: { type: "commit", sha: commit } }))
    .mockReturnValueOnce(JSON.stringify({ enabled: false }));
  expect(() =>
    assertWorkspaceRuntimePublicationTarget(target.repo, target.tag, commit, github),
  ).toThrow("immutable releases");
});
