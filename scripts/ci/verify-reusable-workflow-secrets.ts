import path from "node:path";

import {
  isRecord,
  readWorkflow,
  repositoryRoot,
  requireRecord,
  workflowFiles,
  workflowsDirectory,
} from "./github-workflow-files";
import type { UnknownRecord } from "./github-workflow-files";

const secretReferencePattern = /secrets\.([A-Za-z_][A-Za-z0-9_]*)/gu;
const environmentSecretContracts = new Map<string, ReadonlySet<string>>([
  ["sparkle-feed-finalization", new Set(["SPARKLE_ED25519_PRIVATE_KEY"])],
]);
const environmentSecretNames = new Set(
  [...environmentSecretContracts.values()].flatMap((names) => [...names]),
);
const permissionLevels = new Map([
  ["none", 0],
  ["read", 1],
  ["write", 2],
] as const);

const explicitPermissions = (value: unknown, label: string): ReadonlyMap<string, number> => {
  if (value === undefined) return new Map();
  if (value === "read-all" || value === "write-all") {
    return new Map([["*", value === "read-all" ? 1 : 2]]);
  }
  const permissions = requireRecord(value, label);
  return new Map(
    Object.entries(permissions).map(([name, rawLevel]) => {
      if (
        typeof rawLevel !== "string" ||
        !permissionLevels.has(rawLevel as "none" | "read" | "write")
      ) {
        throw new Error(`${label}.${name} must be none, read, or write`);
      }
      return [name, permissionLevels.get(rawLevel as "none" | "read" | "write") ?? 0];
    }),
  );
};

const verifyPermissionCeiling = (
  callerPath: string,
  jobName: string,
  job: UnknownRecord,
  caller: UnknownRecord,
  target: UnknownRecord,
): void => {
  const callerLabel = `${path.relative(repositoryRoot, callerPath)}:${jobName}.permissions`;
  const callerPermissions = explicitPermissions(job.permissions ?? caller.permissions, callerLabel);
  const requested = new Map(explicitPermissions(target.permissions, "called workflow permissions"));
  const targetJobs = requireRecord(target.jobs, "called workflow jobs");
  for (const [targetJobName, rawTargetJob] of Object.entries(targetJobs)) {
    const targetJob = requireRecord(rawTargetJob, `${targetJobName} job`);
    const permissions = explicitPermissions(
      targetJob.permissions ?? target.permissions,
      `called workflow ${targetJobName} permissions`,
    );
    for (const [name, level] of permissions) {
      requested.set(name, Math.max(requested.get(name) ?? 0, level));
    }
  }
  const callerDefault = callerPermissions.get("*") ?? 0;
  const insufficient = [...requested.entries()]
    .filter(([name, level]) => level > (callerPermissions.get(name) ?? callerDefault))
    .map(([name]) => name)
    .sort();
  if (insufficient.length === 0) return;
  throw new Error(
    `${path.relative(repositoryRoot, callerPath)}:${jobName} does not grant permissions required by the called workflow: ${insufficient.join(", ")}`,
  );
};

const workflowCallSecrets = (workflow: UnknownRecord): UnknownRecord => {
  const triggers = workflow.on;
  if (!isRecord(triggers)) return {};
  const workflowCall = triggers.workflow_call;
  if (!isRecord(workflowCall)) return {};
  return isRecord(workflowCall.secrets) ? workflowCall.secrets : {};
};

const workflowCallInputs = (workflow: UnknownRecord): UnknownRecord => {
  const triggers = workflow.on;
  if (!isRecord(triggers)) return {};
  const workflowCall = triggers.workflow_call;
  if (!isRecord(workflowCall)) return {};
  return isRecord(workflowCall.inputs) ? workflowCall.inputs : {};
};

const isReusableWorkflow = (workflow: UnknownRecord): boolean => {
  const triggers = workflow.on;
  return isRecord(triggers) && isRecord(triggers.workflow_call);
};

const environmentName = (job: UnknownRecord): string | undefined => {
  if (typeof job.environment === "string") return job.environment;
  if (!isRecord(job.environment)) return undefined;
  return typeof job.environment.name === "string" ? job.environment.name : undefined;
};

const referencedSecrets = (value: unknown): ReadonlySet<string> => {
  const references = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(secretReferencePattern)) {
        const name = match[1];
        if (name) references.add(name);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const entry of Object.values(candidate)) visit(entry);
  };
  visit(value);
  return references;
};

const resolveLocalWorkflow = (callerPath: string, uses: string): string => {
  const target = path.resolve(repositoryRoot, uses.slice(2));
  const relative = path.relative(workflowsDirectory, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `${path.relative(repositoryRoot, callerPath)} calls a workflow outside .github/workflows`,
    );
  }
  return target;
};

