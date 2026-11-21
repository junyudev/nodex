import type { RipgrepRelease, RipgrepTarget } from "../src/shared/ripgrep-runtime-metadata.mjs";
export function assertRipgrepRuntimePayload(
  directory: string,
  target: RipgrepTarget,
  options?: { allowSigned?: boolean; release?: RipgrepRelease },
): string;
