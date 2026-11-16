import { expect, test } from "vite-plus/test";

import { resolveMainCiBase } from "./main-ci-base";

const headSha = "a".repeat(40);
const parent = "b".repeat(40);
const grandparent = "c".repeat(40);
const unrelated = "d".repeat(40);
const lineage = [headSha, parent, grandparent];

const run = (head_sha: string, id: number) => ({
  id,
  head_sha,
  head_branch: "main",
  event: "push",
  conclusion: "success",
});

const resolve = (runs: unknown, usesLastGreenRule = (_sha: string) => true) =>
  resolveMainCiBase({
    headSha,
    currentRunId: "3",
    runs,
    usesLastGreenRule,
    isAncestor: (ancestor, descendant) =>
      lineage.includes(descendant) && lineage.indexOf(ancestor) >= lineage.indexOf(descendant),
  });

test("uses the green parent even when the grandparent's dispatch is newer", () => {
  const runs = [{ ...run(grandparent, 2), event: "workflow_dispatch" }, run(parent, 1)];
  expect(resolve(runs).baseSha).toBe(parent);
});

test("reuses a successful main dispatch when the parent failed", () => {
  const runs = [
    { ...run(parent, 2), conclusion: "failure" },
    { ...run(grandparent, 1), event: "workflow_dispatch" },
  ];
  expect(resolve(runs).baseSha).toBe(grandparent);
});

test("skips successful runs on unrelated history, another branch, or another event", () => {
  const runs = [
    run(unrelated, 7),
    { ...run(parent, 6), head_branch: "feature" },
    { ...run(parent, 5), event: "schedule" },
    run(grandparent, 4),
  ];
  expect(resolve(runs).baseSha).toBe(grandparent);
});

test("ignores the current run and accepts another qualifying run for HEAD", () => {
  expect(resolve([run(headSha, 3), run(parent, 2)]).baseSha).toBe(parent);
  expect(resolve([run(headSha, 3), run(headSha, 2)]).baseSha).toBe(headSha);
});

test("runs every gate when the search finds no eligible ancestor", () => {
  expect(resolve([])).toEqual({
    baseSha: null,
    reason: "No trusted green ancestor in recent Main CI runs",
  });
});

test("runs every gate on rollout when only old-rule successes are available", () => {
  expect(resolve([run(parent, 2), run(grandparent, 1)], () => false).baseSha).toBeNull();
});

test("runs every gate when GitHub workflow history is unavailable", () => {
  expect(resolve(null)).toEqual({
    baseSha: null,
    reason: "GitHub workflow history unavailable",
  });
});
