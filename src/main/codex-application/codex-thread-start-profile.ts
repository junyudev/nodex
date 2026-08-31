import type { ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";

type ThreadExecutionProfileResponse = Pick<
  ThreadStartResponse,
  "model" | "reasoningEffort" | "serviceTier"
>;

/** Rejects an unexpected Codex model/settings substitution before admitting the first Turn. */
export function requireExactThreadStartProfile(
  response: ThreadExecutionProfileResponse,
  expected: CodexExecutionProfile | null,
): void {
  if (!expected) return;
  const actual = {
    modelId: response.model,
    reasoningEffort: response.reasoningEffort,
    serviceTier: normalizeCodexServiceTier(response.serviceTier),
  };
  const mismatches = (Object.keys(actual) as Array<keyof typeof actual>).filter(
    (key) => actual[key] !== expected[key],
  );
  if (mismatches.length === 0) return;
  throw new Error(
    `Codex substituted the requested execution settings (${mismatches.join(", ")}): expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}
