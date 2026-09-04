import { describe, expect, test } from "vite-plus/test";

import { APP_TEST_SUITES, STATIC_GROUPS } from "./ci-gate-plan";
import { buildChangeClassificationDocument, classifyChangedPaths } from "./classify-change";

describe("CI change classification", () => {
  test("keeps documentation out of executable gates", () => {
    expect(classifyChangedPaths(["docs/release-macos.md", "docs/ARCHITECTURE.md"])).toEqual({
      allGates: false,
      appTestSuites: [],
      dependencyKind: "none",
      docsOnly: true,
      landingOnly: false,
      protocolContracts: false,
      relatedPaths: [],
      releaseTransition: false,
      rustFast: false,
      rustFull: false,
      rustMigration: false,
      staticGroups: [],
      testMode: "none",
    });
  });

  test("selects only the landing owner for landing plus documentation", () => {
    expect(classifyChangedPaths(["packages/landing/src/App.tsx", "README.md"])).toMatchObject({
      appTestSuites: ["unit", "renderer"],
      landingOnly: true,
      staticGroups: ["landing"],
      testMode: "related",
    });
  });

  test("routes the exact release metadata set to the narrow transition guard", () => {
    expect(
      classifyChangedPaths(["Cargo.lock", "Cargo.toml", "CHANGELOG.md", "package.json"]),
    ).toMatchObject({
      releaseTransition: true,
      rustFast: false,
      staticGroups: [],
      testMode: "none",
    });
  });

  test("uses Vitest related selection for ordinary application source", () => {
    const paths = ["src/renderer/components/app.tsx", "docs/CI.md"];
    expect(classifyChangedPaths(paths)).toMatchObject({
      appTestSuites: ["unit", "renderer", "browser"],
      relatedPaths: ["src/renderer/components/app.tsx"],
      rustFast: false,
      staticGroups: ["types", "ui-contracts"],
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
      ["src/main/example.integration.ts", "integration"],
    ] as const) {
      expect(classifyChangedPaths([path]), path).toMatchObject({
        appTestSuites: [suite],
        relatedPaths: [path],
        testMode: "related",
      });
    }
  });

  test("promotes config and deleted-path changes to deterministic full suites", () => {
    for (const [paths, options] of [
      [["vitest.renderer.config.ts"], {}],
      [["src/renderer/lib/removed.ts"], { forceFullTests: true }],
    ] as const) {
      expect(classifyChangedPaths(paths, options)).toMatchObject({
        appTestSuites: paths[0]?.startsWith("vitest.renderer")
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
      staticGroups: ["types", "repository-contracts", "ci-contracts"],
      testMode: "none",
    });
  });

  test("routes Rust and protocol ownership without UI, stress, or macOS gates", () => {
    expect(
      classifyChangedPaths(["crates/nodex-core/src/database/relation_projection.rs"]),
    ).toMatchObject({
      appTestSuites: ["core-client", "main", "integration"],
      rustFast: true,
      rustMigration: false,
      testMode: "full",
    });
    expect(
      classifyChangedPaths(["crates/nodex-core/src/infrastructure/migration.rs"]),
    ).toMatchObject({ rustFast: true, rustMigration: true });
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
      rustMigration: true,
      staticGroups: STATIC_GROUPS,
      testMode: "full",
    });
    expect(classifyChangedPaths(["Cargo.lock", "crates/nodex-core/Cargo.toml"])).toMatchObject({
      appTestSuites: ["core-client", "main", "integration"],
      dependencyKind: "rust",
      rustFast: true,
      rustMigration: true,
      testMode: "full",
    });
  });

  test("routes local actions to their remaining consumers", () => {
    expect(classifyChangedPaths([".github/actions/run-stress-tests/action.yml"])).toMatchObject({
      appTestSuites: [],
      rustFast: false,
      staticGroups: ["ci-contracts"],
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

  test("routes CI orchestration to contracts and only exercises changed reusable owners", () => {
    expect(classifyChangedPaths([".github/workflows/ci.yml", "docs/CI.md"])).toMatchObject({
      appTestSuites: [],
      rustFast: false,
      staticGroups: ["ci-contracts"],
      testMode: "none",
    });
    expect(classifyChangedPaths([".github/workflows/_app-tests.yml"])).toMatchObject({
      appTestSuites: APP_TEST_SUITES,
      rustFast: false,
      staticGroups: ["ci-contracts"],
      testMode: "full",
    });
    expect(classifyChangedPaths([".github/workflows/_rust-checks.yml"])).toMatchObject({
      appTestSuites: [],
      protocolContracts: true,
      rustFast: true,
      rustFull: true,
      rustMigration: true,
    });
    expect(classifyChangedPaths([".github/workflows/_static-checks.yml"])).toMatchObject({
      staticGroups: STATIC_GROUPS,
    });
    expect(classifyChangedPaths(["scripts/ci/classify-change.ts"])).toMatchObject({
      allGates: false,
      appTestSuites: ["unit"],
      rustFast: false,
      staticGroups: ["types", "ci-contracts"],
      testMode: "full",
    });
  });

  test("keeps opt-in Electron E2E tooling outside automated test gates", () => {
    for (const path of ["playwright.e2e.config.ts", "tests/e2e/electron-smoke.spec.ts"]) {
      expect(classifyChangedPaths([path]), path).toMatchObject({
        allGates: false,
        appTestSuites: [],
        rustFast: false,
        testMode: "none",
      });
    }
  });

  test("selects every deterministic source gate for unknown, empty, and explicit full inputs", () => {
    for (const candidate of [
      classifyChangedPaths(["novel-build-input.xyz"]),
      classifyChangedPaths([]),
      classifyChangedPaths(["README.md"], { full: true }),
    ]) {
      expect(candidate).toMatchObject({
        allGates: true,
        appTestSuites: APP_TEST_SUITES,
        protocolContracts: true,
        rustFast: true,
        rustMigration: true,
        staticGroups: STATIC_GROUPS,
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
    staticGroups: ["ci-contracts", "landing"],
    appTestSuites: ["unit", "renderer"],
  });
  expect(classifyChangedPaths(["scripts/tooling/process.ts"])).toMatchObject({
    appTestSuites: APP_TEST_SUITES,
    testMode: "full",
  });
});
