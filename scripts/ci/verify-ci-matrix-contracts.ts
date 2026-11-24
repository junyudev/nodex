import path from "node:path";

import { APP_TEST_SUITES, parseCiGatePlan, STATIC_GROUPS } from "./ci-gate-plan";
import {
  isRecord,
  readWorkflow,
  relativeRepositoryPath,
  repositoryRoot,
  requireRecord,
  workflowFiles,
  type UnknownRecord,
} from "./github-workflow-files";
import { MAIN_CI_BASE_COMMAND, MAIN_CI_WORKFLOW_PATH } from "./main-ci-base";

const parseStringArray = (value: unknown, label: string): readonly string[] => {
  if (typeof value !== "string") throw new Error(`${label} must be a JSON string.`);
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`${label} must contain a JSON string array.`);
  }
  return parsed;
};

const reusableInputs = (
  workflow: UnknownRecord,
  jobName: string,
  workflowName: string,
): UnknownRecord => {
  const jobs = requireRecord(workflow.jobs, `${workflowName} jobs`);
  const job = requireRecord(jobs[jobName], `${workflowName} ${jobName} job`);
  return requireRecord(job.with, `${workflowName} ${jobName} inputs`);
};

const requireExactEntries = (
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void => {
  if (
    actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index])
  ) {
    return;
  }
  throw new Error(
    `${label} must exactly match its canonical entries: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
  );
};

const requireFullAppTestMatrix = (
  workflow: UnknownRecord,
  jobName: string,
  workflowName: string,
): void => {
  const inputs = reusableInputs(workflow, jobName, workflowName);
  const label = `${workflowName} ${jobName}`;
  requireExactEntries(
    parseStringArray(inputs.suites_json, `${label}.suites_json`),
    APP_TEST_SUITES,
    `${label} suites`,
  );
  if (typeof inputs.gate_plan_json !== "string") {
    throw new Error(`${label}.gate_plan_json must be a JSON string.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputs.gate_plan_json) as unknown;
  } catch (cause) {
    throw new Error(`${label}.gate_plan_json must contain valid JSON.`, { cause });
  }
  const plan = parseCiGatePlan(parsed);
  if (plan.testMode !== "full" || !plan.rustFull) {
    throw new Error(`${workflowName} must use a full deterministic gate plan.`);
  }
  requireExactEntries(plan.appTestSuites, APP_TEST_SUITES, `${label} gate plan suites`);
};

export const verifyFullCiContracts = (
  workflow: UnknownRecord,
  workflowName = "Nightly CI",
): void => {
  const inputs = reusableInputs(workflow, "static-contracts", workflowName);
  requireExactEntries(
    parseStringArray(inputs.groups_json, `${workflowName} static-contracts.groups_json`),
    STATIC_GROUPS,
    `${workflowName} static groups`,
  );
  requireFullAppTestMatrix(workflow, "app-tests", workflowName);
};

export const verifyAppTestMatrixContracts = (workflow: UnknownRecord): void => {
  const jobs = requireRecord(workflow.jobs, "Application test workflow jobs");
  const testJob = requireRecord(jobs.test, "Application test matrix job");
  const steps = Array.isArray(testJob.steps) ? testJob.steps.filter(isRecord) : [];
  const duplicatedBuildResources = steps.some(
    ({ run }) => typeof run === "string" && /\bbuild-resources:prepare\b/u.test(run),
  );
  if (duplicatedBuildResources) {
    throw new Error(
      "Application test cells must not regenerate build resources owned by the generated static contract.",
    );
  }
  const strategy = requireRecord(testJob.strategy, "Application test matrix strategy");
  if (
    testJob["runs-on"] !== "${{ inputs.runner }}" ||
    strategy["max-parallel"] !== "${{ inputs.max_parallel }}"
  ) {
    throw new Error(
      "Application test jobs must respect the caller's runner and parallel job limit.",
    );
  }
};

const SELECTED_GATE_DEPENDENCIES = [
  "app-tests",
  "classify",
  "rust-checks",
  "static-contracts",
  "windows-checks",
] as const;

const verifySelectedWindowsGate = (jobs: UnknownRecord, workflowName: string): void => {
  const windows = requireRecord(jobs["windows-checks"], `${workflowName} Windows job`);
  if (
    windows.needs !== "classify" ||
    windows.if !== "${{ fromJSON(needs.classify.outputs.plan).windowsChecks }}" ||
    windows.uses !== "./.github/workflows/_windows-checks.yml"
  ) {
    throw new Error(`${workflowName} must run Windows checks exactly when the plan selects them.`);
  }
};

