import { resolveNightlyCandidate } from "./candidate";
import { inspectNightlyRemoteCandidate } from "./github-release";
import type { ReleaseIdentity } from "./model";
import { inspectNightlySourceCi, type NightlySourceCi } from "./source-ci";

type NightlyReleaseResolution = NightlySourceCi &
  (
    | { readonly decision: "no-verified-commit" | "version-advance-only" | "already-published" }
    | { readonly decision: "eligible"; readonly identity: ReleaseIdentity }
  );

export function resolveNightlyRelease(options: {
  readonly cwd: string;
  readonly repo: string;
  readonly headSha: string;
}): NightlyReleaseResolution {
  const ci = inspectNightlySourceCi(options);
  if (!ci.verified) return { ...ci, decision: "no-verified-commit" };

  const candidate = resolveNightlyCandidate({
    cwd: options.cwd,
    sourceSha: ci.verified.sourceSha,
  });
  if (!candidate.shouldRelease) return { ...ci, decision: candidate.reason };

  const remote = inspectNightlyRemoteCandidate(options.repo, candidate.identity);
  if (remote.decision === "already-published") return { ...ci, decision: remote.decision };
  return { ...ci, decision: "eligible", identity: candidate.identity };
}
