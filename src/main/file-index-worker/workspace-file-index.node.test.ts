import { assert, it } from "@effect/vitest";
import { WorkspaceFileIndex } from "./workspace-file-index";

const roomy = { entries: 1_000, pathUnits: 100_000 };
const paths = (index: WorkspaceFileIndex) =>
  index
    .entries()
    .map((entry) => `${entry.match_type}:${entry.path}`)
    .sort();

it("gives rankers one growing list while building and a new list after each edit", () => {
  const index = new WorkspaceFileIndex(false);
  const building = index.entries();
  index.add("src/app/main.ts", roomy);
  assert.strictEqual(index.entries(), building);
  assert.deepEqual(
    building.map((entry) => entry.path),
    ["src/app/main.ts", "src/app", "src"],
  );
  index.finishBuilding();
  assert.strictEqual(index.entries(), building);
  const revision = index.revision;

  index.add("src/app/util.ts", roomy);
  assert.lengthOf(building, 3, "a finished list is never edited in place");
  assert.notStrictEqual(index.entries(), building);
  assert.isAbove(index.revision, revision);
  assert.equal(index.add("src/app/util.ts", roomy), "present");
});

it("removes directories once nothing searchable remains below them", () => {
  const index = new WorkspaceFileIndex(false);
  for (const path of ["a/b/c/one.ts", "a/b/two.ts", "a/three.ts", "top.ts"]) index.add(path, roomy);
  index.finishBuilding();

  assert.isTrue(index.remove("a/b/c/one.ts"));
  assert.isFalse(index.hasDirectory("a/b/c"));
  assert.isTrue(index.hasDirectory("a/b"));
  assert.isTrue(index.removeTree("a/b"));
  assert.deepEqual(paths(index), ["directory:a", "file:a/three.ts", "file:top.ts"]);
  assert.equal(index.size, 3);
  assert.equal(index.pathUnits, "a".length + "a/three.ts".length + "top.ts".length);
  assert.isTrue(index.removeTree(""));
  assert.deepEqual(paths(index), []);
  assert.equal(index.pathUnits, 0);
});

it("reconciles only the files a refresh listed", () => {
  const index = new WorkspaceFileIndex(false);
  for (const path of ["src/old.ts", "src/keep.ts", "src/nested/deep.ts"]) index.add(path, roomy);
  index.finishBuilding();

  const direct = index.reconcile("src", "direct", ["src/keep.ts", "src/new/fresh.ts"], roomy);
  assert.deepEqual(direct, { changed: true, full: false });
  assert.deepEqual(paths(index), [
    "directory:src",
    "directory:src/nested",
    "directory:src/new",
    "file:src/keep.ts",
    "file:src/nested/deep.ts",
    "file:src/new/fresh.ts",
  ]);

  index.reconcile("src", "tree", ["src/keep.ts"], roomy);
  assert.deepEqual(paths(index), ["directory:src", "file:src/keep.ts"]);
  assert.equal(index.indexedAncestor("src/new/later/file.ts"), "src");
});

it("stops at its capacity and normalizes listed names", () => {
  const index = new WorkspaceFileIndex(true);
  assert.equal(index.normalize("src\\app\\main.ts"), "src/app/main.ts");
  assert.isNull(index.normalize("bad\uFFFDname"));
  assert.equal(index.add("a/b.ts", { entries: 1, pathUnits: 100 }), "full");
  assert.equal(index.add("a/b.ts", { entries: 2, pathUnits: 100 }), "added");
  assert.equal(index.add("a/c.ts", { entries: 3, pathUnits: 7 }), "full");
  assert.equal(index.size, 2);
});
