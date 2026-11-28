import path from "node:path";
import { expect, test } from "vite-plus/test";
import { readWorkflow, requireRecord, workflowsDirectory } from "./github-workflow-files";
import { verifyReleaseDistributionWorkflows } from "./verify-release-distribution-contracts";

const workflows = () =>
  new Map(
    [
      "_windows-distribution.yml",
      "_mobile-distribution.yml",
      "windows.yml",
      "release.yml",
      "nightly-release.yml",
      "release-rehearsal.yml",
      "_promote-release.yml",
      "_promote-nightly.yml",
      "nightly-retention.yml",
    ].map((file) => [file, structuredClone(readWorkflow(path.join(workflowsDirectory, file)))]),
  );

test("repository distributions require all native architectures before protected finalization and assembly", () => {
  expect(() => verifyReleaseDistributionWorkflows(workflows())).not.toThrow();
});

test.each([
  "certification",
  "distribution",
  "windows-distribution",
  "mobile-distribution",
  "assemble",
  "promote",
])("rejects the dispatch SHA as the Nightly %s source", (name) => {
  const files = workflows();
  const nightly = requireRecord(files.get("nightly-release.yml"), "Nightly");
  const jobs = requireRecord(nightly.jobs, "Nightly jobs");
  const job = requireRecord(jobs[name], "Nightly job");
  files.set("nightly-release.yml", {
    ...nightly,
    jobs: {
      ...jobs,
      [name]: {
        ...job,
        with: { ...requireRecord(job.with, "Nightly inputs"), source_sha: "${{ github.sha }}" },
      },
    },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow(
    `Nightly ${name} must use the verified candidate source SHA`,
  );
});

test("rejects finalizing Nightly from the dispatch checkout", () => {
  const files = workflows();
  const nightly = requireRecord(files.get("nightly-release.yml"), "Nightly");
  const jobs = requireRecord(nightly.jobs, "Nightly jobs");
  const finalizer = requireRecord(jobs["finalize-sparkle"], "Nightly finalizer");
  const [checkout, ...steps] = Array.isArray(finalizer.steps) ? finalizer.steps : [];
  files.set("nightly-release.yml", {
    ...nightly,
    jobs: {
      ...jobs,
      "finalize-sparkle": {
        ...finalizer,
        steps: [
          {
            ...requireRecord(checkout, "Nightly finalizer checkout"),
            with: { ref: "${{ github.sha }}" },
          },
          ...steps,
        ],
      },
    },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow(
    "Nightly finalization must check out and use the verified candidate source SHA",
  );
});

test("requires a native x64 Windows distribution job", () => {
  const files = workflows();
  const windows = requireRecord(files.get("_windows-distribution.yml"), "Windows");
  const installer = requireRecord(requireRecord(windows.jobs, "Jobs").installer, "Installer");
  files.set("_windows-distribution.yml", {
    ...windows,
    jobs: { installer: { ...installer, "runs-on": "ubuntu-latest" } },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("native runner");
});

test.each(["nightly-release.yml", "release-rehearsal.yml"])(
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
        uses: "./.github/workflows/_windows-distribution.yml",
        with: { release: false },
      },
    },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("reuse a verified Nightly");
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

test.each(["nightly-release.yml", "release-rehearsal.yml"])(
  "rejects a %s release assembled without Nodex Mobile",
  (file) => {
    const files = workflows();
    const workflow = requireRecord(files.get(file), file);
    const jobs = requireRecord(workflow.jobs, "Jobs");
    const assemble = requireRecord(jobs.assemble, "Assembly");
    files.set(file, {
      ...workflow,
      jobs: {
        ...jobs,
        assemble: {
          ...assemble,
          needs: ["distribution", "windows-distribution", "finalize-sparkle"],
        },
      },
    });
    expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("mobile-distribution");
  },
);

test("only stable releases publish to TestFlight, from a direct protected job", () => {
  const files = workflows();
  const release = requireRecord(files.get("release.yml"), "Release");
  const releaseJobs = requireRecord(release.jobs, "Jobs");
  const testflight = requireRecord(releaseJobs.testflight, "TestFlight");
  files.set("release.yml", {
    ...release,
    jobs: { ...releaseJobs, testflight: { ...testflight, environment: "release" } },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("direct protected");

  const nightlyFiles = workflows();
  const nightly = requireRecord(nightlyFiles.get("nightly-release.yml"), "Nightly");
  nightlyFiles.set("nightly-release.yml", {
    ...nightly,
    jobs: { ...requireRecord(nightly.jobs, "Jobs"), testflight },
  });
  expect(() => verifyReleaseDistributionWorkflows(nightlyFiles)).toThrow("only stable releases");
});

test("rejects mobile builds outside their protected environment", () => {
  const files = workflows();
  const mobile = requireRecord(files.get("_mobile-distribution.yml"), "Mobile");
  const jobs = requireRecord(mobile.jobs, "Jobs");
  files.set("_mobile-distribution.yml", {
    ...mobile,
    jobs: { ...jobs, ios: { ...requireRecord(jobs.ios, "iOS"), environment: undefined } },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow("mobile-distribution");
});

test("keeps public downloads ahead of Homebrew and serializes Nightly pruning with publication", () => {
  const files = workflows();
  const stable = requireRecord(files.get("_promote-release.yml"), "Stable promotion");
  const jobs = requireRecord(stable.jobs, "Stable promotion jobs");
  const homebrew = requireRecord(jobs.homebrew, "Homebrew");
  files.set("_promote-release.yml", {
    ...stable,
    jobs: { ...jobs, homebrew: { ...homebrew, needs: "publish" } },
  });
  expect(() => verifyReleaseDistributionWorkflows(files)).toThrow(
    "Homebrew publication must require publish, r2",
  );

  const retentionFiles = workflows();
  const retention = requireRecord(retentionFiles.get("nightly-retention.yml"), "Nightly Retention");
  const retentionJobs = requireRecord(retention.jobs, "Nightly Retention jobs");
  const apply = requireRecord(retentionJobs.apply, "Nightly Retention apply");
  retentionFiles.set("nightly-retention.yml", {
    ...retention,
    jobs: { ...retentionJobs, apply: { ...apply, concurrency: { group: "independent" } } },
  });
  expect(() => verifyReleaseDistributionWorkflows(retentionFiles)).toThrow(
    "must serialize R2 changes within the nightly channel",
  );
});
