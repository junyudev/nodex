import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { APP_TEST_SUITES, STATIC_GROUPS, type CiGatePlan } from "./ci-gate-plan";
import {
  verifyAppTestMatrixContracts,
  verifyDirectNeedsContracts,
  verifyElectronE2eWorkflowContracts,
  verifyFullCiContracts,
  verifyMainCiBaseContract,
  verifyNightlyMacApplicationContracts,
  verifyNightlyTierContract,
  verifyPreMergeCiContract,
  verifyRustCacheOwnership,
  verifyWindowsCiContracts,
} from "./verify-ci-matrix-contracts";
import { readWorkflow, repositoryRoot, requireRecord } from "./github-workflow-files";
import { MAIN_CI_BASE_COMMAND } from "./main-ci-base";

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
    draft: false,
    landingOnly: false,
    protocolContracts: true,
    relatedPaths: [],
    rustFast: true,
    rustFull: true,
    staticGroups: STATIC_GROUPS,
    testMode: "full",
    windowsChecks: false,
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
  test("rejects Main CI when its base resolver can be skipped", () => {
    const workflow = readWorkflow(path.join(repositoryRoot, ".github/workflows/ci-main.yml"));
    expect(() => verifyMainCiBaseContract(workflow)).not.toThrow();

    const jobs = requireRecord(workflow.jobs, "jobs");
    const classify = requireRecord(jobs.classify, "classify");
    const base = { id: "base", run: MAIN_CI_BASE_COMMAND, if: "${{ inputs.full }}" };
    expect(() =>
      verifyMainCiBaseContract({
        ...workflow,
        jobs: { ...jobs, classify: { ...classify, steps: [base] } },
      }),
    ).toThrow("must always run the last-green comparison base resolver");

    const concurrency = requireRecord(workflow.concurrency, "concurrency");
    expect(() =>
      verifyMainCiBaseContract({
        ...workflow,
        concurrency: { ...concurrency, "cancel-in-progress": true },
      }),
    ).toThrow("must let the active push finish");
  });

  test("requires Main CI to enforce Windows and publish failed verdicts", () => {
    const workflow = readWorkflow(path.join(repositoryRoot, ".github/workflows/ci-main.yml"));
    const jobs = requireRecord(workflow.jobs, "jobs");
    const complete = requireRecord(jobs.complete, "complete");
    expect(() =>
      verifyMainCiBaseContract({
        ...workflow,
        jobs: {
          ...jobs,
          complete: {
            ...complete,
            needs: ["classify", "static-contracts", "rust-checks", "app-tests"],
          },
        },
      }),
    ).toThrow("Main CI complete dependencies");

    const steps = complete.steps as Record<string, unknown>[];
    expect(() =>
      verifyMainCiBaseContract({
        ...workflow,
        jobs: {
          ...jobs,
          complete: {
            ...complete,
            steps: steps.map((step) =>
              step.name === "Upload Main CI verdict" ? { ...step, if: "success()" } : step,
            ),
          },
        },
      }),
    ).toThrow("must publish the verdict even when verification fails");
  });

  test("accepts exhaustive canonical nightly matrices", () => {
    expect(() => verifyFullCiContracts(nightlyWorkflow())).not.toThrow();
  });

  test("rejects omitted, additional, and reordered nightly matrix entries", () => {
    expect(() =>
      verifyFullCiContracts(nightlyWorkflow({ staticGroups: STATIC_GROUPS.slice(1) })),
    ).toThrow("Nightly CI static groups");
    expect(() =>
      verifyFullCiContracts(nightlyWorkflow({ appTestSuites: [...APP_TEST_SUITES, "new"] })),
    ).toThrow("Nightly CI app-tests suites");
    expect(() =>
      verifyFullCiContracts(nightlyWorkflow({ appTestSuites: [...APP_TEST_SUITES].reverse() })),
    ).toThrow("Nightly CI app-tests suites");
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

  test("leaves enabling the Rust compiler cache to the action that installs it", () => {
    expect(() =>
      verifyRustCacheOwnership(
        {
          jobs: {
            rust: {
              env: { CI_TIMING_JOB: "rust" },
              steps: [{ uses: "./.github/actions/setup-rust-ci" }, { run: "cargo test" }],
            },
          },
        },
        "rust.yml",
      ),
    ).not.toThrow();
    for (const workflow of [
      { env: { RUSTC_WRAPPER: "sccache" }, jobs: {} },
      { jobs: { rust: { env: { SCCACHE_GHA_ENABLED: "true" } } } },
      { jobs: { rust: { steps: [{ env: { RUSTC_WRAPPER: "sccache" }, run: "cargo test" }] } } },
      { jobs: { rust: { steps: [{ run: "export RUSTC_WRAPPER=sccache\ncargo test" }] } } },
    ]) {
      expect(() => verifyRustCacheOwnership(workflow, "rust.yml")).toThrow(
        "Only .github/actions/setup-rust-ci enables the Rust compiler cache",
      );
    }
  });

  test("rejects generated build resources duplicated across application cells", () => {
    expect(() =>
      verifyAppTestMatrixContracts({
        jobs: { test: { steps: [{ run: "pnpm run build-resources:prepare" }] } },
      }),
    ).toThrow("generated static contract");
  });

  test("rejects a bypassed lane or companion shard", () => {
    const workflow = readWorkflow(path.join(repositoryRoot, ".github/workflows/_app-tests.yml"));
    expect(() => verifyAppTestMatrixContracts(workflow)).not.toThrow();
    const jobs = requireRecord(workflow.jobs, "jobs");
    const job = requireRecord(jobs.test, "test");
    expect(() => verifyAppTestMatrixContracts({ jobs: { test: { ...job, if: "false" } } })).toThrow(
      "propagate any lane failure",
    );
    const steps = (job.steps as readonly Record<string, unknown>[]).filter(
      ({ id }) => id !== "companion",
    );
    expect(() => verifyAppTestMatrixContracts({ jobs: { test: { ...job, steps } } })).toThrow(
      "must run every selected shard",
    );
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

describe("pre-merge CI workflow", () => {
  const readPreMergeWorkflow = () =>
    readWorkflow(path.join(repositoryRoot, ".github/workflows/ci.yml"));

  test("requires both trigger events and isolated merge-group runs", () => {
    const workflow = readPreMergeWorkflow();
    expect(() => verifyPreMergeCiContract(workflow)).not.toThrow();

    const concurrency = requireRecord(workflow.concurrency, "concurrency");
    expect(() =>
      verifyPreMergeCiContract({
        ...workflow,
        concurrency: { ...concurrency, group: "ci-all-merge-groups" },
      }),
    ).toThrow("must isolate merge-group runs");

    const triggers = requireRecord(workflow.on, "triggers");
    expect(() =>
      verifyPreMergeCiContract({ ...workflow, on: { ...triggers, merge_group: null } }),
    ).toThrow("merge_group trigger");
  });

  test("rejects an aggregate that can skip checking selected jobs", () => {
    const workflow = readPreMergeWorkflow();
    const jobs = requireRecord(workflow.jobs, "jobs");
    const required = requireRecord(jobs.required, "required");
    expect(() =>
      verifyPreMergeCiContract({
        ...workflow,
        jobs: { ...jobs, required: { ...required, if: "success()" } },
      }),
    ).toThrow("required must always enforce");

    expect(() =>
      verifyPreMergeCiContract({
        ...workflow,
        jobs: {
          ...jobs,
          required: {
            ...required,
            needs: ["classify", "static-contracts", "rust-checks", "app-tests"],
          },
        },
      }),
    ).toThrow("required dependencies");
  });
});

test("keeps the full Windows matrix off pull requests and main pushes", () => {
  const full = readWorkflow(path.join(repositoryRoot, ".github/workflows/windows.yml"));
  const slim = readWorkflow(path.join(repositoryRoot, ".github/workflows/_windows-checks.yml"));
  expect(() => verifyWindowsCiContracts(full, slim)).not.toThrow();

  const triggers = requireRecord(full.on, "Windows triggers");
  expect(() =>
    verifyWindowsCiContracts({ ...full, on: { ...triggers, pull_request: null } }, slim),
  ).toThrow("Full Windows triggers");
  expect(() =>
    verifyWindowsCiContracts({ ...full, on: { ...triggers, push: { branches: ["main"] } } }, slim),
  ).toThrow("Full Windows push branches");
});

test.each([
  ["ci-nightly.yml", "complete"],
  ["_certify-release-source.yml", "certify"],
])("%s gates its aggregate on Linux nightly tests", (filename, aggregateId) => {
  const workflow = readWorkflow(path.join(repositoryRoot, ".github/workflows", filename));
  expect(() => verifyNightlyTierContract(workflow, aggregateId)).not.toThrow();

  const jobs = requireRecord(workflow.jobs, "jobs");
  const aggregate = requireRecord(jobs[aggregateId], "aggregate");
  expect(() =>
    verifyNightlyTierContract(
      { ...workflow, jobs: { ...jobs, [aggregateId]: { ...aggregate, needs: ["app-tests"] } } },
      aggregateId,
    ),
  ).toThrow("must require the nightly application tier");
});

describe("Nightly macOS application coverage", () => {
  const readNightlyWorkflow = () =>
    readWorkflow(path.join(repositoryRoot, ".github/workflows/ci-nightly.yml"));

  test("requires every suite within the shared macOS runner budget", () => {
    const workflow = readNightlyWorkflow();
    expect(() => verifyNightlyMacApplicationContracts(workflow)).not.toThrow();

    const jobs = requireRecord(workflow.jobs, "jobs");
    const macJob = requireRecord(jobs["app-tests-macos"], "mac application job");
    const inputs = requireRecord(macJob.with, "mac application inputs");
    for (const [overrides, error] of [
      [{ max_parallel: 3 }, "in five slots"],
      [{ suites_json: '["unit"]' }, "app-tests-macos suites"],
    ] as const) {
      expect(() =>
        verifyNightlyMacApplicationContracts({
          ...workflow,
          jobs: {
            ...jobs,
            "app-tests-macos": { ...macJob, with: { ...inputs, ...overrides } },
          },
        }),
      ).toThrow(error);
    }
  });

  test("requires the aggregate to wait for the macOS application matrix", () => {
    const workflow = readNightlyWorkflow();
    const jobs = requireRecord(workflow.jobs, "jobs");
    const complete = requireRecord(jobs.complete, "complete");
    expect(() =>
      verifyNightlyMacApplicationContracts({
        ...workflow,
        jobs: { ...jobs, complete: { ...complete, needs: ["app-tests"] } },
      }),
    ).toThrow("complete must always require the macOS application matrix");
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
