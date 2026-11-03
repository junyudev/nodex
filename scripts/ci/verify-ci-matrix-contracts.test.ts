import { describe, expect, test } from "vite-plus/test";

import { APP_TEST_SUITES, STATIC_GROUPS, type CiGatePlan } from "./ci-gate-plan";
import {
  verifyAppTestMatrixContracts,
  verifyDirectNeedsContracts,
  verifyElectronE2eWorkflowContracts,
  verifyFullCiContracts,
} from "./verify-ci-matrix-contracts";

const nightlyWorkflow = ({
  appTestSuites = APP_TEST_SUITES,
  gatePlanOverrides = {},
  rawGatePlan,
  staticGroups = STATIC_GROUPS,
}: {
  readonly appTestSuites?: readonly string[];
  readonly gatePlanOverrides?: Partial<CiGatePlan>;
  readonly rawGatePlan?: unknown;
  readonly staticGroups?: readonly string[];
} = {}): Record<string, unknown> => {
  const gatePlan: CiGatePlan = {
    allGates: true,
    appTestSuites: APP_TEST_SUITES,
    dependencyKind: "source",
    docsOnly: false,
    landingOnly: false,
    protocolContracts: true,
    relatedPaths: [],
    releaseTransition: false,
    rustFast: true,
    rustFull: true,
    rustMigration: true,
    staticGroups: STATIC_GROUPS,
    testMode: "full",
    ...gatePlanOverrides,
  };
  return {
    jobs: {
      "app-tests": {
        with: {
          gate_plan_json: rawGatePlan ?? JSON.stringify(gatePlan),
          suites_json: JSON.stringify(appTestSuites),
        },
      },
      "static-contracts": { with: { groups_json: JSON.stringify(staticGroups) } },
    },
  };
};

describe("CI matrix contracts", () => {
  test("accepts exhaustive canonical nightly matrices", () => {
    expect(() => verifyFullCiContracts(nightlyWorkflow())).not.toThrow();
  });

  test("rejects omitted, additional, and reordered nightly matrix entries", () => {
    expect(() =>
      verifyFullCiContracts(nightlyWorkflow({ staticGroups: STATIC_GROUPS.slice(1) })),
    ).toThrow("Nightly CI static groups");
    expect(() =>
      verifyFullCiContracts(nightlyWorkflow({ appTestSuites: [...APP_TEST_SUITES, "new"] })),
    ).toThrow("Nightly CI app test suites");
    expect(() =>
      verifyFullCiContracts(nightlyWorkflow({ appTestSuites: [...APP_TEST_SUITES].reverse() })),
    ).toThrow("Nightly CI app test suites");
  });

  test("labels malformed full-plan inputs and rejects incomplete coverage", () => {
    expect(() => verifyFullCiContracts(nightlyWorkflow({ rawGatePlan: 7 }))).toThrow(
      "app-tests.gate_plan_json must be a JSON string",
    );
    expect(() => verifyFullCiContracts(nightlyWorkflow({ rawGatePlan: "{" }))).toThrow(
      "app-tests.gate_plan_json must contain valid JSON",
    );
    expect(() => verifyFullCiContracts(nightlyWorkflow({ rawGatePlan: "{}" }))).toThrow(
      "CI gate plan is missing fields",
    );
    expect(() =>
      verifyFullCiContracts(
        nightlyWorkflow({
          gatePlanOverrides: {
            relatedPaths: ["src/shared/core-types.ts"],
            testMode: "related",
          },
        }),
      ),
    ).toThrow("full deterministic gate plan");
    expect(() =>
      verifyFullCiContracts(
        nightlyWorkflow({
          gatePlanOverrides: { rustFull: false },
        }),
      ),
    ).toThrow("full deterministic gate plan");
  });

  test("rejects Rust cache variables inherited by non-Rust matrix cells", () => {
    expect(() =>
      verifyAppTestMatrixContracts({ jobs: { test: { env: { CI_TIMING_JOB: "test" } } } }),
    ).not.toThrow();
    expect(() =>
      verifyAppTestMatrixContracts({
        jobs: { test: { env: { RUSTC_WRAPPER: "sccache" } } },
      }),
    ).toThrow("scope Rust cache variables to Rust-bearing steps");
  });

  test("rejects generated build resources duplicated across application cells", () => {
    expect(() =>
      verifyAppTestMatrixContracts({
        jobs: { test: { steps: [{ run: "pnpm run build-resources:prepare" }] } },
      }),
    ).toThrow("generated static contract");
  });

  test("requires every needs context reference to name a direct dependency", () => {
    expect(() =>
      verifyDirectNeedsContracts(
        {
          jobs: {
            certify: { steps: [] },
            distribute: {
              needs: ["certify"],
              with: { source_tree: "${{ needs.certify.outputs.source_tree }}" },
            },
          },
        },
        "Release",
      ),
    ).not.toThrow();
    expect(() =>
      verifyDirectNeedsContracts(
        {
          jobs: {
            certify: { steps: [] },
            distribute: {
              with: { source_tree: "${{ needs.certify.outputs.source_tree }}" },
            },
          },
        },
        "Release",
      ),
    ).toThrow("undeclared direct needs: certify");
  });

  test("rejects malformed needs declarations", () => {
    expect(() =>
      verifyDirectNeedsContracts(
        {
          jobs: { distribute: { needs: 7 } },
        },
        "Release",
      ),
    ).toThrow("needs must be a job id or array of job ids");
  });
});

describe("Electron E2E workflow ownership", () => {
  const workflow = ({
    command = "vp exec tsx scripts/ci/run-timed.ts --name electron-e2e -- vp run test:e2e:nightly",
    needs = ["electron-e2e"],
    runner = "macos-26",
  } = {}): Record<string, unknown> => ({
    jobs: {
      "electron-e2e": { "runs-on": runner, steps: [{ run: command }] },
      complete: { if: "always()", needs },
    },
  });
  const nightly = ".github/workflows/ci-nightly.yml";

  test("requires the shared curated command on a standard macOS runner", () => {
    expect(() => verifyElectronE2eWorkflowContracts(workflow(), nightly)).not.toThrow();
    expect(() =>
      verifyElectronE2eWorkflowContracts(workflow({ command: "vp run test:e2e" }), nightly),
    ).toThrow("shared test:e2e:nightly selection");
    expect(() =>
      verifyElectronE2eWorkflowContracts(workflow({ runner: "macos-26-xlarge" }), nightly),
    ).toThrow("standard macos-26 runner");
  });

  test("rejects a removed Electron job or an aggregate that omits it", () => {
    expect(() => verifyElectronE2eWorkflowContracts({ jobs: {} }, nightly)).toThrow(
      "Nightly CI Electron E2E jobs",
    );
    expect(() =>
      verifyElectronE2eWorkflowContracts(workflow({ needs: ["app-tests"] }), nightly),
    ).toThrow("complete must always require Electron E2E");
  });

  test.each(["ci.yml", "ci-main.yml", "performance.yml", "_certify-release-source.yml"])(
    "keeps Electron UI automation out of %s",
    (filename) => {
      expect(() =>
        verifyElectronE2eWorkflowContracts(workflow(), `.github/workflows/${filename}`),
      ).toThrow("leave Electron E2E to Nightly CI");
      expect(() =>
        verifyElectronE2eWorkflowContracts(
          { jobs: { test: { steps: [{ run: "vp run test:integration" }] } } },
          `.github/workflows/${filename}`,
        ),
      ).not.toThrow();
    },
  );
});