export const verifyDeclaredReferences = (filePath: string, workflow: UnknownRecord): void => {
  const declared = workflowCallSecrets(workflow);
  const reusable = isReusableWorkflow(workflow);
  const jobs = requireRecord(workflow.jobs, `${path.relative(repositoryRoot, filePath)}.jobs`);
  const workflowWithoutJobs = { ...workflow };
  delete workflowWithoutJobs.jobs;
  const topLevelReferences = [...referencedSecrets(workflowWithoutJobs)];
  const topLevelEnvironmentSecrets = topLevelReferences
    .filter((name) => environmentSecretNames.has(name))
    .sort();
  if (topLevelEnvironmentSecrets.length > 0) {
    throw new Error(
      `${path.relative(repositoryRoot, filePath)} references protected environment secrets outside a job: ${topLevelEnvironmentSecrets.join(", ")}`,
    );
  }
  if (reusable) {
    const topLevelUndeclared = topLevelReferences
      .filter((name) => !Object.hasOwn(declared, name))
      .sort();
    if (topLevelUndeclared.length > 0) {
      throw new Error(
        `${path.relative(repositoryRoot, filePath)} references undeclared workflow-call secrets outside a job: ${topLevelUndeclared.join(", ")}`,
      );
    }
  }
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = requireRecord(rawJob, `${jobName} job`);
    const allowed = environmentSecretContracts.get(environmentName(job) ?? "") ?? new Set<string>();
    const references = [...referencedSecrets(job)];
    const reusableEnvironmentSecrets = references
      .filter((name) => reusable && environmentSecretNames.has(name))
      .sort();
    if (reusableEnvironmentSecrets.length > 0) {
      throw new Error(
        `${path.relative(repositoryRoot, filePath)}:${jobName} must not resolve protected environment secrets across a reusable workflow boundary: ${reusableEnvironmentSecrets.join(", ")}`,
      );
    }
    const misplacedEnvironmentSecrets = references
      .filter((name) => environmentSecretNames.has(name) && !allowed.has(name))
      .sort();
    if (misplacedEnvironmentSecrets.length > 0) {
      throw new Error(
        `${path.relative(repositoryRoot, filePath)}:${jobName} references protected environment secrets outside their environment: ${misplacedEnvironmentSecrets.join(", ")}`,
      );
    }
    if (reusable) {
      const undeclared = references
        .filter((name) => !Object.hasOwn(declared, name) && !allowed.has(name))
        .sort();
      if (undeclared.length > 0) {
        throw new Error(
          `${path.relative(repositoryRoot, filePath)}:${jobName} references undeclared workflow-call secrets: ${undeclared.join(", ")}`,
        );
      }
    }
  }
};

export const verifyCall = (
  callerPath: string,
  jobName: string,
  job: UnknownRecord,
  workflows: ReadonlyMap<string, UnknownRecord>,
): void => {
  const uses = job.uses;
  if (typeof uses !== "string" || !uses.startsWith("./.github/workflows/")) return;
  const targetPath = resolveLocalWorkflow(callerPath, uses);
  const target = workflows.get(targetPath);
  if (!target) throw new Error(`${uses} does not resolve to a repository workflow`);
  const caller = workflows.get(callerPath);
  if (caller) verifyPermissionCeiling(callerPath, jobName, job, caller, target);

  const declaredInputs = workflowCallInputs(target);
  const providedInputs =
    job.with === undefined
      ? {}
      : requireRecord(job.with, `${path.relative(repositoryRoot, callerPath)}:${jobName}.with`);
  const unknownInputs = Object.keys(providedInputs)
    .filter((name) => !Object.hasOwn(declaredInputs, name))
    .sort();
  if (unknownInputs.length > 0) {
    throw new Error(
      `${path.relative(repositoryRoot, callerPath)}:${jobName} passes undeclared inputs: ${unknownInputs.join(", ")}`,
    );
  }
  const missingInputs = Object.entries(declaredInputs)
    .filter(
      ([, definition]) =>
        isRecord(definition) &&
        definition.required === true &&
        !Object.hasOwn(definition, "default"),
    )
    .map(([name]) => name)
    .filter((name) => !Object.hasOwn(providedInputs, name))
    .sort();
  if (missingInputs.length > 0) {
    throw new Error(
      `${path.relative(repositoryRoot, callerPath)}:${jobName} omits required inputs: ${missingInputs.join(", ")}`,
    );
  }

  if (job.secrets === "inherit") {
    throw new Error(
      `${path.relative(repositoryRoot, callerPath)}:${jobName} must map secrets explicitly`,
    );
  }
  const provided =
    job.secrets === undefined
      ? {}
      : requireRecord(
          job.secrets,
          `${path.relative(repositoryRoot, callerPath)}:${jobName}.secrets`,
        );
  const transportedEnvironmentSecrets = Object.keys(provided)
    .filter((name) => environmentSecretNames.has(name))
    .sort();
  if (transportedEnvironmentSecrets.length > 0) {
    throw new Error(
      `${path.relative(repositoryRoot, callerPath)}:${jobName} must resolve protected environment secrets in the called job: ${transportedEnvironmentSecrets.join(", ")}`,
    );
  }
  const declared = workflowCallSecrets(target);
  const unknown = Object.keys(provided)
    .filter((name) => !Object.hasOwn(declared, name))
    .sort();
  if (unknown.length > 0) {
    throw new Error(
      `${path.relative(repositoryRoot, callerPath)}:${jobName} passes undeclared secrets: ${unknown.join(", ")}`,
    );
  }

  const missing = Object.entries(declared)
    .filter(([, definition]) => isRecord(definition) && definition.required === true)
    .map(([name]) => name)
    .filter((name) => !Object.hasOwn(provided, name))
    .sort();
  if (missing.length === 0) return;
  throw new Error(
    `${path.relative(repositoryRoot, callerPath)}:${jobName} omits required secrets: ${missing.join(", ")}`,
  );
};

const main = (): void => {
  const workflows = new Map(workflowFiles().map((filePath) => [filePath, readWorkflow(filePath)]));
  for (const [filePath, workflow] of workflows) {
    verifyDeclaredReferences(filePath, workflow);
    const jobs = requireRecord(workflow.jobs, `${path.relative(repositoryRoot, filePath)}.jobs`);
    for (const [jobName, job] of Object.entries(jobs)) {
      verifyCall(filePath, jobName, requireRecord(job, `${jobName} job`), workflows);
    }
  }
  process.stdout.write(
    `Verified reusable-workflow secret contracts across ${workflows.size} workflows.\n`,
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
