export const MAIN_CI_WORKFLOW_PATH = ".github/workflows/ci-main.yml";
export const MAIN_CI_BASE_COMMAND = "node --no-warnings scripts/ci/resolve-main-ci-base.ts";

export type MainCiBaseDecision =
  | { readonly baseSha: string; readonly reason: "Successful Main CI under the last-green rule" }
  | { readonly baseSha: null; readonly reason: string };

interface MainCiBaseInput {
  readonly headSha: string;
  readonly currentRunId: string | undefined;
  readonly runs: unknown;
  readonly usesLastGreenRule: (sha: string) => boolean;
  readonly isAncestor: (ancestor: string, descendant: string) => boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function resolveMainCiBase({
  headSha,
  currentRunId,
  runs,
  usesLastGreenRule,
  isAncestor,
}: MainCiBaseInput): MainCiBaseDecision {
  if (!Array.isArray(runs)) {
    return { baseSha: null, reason: "GitHub workflow history unavailable" };
  }
  const candidateShas = new Set<string>();
  for (const run of runs as readonly unknown[]) {
    if (
      !isRecord(run) ||
      typeof run.id !== "number" ||
      String(run.id) === currentRunId ||
      run.head_branch !== "main" ||
      run.conclusion !== "success" ||
      (run.event !== "push" && run.event !== "workflow_dispatch") ||
      typeof run.head_sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(run.head_sha)
    ) {
      continue;
    }
    candidateShas.add(run.head_sha);
  }

  let baseSha: string | null = null;
  for (const sha of candidateShas) {
    if (!usesLastGreenRule(sha) || !isAncestor(sha, headSha)) continue;
    // Run creation order can differ from ancestry after dispatches or branch rewrites.
    if (baseSha !== null && !isAncestor(baseSha, sha)) continue;
    baseSha = sha;
    if (baseSha === headSha) break;
  }
  if (baseSha === null) {
    return { baseSha, reason: "No trusted green ancestor in recent Main CI runs" };
  }
  return { baseSha, reason: "Successful Main CI under the last-green rule" };
}
