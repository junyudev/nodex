export interface PackagedPtyReceipt {
  readonly schemaVersion: 1;
  readonly nodeExecutable: string;
  readonly addonPath: string;
  readonly platform: string;
  readonly architecture: string;
  readonly marker: string;
  readonly output: string;
  readonly exitCode: 73;
  readonly ptyPid: number;
}
export function assertPackagedPtyReceipt(receipt: unknown): PackagedPtyReceipt;
export function runPackagedPtyProbe(input: {
  readonly nodeExecutable: string;
  readonly addonPath: string;
  readonly timeoutMs?: number;
}): PackagedPtyReceipt;
