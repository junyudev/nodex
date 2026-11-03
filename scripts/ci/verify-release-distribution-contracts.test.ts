import path from "node:path";
import { expect, test } from "vite-plus/test";
import { readWorkflow, requireRecord, workflowsDirectory } from "./github-workflow-files";
import { verifyReleaseDistributionWorkflows } from "./verify-release-distribution-contracts";

const workflows = () =>
  new Map(
    [
      "_windows-distribution.yml",
      "windows.yml",
      "release.yml",
      "nightly-release.yml",
      "release-rehearsal.yml",
      "release-recovery.yml",
    ].map((file) => [file, structuredClone(readWorkflow(path.join(workflowsDirectory, file)))]),
  );

test("repository distributions require all native architectures before protected finalization and assembly", () => {
  expect(() => verifyReleaseDistributionWorkflows(workflows())).not.toThrow();
});

test("rejects cross-CPU packaging and missing native architecture cells", () => {
  for (const cells of [
    [{ arch: "x64", runner: "windows-latest" }],
    [
      { arch: "x64", runner: "windows-latest" },
      { arch: "arm64", runner: "windows-latest" },
    ],
  ]) {
    const files = workflows();
    const windows = requireRecord(files.get("_windows-distribution.yml"), "Windows");
    const installer = requireRecord(requireRecord(windows.jobs, "Jobs").installer, "Installer");
    files.set("_windows-distribution.yml", {
      ...windows,
      jobs: { installer: { ...installer, strategy: { matrix: { include: cells } } } },
    });
    expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("native runners");
  }
});

test.each(["release.yml", "nightly-release.yml", "release-rehearsal.yml", "release-recovery.yml"])(
  "rejects incomplete release admission in %s",
  (file) => {
    const files = workflows();
    const workflow = requireRecord(files.get(file), file);
    const jobs = requireRecord(workflow.jobs, "Jobs");
    files.set(file, {
      ...workflow,
      jobs: {
        ...jobs,
        assemble: {
          ...requireRecord(jobs.assemble, "Assembly"),
          needs: ["distribution", "finalize-sparkle"],
        },
      },
    });
    expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("windows-distribution");
  },
);

test("rejects a reusable finalizer or a validation-only release build", () => {
  const files = workflows();
  const workflow = requireRecord(files.get("release.yml"), "Release");
  const jobs = requireRecord(workflow.jobs, "Jobs");
  files.set("release.yml", {
    ...workflow,
    jobs: {
      ...jobs,
      "finalize-sparkle": {
        ...requireRecord(jobs["finalize-sparkle"], "Finalizer"),
        uses: "./.github/workflows/finalizer.yml",
      },
    },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("direct protected");
  files.set("release.yml", {
    ...workflow,
    jobs: {
      ...jobs,
      "windows-distribution": {
        ...requireRecord(jobs["windows-distribution"], "Windows"),
        with: { release: false },
      },
    },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("official Windows distribution");
});

test("rejects runner context before job-level Windows environment evaluation", () => {
  const files = workflows();
  const windows = requireRecord(files.get("_windows-distribution.yml"), "Windows");
  const jobs = requireRecord(windows.jobs, "Jobs");
  const installer = requireRecord(jobs.installer, "Installer");
  files.set("_windows-distribution.yml", {
    ...windows,
    jobs: {
      ...jobs,
      installer: {
        ...installer,
        env: { RELEASE_IDENTITY_PATH: "${{ runner.temp }}/identity.json" },
      },
    },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow(
    "job-level env cannot use runner context",
  );
});
