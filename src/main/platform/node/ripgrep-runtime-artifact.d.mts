import type { RipgrepRelease, RipgrepTarget } from "../../../shared/ripgrep-runtime-metadata.mjs";
export function ripgrepSha256(bytes: Uint8Array): string;
export function ripgrepMachOContentSha256(binary: Buffer): string;
export function assertRipgrepBytes(
  binary: Buffer,
  target: RipgrepTarget,
  mode?: "upstream" | "signed",
  release?: RipgrepRelease,
): void;
