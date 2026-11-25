export type RipgrepTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-x64";
export interface RipgrepBuild {
  readonly binarySha256: string;
  readonly binarySize: number;
  readonly machOContentSha256?: string;
  readonly archive: {
    readonly url: string;
    readonly member: string;
    readonly sha256: string;
    readonly size: number;
  };
}
export interface RipgrepRelease {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly licenseSha256: string;
  readonly builds: Readonly<Record<RipgrepTarget, RipgrepBuild>>;
}
export function parseRipgrepRelease(value: unknown): RipgrepRelease;
export const ripgrepRelease: RipgrepRelease;
export function ripgrepTarget(platform: string, arch: string): RipgrepTarget | null;
export function ripgrepExecutableName(target: RipgrepTarget): "rg" | "rg.exe";