export const verifyMainCiBaseContract = (workflow: UnknownRecord): void => {
  const concurrency = requireRecord(workflow.concurrency, "Main CI concurrency");
  if (
    concurrency.group !==
      "${{ github.event_name == 'push' && format('main-ci-{0}', github.ref) || format('main-ci-run-{0}', github.run_id) }}" ||
    concurrency["cancel-in-progress"] !== false
  ) {
    throw new Error("Main CI must let the active push finish and isolate manual runs.");
  }
  const jobs = requireRecord(workflow.jobs, "Main CI jobs");
  verifySelectedWindowsGate(jobs, "Main CI");
  const classify = requireRecord(jobs.classify, "Main CI classify job");
  const base = Array.isArray(classify.steps)
    ? classify.steps.filter(isRecord).find((step) => step.id === "base")
    : undefined;
  // The command also identifies successful runs eligible to certify a comparison base.
  if (base?.run !== MAIN_CI_BASE_COMMAND || base.if !== undefined) {
    throw new Error("Main CI classify must always run the last-green comparison base resolver.");
  }

  const complete = requireRecord(jobs.complete, "Main CI complete job");
  requireExactEntries(
    [...declaredNeeds(complete.needs, "Main CI complete")].sort(),
    SELECTED_GATE_DEPENDENCIES,
    "Main CI complete dependencies",
  );
  const env = requireRecord(complete.env, "Main CI complete environment");
  const steps = Array.isArray(complete.steps) ? complete.steps.filter(isRecord) : [];
  const verify = steps.find((step) => step.id === "verify");
  if (
    complete.if !== "always()" ||
    complete["continue-on-error"] !== undefined ||
    env.CI_GATE_PLAN_JSON !== "${{ needs.classify.outputs.plan }}" ||
    env.CI_NEEDS_JSON !== "${{ toJSON(needs) }}" ||
    verify?.run !== "node --no-warnings scripts/ci/verify-required-gates.ts" ||
    verify.if !== undefined ||
    verify["continue-on-error"] !== undefined
  ) {
    throw new Error("Main CI complete must always enforce the selected gate results.");
  }

  const report = steps.find(
    (step) => step.run === "node --no-warnings scripts/ci/write-main-ci-verdict.ts",
  );
  const reportEnv = requireRecord(report?.env, "Main CI verdict environment");
  const upload = steps.find((step) => isRecord(step.with) && step.with.name === "main-ci-verdict");
  if (
    report?.if !== "always()" ||
    reportEnv.CI_GATE_OUTCOME !== "${{ steps.verify.outcome }}" ||
    reportEnv.CI_BASE_SHA !== "${{ needs.classify.outputs.base_sha }}" ||
    upload?.if !== "always()"
  ) {
    throw new Error("Main CI must publish the verdict even when verification fails.");
  }

  const issue = steps.find(
    (step) => step.run === "node --no-warnings scripts/ci/update-main-ci-issue.ts",
  );
  const issueEnv = requireRecord(issue?.env, "Main CI red-main issue environment");
  const permissions = requireRecord(complete.permissions, "Main CI complete permissions");
  const workflowPermissions = requireRecord(workflow.permissions, "Main CI workflow permissions");
  const otherIssueWriters = Object.entries(jobs).some(
    ([id, job]) =>
      id !== "complete" &&
      isRecord(job) &&
      (job.permissions === "write-all" ||
        (isRecord(job.permissions) && job.permissions.issues === "write")),
  );
  if (
    Object.keys(permissions).length !== 3 ||
    permissions.actions !== "read" ||
    permissions.contents !== "read" ||
    permissions.issues !== "write" ||
    workflowPermissions.issues !== undefined ||
    otherIssueWriters ||
    report?.id !== "verdict" ||
    issueEnv.GITHUB_TOKEN !== "${{ github.token }}" ||
    issueEnv.CI_GATE_OUTCOME !== "${{ steps.verify.outcome }}" ||
    issue?.if !==
      "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.verdict.outcome == 'success' && (steps.verify.outcome == 'failure' || success()) }}"
  ) {
    throw new Error(
      "Only Main CI complete may update the red-main issue for a finished main push.",
    );
  }
};

const referencedNeeds = (value: unknown): ReadonlySet<string> => {
  const references = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(/\bneeds\.([A-Za-z_][A-Za-z0-9_-]*)\b/gu)) {
        const name = match[1];
        if (name) references.add(name);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    for (const entry of Object.values(candidate)) visit(entry);
  };
  visit(value);
  return references;
};

