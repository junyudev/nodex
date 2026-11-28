import path from "node:path";
import { RELEASE_ARCHITECTURES } from "../release/targets";
import {
  isRecord,
  readWorkflow,
  requireRecord,
  workflowsDirectory,
  type UnknownRecord,
} from "./github-workflow-files";

const TARGETS = [...RELEASE_ARCHITECTURES].sort();
const WINDOWS_WORKFLOW = "./.github/workflows/_windows-distribution.yml";
const MOBILE_WORKFLOW = "./.github/workflows/_mobile-distribution.yml";
/** Only a stable release opens a build to the public TestFlight beta. */
const TESTFLIGHT_CALLERS = new Set(["release.yml"]);
const RELEASE_CALLERS = ["release.yml", "nightly-release.yml", "release-rehearsal.yml"];
const R2_WORKFLOWS = [
  "_promote-release.yml",
  "_promote-nightly.yml",
  "nightly-retention.yml",
] as const;
const R2_COMMANDS = ["publish:r2", "publish:feeds", "verify:feeds"] as const;

const names = (value: unknown): readonly string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
const assertNeeds = (job: UnknownRecord, dependencies: readonly string[], label: string): void => {
  if (dependencies.some((dependency) => !names(job.needs).includes(dependency)))
    throw new Error(`${label} must require ${dependencies.join(", ")}.`);
};

function verifyNightlySource(jobs: UnknownRecord): void {
  const source = "${{ needs.resolve.outputs.source_sha }}";
  const resolve = requireRecord(jobs.resolve, "Nightly resolve");
  const outputs = requireRecord(resolve.outputs, "Nightly resolve outputs");
  if (outputs.source_sha !== "${{ steps.candidate.outputs.source_sha }}") {
    throw new Error("Nightly must export its verified candidate source SHA.");
  }

  const certification = requireRecord(jobs.certification, "Nightly certification");
  if (certification.uses !== "./.github/workflows/_certify-release-source.yml") {
    throw new Error("Nightly must certify the verified candidate source.");
  }

  for (const name of [
    "certification",
    "distribution",
    "windows-distribution",
    "mobile-distribution",
    "assemble",
    "promote",
  ]) {
    const job = requireRecord(jobs[name], `Nightly ${name}`);
    assertNeeds(job, ["resolve"], `Nightly ${name}`);
    if (requireRecord(job.with, `Nightly ${name} inputs`).source_sha !== source) {
      throw new Error(`Nightly ${name} must use the verified candidate source SHA.`);
    }
  }
  assertNeeds(
    requireRecord(jobs.distribution, "Nightly distribution"),
    ["certification"],
    "Nightly distribution",
  );

  const finalizer = requireRecord(jobs["finalize-sparkle"], "Nightly finalizer");
  assertNeeds(finalizer, ["resolve"], "Nightly finalizer");
  const steps = Array.isArray(finalizer.steps) ? finalizer.steps.filter(isRecord) : [];
  const checkouts = steps.filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
  );
  const finalize = steps.find((step) => step.uses === "./.github/actions/finalize-sparkle");
  if (
    checkouts.length === 0 ||
    checkouts.some((step) => !isRecord(step.with) || step.with.ref !== source) ||
    !isRecord(finalize?.with) ||
    finalize.with.source_sha !== source
  ) {
    throw new Error(
      "Nightly finalization must check out and use the verified candidate source SHA.",
    );
  }
}

function verifyR2Job(job: UnknownRecord, command: string, label: string): string {
  const steps = Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
  const step = steps.find((step) => typeof step.run === "string" && step.run.includes(command));
  const environment = step?.env;
  if (
    job.environment !== "release-r2-publish" ||
    typeof step?.run !== "string" ||
    !isRecord(environment) ||
    environment.R2_ACCESS_KEY_ID !== "${{ secrets.CLOUDFLARE_R2_RELEASES_ACCESS_KEY_ID }}" ||
    environment.R2_SECRET_ACCESS_KEY !== "${{ secrets.CLOUDFLARE_R2_RELEASES_SECRET_ACCESS_KEY }}"
  ) {
    throw new Error(
      `${label} must resolve the R2 credentials in its protected release-r2-publish job.`,
    );
  }
  return step.run;
}

function verifyR2Queue(job: UnknownRecord, channel: string, label: string): void {
  const queue = requireRecord(job.concurrency, `${label} concurrency`);
  if (
    queue.group !== `release-r2-${channel}` ||
    queue["cancel-in-progress"] !== false ||
    queue.queue !== "max"
  ) {
    throw new Error(`${label} must serialize R2 changes within the ${channel} channel.`);
  }
}

