import path from "node:path";
import {
  isRecord,
  readWorkflow,
  requireRecord,
  workflowsDirectory,
  type UnknownRecord,
} from "./github-workflow-files";

const TARGETS = ["arm64", "windows-arm64", "windows-x64"];
const WINDOWS_WORKFLOW = "./.github/workflows/_windows-distribution.yml";
const RELEASE_CALLERS = [
  "release.yml",
  "nightly-release.yml",
  "release-rehearsal.yml",
  "release-recovery.yml",
];
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

/** Architecture completeness and the protected signing boundary are release admission contracts. */
export function verifyReleaseDistributionWorkflows(
  workflows: ReadonlyMap<string, UnknownRecord>,
): void {
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
  const matrix = requireRecord(
    requireRecord(installer.strategy, "Windows strategy").matrix,
    "Windows matrix",
  );
  const cells = Array.isArray(matrix.include) ? matrix.include.filter(isRecord) : [];
  if (
    cells.length !== 2 ||
    !cells.some((cell) => cell.arch === "x64" && cell.runner === "windows-latest") ||
    !cells.some((cell) => cell.arch === "arm64" && cell.runner === "windows-11-arm") ||
    installer["runs-on"] !== "${{ matrix.runner }}"
  )
    throw new Error("Windows distribution must build both CPUs on their native runners.");
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
  for (const filename of RELEASE_CALLERS) {
    const caller = requireRecord(workflows.get(filename), filename);
    const callerJobs = requireRecord(caller.jobs, `${filename} jobs`);
    const distribution = requireRecord(
      callerJobs["windows-distribution"],
      `${filename} Windows distribution`,
    );
    if (
      distribution.uses !== WINDOWS_WORKFLOW ||
      distribution.steps ||
      (isRecord(distribution.with) && distribution.with.release === false)
    )
      throw new Error(`${filename} must consume the official Windows distribution.`);
    assertNeeds(distribution, ["certification"], filename);
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
    assertNeeds(finalizer, ["distribution", "windows-distribution"], filename);
    assertNeeds(
      requireRecord(callerJobs.assemble, `${filename} assembly`),
      ["distribution", "windows-distribution", "finalize-sparkle"],
      filename,
    );
    if (
      filename === "release-recovery.yml" &&
      (!String(finalizer.if).includes("needs.windows-distribution.result == 'success'") ||
        !String(requireRecord(callerJobs.assemble, "Recovery assembly").if).includes(
          "needs.windows-distribution.result == 'success'",
        ))
    )
      throw new Error("Recovery must reject a failed Windows distribution even with always().");
  }
}

export function verifyRepositoryReleaseDistribution(): void {
  const files = ["_windows-distribution.yml", "windows.yml", ...RELEASE_CALLERS];
  verifyReleaseDistributionWorkflows(
    new Map(files.map((file) => [file, readWorkflow(path.join(workflowsDirectory, file))])),
  );
  process.stdout.write(
    "Verified complete native release distributions and protected finalizers.\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename))
  verifyRepositoryReleaseDistribution();