const declaredNeeds = (value: unknown, label: string): ReadonlySet<string> => {
  if (value === undefined) return new Set();
  if (typeof value === "string") return new Set([value]);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return new Set(value);
  }
  throw new Error(`${label} needs must be a job id or array of job ids.`);
};

export const verifyPreMergeCiContract = (workflow: UnknownRecord): void => {
  const triggers = requireRecord(workflow.on, "Pre-merge CI triggers");
  const pullRequest = requireRecord(triggers.pull_request, "Pre-merge CI pull_request trigger");
  const activities = pullRequest.types;
  if (
    Object.keys(pullRequest).length !== 1 ||
    !Array.isArray(activities) ||
    !activities.every((activity): activity is string => typeof activity === "string")
  ) {
    throw new Error("Pre-merge CI must run on unfiltered pull requests.");
  }
  requireExactEntries(
    [...activities].sort(),
    ["labeled", "opened", "ready_for_review", "reopened", "synchronize"],
    "Pre-merge CI pull request activities",
  );
  const mergeGroup = requireRecord(triggers.merge_group, "Pre-merge CI merge_group trigger");
  if (
    Object.keys(mergeGroup).length !== 1 ||
    !Array.isArray(mergeGroup.types) ||
    mergeGroup.types.length !== 1 ||
    mergeGroup.types[0] !== "checks_requested"
  ) {
    throw new Error("Pre-merge CI must run for every merge-group check request.");
  }

  const concurrency = requireRecord(workflow.concurrency, "Pre-merge CI concurrency");
  if (
    concurrency.group !==
      "ci-${{ github.event_name }}-${{ github.event_name == 'merge_group' && github.run_id || github.event.pull_request.number || github.ref }}" ||
    concurrency["cancel-in-progress"] !== "${{ github.event_name != 'merge_group' }}"
  ) {
    throw new Error("Pre-merge CI must isolate merge-group runs and allow superseding PR runs.");
  }

  const jobs = requireRecord(workflow.jobs, "Pre-merge CI jobs");
  const classify = requireRecord(jobs.classify, "Pre-merge CI classify job");
  const changes = Array.isArray(classify.steps)
    ? classify.steps.filter(isRecord).find((step) => step.id === "changes")
    : undefined;
  const diff = requireRecord(changes?.env, "Pre-merge CI comparison range");
  if (
    classify.if !== undefined ||
    changes === undefined ||
    changes.if !== undefined ||
    diff.DRAFT_PLAN !==
      "${{ github.event_name == 'pull_request' && github.event.pull_request.draft && !contains(github.event.pull_request.labels.*.name, 'ci:full') }}" ||
    typeof changes.run !== "string" ||
    !changes.run.includes("arguments+=(--draft)") ||
    diff.BASE_SHA !==
      "${{ github.event.merge_group.base_sha || github.event.pull_request.base.sha }}" ||
    diff.HEAD_SHA !==
      "${{ github.event_name != 'merge_group' && github.sha || github.event.merge_group.head_sha }}"
  ) {
    throw new Error("Pre-merge CI must classify the event range and honor the draft opt-in.");
  }

  verifySelectedWindowsGate(jobs, "Pre-merge CI");

  const required = requireRecord(jobs.required, "Pre-merge CI required job");
  requireExactEntries(
    [...declaredNeeds(required.needs, "Pre-merge CI required")].sort(),
    SELECTED_GATE_DEPENDENCIES,
    "Pre-merge CI required dependencies",
  );
  const verifier = Array.isArray(required.steps)
    ? required.steps.filter(isRecord).find((step) => step.id === "verify")
    : undefined;
  const env = requireRecord(verifier?.env, "Pre-merge CI required verifier environment");
  if (
    required.name !== "required" ||
    required.if !== "always()" ||
    required["continue-on-error"] !== undefined ||
    verifier?.if !== undefined ||
    verifier?.["continue-on-error"] !== undefined ||
    verifier?.run !== "node --no-warnings scripts/ci/verify-required-gates.ts" ||
    env.CI_GATE_PLAN_JSON !== "${{ needs.classify.outputs.plan }}" ||
    env.CI_NEEDS_JSON !== "${{ toJSON(needs) }}" ||
    env.CI_CLASSIFIER_RESULT !== undefined
  ) {
    throw new Error("Pre-merge CI required must always enforce the selected gate results.");
  }
};