function verifyR2Distribution(workflows: ReadonlyMap<string, UnknownRecord>): void {
  for (const [channel, filename, jobName, callerName] of [
    ["stable", "_promote-release.yml", "r2", "release.yml"],
    ["nightly", "_promote-nightly.yml", "feed", "nightly-release.yml"],
  ] as const) {
    const caller = requireRecord(workflows.get(callerName), callerName);
    const promote = requireRecord(
      requireRecord(caller.jobs, `${callerName} jobs`).promote,
      `${callerName} promote`,
    );
    if (promote.uses !== `./.github/workflows/${filename}`) {
      throw new Error(`${callerName} must use the ${channel} promotion workflow.`);
    }
    const workflow = requireRecord(workflows.get(filename), filename);
    const jobs = requireRecord(workflow.jobs, `${channel} promotion jobs`);
    const job = requireRecord(jobs[jobName], `${channel} R2 publication`);
    const label = `${channel} R2 publication`;
    assertNeeds(job, ["publish"], label);
    const publish = verifyR2Job(job, "vp run release:publish:r2", label);
    if (!publish.includes("vp run release:publish:feeds")) {
      throw new Error(`${label} must publish assets and feeds with the R2 credentials.`);
    }
    verifyR2Queue(job, channel, label);

    const commands = (Array.isArray(job.steps) ? job.steps.filter(isRecord) : [])
      .map((step) => step.run)
      .filter((run): run is string => typeof run === "string")
      .join("\n");
    const positions = R2_COMMANDS.map((command) =>
      commands.indexOf(`vp run release:${command} -- --bundle`),
    );
    if (
      positions.some(
        (position, index) => position < 0 || (index > 0 && position <= positions[index - 1]),
      )
    ) {
      throw new Error(
        `${label} must publish the bundle, publish its feeds, then verify public distribution.`,
      );
    }
    if (channel === "stable") {
      assertNeeds(
        requireRecord(jobs.homebrew, "Homebrew publication"),
        ["publish", jobName],
        "Homebrew publication",
      );
      const advance = requireRecord(
        requireRecord(caller.jobs, "Stable jobs").advance,
        "Stable advance",
      );
      const steps = Array.isArray(advance.steps) ? advance.steps.filter(isRecord) : [];
      if (
        !steps.some(
          (step) =>
            typeof step.run === "string" &&
            step.run.includes("gh workflow run deploy-landing-site.yml"),
        )
      ) {
        throw new Error("Stable advance must dispatch the landing site deployment.");
      }
    }
  }

  const rehearsal = requireRecord(workflows.get("release-rehearsal.yml"), "Distribution Rehearsal");
  const rehearsalJobs = requireRecord(rehearsal.jobs, "Distribution Rehearsal jobs");
  for (const job of Object.values(rehearsalJobs).filter(isRecord)) {
    if (
      job.environment === "release-r2-publish" ||
      R2_WORKFLOWS.some((name) => job.uses === `./.github/workflows/${name}`)
    ) {
      throw new Error("Distribution Rehearsal must remain free of public distribution.");
    }
  }

  const retention = requireRecord(workflows.get("nightly-retention.yml"), "Nightly Retention");
  const jobs = requireRecord(retention.jobs, "Nightly Retention jobs");
  for (const name of ["plan", "apply"]) {
    const label = `Nightly Retention ${name}`;
    const job = requireRecord(jobs[name], label);
    const command = verifyR2Job(job, "vp run release:retain:nightlies", label);
    if (name === "plan") {
      if (!command.includes("--destructive false")) throw new Error(`${label} must be a dry run.`);
      continue;
    }
    verifyR2Queue(job, "nightly", label);
    if (
      job.if !== "github.event_name == 'workflow_dispatch' && inputs.destructive == true" ||
      !isRecord(job.permissions) ||
      job.permissions.contents !== "write" ||
      !command.includes("--destructive true")
    ) {
      throw new Error(
        `${label} must delete only on manual dispatch with repository write permission.`,
      );
    }
  }
}

