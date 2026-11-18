import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { classifyChangedPaths } from "../ci/classify-change.ts";
import { STATIC_GROUPS } from "../ci/ci-gate-plan.ts";
import {
  comparisonRef,
  planCheckSteps,
  readChangedPaths,
  rustGateEnvironment,
} from "./check-changed.ts";

describe("changed-check comparison", () => {
  it("prefers remote main even when local main already contains the unpushed work", () => {
    expect(comparisonRef(["refs/heads/main", "refs/remotes/origin/main"])).toBe(
      "refs/remotes/origin/main",
    );
  });

  it("falls back to local main only when remote main is absent", () => {
    expect(comparisonRef(["refs/heads/main"])).toBe("refs/heads/main");
    expect(() => comparisonRef([])).toThrow("requires origin/main or a local main ref");
  });

  it("includes unpushed commits on main, staged, unstaged, untracked, and deleted paths", () => {
    const generated = path.resolve(import.meta.dirname, "../../.generated");
    mkdirSync(generated, { recursive: true });
    const root = mkdtempSync(path.join(generated, "check-changed-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const write = (name: string, text = name) => writeFileSync(path.join(root, name), text);
    const commit = () =>
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "test");
    try {
      git("init", "-q", "--initial-branch=main");
      for (const name of ["deleted.ts", "staged.ts", "unstaged.ts"]) write(name);
      git("add", ".");
      commit();
      const base = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", base);
      write("committed.ts");
      git("add", ".");
      commit();
      write("staged.ts", "changed");
      git("add", "staged.ts");
      write("unstaged.ts", "changed");
      write("untracked.ts");
      rmSync(path.join(root, "deleted.ts"));
      expect(readChangedPaths(root)).toEqual({
        base,
        ref: "refs/remotes/origin/main",
        files: ["committed.ts", "deleted.ts", "staged.ts", "unstaged.ts", "untracked.ts"],
      });
      git("switch", "-qc", "feature");
      expect(readChangedPaths(root).base).toBe(base);
      git("update-ref", "-d", "refs/remotes/origin/main");
      expect(readChangedPaths(root).files).not.toContain("committed.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Main CI plan steps", () => {
  it("covers every selected static group with one integrated types check", () => {
    const steps = planCheckSteps(classifyChangedPaths(["package.json"]));
    expect(steps.preflight).toEqual([{ name: "static types", args: ["run", "check"] }]);
    expect(steps.gates.filter((step) => step.name.startsWith("static "))).toEqual(
      STATIC_GROUPS.filter((group) => group !== "types").map((group) => ({
        name: `static ${group}`,
        args: ["exec", "tsx", "scripts/ci/verify-static.ts", "--group", group],
      })),
    );
  });

  it("runs selected static groups even when no application suites are selected", () => {
    const plan = classifyChangedPaths([".github/workflows/_static-checks.yml"]);
    expect(plan.appTestSuites).toEqual([]);
    expect(
      planCheckSteps(plan).gates.some((step) => step.name === "static repository-contracts"),
    ).toBe(true);
    expect(planCheckSteps(plan).gates.some((step) => step.name === "static ui-contracts")).toBe(
      true,
    );
  });

  it("keeps the semantic check for docs-only plans without selecting CI lanes", () => {
    expect(planCheckSteps(classifyChangedPaths(["AGENTS.md"]))).toEqual({
      preflight: [{ name: "semantic", args: ["run", "check:semantic"] }],
      gates: [],
    });
  });

  it("runs formatting, Clippy, nextest and doctests through the affected Rust runner", () => {
    const steps = planCheckSteps(classifyChangedPaths(["crates/nodex-platform/src/lib.rs"]));
    expect(steps.gates.filter((step) => step.name.startsWith("rust "))).toEqual([
      { name: "rust format", args: ["exec", "cargo", "fmt", "--all", "--check"] },
      {
        name: "rust clippy",
        args: ["exec", "tsx", "scripts/ci/run-affected-rust.ts", "--kind", "clippy"],
        rust: true,
      },
      {
        name: "rust tests",
        args: ["exec", "tsx", "scripts/ci/run-affected-rust.ts", "--kind", "tests"],
        rust: true,
      },
    ]);
  });

  it("forwards the affected paths or full-workspace selection and bounds Rust workers", () => {
    const files = ["crates/nodex-platform/src/lib.rs"];
    expect(rustGateEnvironment(classifyChangedPaths(files), files)).toEqual({
      CI_CHANGED_PATHS_JSON: JSON.stringify(files),
      CI_RUST_FULL: "false",
      CARGO_BUILD_JOBS: "4",
      NEXTEST_TEST_THREADS: "2",
    });
    const full = rustGateEnvironment(classifyChangedPaths(["Cargo.lock"]), ["Cargo.lock"]);
    expect(full.CI_RUST_FULL).toBe("true");
    expect(full.CI_CHANGED_PATHS_JSON).toBe("[]");
  });

  it.each([
    ["packages/core-protocol/src/generated.ts", ["protocol contracts"]],
    ["crates/nodex-core/schema/current.sql", ["rust clippy", "rust tests", "rust migration"]],
    ["Cargo.lock", ["rust clippy", "rust tests", "protocol contracts", "rust migration"]],
    ["src/renderer/example.tsx", []],
  ])("selects independent budgeted Rust lanes for %s", (file, expected) => {
    const steps = planCheckSteps(classifyChangedPaths([file]));
    expect(steps.gates.filter((step) => step.rust).map((step) => step.name)).toEqual(expected);
  });
});