export const verifyWindowsCiContracts = (full: UnknownRecord, slim: UnknownRecord): void => {
  const triggers = requireRecord(full.on, "Full Windows triggers");
  requireExactEntries(
    Object.keys(triggers).sort(),
    ["push", "schedule", "workflow_dispatch"],
    "Full Windows triggers",
  );
  const push = requireRecord(triggers.push, "Full Windows push trigger");
  requireExactEntries(
    Array.isArray(push.branches) ? push.branches : [],
    ["codex/windows-**"],
    "Full Windows push branches",
  );
  const dispatch = requireRecord(triggers.workflow_dispatch, "Full Windows dispatch");
  const inputs = requireRecord(dispatch.inputs, "Full Windows dispatch inputs");
  const reprobe = requireRecord(inputs.installer_run_id, "Full Windows installer re-probe");
  if (reprobe.type !== "string" || reprobe.default !== "") {
    throw new Error("Full Windows must allow an optional installer re-probe on dispatch.");
  }

  const slimTriggers = requireRecord(slim.on, "Slim Windows triggers");
  requireExactEntries(Object.keys(slimTriggers), ["workflow_call"], "Slim Windows triggers");
  const jobs = requireRecord(slim.jobs, "Slim Windows jobs");
  const native = requireRecord(jobs.native, "Slim Windows native job");
  if (
    Object.keys(jobs).length !== 1 ||
    native["runs-on"] !== "windows-latest" ||
    native.strategy !== undefined ||
    native.if !== undefined ||
    native["continue-on-error"] !== undefined
  ) {
    throw new Error("Slim Windows must require one native x64 job.");
  }
};

export const verifyNightlyMacApplicationContracts = (workflow: UnknownRecord): void => {
  const jobs = requireRecord(workflow.jobs, "Nightly CI jobs");
  const macJob = requireRecord(jobs["app-tests-macos"], "Nightly CI macOS application job");
  const inputs = requireRecord(macJob.with, "Nightly CI macOS application inputs");
  const linuxInputs = reusableInputs(workflow, "app-tests", "Nightly CI");
  if (
    macJob.uses !== "./.github/workflows/_app-tests.yml" ||
    macJob.if !== undefined ||
    inputs.runner !== "macos-26" ||
    typeof inputs.timing_prefix !== "string" ||
    inputs.timing_prefix === linuxInputs.timing_prefix
  ) {
    throw new Error(
      "Nightly CI must reuse the application workflow on macos-26 with distinct artifacts.",
    );
  }
  requireFullAppTestMatrix(workflow, "app-tests-macos", "Nightly CI");

  const otherMacJobs = Object.values(jobs).filter(
    (job) =>
      isRecord(job) && typeof job["runs-on"] === "string" && job["runs-on"].startsWith("macos-"),
  ).length;
  const parallel = inputs.max_parallel;
  if (
    typeof parallel !== "number" ||
    !Number.isInteger(parallel) ||
    parallel < 1 ||
    parallel + otherMacJobs > 5
  ) {
    throw new Error(
      "Nightly CI must fit its application matrix and other macOS jobs in five slots.",
    );
  }

  const complete = requireRecord(jobs.complete, "Nightly CI complete job");
  if (
    complete.if !== "always()" ||
    !declaredNeeds(complete.needs, "Nightly CI complete").has("app-tests-macos")
  ) {
    throw new Error("Nightly CI complete must always require the macOS application matrix.");
  }
};

/** Electron UI coverage belongs only to the curated Nightly job. */
export const verifyElectronE2eWorkflowContracts = (
  workflow: UnknownRecord,
  workflowName: string,
): void => {
  const jobs = requireRecord(workflow.jobs, `${workflowName} jobs`);
  const e2eJobs = Object.entries(jobs).filter(([, rawJob]) => {
    const job = requireRecord(rawJob, `${workflowName} job`);
    if (!Array.isArray(job.steps)) return false;
    return job.steps.some(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        typeof step.run === "string" &&
        /\btest:e2e(?::[\w-]+)?\b/u.test(step.run),
    );
  });
  if (workflowName !== ".github/workflows/ci-nightly.yml") {
    if (e2eJobs.length > 0) {
      throw new Error(`${workflowName} must leave Electron E2E to Nightly CI.`);
    }
    return;
  }
  requireExactEntries(
    e2eJobs.map(([name]) => name),
    ["electron-e2e"],
    "Nightly CI Electron E2E jobs",
  );
  const job = requireRecord(jobs["electron-e2e"], "Nightly CI Electron E2E job");
  if (job["runs-on"] !== "macos-26") {
    throw new Error("Nightly CI Electron E2E must use the standard macos-26 runner.");
  }
  const steps = job.steps as readonly UnknownRecord[];
  const commands = steps.flatMap((step) =>
    typeof step.run === "string" && /\btest:e2e\b/u.test(step.run) ? [step.run] : [],
  );
  if (commands.length !== 1 || !/\bvp run test:e2e:nightly$/u.test(commands[0] ?? "")) {
    throw new Error("Nightly CI Electron E2E must run the shared test:e2e:nightly selection.");
  }
  const complete = requireRecord(jobs.complete, "Nightly CI complete job");
  if (
    complete.if !== "always()" ||
    !declaredNeeds(complete.needs, "Nightly CI complete").has("electron-e2e")
  ) {
    throw new Error("Nightly CI complete must always require Electron E2E.");
  }
};

