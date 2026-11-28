import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { APP_TEST_SUITES, STATIC_GROUPS } from "./ci-gate-plan";
import { buildChangeClassificationDocument, classifyChangedPaths } from "./classify-change";

describe("CI change classification", () => {
  test("keeps documentation out of executable gates", () => {
    expect(classifyChangedPaths(["docs/release.md", "docs/ARCHITECTURE.md"])).toEqual({
      allGates: false,
      appTestSuites: [],
      dependencyKind: "none",
      docsOnly: true,
      draft: false,
      landingOnly: false,
      protocolContracts: false,
      relatedPaths: [],
      rustFast: false,
      rustFull: false,
      staticGroups: [],
      testMode: "none",
      windowsChecks: false,
    });
  });

  test.each([
    ["CHANGELOG.md"],
    ["changes/fixed/2026-11-24-editor.md", "docs/release.md"],
    ["changes/README.md", "changes/added/2026-11-24-editor.md"],
    ["changes/fixed/nested/malformed.txt"],
  ])("validates release notes with release:check alone: %s", (...paths) => {
    expect(classifyChangedPaths(paths)).toEqual({
      allGates: false,
      appTestSuites: [],
      dependencyKind: "none",
      docsOnly: false,
      draft: false,
      landingOnly: false,
      protocolContracts: false,
      relatedPaths: [],
      rustFast: false,
      rustFull: false,
      staticGroups: ["repository-contracts"],
      testMode: "none",
      windowsChecks: false,
    });
  });

  test("adds release:check to the plan of the change a release note describes", () => {
    const change = "changes/added/2026-11-24-editor.md";
    const source = classifyChangedPaths(["src/renderer/components/app.tsx"]);
    const withNotes = classifyChangedPaths(["src/renderer/components/app.tsx", change]);
    expect(withNotes).toEqual({
      ...source,
      staticGroups: expect.arrayContaining([...source.staticGroups, "repository-contracts"]),
    });
    expect(withNotes.relatedPaths).not.toContain(change);
    expect(classifyChangedPaths(["packages/landing/src/App.tsx", change])).toMatchObject({
      landingOnly: true,
      staticGroups: ["source-ownership", "repository-contracts", "landing"],
      relatedPaths: ["packages/landing/src/App.tsx"],
    });
  });

  test("selects only the landing owner for landing plus documentation", () => {
    expect(classifyChangedPaths(["packages/landing/src/App.tsx", "README.md"])).toMatchObject({
      appTestSuites: ["unit", "renderer"],
      landingOnly: true,
      staticGroups: ["source-ownership", "landing"],
      testMode: "related",
    });
  });

  test("checks the landing Worker and its deployment in the landing CI lanes", () => {
    const paths = ["packages/landing/worker/index.ts", ".github/workflows/deploy-landing-site.yml"];
    expect(classifyChangedPaths(paths)).toMatchObject({
      appTestSuites: ["unit", "renderer"],
      landingOnly: true,
      relatedPaths: paths,
      staticGroups: ["source-ownership", "ci-contracts", "tooling-contracts", "landing"],
      testMode: "related",
    });
  });

  test("requires source ownership for every TypeScript extension and project configuration", () => {
    for (const path of [
      "src/renderer/components/new.tsx",
      "src/main/new.cts",
      "scripts/new.mts",
      "scripts/ci/new.ts",
      "tests/fixtures/new.ts",
      "packages/effect-codex-app-server/scripts/auxiliary.mts",
      "packages/landing/auxiliary.cts",
      "packages/landing/auxiliary.mts",
      "third_party/blocknote/packages/core/new.config.tsx",
      "docs/example.ts",
      ".github/actions/run-stress-tests/helper.ts",
      ".github/actions/setup-playwright/helper.mts",
      ".github/actions/setup-rust-ci/helper.cts",
      "config/tsconfig.node.json",
      "packages/landing/tsconfig.json",
    ]) {
      expect(classifyChangedPaths([path]).staticGroups, path).toContain("source-ownership");
    }
  });

  test("keeps non-TypeScript landing edits within the build owner", () => {
    expect(classifyChangedPaths(["packages/landing/src/index.css"])).toMatchObject({
      landingOnly: true,
      staticGroups: ["landing"],
    });
  });

  test("uses Vitest related selection for ordinary application source", () => {
    const paths = ["src/renderer/components/app.tsx", "docs/CI.md"];
    expect(classifyChangedPaths(paths)).toMatchObject({
      appTestSuites: ["unit", "renderer", "browser"],
      relatedPaths: ["src/renderer/components/app.tsx"],
      rustFast: false,
      staticGroups: ["types", "source-ownership", "ui-contracts", "startup-bundles"],
      testMode: "related",
    });
  });

  test("routes changed test files directly to their related owning suite", () => {
    for (const [path, suite] of [
      ["src/renderer/lib/example.node.test.ts", "unit"],
      ["src/renderer/lib/example.jsdom.test.ts", "renderer"],
      ["src/renderer/lib/example.browser.test.tsx", "browser"],
      ["src/main/core-client/example.node.test.ts", "core-client"],
      ["src/main/new-application/example.node.test.ts", "core-client"],
      ["packages/effect-codex-app-server/src/example.test.ts", "effect-codex"],
      ["src/shared/block-documents/yjs-yrs-conformance.test.ts", "core-client"],
      ["src/main/example.test.ts", "main"],
      ["src/host/example.test.ts", "main"],
      ["src/host/example.node.test.ts", "core-client"],
      ["src/host/example.integration.ts", "integration"],
      ["src/main/example.integration.ts", "integration"],
    ] as const) {
      expect(classifyChangedPaths([path]), path).toMatchObject({
        appTestSuites: [suite],
        relatedPaths: [path],
        testMode: "related",
      });
    }
  });

  test("routes host implementation changes through the application suites", () => {
    expect(classifyChangedPaths(["src/host/HostKernel.ts"])).toMatchObject({
      appTestSuites: ["core-client", "main", "integration"],
      testMode: "related",
    });
  });

  test("promotes config and deleted-path changes to deterministic full suites", () => {
    for (const [paths, options] of [
      [["config/vitest.renderer.config.ts"], {}],
      [["src/renderer/lib/removed.ts"], { forceFullTests: true }],
    ] as const) {
      expect(classifyChangedPaths(paths, options)).toMatchObject({
        appTestSuites: paths[0]?.startsWith("config/vitest.renderer")
          ? ["renderer"]
          : ["unit", "renderer", "browser"],
        relatedPaths: [],
        testMode: "full",
      });
    }
  });

  test("leaves explicit stress tests to their nightly owner", () => {
    expect(classifyChangedPaths(["src/main/git-worker/example.stress.test.ts"])).toMatchObject({
      appTestSuites: [],
      staticGroups: ["types", "source-ownership", "ci-contracts", "repository-contracts"],
      testMode: "none",
    });
  });

  test.each([
    ["src/main/core-client/example.nightly.node.test.ts", "core-client"],
    ["src/renderer/example.nightly.browser.test.tsx", "browser"],
    ["scripts/ci/example.nightly.test.ts", "unit"],
    ["packages/landing/src/example.nightly.jsdom.test.ts", "renderer"],
    ["src/host/example.nightly.integration.ts", "integration"],
  ])("runs changes to %s in the owning suite", (path, suite) => {
    expect(classifyChangedPaths([path, "docs/CI.md"])).toMatchObject({
      appTestSuites: [suite],
      docsOnly: false,
      protocolContracts: false,
      relatedPaths: [path],
      staticGroups: ["types", "ci-contracts"],
      testMode: "related",
      windowsChecks: false,
    });
  });

  test("adds changed nightly coverage to a source edit's related plan", () => {
    const source = "src/main/boards/board-queries.ts";
    const nightly = "scripts/ci/example.nightly.test.ts";
    expect(classifyChangedPaths([source, nightly])).toMatchObject({
      appTestSuites: ["unit", "core-client", "main", "integration"],
      relatedPaths: [source, nightly],
      staticGroups: [
        "types",
        "source-ownership",
        "startup-bundles",
        "ci-contracts",
        "repository-contracts",
      ],
      testMode: "related",
    });
    expect(classifyChangedPaths([source, nightly], { forceFullTests: true })).toMatchObject({
      appTestSuites: ["core-client", "main", "integration"],
      relatedPaths: [],
      testMode: "full",
    });
  });

  test("adds the runtime owner of a nightly sibling that differs from the default owner", () => {
    const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "nodex-classify-nightly-"));
    const ordinary = "src/renderer/widget.test.tsx";
    const nightly = "src/renderer/widget.nightly.integration.ts";
    try {
      mkdirSync(path.join(repositoryRoot, "src/renderer"), { recursive: true });
      for (const file of [ordinary, nightly]) writeFileSync(path.join(repositoryRoot, file), "");
      expect(classifyChangedPaths([ordinary], { repositoryRoot })).toMatchObject({
        relatedPaths: [ordinary],
        appTestSuites: ["renderer", "integration"],
        testMode: "related",
      });
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("combines Landing gates with a nightly test outside Landing", () => {
    const landing = "packages/landing/src/example.ts";
    const nightly = "src/main/example.nightly.test.ts";
    expect(classifyChangedPaths([landing, nightly])).toMatchObject({
      landingOnly: false,
      appTestSuites: ["unit", "main", "renderer"],
      relatedPaths: [landing, nightly],
      staticGroups: ["types", "source-ownership", "ci-contracts", "landing"],
    });
  });

  test("routes Rust and protocol ownership without UI, stress, or macOS gates", () => {
    expect(
      classifyChangedPaths(["crates/nodex-core/src/database/relation_projection.rs"]),
    ).toMatchObject({
      appTestSuites: ["unit", "core-client", "main", "integration"],
      rustFast: true,
      testMode: "full",
    });
    expect(
      classifyChangedPaths(["crates/nodex-core/src/infrastructure/migration.rs"]),
    ).toMatchObject({ rustFast: true });
    expect(classifyChangedPaths(["src/main/core-client/core-client.ts"])).toMatchObject({
      appTestSuites: ["core-client", "main", "integration"],
      protocolContracts: true,
      rustFast: false,
      testMode: "related",
    });
  });

  test("runs full deterministic suites for dependency changes", () => {
    expect(classifyChangedPaths(["package.json", "pnpm-lock.yaml", "README.md"])).toMatchObject({
      allGates: false,
      appTestSuites: APP_TEST_SUITES,
      dependencyKind: "javascript",
      rustFast: true,
      staticGroups: STATIC_GROUPS,
      testMode: "full",
    });
    expect(classifyChangedPaths(["Cargo.lock", "crates/nodex-core/Cargo.toml"])).toMatchObject({
      appTestSuites: ["unit", "core-client", "main", "integration"],
      dependencyKind: "rust",
      rustFast: true,
      testMode: "full",
    });
  });

  test("routes local actions to their remaining consumers", () => {
    expect(classifyChangedPaths([".github/actions/run-stress-tests/action.yml"])).toMatchObject({
      appTestSuites: [],
      rustFast: false,
      staticGroups: ["ci-contracts", "tooling-contracts"],
    });
    expect(classifyChangedPaths([".github/actions/setup-playwright/action.yml"])).toMatchObject({
      appTestSuites: ["browser"],
      testMode: "full",
    });
    expect(classifyChangedPaths([".github/actions/setup-rust-ci/action.yml"])).toMatchObject({
      appTestSuites: [],
      protocolContracts: true,
      rustFast: true,
    });
  });

  test("audits every dependency entry point even alongside application changes", () => {
    for (const dependencyPath of [
      ".npmrc",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "packages/landing/package.json",
      "packages/nodex-app-tools-mcp/package.json",
      "third_party/blocknote/packages/core/package.json",
    ]) {
      for (const accompanyingPaths of [[], ["src/renderer/app.tsx", "docs/SECURITY.md"]]) {
        const plan = classifyChangedPaths([dependencyPath, ...accompanyingPaths]);
        expect(plan.staticGroups, dependencyPath).toContain("dependency-security");
        expect(plan.landingOnly, dependencyPath).toBe(false);
      }
    }
  });

  test("routes CI orchestration to contracts and only exercises changed reusable owners", () => {
    expect(classifyChangedPaths([".github/workflows/ci.yml", "docs/CI.md"])).toMatchObject({
      appTestSuites: [],
      rustFast: false,
      staticGroups: ["ci-contracts", "tooling-contracts"],
      testMode: "none",
    });
    expect(classifyChangedPaths([".github/workflows/ci-nightly.yml"])).toMatchObject({
      appTestSuites: [],
      rustFast: false,
      staticGroups: ["ci-contracts", "tooling-contracts"],
      testMode: "none",
    });
    expect(classifyChangedPaths([".github/workflows/_app-tests.yml"])).toMatchObject({
      appTestSuites: APP_TEST_SUITES,
      rustFast: false,
      staticGroups: ["ci-contracts", "tooling-contracts"],
      testMode: "full",
    });
    expect(classifyChangedPaths([".github/workflows/_rust-checks.yml"])).toMatchObject({
      appTestSuites: [],
      protocolContracts: true,
      rustFast: true,
      rustFull: true,
    });
    expect(classifyChangedPaths([".github/workflows/_static-checks.yml"])).toMatchObject({
      staticGroups: STATIC_GROUPS,
    });
    expect(classifyChangedPaths(["scripts/ci/classify-change.ts"])).toMatchObject({
      allGates: false,
      appTestSuites: ["unit"],
      rustFast: false,
      staticGroups: ["types", "source-ownership", "ci-contracts", "tooling-contracts"],
      testMode: "full",
    });
  });

  test.each([
    "crates/nodex-core-server/src/lib.rs",
    "crates/nodex-search-kernel/src/lib.rs",
    ".cargo/config.toml",
    "src/main/core-client/core-client.ts",
    "src/main/platform/node/NodexCliShell.ts",
    "src/main/terminal-runtime/TerminalSessions.ts",
    "src/shared/codex-workspace-paths.ts",
    "src/shared/runtime-platform.ts",
    "src/main/browser-use/browser-use-peer-authorizer.ts",
    "scripts/desktop-runtime-payload.mjs",
    "packages/agent-runtime/src/provider/CodexWindowsSandbox.ts",
    "scripts/tooling/process.ts",
    "resources/windows/installer.nsh",
    "config/electron-builder.yml",
    ".github/actions/setup-windows-rust/action.yml",
    ".github/workflows/_windows-distribution.yml",
    ".github/workflows/_windows-checks.yml",
    ".github/workflows/windows.yml",
  ])("selects Windows for native runtime and distribution inputs: %s", (path) => {
    expect(classifyChangedPaths([path, "docs/CI.md"]).windowsChecks).toBe(true);
  });

  test.each([
    "src/renderer/components/app.tsx",
    "src/shared/card-title.ts",
    "src/main/boards/board-queries.ts",
    "packages/landing/package.json",
    ".github/workflows/ci-nightly.yml",
    "novel-build-input.xyz",
    "docs/windows-verification.md",
  ])("keeps Windows out of unrelated plans: %s", (path) => {
    expect(classifyChangedPaths([path]).windowsChecks).toBe(false);
  });

  test("keeps draft plans to cheap static groups even for a full native change", () => {
    const paths = ["src/main/core-client/core-client.ts", "crates/nodex-platform/src/lib.rs"];
    expect(classifyChangedPaths(paths, { draft: true })).toMatchObject({
      draft: true,
      appTestSuites: [],
      protocolContracts: false,
      rustFast: false,
      staticGroups: ["source-ownership"],
      testMode: "none",
      windowsChecks: false,
    });
    expect(classifyChangedPaths(paths)).toMatchObject({
      draft: false,
      rustFast: true,
      protocolContracts: true,
      windowsChecks: true,
    });
    expect(classifyChangedPaths(["packages/landing/src/App.tsx"], { draft: true })).toMatchObject({
      draft: true,
      landingOnly: true,
      staticGroups: ["source-ownership"],
    });
  });

  test("includes Windows in explicit full runs", () => {
    expect(classifyChangedPaths(["docs/CI.md"], { full: true }).windowsChecks).toBe(true);
  });

  test("keeps Electron E2E outside PR and Main test selection", () => {
    for (const path of ["config/playwright.e2e.config.ts", "tests/e2e/electron-smoke.spec.ts"]) {
      expect(classifyChangedPaths([path]), path).toMatchObject({
        allGates: false,
        appTestSuites: [],
        rustFast: false,
        testMode: "none",
      });
    }
  });

  test("selects tooling contracts for build and tooling inputs alongside product edits", () => {
    const source = "src/main/boards/board-queries.ts";
    for (const path of [
      "config/renderer-vite-shared.ts",
      "scripts/ci/classify-change.ts",
      "scripts/tooling/process.ts",
      "scripts/fixtures/tooling/contract.ts",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      ".github/workflows/ci.yml",
      ".oxlintrc.json",
      "packages/agent-runtime/vite.config.ts",
    ]) {
      expect(classifyChangedPaths([source, path]).staticGroups, path).toContain(
        "tooling-contracts",
      );
    }
    for (const path of [
      source,
      "src/host/HostKernel.ts",
      "packages/core-protocol/src/generated.ts",
    ]) {
      expect(classifyChangedPaths([path]).staticGroups, path).not.toContain("tooling-contracts");
    }
  });

  test("selects deterministic source gates for unknown, empty, and explicit full inputs", () => {
    for (const [candidate, groups] of [
      [
        classifyChangedPaths(["novel-build-input.xyz"]),
        STATIC_GROUPS.filter((group) => group !== "tooling-contracts"),
      ],
      [classifyChangedPaths([]), STATIC_GROUPS],
      [classifyChangedPaths(["README.md"], { full: true }), STATIC_GROUPS],
    ] as const) {
      expect(candidate).toMatchObject({
        allGates: true,
        appTestSuites: APP_TEST_SUITES,
        protocolContracts: true,
        rustFast: true,
        staticGroups: groups,
        testMode: "full",
      });
    }
  });

  test("does not publish an affected-path closure for full Rust workspace gates", () => {
    for (const document of [
      buildChangeClassificationDocument(["crates/nodex-core/src/lib.rs", "src/renderer/app.tsx"], {
        full: true,
      }),
      buildChangeClassificationDocument(["package.json", "pnpm-lock.yaml"]),
    ]) {
      expect(document.changedPaths).toEqual([]);
      expect(document.plan).toMatchObject({
        rustFull: true,
        testMode: "full",
      });
    }
  });

  test("rejects paths that escape the repository", () => {
    expect(() => classifyChangedPaths(["../outside"])).toThrow("invalid");
  });
});

test("audits landing test ownership and validates the shared process adapter in real suites", () => {
  expect(classifyChangedPaths(["packages/landing/src/new.jsdom.test.ts"])).toMatchObject({
    landingOnly: true,
    staticGroups: ["source-ownership", "ci-contracts", "landing"],
    appTestSuites: ["unit", "renderer"],
  });
  expect(classifyChangedPaths(["scripts/tooling/process.ts"])).toMatchObject({
    appTestSuites: APP_TEST_SUITES,
    testMode: "full",
  });
});
