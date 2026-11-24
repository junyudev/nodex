import type { LocalInputs } from "./test-cache-inputs.ts";

export interface CacheExclusion {
  readonly reason: string;
  readonly input?: string;
}

export interface TestEvidence {
  readonly file: string;
  readonly passed: boolean;
  readonly deps?: readonly string[];
  readonly local?: Omit<LocalInputs, "topology">;
  readonly broadTopology?: boolean;
  readonly reason?: string;
  readonly input?: string;
  readonly exclusions?: readonly CacheExclusion[];
  readonly durationMs?: number;
}