const RUST_CACHE_VARIABLES = ["RUSTC_WRAPPER", "SCCACHE_GHA_ENABLED"] as const;
const RUST_CACHE_ASSIGNMENT = /\b(?:RUSTC_WRAPPER|SCCACHE_GHA_ENABLED)=/u;

/**
 * The compiler cache only makes builds faster. `.github/actions/setup-rust-ci` enables it once
 * sccache is installed, so a workflow that sets it itself would fail when the download does.
 */
export const verifyRustCacheOwnership = (workflow: UnknownRecord, workflowName: string): void => {
  const owners: string[] = [];
  const inspectEnvironment = (environment: unknown, label: string): void => {
    if (typeof environment !== "object" || environment === null) return;
    for (const name of RUST_CACHE_VARIABLES)
      if (Object.hasOwn(environment, name)) owners.push(`${label} sets ${name}`);
  };
  inspectEnvironment(workflow.env, workflowName);
  const jobs =
    workflow.jobs === undefined ? {} : requireRecord(workflow.jobs, `${workflowName} jobs`);
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = requireRecord(rawJob, `${workflowName} ${jobName} job`);
    inspectEnvironment(job.env, `${workflowName} ${jobName}`);
    if (!Array.isArray(job.steps)) continue;
    job.steps.forEach((candidate: unknown, index) => {
      if (typeof candidate !== "object" || candidate === null) return;
      const step = candidate as UnknownRecord;
      const label = `${workflowName} ${jobName} step ${index + 1}`;
      inspectEnvironment(step.env, label);
      if (typeof step.run === "string" && RUST_CACHE_ASSIGNMENT.test(step.run))
        owners.push(`${label} assigns a Rust cache variable`);
    });
  }
  if (owners.length > 0) {
    throw new Error(
      `Only .github/actions/setup-rust-ci enables the Rust compiler cache: ${owners.join("; ")}.`,
    );
  }
};

export const verifyDirectNeedsContracts = (workflow: UnknownRecord, workflowName: string): void => {
  const jobs = requireRecord(workflow.jobs, `${workflowName} jobs`);
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = requireRecord(rawJob, `${workflowName} ${jobName} job`);
    const available = declaredNeeds(job.needs, `${workflowName} ${jobName}`);
    const missing = [...referencedNeeds(job)].filter((name) => !available.has(name)).sort();
    if (missing.length > 0) {
      throw new Error(
        `${workflowName} ${jobName} references undeclared direct needs: ${missing.join(", ")}.`,
      );
    }
  }
};

const main = (): void => {
  const nightly = readWorkflow(path.join(repositoryRoot, ".github/workflows/ci-nightly.yml"));
  verifyFullCiContracts(nightly);
  verifyNightlyMacApplicationContracts(nightly);
  verifyFullCiContracts(
    readWorkflow(path.join(repositoryRoot, ".github/workflows/_certify-release-source.yml")),
    "Release certification",
  );
  verifyAppTestMatrixContracts(
    readWorkflow(path.join(repositoryRoot, ".github/workflows/_app-tests.yml")),
  );
  verifyPreMergeCiContract(readWorkflow(path.join(repositoryRoot, ".github/workflows/ci.yml")));
  verifyMainCiBaseContract(readWorkflow(path.join(repositoryRoot, MAIN_CI_WORKFLOW_PATH)));
  verifyWindowsCiContracts(
    readWorkflow(path.join(repositoryRoot, ".github/workflows/windows.yml")),
    readWorkflow(path.join(repositoryRoot, ".github/workflows/_windows-checks.yml")),
  );
  for (const workflowPath of workflowFiles()) {
    const workflow = readWorkflow(workflowPath);
    const workflowName = relativeRepositoryPath(workflowPath);
    verifyElectronE2eWorkflowContracts(workflow, workflowName);
    verifyDirectNeedsContracts(workflow, workflowName);
    verifyRustCacheOwnership(workflow, workflowName);
  }
  process.stdout.write("Verified CI matrix coverage and prerequisite isolation.\n");
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
