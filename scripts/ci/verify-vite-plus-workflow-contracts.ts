import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { load } from "js-yaml";

import {
  readWorkflow,
  relativeRepositoryPath,
  repositoryRoot,
  requireRecord,
  workflowFiles,
} from "./github-workflow-files";
import type { UnknownRecord } from "./github-workflow-files";

const sharedSetupAction = "./.github/actions/setup-vite-plus";
const setupVpCommit = "313600b80b104eadebb9111787d37a2e83e014ca";
const pinnedSetupVpAction = `voidzero-dev/setup-vp@${setupVpCommit}`;
const forbiddenSetupActions = ["pnpm/action-setup@", "actions/setup-node@"] as const;
const pnpmCommandPattern = /\bpnpm(?:\.cmd)?\b/u;
const vpCommandPattern =
  /(?:^|[;&|()\s])vp(?:\.cmd|\.exe)?\s+(?:build|check|dev|exec|fmt|install|lint|pack|run|test)\b/u;
const canonicalCheckPattern = /(?:^|[;&|()\s])vp(?:\.cmd|\.exe)?\s+run\s+check(?:\s|$)/u;
const staticGroupPattern =
  /(?:^|[;&|()\s])vp(?:\.cmd|\.exe)?\s+exec\s+tsx\s+scripts\/ci\/verify-static\.ts\s+--group\b/u;
const staticCheckWorkflow = ".github/workflows/_static-checks.yml";

const actionsDirectory = path.join(repositoryRoot, ".github/actions");
const sharedSetupPath = path.join(actionsDirectory, "setup-vite-plus/action.yml");

const readAutomationFile = (filePath: string): UnknownRecord =>
  requireRecord(load(readFileSync(filePath, "utf8")), relativeRepositoryPath(filePath));

const actionFiles = (): readonly string[] =>
  readdirSync(actionsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ["action.yml", "action.yaml"]
        .map((filename) => path.join(actionsDirectory, entry.name, filename))
        .filter((filePath) => {
          try {
            readFileSync(filePath);
            return true;
          } catch {
            return false;
          }
        }),
    )
    .sort();

const automationSteps = (owner: UnknownRecord, label: string): readonly UnknownRecord[] => {
  const runs = requireRecord(owner.runs, `${label}.runs`);
  if (!Array.isArray(runs.steps)) throw new Error(`${label}.runs.steps must be an array`);
  return runs.steps.map((step, index) => requireRecord(step, `${label}.runs.steps[${index}]`));
};

export const verifyCommandSteps = (
  label: string,
  steps: readonly UnknownRecord[],
  requireSetupBeforeVp: boolean,
): number => {
  let setupReady = false;
  let vpCommandCount = 0;

  for (const [index, step] of steps.entries()) {
    const stepLabel = `${label}.steps[${index}]`;
    const uses = typeof step.uses === "string" ? step.uses : "";
    if (forbiddenSetupActions.some((prefix) => uses.startsWith(prefix))) {
      throw new Error(`${stepLabel} bypasses the shared Vite+ setup action: ${uses}`);
    }
    if (uses.startsWith("voidzero-dev/setup-vp@")) {
      throw new Error(`${stepLabel} must use ${sharedSetupAction}, not ${uses}`);
    }
    if (uses === sharedSetupAction) setupReady = true;

    const run = typeof step.run === "string" ? step.run : "";
    if (pnpmCommandPattern.test(run)) {
      throw new Error(`${stepLabel} invokes pnpm directly; use vp install, vp run, or vp exec`);
    }
    if (!vpCommandPattern.test(run)) continue;
    vpCommandCount += 1;
    if (!requireSetupBeforeVp || setupReady) continue;
    throw new Error(`${stepLabel} invokes vp before ${sharedSetupAction}`);
  }

  return vpCommandCount;
};

export const verifyStaticCheckSteps = (label: string, steps: readonly UnknownRecord[]): void => {
  const checkIndex = steps.findIndex(
    (step) => typeof step.run === "string" && canonicalCheckPattern.test(step.run),
  );
  if (checkIndex < 0) throw new Error(`${label} must run the canonical vp run check task`);

  const groupedChecksIndex = steps.findIndex(
    (step) => typeof step.run === "string" && staticGroupPattern.test(step.run),
  );
  if (groupedChecksIndex < 0) {
    throw new Error(`${label} must route non-type groups through verify-static.ts`);
  }
  if (checkIndex <= groupedChecksIndex) return;

  throw new Error(`${label} must declare vp run check before grouped static contracts`);
};

const verifySharedSetupAction = (): void => {
  const action = readAutomationFile(sharedSetupPath);
  const steps = automationSteps(action, relativeRepositoryPath(sharedSetupPath));
  if (steps.length !== 1) throw new Error(`${sharedSetupAction} must own one setup step`);

  const setup = steps[0];
  if (!setup || setup.uses !== pinnedSetupVpAction) {
    throw new Error(`${sharedSetupAction} must pin setup-vp to ${setupVpCommit}`);
  }
  const inputs = requireRecord(setup.with, `${sharedSetupAction}.with`);
  if (inputs["node-version-file"] !== ".node-version") {
    throw new Error(`${sharedSetupAction} must resolve Node.js from .node-version`);
  }
  if (inputs.cache !== true || inputs["cache-dependency-path"] !== "pnpm-lock.yaml") {
    throw new Error(`${sharedSetupAction} must own the pnpm dependency cache`);
  }
  if (inputs["run-install"] !== false) {
    throw new Error(`${sharedSetupAction} must preserve each job's dependency-install ordering`);
  }
};

interface WorkflowJobSteps {
  readonly jobName: string;
  readonly steps: readonly UnknownRecord[];
}

const workflowSteps = (filePath: string, workflow: UnknownRecord): readonly WorkflowJobSteps[] => {
  const jobs = requireRecord(workflow.jobs, `${relativeRepositoryPath(filePath)}.jobs`);
  return Object.entries(jobs).flatMap(([jobName, rawJob]) => {
    const job = requireRecord(rawJob, `${relativeRepositoryPath(filePath)}:${jobName}`);
    if (!Array.isArray(job.steps)) return [];
    return [
      {
        jobName,
        steps: job.steps.map((step, index) =>
          requireRecord(step, `${relativeRepositoryPath(filePath)}:${jobName}.steps[${index}]`),
        ),
      },
    ];
  });
};

export const verifyVitePlusWorkflowContracts = (): number => {
  verifySharedSetupAction();
  let vpCommandCount = 0;

  for (const filePath of workflowFiles()) {
    const label = relativeRepositoryPath(filePath);
    for (const { jobName, steps } of workflowSteps(filePath, readWorkflow(filePath))) {
      const jobLabel = `${label}:${jobName}`;
      vpCommandCount += verifyCommandSteps(jobLabel, steps, true);
      if (label === staticCheckWorkflow && jobName === "check") {
        verifyStaticCheckSteps(jobLabel, steps);
      }
    }
  }

  for (const filePath of actionFiles()) {
    if (filePath === sharedSetupPath) continue;
    const label = relativeRepositoryPath(filePath);
    vpCommandCount += verifyCommandSteps(
      label,
      automationSteps(readAutomationFile(filePath), label),
      false,
    );
  }

  if (vpCommandCount === 0) throw new Error("No direct Vite+ commands were found in CI");
  return vpCommandCount;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const count = verifyVitePlusWorkflowContracts();
  process.stdout.write(
    `Verified ${count} direct Vite+ CI commands and the shared setup boundary.\n`,
  );
}
