export const WINDOWS_PE_MACHINE: Readonly<{ x64: 0x8664 }>;
export function inspectWindowsPe(
  file: string,
): { machine: number; certificate: Buffer | null } | null;