/** Architecture completeness and the protected signing boundary are release admission contracts. */
export function verifyReleaseDistributionWorkflows(
  workflows: ReadonlyMap<string, UnknownRecord>,
): void {
  verifyR2Distribution(workflows);
  const windows = requireRecord(
    workflows.get("_windows-distribution.yml"),
    "Windows implementation",
  );
  const jobs = requireRecord(windows.jobs, "Windows jobs");
  const installer = requireRecord(jobs.installer, "Windows installer");
  const environment = requireRecord(installer.env, "Windows distribution environment");
  if (
    Object.values(environment).some(
      (value) => typeof value === "string" && /\$\{\{\s*runner\b/u.test(value),
    )
  ) {
    throw new Error(
      "Windows job-level env cannot use runner context; use a step or workspace path.",
    );
  }
  const reusable = requireRecord(
    requireRecord(windows.on, "Windows triggers").workflow_call,
    "Reusable Windows trigger",
  );
  const architecture = requireRecord(
    requireRecord(reusable.inputs, "Windows inputs").arch,
    "Windows architecture",
  );
  if (
    architecture.default !== "x64" ||
    installer.strategy ||
    installer["runs-on"] !==
      "${{ !inputs.release && inputs.arch == 'arm64' && 'windows-11-arm' || 'windows-latest' }}"
  )
    throw new Error("Official Windows distribution must default to the native runner for x64.");
  const validation = requireRecord(
    requireRecord(workflows.get("windows.yml"), "Windows validation").jobs,
    "Windows validation jobs",
  );
  const validationPackage = requireRecord(validation.package, "Windows validation package");
  if (
    validationPackage.uses !== WINDOWS_WORKFLOW ||
    validationPackage.steps ||
    requireRecord(validationPackage.with, "Windows validation inputs").release !== false
  )
    throw new Error("Windows validation must reuse native distribution with updates disabled.");
  const mobile = requireRecord(
    requireRecord(workflows.get("_mobile-distribution.yml"), "Mobile implementation").jobs,
    "Mobile jobs",
  );
  for (const [platform, runner] of [
    ["android", "ubuntu-latest"],
    ["ios", "macos-26"],
  ] as const) {
    const job = requireRecord(mobile[platform], `Mobile ${platform}`);
    if (job["runs-on"] !== runner || job.environment !== "mobile-distribution")
      throw new Error(
        `Mobile ${platform} must build on ${runner} in the protected mobile-distribution environment.`,
      );
  }
  for (const filename of RELEASE_CALLERS) {
    const caller = requireRecord(workflows.get(filename), filename);
    const callerJobs = requireRecord(caller.jobs, `${filename} jobs`);
    const stable = filename === "release.yml";
    if (stable) {
      const triggers = requireRecord(caller.on, "Stable triggers");
      if (
        Object.keys(triggers).join() !== "workflow_dispatch" ||
        ["certification", "distribution", "windows-distribution", "mobile-distribution"].some(
          (job) => Object.hasOwn(callerJobs, job),
        )
      ) {
        throw new Error("Stable must be dispatch-only and reuse a verified Nightly build.");
      }
      const resolve = requireRecord(callerJobs.resolve, "Stable candidate verification");
      if (resolve.environment !== "release-source" || resolve.secrets !== undefined) {
        throw new Error("Stable candidate verification must precede signing secrets.");
      }
    } else {
      const distribution = requireRecord(
        callerJobs["windows-distribution"],
        `${filename} Windows distribution`,
      );
      if (
        distribution.uses !== WINDOWS_WORKFLOW ||
        distribution.steps ||
        (isRecord(distribution.with) &&
          (distribution.with.release === false ||
            (distribution.with.arch !== undefined && distribution.with.arch !== "x64")))
      )
        throw new Error(`${filename} must consume the official Windows distribution.`);
      assertNeeds(distribution, ["certification"], filename);
      const mobileDistribution = requireRecord(
        callerJobs["mobile-distribution"],
        `${filename} mobile distribution`,
      );
      if (mobileDistribution.uses !== MOBILE_WORKFLOW || mobileDistribution.steps)
        throw new Error(`${filename} must consume the official mobile distribution.`);
      assertNeeds(mobileDistribution, ["certification"], filename);
    }
    const testflight = callerJobs.testflight;
    if (TESTFLIGHT_CALLERS.has(filename)) {
      const job = requireRecord(testflight, `${filename} TestFlight`);
      if (job.uses || job.environment !== "testflight" || job["runs-on"] !== "macos-26")
        throw new Error(`${filename} TestFlight must stay in a direct protected macOS job.`);
      assertNeeds(job, ["promote"], filename);
    } else if (testflight !== undefined) {
      throw new Error(`${filename} must not publish to TestFlight; only stable releases do.`);
    }
    const finalizer = requireRecord(callerJobs["finalize-sparkle"], `${filename} finalizer`);
    if (
      finalizer.uses ||
      finalizer.environment !== "sparkle-feed-finalization" ||
      finalizer["runs-on"] !== "macos-26"
    )
      throw new Error(`${filename} signing must stay in a direct protected macOS job.`);
    const finalizerMatrix = requireRecord(
      requireRecord(finalizer.strategy, "Finalizer strategy").matrix,
      "Finalizer matrix",
    );
    if (JSON.stringify([...names(finalizerMatrix.architecture)].sort()) !== JSON.stringify(TARGETS))
      throw new Error(`${filename} must finalize all three release architectures.`);
    assertNeeds(
      finalizer,
      stable ? ["resolve"] : ["distribution", "windows-distribution"],
      filename,
    );
    assertNeeds(
      requireRecord(callerJobs.assemble, `${filename} assembly`),
      stable
        ? ["resolve", "finalize-sparkle"]
        : ["distribution", "windows-distribution", "mobile-distribution", "finalize-sparkle"],
      filename,
    );
    if (filename === "nightly-release.yml") verifyNightlySource(callerJobs);
  }
}

export function verifyRepositoryReleaseDistribution(): void {
  const files = [
    "_windows-distribution.yml",
    "_mobile-distribution.yml",
    "windows.yml",
    ...RELEASE_CALLERS,
    ...R2_WORKFLOWS,
  ];
  verifyReleaseDistributionWorkflows(
    new Map(files.map((file) => [file, readWorkflow(path.join(workflowsDirectory, file))])),
  );
  process.stdout.write(
    "Verified complete native and mobile distributions, protected finalizers and R2 publication.\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename))
  verifyRepositoryReleaseDistribution();
